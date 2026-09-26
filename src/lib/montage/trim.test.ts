import { describe, expect, it } from 'vitest'
import {
  SNAP_MS,
  edgeLimits,
  moveClip,
  moveEdge,
  nextBoundary,
  snapPoints,
  snapTo,
  trimActions,
  withinReach,
} from './trim'
import { MAX_PAD_MS, MIN_CLIP_MS, trimWindow } from './types'
import type { SceneMatch } from '@/lib/search/search'
import type { Cue } from '@/lib/subtitles/parse'

/**
 * Trimming used to be two steppers that moved an edge by a quarter second. The
 * questions people actually have are "does this include the setup line" and "am
 * I stopping before the reaction", so these rules land edges on the boundaries
 * of the dialogue and refuse to leave a clip that could not be encoded.
 */

const MATCH: SceneMatch = {
  lineId: 7,
  titleId: 'slough-house',
  titleName: 'Slow Horses',
  videoId: 'greendale',
  videoName: 'Modern Warfare',
  season: 1,
  episode: 23,
  startMs: 100_000,
  endMs: 110_000,
  text: 'You are the least dumb person I have ever met',
  score: 0.82,
}

const cue = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text })

const CUES: Cue[] = [
  cue(94_000, 96_500, 'Why? To take the piss out of Ho.'),
  cue(100_200, 103_000, 'Is that what Lamb told you to do?'),
  cue(104_000, 106_500, 'He tells us that all the time.'),
  cue(107_000, 109_800, 'He did not mean it.'),
  cue(112_000, 114_000, 'Yes, he did.'),
]

const WINDOW = trimWindow(MATCH)

describe('edgeLimits', () => {
  it('lets the start reach the padding limit before the matched dialogue', () => {
    expect(edgeLimits('start', MATCH, 100_000, 110_000).lowest).toBe(100_000 - MAX_PAD_MS)
  })

  it('never lets the start pass the end and leave an unencodable clip', () => {
    const limits = edgeLimits('start', MATCH, 100_000, 101_000)
    expect(limits.highest).toBe(101_000 - MIN_CLIP_MS)
  })

  it('never lets the end pass the start', () => {
    const limits = edgeLimits('end', MATCH, 109_000, 110_000)
    expect(limits.lowest).toBe(109_000 + MIN_CLIP_MS)
  })

  /*
   * The reported bug. Each edge used to be capped relative to the matched
   * dialogue as well as to the other edge, which pinned every clip to the region
   * the search happened to land on: the start could not pass the match's end, nor
   * the end precede the match's start. A search result is a place to start
   * looking, so both of these have to be allowed.
   */
  it('lets the start be put after the matched dialogue has finished', () => {
    const limits = edgeLimits('start', MATCH, 100_000, WINDOW.endMs)
    expect(limits.highest).toBe(WINDOW.endMs - MIN_CLIP_MS)
    expect(limits.highest).toBeGreaterThan(MATCH.endMs)
  })

  it('lets the end be put before the matched dialogue begins', () => {
    const limits = edgeLimits('end', MATCH, WINDOW.startMs, 90_000)
    expect(limits.lowest).toBe(WINDOW.startMs + MIN_CLIP_MS)
    expect(limits.lowest).toBeLessThan(MATCH.startMs)
  })

  it('still stops at the edge of the filmstrip, whatever the other edge says', () => {
    expect(edgeLimits('start', MATCH, 100_000, 999_999).highest).toBe(WINDOW.endMs)
    expect(edgeLimits('end', MATCH, -999_999, 110_000).lowest).toBe(WINDOW.startMs)
  })

  it('cannot reach before the beginning of the episode', () => {
    const early = { ...MATCH, startMs: 3_000, endMs: 9_000 }
    expect(edgeLimits('start', early, 3_000, 9_000).lowest).toBe(0)
  })
})

describe('moveEdge', () => {
  const bounds = { startMs: 100_000, endMs: 110_000 }

  it('moves only the edge it was given', () => {
    expect(moveEdge('start', 97_000, bounds, MATCH)).toEqual({
      startMs: 97_000,
      endMs: 110_000,
    })
    expect(moveEdge('end', 113_000, bounds, MATCH)).toEqual({
      startMs: 100_000,
      endMs: 113_000,
    })
  })

  it.each([
    ['dragged far left', 'start' as const, -50_000, 100_000 - MAX_PAD_MS],
    ['dragged far right', 'end' as const, 999_999, 110_000 + MAX_PAD_MS],
  ])('clamps an edge %s to the reachable range', (_case, edge, target, expected) => {
    const moved = moveEdge(edge, target, bounds, MATCH)
    expect(edge === 'start' ? moved.startMs : moved.endMs).toBe(expected)
  })

  it('keeps at least the minimum clip length when the edges are dragged together', () => {
    const tight = { startMs: 109_900, endMs: 110_000 }
    const moved = moveEdge('start', 110_000, tight, MATCH)
    expect(moved.endMs - moved.startMs).toBeGreaterThanOrEqual(MIN_CLIP_MS)
  })

  it('lands on a nearby line boundary when snapping is asked for', () => {
    const points = snapPoints(CUES, MATCH)
    // 96_300 is 200 ms shy of the cue that ends at 96_500.
    expect(moveEdge('start', 96_300, bounds, MATCH, { snapTo: points }).startMs).toBe(96_500)
  })

  it('leaves a deliberate position alone when no boundary is near', () => {
    const points = snapPoints(CUES, MATCH)
    expect(moveEdge('start', 98_000, bounds, MATCH, { snapTo: points }).startMs).toBe(98_000)
  })

  it('rounds to whole milliseconds, because a dragged pixel is not an integer', () => {
    expect(moveEdge('start', 97_000.6, bounds, MATCH).startMs).toBe(97_001)
  })

  it('can walk a clip clear of the dialogue it was found by', () => {
    // Two drags in the order the UI allows: push the end out, then bring the
    // start up behind it. Neither step was possible before.
    const stretched = moveEdge('end', 120_000, bounds, MATCH)
    expect(moveEdge('start', 112_000, stretched, MATCH)).toEqual({
      startMs: 112_000,
      endMs: 120_000,
    })
  })
})

describe('moveClip', () => {
  const bounds = { startMs: 100_000, endMs: 110_000 }

  it('shifts both edges and keeps the length', () => {
    expect(moveClip(4_000, bounds, MATCH)).toEqual({ startMs: 104_000, endMs: 114_000 })
    expect(moveClip(-4_000, bounds, MATCH)).toEqual({ startMs: 96_000, endMs: 106_000 })
  })

  it.each([
    ['past the end of the strip', 999_999, WINDOW.endMs - 10_000, WINDOW.endMs],
    ['past the start of the strip', -999_999, WINDOW.startMs, WINDOW.startMs + 10_000],
  ])('stops the clip %s without shortening it', (_case, shift, startMs, endMs) => {
    expect(moveClip(shift, bounds, MATCH)).toEqual({ startMs, endMs })
  })

  it('rounds the shift, because a dragged pixel is not an integer', () => {
    expect(moveClip(1_000.4, bounds, MATCH)).toEqual({ startMs: 101_000, endMs: 111_000 })
  })

  it('leaves a clip that already fills the strip where it is', () => {
    const full = { startMs: WINDOW.startMs, endMs: WINDOW.endMs }
    expect(moveClip(5_000, full, MATCH)).toEqual(full)
  })
})

describe('snapTo', () => {
  const points = [1_000, 5_000, 9_000]

  it.each([
    ['just inside the tolerance', 5_000 - (SNAP_MS - 1), 5_000],
    ['exactly on a point', 5_000, 5_000],
  ])('snaps a value %s', (_case, value, expected) => {
    expect(snapTo(value, points)).toBe(expected)
  })

  it('leaves a value beyond the tolerance untouched', () => {
    expect(snapTo(5_000 + SNAP_MS + 1, points)).toBe(5_000 + SNAP_MS + 1)
  })

  it('picks the closer of two boundaries', () => {
    expect(snapTo(5_150, [5_000, 5_200])).toBe(5_200)
  })
})

describe('snapPoints', () => {
  it('offers every cue edge plus the matched dialogue, in order and deduplicated', () => {
    const points = snapPoints([cue(100_000, 110_000, 'same edges as the match')], MATCH)
    expect(points).toEqual([100_000, 110_000])
  })
})

describe('nextBoundary', () => {
  const points = snapPoints(CUES, MATCH)

  it('walks forward to the next line edge', () => {
    expect(nextBoundary(points, 100_000, 1)).toBe(100_200)
  })

  it('walks back to the previous line edge', () => {
    expect(nextBoundary(points, 100_000, -1)).toBe(96_500)
  })

  it('does not get stuck on the boundary it is already sitting on', () => {
    expect(nextBoundary(points, 96_500, 1)).toBe(100_000)
  })

  it('reports nothing rather than jumping when there is nowhere further to go', () => {
    expect(nextBoundary(points, 999_999, 1)).toBeNull()
    expect(nextBoundary(points, 0, -1)).toBeNull()
  })
})

describe('withinReach', () => {
  const bounds = { startMs: 100_000, endMs: 110_000 }

  it.each([
    ['the padding limit', 'start' as const, MATCH.startMs - MAX_PAD_MS, true],
    ['one past the padding limit', 'start' as const, MATCH.startMs - MAX_PAD_MS - 1, false],
    ['well inside the matched dialogue', 'end' as const, MATCH.startMs + 5_000, true],
    ['closer to the start than a clip may be', 'end' as const, bounds.startMs, false],
    ['the far end of the strip', 'end' as const, WINDOW.endMs, true],
    ['one past the far end of the strip', 'end' as const, WINDOW.endMs + 1, false],
  ])('reports %s as reachable=%s', (_case, edge, target, expected) => {
    expect(withinReach(edge, target, MATCH, bounds)).toBe(expected)
  })
})

describe('trimActions', () => {
  it('offers the line before and the line after, quoting them', () => {
    const actions = trimActions(CUES, MATCH, 100_000, 110_000)
    const before = actions.find((a) => a.key === 'add-before')
    const after = actions.find((a) => a.key === 'add-after')

    expect(before?.quote).toBe('Why? To take the piss out of Ho.')
    expect(before?.to).toBe(94_000)
    expect(after?.quote).toBe('Yes, he did.')
    expect(after?.to).toBe(114_000)
  })

  it('offers to drop the first and last lines inside the cut', () => {
    const actions = trimActions(CUES, MATCH, 100_000, 110_000)
    expect(actions.find((a) => a.key === 'drop-first')?.to).toBe(103_000)
    expect(actions.find((a) => a.key === 'drop-last')?.to).toBe(107_000)
  })

  it('will not offer to drop the only line in the cut', () => {
    const single = [cue(100_200, 103_000, 'Is that what Lamb told you to do?')]
    const keys = trimActions(single, MATCH, 100_000, 110_000).map((a) => a.key)
    expect(keys).not.toContain('drop-first')
    expect(keys).not.toContain('drop-last')
  })

  it('hides a line that is further away than an edge can reach', () => {
    const distant = [cue(1_000, 2_000, 'Twenty seconds too early to matter')]
    expect(trimActions(distant, MATCH, 100_000, 110_000)).toEqual([])
  })

  it('offers nothing when the subtitles could not be read', () => {
    expect(trimActions([], MATCH, 100_000, 110_000)).toEqual([])
  })

  it('treats a line the cut clips by a hair as one to pull in, not one it has', () => {
    // This line ends 100 ms after the cut starts, so a tenth of it is audible:
    // functionally outside. Without the grace window it would count as the first
    // line inside, and both "add the line before" and "drop the first line"
    // would then name the wrong piece of dialogue.
    const clipped = [cue(98_000, 100_100, 'Barely audible'), ...CUES.slice(1)]
    const actions = trimActions(clipped, MATCH, 100_000, 110_000)

    expect(actions.find((a) => a.key === 'add-before')?.quote).toBe('Barely audible')
    expect(actions.find((a) => a.key === 'drop-first')?.quote).toBe(
      'Is that what Lamb told you to do?',
    )
  })
})
