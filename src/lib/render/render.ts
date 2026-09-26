import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getDb } from '@/lib/db'
import { audioStreamFor } from '@/lib/jellyfin/audio'
import { JellyfinClient } from '@/lib/jellyfin/client'
import type { Cue } from '@/lib/subtitles/parse'
import { writeCaptionFile } from './caption'
import {
  cleanUp,
  concatSegments,
  encodeSegment,
  ensureDir,
  fileSize,
  makeWorkDir,
  toGif,
  toStill,
  toWebm,
  RenderError,
} from './ffmpeg'
import { RENDER_DIR } from './paths'
import {
  activeMatch,
  clipBounds,
  isStillFormat,
  resolveCaption,
  type Montage,
  type RenderSettings,
} from '@/lib/montage/types'

export interface RenderRecord {
  id: string
  montageId: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  stage: string
  format: string
  filePath: string | null
  fileSize: number | null
  error: string | null
  createdAt: number
  updatedAt: number
}

interface RenderRow {
  id: string
  montage_id: string
  status: RenderRecord['status']
  progress: number
  stage: string
  format: string
  file_path: string | null
  file_size: number | null
  error: string | null
  created_at: number
  updated_at: number
}

const rowToRecord = (r: RenderRow): RenderRecord => ({
  id: r.id,
  montageId: r.montage_id,
  status: r.status,
  progress: r.progress,
  stage: r.stage,
  format: r.format,
  filePath: r.file_path,
  fileSize: r.file_size,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function getRender(id: string): RenderRecord | null {
  const row = getDb().prepare('SELECT * FROM render WHERE id = ?').get(id) as RenderRow | undefined
  return row ? rowToRecord(row) : null
}

export function latestRenderFor(montageId: string): RenderRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM render WHERE montage_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(montageId) as RenderRow | undefined
  return row ? rowToRecord(row) : null
}

function updateRender(id: string, patch: Partial<RenderRow>) {
  const fields = Object.keys(patch)
  if (fields.length === 0) return
  getDb()
    .prepare(
      `UPDATE render SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    )
    .run(...fields.map((f) => (patch as Record<string, unknown>)[f]), Date.now(), id)
}

/**
 * Renders a montage to a single file.
 *
 * Each clip is encoded to a normalised segment read straight from Jellyfin over
 * HTTP, then the segments are concatenated with a stream copy. GIF and WebM are
 * produced by converting the assembled MP4, so the expensive per-clip work
 * happens exactly once regardless of output format.
 */
export async function runRender(
  renderId: string,
  montage: Montage,
  settings: RenderSettings,
  client: JellyfinClient,
): Promise<void> {
  const workDir = await makeWorkDir()
  const cueCache = new Map<string, Cue[]>()

  try {
    updateRender(renderId, { status: 'running', stage: 'preparing', progress: 0 })
    await ensureDir(RENDER_DIR)

    const renderable = montage.clips.filter((clip) => activeMatch(clip) && clipBounds(clip))
    if (renderable.length === 0) {
      throw new RenderError('No clips have a matched scene to render')
    }

    const segmentPaths: string[] = []

    for (let i = 0; i < renderable.length; i++) {
      const clip = renderable[i]
      const match = activeMatch(clip)!
      const bounds = clipBounds(clip)!

      updateRender(renderId, {
        stage: `encoding clip ${i + 1} of ${renderable.length}`,
        // Encoding is ~85% of the work; the tail is concat and conversion.
        progress: (i / renderable.length) * 0.85,
      })

      const assPath = await writeCaptionFile(
        {
          caption: resolveCaption(clip, montage.caption),
          videoId: match.videoId,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          width: settings.maxWidth,
        },
        client,
        cueCache,
        join(workDir, `cap-${i}.ass`),
      )

      const segmentPath = join(workDir, `seg-${String(i).padStart(3, '0')}.mp4`)
      await encodeSegment(
        {
          // Read through Jellyfin's transcoder rather than from the original
          // file: it tone maps HDR to SDR on its GPU. Reading the original left
          // PQ-tagged pixels in an 8-bit file, which looks washed out on every
          // ordinary display, and it is what the editor's preview now shows.
          input: client.segmentUrl(
            match.videoId,
            bounds.startMs,
            settings.maxWidth,
            `render-${renderId}-${i}`,
            await audioStreamFor(client, match.videoId),
          ),
          seek: 'positioned',
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          assPath,
          silent: clip.muted,
        },
        { maxWidth: settings.maxWidth, fps: settings.fps, stripAudio: settings.stripAudio },
        segmentPath,
      )
      segmentPaths.push(segmentPath)
    }

    updateRender(renderId, { stage: 'joining clips', progress: 0.88 })
    const joinedPath = join(workDir, 'joined.mp4')
    await concatSegments(segmentPaths, joinedPath, workDir)

    const outputPath = join(RENDER_DIR, `${renderId}.${settings.format}`)

    if (isStillFormat(settings.format)) {
      updateRender(renderId, { stage: 'grabbing frame', progress: 0.92 })
      await toStill(joinedPath, outputPath, {
        frameMs: settings.frameMs,
        maxWidth: settings.maxWidth,
        jpeg: settings.format === 'jpg',
      })
    } else if (settings.format === 'gif') {
      updateRender(renderId, { stage: 'building gif palette', progress: 0.92 })
      await toGif(joinedPath, outputPath, { fps: settings.fps, maxWidth: settings.maxWidth })
    } else if (settings.format === 'webm') {
      updateRender(renderId, { stage: 'encoding webm', progress: 0.92 })
      await toWebm(joinedPath, outputPath, settings.stripAudio)
    } else {
      updateRender(renderId, { stage: 'finalising', progress: 0.95 })
      await concatSegments([joinedPath], outputPath, workDir)
    }

    updateRender(renderId, {
      status: 'done',
      stage: 'done',
      progress: 1,
      file_path: outputPath,
      file_size: await fileSize(outputPath),
    })
  } catch (error) {
    updateRender(renderId, {
      status: 'error',
      stage: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await cleanUp(workDir)
  }
}

/** Creates the render row and kicks the job off without blocking the request. */
export function startRender(
  montage: Montage,
  settings: RenderSettings,
  client: JellyfinClient,
): RenderRecord {
  const id = randomUUID()
  const now = Date.now()

  getDb()
    .prepare(
      `INSERT INTO render (id, montage_id, status, progress, stage, format, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, 'queued', ?, ?, ?)`,
    )
    .run(id, montage.id, settings.format, now, now)

  void runRender(id, montage, settings, client)

  return getRender(id)!
}
