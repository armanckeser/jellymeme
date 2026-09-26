/**
 * Hand-written subset of the Jellyfin 12.0 API surface.
 *
 * We deliberately do not depend on @jellyfin/sdk: we touch roughly eight
 * endpoints, and the SDK pulls in axios plus a large generated client whose
 * types we would still narrow by hand. These are the fields we actually read.
 */

/** Jellyfin expresses all timings in "ticks": 100-nanosecond units. */
export const TICKS_PER_MS = 10_000

export const ticksToMs = (ticks: number): number => Math.round(ticks / TICKS_PER_MS)
export const msToTicks = (ms: number): number => Math.round(ms * TICKS_PER_MS)

export interface SystemInfo {
  ServerName: string
  Version: string
  Id: string
}

export interface MediaStream {
  Index: number
  Type: 'Video' | 'Audio' | 'Subtitle' | 'EmbeddedImage' | 'Data' | 'Lyric'
  Codec: string | null
  Language: string | null
  DisplayTitle: string | null
  IsDefault: boolean
  IsForced: boolean
  IsExternal: boolean
  /** True for SRT/ASS/SSA-style tracks; false for bitmap subs (PGS/VOBSUB). */
  IsTextSubtitleStream: boolean
  IsHearingImpaired?: boolean
  Height?: number | null
  Width?: number | null
  AverageFrameRate?: number | null
  RealFrameRate?: number | null
}

export interface MediaSource {
  Id: string
  Path: string | null
  Container: string | null
  Size?: number | null
  RunTimeTicks?: number | null
  MediaStreams: MediaStream[] | null
}

export type ItemKind = 'Series' | 'Season' | 'Episode' | 'Movie' | 'CollectionFolder' | 'Folder'

export interface BaseItem {
  Id: string
  Name: string
  Type: ItemKind
  RunTimeTicks?: number | null
  IndexNumber?: number | null
  ParentIndexNumber?: number | null
  SeriesName?: string | null
  SeriesId?: string | null
  ProductionYear?: number | null
  /** External ids keyed by provider — `Tvdb`, `Tmdb`, `Imdb`. */
  ProviderIds?: Record<string, string> | null
  MediaSources?: MediaSource[] | null
  MediaStreams?: MediaStream[] | null
  ImageTags?: Record<string, string> | null
  CollectionType?: string | null
  ChildCount?: number | null
}

export interface ItemsResponse {
  Items: BaseItem[] | null
  TotalRecordCount: number
  StartIndex: number
}

/** A subtitle track we consider usable for indexing. */
export interface SubtitleTrack {
  mediaSourceId: string
  index: number
  language: string | null
  displayTitle: string | null
  isExternal: boolean
  isForced: boolean
  isDefault: boolean
  isHearingImpaired: boolean
  codec: string | null
}
