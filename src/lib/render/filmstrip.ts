import { createHash, randomUUID } from 'node:crypto'
import { JellyfinClient } from '@/lib/jellyfin/client'
import { TILE_HEIGHT, TILE_WIDTH, type FilmstripPlan } from '@/lib/montage/filmstrip'
import { cachedArtefact } from './cache'
import { encodeFilmstrip } from './ffmpeg'
import { FILMSTRIP_DIR } from './paths'

/**
 * The sprite behind the editor's trim timeline.
 *
 * Deliberately has no captions in it. Two reasons: a caption sits over the
 * middle of the frame, which is the part you are squinting at to decide where
 * the cut should go; and a caption would make the strip depend on the caption
 * text, so every keystroke in the caption box would invalidate it. Keeping the
 * strip a function of (video, window) alone is what makes dragging a handle
 * instant — the whole reachable range is already on screen before you start.
 */

/**
 * What to ask Jellyfin for. Larger than a tile so the downscale has something
 * to work with, small enough that its transcoder is not doing real work.
 */
const SOURCE_WIDTH = 320

function cacheKey(videoId: string, plan: FilmstripPlan): string {
  return createHash('sha1')
    .update(
      [
        videoId,
        Math.round(plan.startMs),
        Math.round(plan.endMs),
        plan.tiles,
        TILE_WIDTH,
        TILE_HEIGHT,
      ].join('|'),
    )
    .digest('hex')
}

/** Path to the sprite for one window of one video, building it if needed. */
export async function buildFilmstrip(
  videoId: string,
  plan: FilmstripPlan,
  client: JellyfinClient,
): Promise<string> {
  return cachedArtefact(
    { directory: FILMSTRIP_DIR, key: cacheKey(videoId, plan), extension: 'jpg' },
    (outputPath) =>
      encodeFilmstrip(
        {
          input: client.segmentUrl(
            videoId,
            plan.startMs,
            SOURCE_WIDTH,
            `filmstrip-${randomUUID()}`,
          ),
          durationMs: plan.endMs - plan.startMs,
          tiles: plan.tiles,
          tileWidth: TILE_WIDTH,
          tileHeight: TILE_HEIGHT,
        },
        outputPath,
      ),
  )
}
