import { describe, expect, it } from 'vitest'
import {
  TILE_HEIGHT,
  TILE_WIDTH,
  filmstripUrl,
  planFilmstrip,
  positionPercent,
  spanAtPercent,
  spineTiles,
  tileAt,
  tileOffsetPercent,
  timeAtPercent,
} from './filmstrip'
import { MAX_PAD_MS, clipBounds, paddingFor, trimWindow, type MontageClip } from './types'
import type { SceneMatch } from '@/lib/search/search'

/**
 * The trim timeline is a sprite addressed by index. Every number here feeds
 * either an ffmpeg argument or a CSS background offset, and the two have to
 * agree exactly: a strip built with one tile count and read with another shows
 * the user a frame from somewhere else in the episode and says it is the frame
 * they are cutting on.
 */

const match = (startMs: number, endMs: number): SceneMatch => ({
  lineId: 1,
  titleId: 'greendale-community-college',
  titleName: 'Community',
  videoId: 'abed',
  videoName: 'Modern Warfare',
  season: 1,
  episode: 23,
  startMs,
  endMs,
  text: 'You are the least dumb person I have ever met',
  score: 0.8,
})

const clipOf = (
  scene: SceneMatch,
  padding: { padBeforeMs: number; padAfterMs: number },
): MontageClip => ({
  id: 'clip-1',
  description: 'the one about the paintball',
  alternates: [scene],
  alternateIndex: 0,
  caption: { mode: 'none', text: '' },
  muted: false,
  where: null,
  ...padding,
})

describe('planFilmstrip', () => {
  it('samples about twice a second so a boundary thumbnail is close to its edge', () => {
    const plan = planFilmstrip(10_000, 30_000)
    expect(plan.tiles).toBe(40)
    expect(plan.intervalMs).toBe(500)
  })

  it.each([
    ['the widest window the editor can ask for', 0, 15_000 + 14_000 + 15_000],
    ['a hand-written span far beyond it', 0, 10 * 60_000],
  ])('caps tiles below the browser texture limit for %s', (_case, startMs, endMs) => {
    const plan = planFilmstrip(startMs, endMs)
    // A sprite past roughly 16384px silently fails to paint rather than erroring.
    expect(plan.tiles * TILE_WIDTH).toBeLessThan(16_384)
  })

  it('still yields one tile for a span shorter than the sample interval', () => {
    const plan = planFilmstrip(1_000, 1_100)
    expect(plan.tiles).toBe(1)
  })

  it('covers the whole requested span with its tiles', () => {
    const plan = planFilmstrip(4_000, 47_000)
    expect(plan.tiles * plan.intervalMs).toBeCloseTo(43_000, 6)
  })
})

describe('tileOffsetPercent', () => {
  it.each([
    [0, 40, 0],
    [39, 40, 100],
    [10, 41, 25],
  ])('places tile %i of %i at %f%%', (index, tiles, expected) => {
    expect(tileOffsetPercent(index, tiles)).toBeCloseTo(expected, 6)
  })

  it('does not divide by zero on a single-tile strip', () => {
    expect(tileOffsetPercent(0, 1)).toBe(0)
  })
})

describe('tileAt', () => {
  const plan = planFilmstrip(10_000, 30_000)

  it.each([
    ['the first moment', 10_000, 0],
    ['half a second in', 10_500, 1],
    ['the last moment', 29_999, 39],
  ])('finds the tile for %s', (_case, atMs, expected) => {
    expect(tileAt(plan, atMs)).toBe(expected)
  })

  it.each([
    ['before the strip', 0, 0],
    ['after the strip', 999_999, 39],
  ])('clamps a moment %s into the strip', (_case, atMs, expected) => {
    expect(tileAt(plan, atMs)).toBe(expected)
  })
})

describe('spineTiles', () => {
  const plan = planFilmstrip(0, 30_000)

  it('shows the first and last tile, because those read as before and after', () => {
    const tiles = spineTiles(plan, 12)
    expect(tiles[0]).toBe(0)
    expect(tiles[tiles.length - 1]).toBe(plan.tiles - 1)
  })

  it('returns the asked-for count, in order', () => {
    const tiles = spineTiles(plan, 12)
    expect(tiles).toHaveLength(12)
    expect([...tiles].sort((a, b) => a - b)).toEqual(tiles)
  })

  it('never invents a tile the strip does not contain', () => {
    const short = planFilmstrip(0, 1_500)
    expect(spineTiles(short, 12)).toHaveLength(3)
  })
})

describe('positionPercent and timeAtPercent', () => {
  const plan = planFilmstrip(60_000, 100_000)

  it.each([
    ['the start', 60_000, 0],
    ['the midpoint', 80_000, 50],
    ['the end', 100_000, 100],
  ])('puts %s at %f%% along the strip', (_case, atMs, expected) => {
    expect(positionPercent(plan, atMs)).toBeCloseTo(expected, 6)
  })

  it('clamps a moment outside the strip rather than overflowing the track', () => {
    expect(positionPercent(plan, 10_000)).toBe(0)
    expect(positionPercent(plan, 200_000)).toBe(100)
  })

  it('round-trips a dragged position back to the same moment', () => {
    const dragged = 72_345
    expect(timeAtPercent(plan, positionPercent(plan, dragged))).toBeCloseTo(dragged, 6)
  })
})

describe('spanAtPercent', () => {
  const plan = planFilmstrip(60_000, 100_000)

  it.each([
    ['a tenth of the strip', 10, 4_000],
    ['the whole strip', 100, 40_000],
    ['no movement at all', 0, 0],
  ])('converts %s into screen time', (_case, percent, expected) => {
    expect(spanAtPercent(plan, percent)).toBe(expected)
  })

  /*
   * Unlike a position, a drag distance is signed and can exceed the strip: a
   * pointer dragged left of where it started has moved a negative distance, and
   * clamping that to zero would make a clip refuse to slide backwards.
   */
  it('keeps the sign of a leftward drag', () => {
    expect(spanAtPercent(plan, -25)).toBe(-10_000)
  })

  it('does not clamp a drag that runs past the end of the strip', () => {
    expect(spanAtPercent(plan, 150)).toBe(60_000)
  })
})

describe('trimWindow', () => {
  it('reaches the trim limit either side of the matched dialogue', () => {
    const window = trimWindow(match(120_000, 130_000))
    expect(window).toEqual({ startMs: 105_000, endMs: 145_000 })
  })

  it('cannot reach before the start of the episode', () => {
    const window = trimWindow(match(2_000, 9_000))
    expect(window.startMs).toBe(0)
  })
})

describe('paddingFor', () => {
  const scene = match(100_000, 110_000)

  it.each([
    ['extending both ends', 95_000, 115_000, 5_000, 5_000],
    ['tightening both ends', 103_000, 108_000, -3_000, -2_000],
    ['leaving it as matched', 100_000, 110_000, 0, 0],
  ])('converts %s into stored padding', (_case, startMs, endMs, before, after) => {
    expect(paddingFor(scene, startMs, endMs)).toEqual({
      padBeforeMs: before,
      padAfterMs: after,
    })
  })

  it('refuses to store padding beyond the reachable range', () => {
    const padded = paddingFor(scene, 0, 999_999)
    expect(padded).toEqual({ padBeforeMs: MAX_PAD_MS, padAfterMs: MAX_PAD_MS })
  })

  /*
   * A clip is allowed to sit anywhere in the window, including entirely outside
   * the dialogue it was matched from. The padding pair has to be able to say so —
   * clamping each number to a fixed trim limit silently pinned the clip to the
   * matched region no matter what the editor asked for.
   */
  it('stores a clip that begins after the matched dialogue has ended', () => {
    const window = trimWindow(scene)
    const startMs = 112_000
    const endMs = 118_000

    const moved = paddingFor(scene, startMs, endMs)
    expect(moved).toEqual({ padBeforeMs: -12_000, padAfterMs: 8_000 })

    // And it survives the round trip, which is what the export actually reads.
    expect(clipBounds(clipOf(scene, moved))).toEqual({ startMs, endMs })
    expect(startMs).toBeGreaterThan(scene.endMs)
    expect(endMs).toBeLessThan(window.endMs)
  })

  it('clamps in/out points to the window rather than the padding to a limit', () => {
    // Both edges dragged far past each other, which the UI prevents but a stale
    // request could still ask for. Each lands on the far side of the window.
    const window = trimWindow(scene)
    expect(paddingFor(scene, 500_000, 0)).toEqual({
      padBeforeMs: scene.startMs - window.endMs,
      padAfterMs: window.startMs - scene.endMs,
    })
  })
})

describe('filmstripUrl', () => {
  it('names the pixels in the query string so the browser can cache them', () => {
    const plan = planFilmstrip(1_461_393, 1_492_394)
    expect(filmstripUrl('slough-house', plan)).toBe(
      '/api/clip-filmstrip?videoId=slough-house&start=1461393&end=1492394',
    )
  })
})

describe('tile shape', () => {
  it('is 16:9, so a thumbnail can be shown undistorted', () => {
    expect(TILE_WIDTH / TILE_HEIGHT).toBeCloseTo(16 / 9, 6)
  })
})
