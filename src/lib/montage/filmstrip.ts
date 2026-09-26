/**
 * Geometry of a clip's filmstrip.
 *
 * One module, three consumers: ffmpeg builds the sprite from it, the API route
 * validates against it, and the editor does its CSS maths with it. Splitting
 * that across a server file and a component is how a filmstrip ends up
 * half a tile out of alignment with the timeline drawn beside it.
 *
 * No Node imports here on purpose — the browser needs this too.
 */

/** Tile pixel size. 16:9, so tiles can be shown undistorted at any scale. */
export const TILE_WIDTH = 128
export const TILE_HEIGHT = 72

/**
 * Roughly how much screen time one tile should cover.
 *
 * Half a second is fine enough to answer "what is just outside the cut" — the
 * question the boundary thumbnails exist for — without making the sprite
 * enormous.
 */
const TARGET_INTERVAL_MS = 500

/**
 * A sprite wider than this risks exceeding the browser's maximum texture size,
 * at which point it silently fails to paint rather than erroring.
 */
const MAX_TILES = 96

export interface FilmstripPlan {
  startMs: number
  endMs: number
  /** Number of tiles in the sprite, left to right. */
  tiles: number
  /** Screen time each tile covers. */
  intervalMs: number
}

/**
 * Decides the sprite layout for a window of an episode.
 *
 * Tile count is derived from the window so a sprite is completely described by
 * `start` and `end` — the URL then names the pixels exactly, which is what lets
 * the browser and the disk cache both hold on to it.
 */
export function planFilmstrip(startMs: number, endMs: number): FilmstripPlan {
  const durationMs = Math.max(TARGET_INTERVAL_MS, endMs - startMs)
  const tiles = Math.max(1, Math.min(MAX_TILES, Math.round(durationMs / TARGET_INTERVAL_MS)))
  return { startMs, endMs, tiles, intervalMs: durationMs / tiles }
}

/** The tile showing a given moment, clamped to the strip. */
export function tileAt(plan: FilmstripPlan, atMs: number): number {
  const offset = (atMs - plan.startMs) / plan.intervalMs
  return Math.max(0, Math.min(plan.tiles - 1, Math.floor(offset)))
}

/**
 * `background-position-x` for one tile of a sprite scaled to `tiles * 100%`.
 *
 * Percentage background positions align the same fraction of the image with
 * that fraction of the box, which for an N-cell sprite scaled to N box widths
 * works out to this. Pixel maths would need the box measured first.
 */
export function tileOffsetPercent(index: number, tiles: number): number {
  if (tiles <= 1) return 0
  return (index / (tiles - 1)) * 100
}

/**
 * Evenly spaced tiles to draw along a timeline.
 *
 * The sprite is sampled far more finely than a timeline a few hundred pixels
 * wide can show, so the spine takes a subset. Always includes the first and
 * last tile: the ends of the strip are the parts a user reads as "before" and
 * "after".
 */
export function spineTiles(plan: FilmstripPlan, count: number): number[] {
  const wanted = Math.max(1, Math.min(plan.tiles, count))
  if (wanted === 1) return [0]
  return Array.from({ length: wanted }, (_, i) =>
    Math.round((i / (wanted - 1)) * (plan.tiles - 1)),
  )
}

/** Where a moment sits along the strip, as a percentage of its width. */
export function positionPercent(plan: FilmstripPlan, atMs: number): number {
  const span = plan.endMs - plan.startMs
  if (span <= 0) return 0
  return Math.max(0, Math.min(100, ((atMs - plan.startMs) / span) * 100))
}

/**
 * How much screen time a fraction of the strip's width covers.
 *
 * Signed and unclamped, because this is what a drag distance means: a pointer
 * that has moved left has moved a negative number of milliseconds.
 */
export function spanAtPercent(plan: FilmstripPlan, percent: number): number {
  return ((plan.endMs - plan.startMs) * percent) / 100
}

/** The moment a percentage along the strip corresponds to. */
export function timeAtPercent(plan: FilmstripPlan, percent: number): number {
  return plan.startMs + spanAtPercent(plan, Math.max(0, Math.min(100, percent)))
}

export function filmstripUrl(videoId: string, plan: FilmstripPlan): string {
  const params = new URLSearchParams({
    videoId,
    start: String(Math.round(plan.startMs)),
    end: String(Math.round(plan.endMs)),
  })
  return `/api/clip-filmstrip?${params.toString()}`
}
