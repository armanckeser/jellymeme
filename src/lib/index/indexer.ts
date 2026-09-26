import { unlink } from 'node:fs/promises'
import { getDb, toVectorBlob } from '@/lib/db'
import { JellyfinClient } from '@/lib/jellyfin/client'
import type { BaseItem } from '@/lib/jellyfin/types'
import { ticksToMs } from '@/lib/jellyfin/types'
import { parseSubtitles } from '@/lib/subtitles/parse'
import { buildWindows } from '@/lib/subtitles/window'
import { embed } from '@/lib/search/embed'

/** Embedding batch size — large enough to amortise the ONNX call, small enough to bound memory. */
const EMBED_BATCH = 128

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface IndexJob {
  titleId: string
  titleName: string
  status: JobStatus
  totalVideos: number
  processedVideos: number
  linesIndexed: number
  currentVideo: string
  /** Videos that yielded no usable subtitles, so the UI can report coverage honestly. */
  skipped: { name: string; reason: string }[]
  error?: string
  startedAt: number
  finishedAt?: number
}

// Jobs are in-memory: they are progress for an operation the user is watching,
// and a restart mid-index is resumable anyway because each video is committed
// as it completes.
const jobs = new Map<string, IndexJob>()
const cancelled = new Set<string>()

export const getJob = (titleId: string): IndexJob | undefined => jobs.get(titleId)
export const listJobs = (): IndexJob[] => [...jobs.values()]

export function cancelJob(titleId: string): boolean {
  if (!jobs.has(titleId)) return false
  cancelled.add(titleId)
  return true
}

function upsertTitle(item: BaseItem) {
  getDb()
    .prepare(
      `INSERT INTO title (id, name, kind, year)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, year = excluded.year`,
    )
    .run(item.Id, item.Name, item.Type, item.ProductionYear ?? null)
}

/** Writes one video's dialogue windows and their vectors in a single transaction. */
function storeVideo(
  video: BaseItem,
  titleId: string,
  mediaSourceId: string | undefined,
  subtitleIndex: number | null,
  windows: { startMs: number; endMs: number; text: string }[],
  vectors: Float32Array[],
  status: 'ok' | 'none' | 'error',
  note?: string,
) {
  const db = getDb()

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO video (id, title_id, name, season, episode, media_source_id, runtime_ms, subtitle_status, subtitle_note, subtitle_index, audio_index, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title_id = excluded.title_id, name = excluded.name, season = excluded.season, episode = excluded.episode,
         media_source_id = excluded.media_source_id, runtime_ms = excluded.runtime_ms,
         subtitle_status = excluded.subtitle_status, subtitle_note = excluded.subtitle_note,
         subtitle_index = excluded.subtitle_index, audio_index = excluded.audio_index,
         indexed_at = excluded.indexed_at`,
    ).run(
      video.Id,
      titleId,
      video.Name,
      video.ParentIndexNumber ?? null,
      video.IndexNumber ?? null,
      mediaSourceId ?? null,
      video.RunTimeTicks ? ticksToMs(video.RunTimeTicks) : null,
      status,
      note ?? null,
      subtitleIndex,
      JellyfinClient.pickAudioStream(video.MediaSources) ?? -1,
      Date.now(),
    )

    // Re-indexing replaces prior content for this video.
    const stale = db.prepare('SELECT id FROM line WHERE video_id = ?').all(video.Id) as {
      id: number
    }[]
    if (stale.length > 0) {
      const del = db.prepare('DELETE FROM line_vec WHERE rowid = ?')
      for (const { id } of stale) del.run(BigInt(id))
      db.prepare('DELETE FROM line WHERE video_id = ?').run(video.Id)
    }

    const insertLine = db.prepare(
      'INSERT INTO line (video_id, title_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
    )
    const insertVec = db.prepare(
      'INSERT INTO line_vec (rowid, embedding, title_id, video_id) VALUES (?, ?, ?, ?)',
    )

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]
      const { lastInsertRowid } = insertLine.run(video.Id, titleId, w.startMs, w.endMs, w.text)
      // sqlite-vec rejects a JS number here; the rowid must be bound as a BigInt.
      insertVec.run(BigInt(lastInsertRowid), toVectorBlob(vectors[i]), titleId, video.Id)
    }
  })

  write()
}

/**
 * Recomputes a title's cached counts from what is actually stored.
 *
 * Called after every video rather than only when a run finishes. An index job
 * that dies partway — the embedder crashed doing exactly this — otherwise leaves
 * `line_count` at zero and `indexed_at` NULL with thousands of rows on disk, and
 * the library then reports the title as having no usable subtitles. Two COUNT(*)s
 * per episode is nothing next to embedding one.
 */
function refreshTitleCounts(titleId: string) {
  getDb()
    .prepare(
      `UPDATE title SET
         indexed_at  = ?,
         video_count = (SELECT COUNT(*) FROM video WHERE title_id = ? AND subtitle_status = 'ok'),
         line_count  = (SELECT COUNT(*) FROM line WHERE title_id = ?)
       WHERE id = ?`,
    )
    .run(Date.now(), titleId, titleId, titleId)
}

export interface IndexOptions {
  /** Re-index videos that already have content instead of skipping them. */
  force?: boolean
}

/**
 * Indexes every episode of a title.
 *
 * Each video is committed as soon as it is embedded, so an interrupted run
 * loses at most one episode and a re-run resumes where it stopped.
 */
export async function runIndexJob(
  client: JellyfinClient,
  title: BaseItem,
  options: IndexOptions = {},
): Promise<IndexJob> {
  const db = getDb()
  const job: IndexJob = {
    titleId: title.Id,
    titleName: title.Name,
    status: 'running',
    totalVideos: 0,
    processedVideos: 0,
    linesIndexed: 0,
    currentVideo: '',
    skipped: [],
    startedAt: Date.now(),
  }
  jobs.set(title.Id, job)
  cancelled.delete(title.Id)

  try {
    upsertTitle(title)
    const videos = await client.videosForTitle(title)
    job.totalVideos = videos.length

    const already = new Set(
      (
        db
          .prepare("SELECT id FROM video WHERE title_id = ? AND subtitle_status = 'ok'")
          .all(title.Id) as { id: string }[]
      ).map((r) => r.id),
    )

    const needsFetch = (video: BaseItem) =>
      (options.force || !already.has(video.Id)) &&
      JellyfinClient.pickSubtitleTrack(video.MediaSources) !== null

    /**
     * Subtitle downloads (network, and server-side transcoding on Jellyfin's
     * end) and embedding (local CPU) are different kinds of work, so there is
     * no reason to make one wait on the other. This holds at most one fetch
     * in flight, for the next episode that will actually need one, started
     * while the current episode is busy embedding below.
     *
     * A prefetch that fails is not surfaced here — it surfaces normally when
     * its result is awaited in the main loop, exactly like an un-prefetched
     * fetch would. `.catch(() => {})` only stops it from being reported twice,
     * as an unhandled rejection here and as a real error there.
     */
    const prefetched = new Map<string, Promise<string>>()
    function prefetchFrom(startIndex: number) {
      for (let i = startIndex; i < videos.length; i++) {
        const candidate = videos[i]
        if (!needsFetch(candidate)) continue
        if (!prefetched.has(candidate.Id)) {
          const track = JellyfinClient.pickSubtitleTrack(candidate.MediaSources)!
          const promise = client.subtitleSrt(candidate.Id, track)
          promise.catch(() => {})
          prefetched.set(candidate.Id, promise)
        }
        return
      }
    }

    for (let index = 0; index < videos.length; index++) {
      const video = videos[index]
      if (cancelled.has(title.Id)) {
        job.status = 'cancelled'
        break
      }

      const label =
        video.ParentIndexNumber != null && video.IndexNumber != null
          ? `S${String(video.ParentIndexNumber).padStart(2, '0')}E${String(video.IndexNumber).padStart(2, '0')} ${video.Name}`
          : video.Name
      job.currentVideo = label

      if (!options.force && already.has(video.Id)) {
        job.processedVideos++
        continue
      }

      const track = JellyfinClient.pickSubtitleTrack(video.MediaSources)
      const mediaSourceId = JellyfinClient.primaryMediaSourceId(video)

      if (!track) {
        job.skipped.push({ name: label, reason: 'no text subtitle track' })
        storeVideo(video, title.Id, mediaSourceId, null, [], [], 'none', 'no text subtitle track')
        job.processedVideos++
        continue
      }

      try {
        const srtPromise = prefetched.get(video.Id) ?? client.subtitleSrt(video.Id, track)
        prefetched.delete(video.Id)

        const srt = await srtPromise

        // Only now, with this episode's fetch settled, is it safe to start the
        // next one: Jellyfin does not take a second subtitle transcode
        // gracefully while one is still running (confirmed against a real
        // server — the loser stalls until it hits the client-side timeout
        // above, misreporting a working episode as broken). Starting this
        // fetch here overlaps it with the embedding below instead, which is
        // the actual point: fetch and embed are different resources, but two
        // fetches are not.
        prefetchFrom(index + 1)

        const cues = parseSubtitles(srt)
        const windows = buildWindows(cues)

        if (windows.length === 0) {
          job.skipped.push({ name: label, reason: 'subtitle track was empty' })
          storeVideo(video, title.Id, mediaSourceId, track.index, [], [], 'none', 'subtitle track was empty')
          job.processedVideos++
          continue
        }

        const vectors: Float32Array[] = []
        for (let i = 0; i < windows.length; i += EMBED_BATCH) {
          if (cancelled.has(title.Id)) break
          const batch = windows.slice(i, i + EMBED_BATCH)
          vectors.push(...(await embed(batch.map((w) => w.text))))
        }

        if (cancelled.has(title.Id)) {
          job.status = 'cancelled'
          break
        }

        storeVideo(video, title.Id, mediaSourceId, track.index, windows, vectors, 'ok')
        job.linesIndexed += windows.length
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        job.skipped.push({ name: label, reason: message })
        storeVideo(video, title.Id, mediaSourceId, track.index, [], [], 'error', message)
      }

      job.processedVideos++
      refreshTitleCounts(title.Id)
    }

    refreshTitleCounts(title.Id)
    if (job.status === 'running') job.status = 'done'
  } catch (error) {
    job.status = 'error'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.finishedAt = Date.now()
    job.currentVideo = ''
    cancelled.delete(title.Id)
  }

  return job
}

export interface TitleRemovalCost {
  /** Cuts that would be destroyed along with the index. */
  montages: number
  /** Finished files on disk that would be orphaned. */
  renders: number
}

/**
 * What removing a title's index would take with it.
 *
 * `montage.title_id` and `render.montage_id` both cascade, so deleting a title
 * quietly deletes every cut made from it. Cascade is the right shape — a cut
 * whose dialogue index is gone cannot be re-rendered — but it is not something
 * to do without saying so first, and the render files on disk are not covered by
 * it at all.
 */
export function titleRemovalCost(titleId: string): TitleRemovalCost {
  const db = getDb()
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM montage WHERE title_id = ?) AS montages,
         (SELECT COUNT(*) FROM render r
            JOIN montage m ON m.id = r.montage_id
           WHERE m.title_id = ? AND r.file_path IS NOT NULL) AS renders`,
    )
    .get(titleId, titleId) as { montages: number; renders: number }
  return counts
}

/** Removes a title's index, its cuts, and the files those cuts produced. */
export async function removeTitleIndex(titleId: string): Promise<void> {
  const db = getDb()

  // Read the paths before the rows go: the cascade takes the records with it and
  // there would be nothing left to say which files to clean up.
  const files = (
    db
      .prepare(
        `SELECT r.file_path FROM render r
           JOIN montage m ON m.id = r.montage_id
          WHERE m.title_id = ? AND r.file_path IS NOT NULL`,
      )
      .all(titleId) as { file_path: string }[]
  ).map((row) => row.file_path)

  db.transaction(() => {
    const lines = db.prepare('SELECT id FROM line WHERE title_id = ?').all(titleId) as {
      id: number
    }[]
    const deleteVector = db.prepare('DELETE FROM line_vec WHERE rowid = ?')
    for (const { id } of lines) deleteVector.run(BigInt(id))
    // Cascades remove video, line, montage and render rows.
    db.prepare('DELETE FROM title WHERE id = ?').run(titleId)
  })()

  await Promise.all(files.map((path) => unlink(path).catch(() => {})))
}

interface QueuedIndex {
  client: JellyfinClient
  title: BaseItem
  options: IndexOptions
}

/*
 * Indexing runs one title at a time.
 *
 * Selecting a whole library is a reasonable thing to ask for — the entire thing
 * is well under an hour — but each title's run holds the embedding model and
 * writes to SQLite, so starting sixty at once would thrash both and finish
 * nothing. A queue makes "index everything" a single click that simply takes a
 * while, and each title is committed episode by episode so it survives a
 * restart mid-run.
 */
const queue: QueuedIndex[] = []
let draining = false

async function drainQueue(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const next = queue.shift()!
      if (cancelled.has(next.title.Id)) {
        const job = jobs.get(next.title.Id)
        if (job) job.status = 'cancelled'
        cancelled.delete(next.title.Id)
        continue
      }
      await runIndexJob(next.client, next.title, next.options)
    }
  } finally {
    draining = false
  }
}

/** Queues an index run without blocking the request that triggered it. */
export function startIndexJob(
  client: JellyfinClient,
  title: BaseItem,
  options: IndexOptions = {},
): IndexJob {
  const existing = jobs.get(title.Id)
  if (existing?.status === 'running' || existing?.status === 'queued') return existing

  const job: IndexJob = {
    titleId: title.Id,
    titleName: title.Name,
    status: 'queued',
    totalVideos: 0,
    processedVideos: 0,
    linesIndexed: 0,
    currentVideo: '',
    skipped: [],
    startedAt: Date.now(),
  }
  jobs.set(title.Id, job)
  cancelled.delete(title.Id)
  queue.push({ client, title, options })

  void drainQueue()
  return job
}

/** Queues several titles, in the order given. */
export function startIndexJobs(
  client: JellyfinClient,
  titles: BaseItem[],
  options: IndexOptions = {},
): IndexJob[] {
  return titles.map((title) => startIndexJob(client, title, options))
}
