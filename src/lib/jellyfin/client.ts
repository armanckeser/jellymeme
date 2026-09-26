import type {
  BaseItem,
  ItemsResponse,
  MediaSource,
  MediaStream,
  SubtitleTrack,
  SystemInfo,
} from './types'
import { msToTicks } from './types'

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'JellyfinError'
  }
}

/** Fields we must request explicitly — Jellyfin omits them from list responses by default. */
const ITEM_FIELDS = 'MediaSources,MediaStreams,Path,ProductionYear,ParentId'

/**
 * Metadata calls should come back in well under this on any real server; if one
 * doesn't, the server or the network is the problem and waiting longer just
 * delays saying so.
 */
const METADATA_TIMEOUT_MS = 30_000

/**
 * Subtitle transcoding is server-side CPU work with no progress signal, so it
 * needs more slack than a metadata call — but an indexing run that stalls here
 * for undici's ~5 minute default rather than failing fast turns one bad episode
 * into most of an hour. Real transcodes of a plain text track finish in well
 * under this; a request that doesn't is not going to.
 */
const SUBTITLE_TIMEOUT_MS = 60_000

export interface JellyfinConfig {
  baseUrl: string
  apiKey: string
}

/**
 * Minimal Jellyfin client.
 *
 * Everything Jellymeme needs from a media server is here: find titles,
 * enumerate episodes, pull subtitle text, and hand ffmpeg a seekable URL.
 * Notably it never needs filesystem access to the media itself.
 */
export class JellyfinClient {
  readonly baseUrl: string
  private readonly apiKey: string

  constructor({ baseUrl, apiKey }: JellyfinConfig) {
    // Normalise: accept "http://host:8096/" and "http://host:8096"
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
  }

  private headers(): HeadersInit {
    return {
      // Jellyfin's scheme. The quoted-token form is what the server parses.
      Authorization: `MediaBrowser Token="${this.apiKey}"`,
      Accept: 'application/json',
    }
  }

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
    const u = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v))
    }
    return u
  }

  private async getJson<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    timeoutMs = METADATA_TIMEOUT_MS,
  ): Promise<T> {
    const url = this.url(path, query)
    let res: Response
    try {
      res = await fetch(url, {
        headers: this.headers(),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new JellyfinError(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `Jellyfin did not respond within ${timeoutMs / 1000}s for ${path}.`
          : `Could not reach Jellyfin at ${this.baseUrl}. Is the server running and the URL correct?`,
      )
    }
    if (!res.ok) {
      throw new JellyfinError(
        res.status === 401
          ? 'Jellyfin rejected the API key (401). Generate one in Dashboard → API Keys.'
          : `Jellyfin returned ${res.status} for ${path}`,
        res.status,
      )
    }
    return (await res.json()) as T
  }

  /** Verifies both connectivity and credentials. */
  async systemInfo(): Promise<SystemInfo> {
    return this.getJson<SystemInfo>('/System/Info')
  }

  /**
   * Every series and film on the server, by name.
   *
   * The limit is high because the browse surface shows the whole library at
   * once: a search box that has to be used before anything appears is a gate,
   * and choosing what to index is a browsing job, not a searching one. The total
   * comes back too, so a truncated list can say so instead of quietly lying.
   */
  async titles(
    searchTerm?: string,
    limit = 1000,
  ): Promise<{ items: BaseItem[]; total: number }> {
    const res = await this.getJson<ItemsResponse>('/Items', {
      recursive: true,
      includeItemTypes: 'Series,Movie',
      sortBy: 'SortName',
      sortOrder: 'Ascending',
      searchTerm: searchTerm || undefined,
      limit,
      fields: 'ProductionYear,ProviderIds',
      enableImages: true,
      enableTotalRecordCount: true,
    })
    const all = res.Items ?? []
    const items = collapseSplitTitles(all)
    const total = res.TotalRecordCount ?? all.length
    return { items, total: total - (all.length - items.length) }
  }

  /**
   * Several items in one round trip.
   *
   * Same route and same reason as `item`: the per-item route needs a user
   * context an API-key caller does not have.
   */
  async items(itemIds: string[]): Promise<BaseItem[]> {
    if (itemIds.length === 0) return []
    const res = await this.getJson<ItemsResponse>('/Items', {
      ids: itemIds.join(','),
      recursive: true,
      fields: ITEM_FIELDS,
    })
    return res.Items ?? []
  }

  /**
   * One item by id.
   *
   * Deliberately the list endpoint filtered by id, not `/Items/{itemId}`. That
   * route resolves against a user's library view, so an API-key caller with no
   * user context gets a bare 400 from it — with or without `fields`. The list
   * form needs no user and still carries MediaSources when asked explicitly.
   */
  async item(itemId: string): Promise<BaseItem> {
    const res = await this.getJson<ItemsResponse>('/Items', {
      ids: itemId,
      recursive: true,
      fields: ITEM_FIELDS,
    })
    const item = res.Items?.[0]
    if (!item) {
      throw new JellyfinError(`Jellyfin has no item ${itemId}`, 404)
    }
    return item
  }

  /**
   * The videos that make up a title: every episode for a series, or the movie
   * itself. Each carries MediaSources so we can pick a subtitle track without
   * a second round-trip.
   */
  async videosForTitle(title: BaseItem): Promise<BaseItem[]> {
    if (title.Type === 'Movie') {
      return [await this.item(title.Id)]
    }
    const res = await this.getJson<ItemsResponse>(`/Shows/${title.Id}/Episodes`, {
      fields: ITEM_FIELDS,
      enableImages: false,
      enableUserData: false,
    })
    return res.Items ?? []
  }

  /**
   * Picks the best subtitle track for indexing.
   *
   * Only text-based tracks are usable — PGS/VOBSUB are bitmaps and would need
   * OCR. Among those we prefer English, non-forced (forced tracks only cover
   * foreign-language lines), and non-hearing-impaired (SDH is noisier, full of
   * [DOOR SLAMS]), falling back through those preferences in order.
   *
   * A track tagged with another language is not a fallback. The embedding model
   * is English-only, so indexing, say, the Russian track of a dual-language
   * release makes the title look searchable while matching nothing — and a
   * title that looks indexed is never re-read when English subtitles turn up.
   * Untagged tracks are kept: plenty of English files never set a language.
   */
  static pickSubtitleTrack(sources: MediaSource[] | null | undefined): SubtitleTrack | null {
    const candidates: SubtitleTrack[] = []
    for (const source of sources ?? []) {
      for (const stream of source.MediaStreams ?? []) {
        if (stream.Type !== 'Subtitle') continue
        if (!stream.IsTextSubtitleStream) continue
        if (!isEnglishOrUntagged(stream.Language)) continue
        candidates.push({
          mediaSourceId: source.Id,
          index: stream.Index,
          language: stream.Language,
          displayTitle: stream.DisplayTitle,
          isExternal: stream.IsExternal,
          isForced: stream.IsForced,
          isDefault: stream.IsDefault,
          isHearingImpaired: Boolean(stream.IsHearingImpaired),
          codec: stream.Codec,
        })
      }
    }
    if (candidates.length === 0) return null

    const isEnglish = (t: SubtitleTrack) => /^en/i.test(t.language ?? '')
    const score = (t: SubtitleTrack) =>
      (isEnglish(t) ? 8 : 0) +
      (t.isForced ? 0 : 4) +
      (t.isHearingImpaired ? 0 : 2) +
      (t.isDefault ? 1 : 0)

    return candidates.slice().sort((a, b) => score(b) - score(a))[0]
  }

  /**
   * The English audio stream, when a source has one to choose.
   *
   * Dual-language releases commonly lead with a dub, and Jellyfin's transcoder
   * plays the default track unless it is given `AudioStreamIndex`, so clips cut
   * from them came out dubbed while the subtitles they were found by are
   * English. Null means no English track, where the default is all there is.
   */
  static pickAudioStream(sources: MediaSource[] | null | undefined): number | null {
    for (const source of sources ?? []) {
      for (const stream of source.MediaStreams ?? []) {
        if (stream.Type === 'Audio' && /^en/i.test(stream.Language ?? '')) return stream.Index
      }
    }
    return null
  }

  /**
   * Downloads a subtitle track as SRT. Jellyfin transcodes the track
   * server-side, so ASS/SSA/embedded MKV tracks all arrive as plain SRT and we
   * never need to run ffmpeg to extract subtitles.
   */
  async subtitleSrt(itemId: string, track: SubtitleTrack): Promise<string> {
    const url = this.url(
      `/Videos/${itemId}/${track.mediaSourceId}/Subtitles/${track.index}/Stream.srt`,
    )
    let res: Response
    try {
      res = await fetch(url, {
        headers: this.headers(),
        cache: 'no-store',
        signal: AbortSignal.timeout(SUBTITLE_TIMEOUT_MS),
      })
    } catch (cause) {
      throw new JellyfinError(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `Jellyfin did not finish transcoding subtitles for item ${itemId} within ${SUBTITLE_TIMEOUT_MS / 1000}s.`
          : `Could not reach Jellyfin to download subtitles for item ${itemId}.`,
      )
    }
    if (!res.ok) {
      throw new JellyfinError(
        `Could not download subtitles for item ${itemId} (${res.status})`,
        res.status,
      )
    }
    return res.text()
  }

  /**
   * A direct, seekable URL to the original media file.
   *
   * `static=true` means Jellyfin serves the untranscoded file and honours HTTP
   * range requests, which is what lets ffmpeg seek straight to a timestamp deep
   * inside a multi-gigabyte file instead of streaming it from the beginning.
   * The API key rides in the query string because ffmpeg consumes a bare URL.
   * `ApiKey`, not `api_key`: Jellyfin 12 turns the legacy spelling off.
   */
  streamUrl(itemId: string, mediaSourceId?: string): string {
    return this.url(`/Videos/${itemId}/stream`, {
      static: true,
      mediaSourceId,
      ApiKey: this.apiKey,
    }).toString()
  }

  /**
   * A browser-playable stream, transcoded by Jellyfin on the fly.
   *
   * The static URL above is perfect for ffmpeg and useless to a browser: most
   * libraries are MKV, often HEVC, which Chrome and Safari will not decode.
   * This is the one place Jellyfin's transcoder earns its keep — it remuxes or
   * re-encodes to H.264/AAC in MP4 and seeks with `startTimeTicks`, so the
   * editor can scrub any source format without Jellymeme touching a frame.
   */
  previewUrl(itemId: string, startMs = 0, maxWidth = 640, audioStreamIndex?: number): string {
    return this.url(`/Videos/${itemId}/stream.mp4`, {
      static: false,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      // Let Jellyfin stream-copy when the source is already compatible.
      allowVideoStreamCopy: true,
      allowAudioStreamCopy: true,
      enableAutoStreamCopy: true,
      maxWidth,
      startTimeTicks: msToTicks(startMs),
      // Jellyfin keys transcoding sessions by device; a stable id keeps it from
      // spawning a new ffmpeg process for every seek.
      deviceId: 'jellymeme-preview',
      AudioStreamIndex: audioStreamIndex,
      ApiKey: this.apiKey,
    }).toString()
  }

  /**
   * A stream the server has already positioned at `startMs`, transcoded to
   * H.264 in SDR.
   *
   * Reading a segment through the transcoder rather than from the original file
   * hands Jellyfin the two jobs it has a GPU for: decoding 4K HEVC, and tone
   * mapping HDR down to SDR. Reading the original instead leaves PQ-tagged
   * pixels in an 8-bit output, which looks washed out everywhere.
   *
   * The result is not byte-seekable and its timestamps do not start at zero, so
   * a consumer must bound the segment on the output side rather than seeking.
   * `session` keys Jellyfin's transcode session — concurrent reads need
   * distinct values or they evict each other.
   */
  segmentUrl(
    itemId: string,
    startMs: number,
    maxWidth: number,
    session: string,
    audioStreamIndex?: number,
  ): string {
    return this.url(`/Videos/${itemId}/stream.mp4`, {
      static: false,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      maxWidth,
      // Generous relative to the target width: this is an intermediate that
      // gets re-encoded, so its artefacts would compound in the final file.
      videoBitRate: Math.min(12_000_000, Math.max(1_500_000, maxWidth * 8_000)),
      // Stream copy has to be off. Left on, Jellyfin may hand back the original
      // packets for an already-H.264 source — which skips the tone mapping this
      // endpoint exists for, and ignores maxWidth. Always transcoding costs the
      // server work but makes the colour and the size deterministic.
      allowVideoStreamCopy: false,
      allowAudioStreamCopy: false,
      enableAutoStreamCopy: false,
      startTimeTicks: msToTicks(startMs),
      deviceId: `jellymeme-${session}`,
      AudioStreamIndex: audioStreamIndex,
      ApiKey: this.apiKey,
    }).toString()
  }

  /** Primary artwork for a title, for the picker UI. */
  imageUrl(itemId: string, maxHeight = 400): string {
    return this.url(`/Items/${itemId}/Images/Primary`, {
      maxHeight,
      ApiKey: this.apiKey,
    }).toString()
  }

  static videoStreamOf(item: BaseItem): MediaStream | null {
    const streams = item.MediaSources?.[0]?.MediaStreams ?? item.MediaStreams ?? []
    return streams.find((s) => s.Type === 'Video') ?? null
  }

  static primaryMediaSourceId(item: BaseItem): string | undefined {
    return item.MediaSources?.[0]?.Id
  }
}

/** `und` is ISO 639's "undetermined", which is as good as no tag. */
function isEnglishOrUntagged(language: string | null | undefined): boolean {
  return !language || /^(en|und$)/i.test(language)
}

/**
 * One entry per show, however many folders it is spread across.
 *
 * A library with several folders — an old drive and a new one — gets a Series
 * item per folder the show appears in, and Jellyfin's `/Shows/{id}/Episodes`
 * answers every one of them with the same merged episode list. Listed as-is the
 * show appears twice, and indexing both reads the same episodes twice, the
 * second run taking the first's lines with it. Items are the same title when
 * they share a kind and an external id; the lowest id wins so the choice holds
 * from one listing to the next.
 */
export function collapseSplitTitles(items: BaseItem[]): BaseItem[] {
  const keep = new Map<string, BaseItem>()
  for (const item of items) {
    const key = identityKey(item)
    if (!key) continue
    const held = keep.get(key)
    if (!held || item.Id < held.Id) keep.set(key, item)
  }
  return items.filter((item) => {
    const key = identityKey(item)
    return !key || keep.get(key) === item
  })
}

function identityKey(item: BaseItem): string | null {
  const ids = item.ProviderIds ?? {}
  for (const provider of ['Tvdb', 'Tmdb', 'Imdb']) {
    if (ids[provider]) return `${item.Type}:${provider}:${ids[provider]}`
  }
  return null
}
