import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { readIndexedVideo } from '@/lib/queries'
import { cuesForVideo } from '@/lib/render/caption'
import type { Cue } from '@/lib/subtitles/parse'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

const MAX_WINDOW_MS = 120_000

/**
 * Subtitle tracks are fetched from Jellyfin and parsed on every call otherwise,
 * and the editor asks for one window per clip on load. Cues for a video only
 * change when its file does, so a process-lifetime cache is safe and a restart
 * clears it.
 */
const cueCache = new Map<string, Cue[]>()

/**
 * The dialogue inside a span of a video, with its real cue boundaries.
 *
 * These are the edges that matter when trimming: you extend a clip because it
 * is missing a line and shorten it because it carries one it does not need, so
 * the timeline snaps to cue boundaries and can name what moving an edge would
 * add or drop. Deliberately the same cues the caption burner uses, so the
 * boundary the editor snaps to is the boundary the caption appears on.
 */
export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams

  const videoId = params.get('videoId')
  const startMs = Number(params.get('start'))
  const endMs = Number(params.get('end'))

  if (!videoId) return fail('videoId is required')
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return fail('start and end must be numbers in milliseconds')
  }
  if (endMs - startMs > MAX_WINDOW_MS) return fail('That span is too long')
  if (!readIndexedVideo(videoId)) return fail('That video has not been indexed', 404)

  const cues = await cuesForVideo(requireJellyfinClient(), videoId, cueCache)

  return json({
    cues: cues
      .filter((cue) => cue.endMs > startMs && cue.startMs < endMs)
      .map(({ startMs: from, endMs: to, text }) => ({ startMs: from, endMs: to, text })),
  })
})
