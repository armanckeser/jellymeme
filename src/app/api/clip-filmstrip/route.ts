import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { planFilmstrip } from '@/lib/montage/filmstrip'
import { readIndexedVideo } from '@/lib/queries'
import { buildFilmstrip } from '@/lib/render/filmstrip'
import { fail, handler, serveFile } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Widest span a single strip may cover. The editor asks for a clip's reachable
 * range, which is bounded by the trim limits; anything much larger than that is
 * a hand-written URL, not the app.
 */
const MAX_WINDOW_MS = 120_000
const MIN_WINDOW_MS = 1_000

/**
 * A sprite of evenly spaced thumbnails across one span of a video.
 *
 * This is the editor's timeline. It covers everywhere a clip's edges can reach,
 * so it is fetched once per clip and then dragging the handles is pure CSS
 * rather than a round trip per pixel.
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

  const span = endMs - startMs
  if (span < MIN_WINDOW_MS) return fail('That span is too short for a filmstrip')
  if (span > MAX_WINDOW_MS) return fail('That span is too long for a filmstrip')

  if (!readIndexedVideo(videoId)) return fail('That video has not been indexed', 404)

  const plan = planFilmstrip(Math.max(0, Math.round(startMs)), Math.round(endMs))
  const path = await buildFilmstrip(videoId, plan, requireJellyfinClient())

  return serveFile(request, path, {
    contentType: 'image/jpeg',
    filename: 'filmstrip.jpg',
    disposition: 'inline',
    // The query string fixes the pixels. Not immutable: re-indexing a title can
    // point the same video id at a different file.
    cacheControl: 'private, max-age=86400',
  })
})
