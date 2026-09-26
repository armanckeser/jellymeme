import 'server-only'
import { getDb } from '@/lib/db'
import { listJobs, getJob, type IndexJob } from '@/lib/index/indexer'
import { listMontages } from '@/lib/montage/build'
import type { JellyfinClient } from '@/lib/jellyfin/client'

/**
 * Read models shared by the API routes and the server components.
 *
 * Pages render from these directly, so the first paint carries real data
 * instead of a spinner plus a client-side fetch of the app's own API.
 */

export interface LibraryTitle {
  id: string
  name: string
  kind: string
  year: number | null
  indexedAt: number | null
  videoCount: number
  lineCount: number
  videosWithoutSubtitles: number
}

export interface LibrarySnapshot {
  titles: LibraryTitle[]
  jobs: IndexJob[]
}

export function readLibrary(): LibrarySnapshot {
  const db = getDb()

  const rows = db.prepare('SELECT * FROM title ORDER BY name COLLATE NOCASE').all() as {
    id: string
    name: string
    kind: string
    year: number | null
    indexed_at: number | null
    video_count: number
    line_count: number
  }[]

  const skipped = db
    .prepare(
      `SELECT title_id, COUNT(*) AS n FROM video
        WHERE subtitle_status IN ('none','error') GROUP BY title_id`,
    )
    .all() as { title_id: string; n: number }[]
  const skippedBy = new Map(skipped.map((r) => [r.title_id, r.n]))

  return {
    titles: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      year: r.year,
      indexedAt: r.indexed_at,
      videoCount: r.video_count,
      lineCount: r.line_count,
      videosWithoutSubtitles: skippedBy.get(r.id) ?? 0,
    })),
    jobs: listJobs(),
  }
}

export interface RemoteTitle {
  id: string
  name: string
  kind: string
  year: number | null
  imageUrl: string | null
  indexed: boolean
  videoCount: number
  lineCount: number
}

export interface RemoteTitles {
  titles: RemoteTitle[]
  /** How many the server holds, so a truncated list can admit it. */
  total: number
}

/**
 * Everything on the Jellyfin server, annotated with what has been indexed here.
 *
 * Both the browse page and its API route read this, so the list cannot mean one
 * thing on first paint and another after a refresh.
 */
export async function readRemoteTitles(
  client: JellyfinClient,
  searchTerm?: string,
): Promise<RemoteTitles> {
  const { items, total } = await client.titles(searchTerm)

  const indexed = new Map(
    (
      getDb()
        .prepare('SELECT id, video_count, line_count, indexed_at FROM title')
        .all() as {
        id: string
        video_count: number
        line_count: number
        indexed_at: number | null
      }[]
    ).map((row) => [row.id, row]),
  )

  return {
    total,
    titles: items.map((item) => {
      const local = indexed.get(item.Id)
      return {
        id: item.Id,
        name: item.Name,
        kind: item.Type,
        year: item.ProductionYear ?? null,
        // Proxied, so the API key never reaches the browser. Small: the grid
        // shows the whole library, and full-size art would be megabytes of
        // pointless downscaling.
        imageUrl: item.ImageTags?.Primary ? `/api/image/${item.Id}?h=220` : null,
        indexed: Boolean(local?.indexed_at),
        videoCount: local?.video_count ?? 0,
        lineCount: local?.line_count ?? 0,
      }
    }),
  }
}

export interface TitleVideo {
  id: string
  name: string
  season: number | null
  episode: number | null
  status: string
  note: string | null
}

export interface TitleDetail {
  title: Omit<LibraryTitle, 'videosWithoutSubtitles'> | null
  videos: TitleVideo[]
  job: IndexJob | null
}

export function readTitleDetail(titleId: string): TitleDetail {
  const db = getDb()

  const title = db.prepare('SELECT * FROM title WHERE id = ?').get(titleId) as
    | {
        id: string
        name: string
        kind: string
        year: number | null
        indexed_at: number | null
        video_count: number
        line_count: number
      }
    | undefined

  const videos = db
    .prepare(
      `SELECT id, name, season, episode, subtitle_status, subtitle_note
         FROM video WHERE title_id = ?
        ORDER BY season, episode, name`,
    )
    .all(titleId) as {
    id: string
    name: string
    season: number | null
    episode: number | null
    subtitle_status: string
    subtitle_note: string | null
  }[]

  return {
    title: title
      ? {
          id: title.id,
          name: title.name,
          kind: title.kind,
          year: title.year,
          indexedAt: title.indexed_at,
          videoCount: title.video_count,
          lineCount: title.line_count,
        }
      : null,
    videos: videos.map((v) => ({
      id: v.id,
      name: v.name,
      season: v.season,
      episode: v.episode,
      status: v.subtitle_status,
      note: v.subtitle_note,
    })),
    job: getJob(titleId) ?? null,
  }
}

export interface IndexedVideo {
  id: string
  name: string
  season: number | null
  episode: number | null
  runtimeMs: number | null
}

/**
 * Looks up a video Jellymeme has indexed.
 *
 * Every route that hands a video id to Jellyfin goes through this first, so the
 * app can never be used as an open transcoding proxy for arbitrary items on the
 * media server — only for the titles the user chose to index here.
 */
export function readIndexedVideo(videoId: string): IndexedVideo | null {
  const row = getDb()
    .prepare('SELECT id, name, season, episode, runtime_ms FROM video WHERE id = ?')
    .get(videoId) as
    | { id: string; name: string; season: number | null; episode: number | null; runtime_ms: number | null }
    | undefined

  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    season: row.season,
    episode: row.episode,
    runtimeMs: row.runtime_ms,
  }
}

export interface MontageSummary {
  id: string
  name: string
  clipCount: number
  updatedAt: number
  titleId: string
  /** Which show or film it came from, for a list that spans several. */
  titleName: string
}

export function readMontageSummaries(titleId?: string): MontageSummary[] {
  const names = new Map(
    (getDb().prepare('SELECT id, name FROM title').all() as { id: string; name: string }[]).map(
      (row) => [row.id, row.name],
    ),
  )

  return listMontages(titleId).map((m) => ({
    id: m.id,
    name: m.name,
    clipCount: m.clips.length,
    updatedAt: m.updatedAt,
    titleId: m.titleId,
    titleName: names.get(m.titleId) ?? 'Unknown',
  }))
}
