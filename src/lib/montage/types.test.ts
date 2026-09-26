import { describe, it, expect } from 'vitest'
import {
  alternatesForTitle,
  clampCaptionSize,
  clipBounds,
  clipDurationMs,
  cueKey,
  DEFAULT_LOOK,
  insertClip,
  isStillFormat,
  MAX_CAPTION_SIZE,
  MIN_CAPTION_SIZE,
  MIN_CLIP_MS,
  newClip,
  resolveCaption,
} from './types'
import type { Caption, ClipCaptionMode, MontageClip } from './types'
import type { SceneMatch } from '@/lib/search/search'

const match: SceneMatch = {
  lineId: 1,
  titleId: 't1',
  titleName: 'Community',
  videoId: 'v1',
  videoName: 'Episode',
  season: 1,
  episode: 1,
  startMs: 30_000,
  endMs: 36_000,
  text: 'some dialogue',
  score: 0.8,
}

const clip = (padBeforeMs: number, padAfterMs: number): MontageClip => ({
  id: 'c1',
  description: 'a scene',
  alternates: [match],
  alternateIndex: 0,
  padBeforeMs,
  padAfterMs,
  caption: { mode: 'none', text: '' },
  muted: false,
  where: null,
})

/*
 * Guards the one-show invariant against a library-wide search.
 *
 * `montage.title_id` is NOT NULL, so a cut belongs to exactly one show. A search
 * across every title returns candidates from several, and those candidates become
 * a clip's alternates — so without this, "Not this one" would swap in footage from
 * a different series while the cut still claimed the original title, and the
 * export would read a video the montage has no relationship to.
 */
describe('alternatesForTitle', () => {
  const scene = (titleId: string, lineId: number): SceneMatch => ({
    ...match,
    titleId,
    titleName: titleId === 't1' ? 'Community' : 'Slow Horses',
    lineId,
  })

  const mixed = [scene('t1', 1), scene('t2', 2), scene('t1', 3), scene('t2', 4)]

  it('keeps only the candidates from the chosen scene’s own show', () => {
    const scoped = alternatesForTitle(mixed, [1])

    expect(scoped?.titleId).toBe('t2')
    expect(scoped?.alternates.map((m) => m.lineId)).toEqual([2, 4])
  })

  it('still points at the scene that was chosen after the others are dropped', () => {
    const scoped = alternatesForTitle(mixed, [3])

    // Index 3 of the mixed list is index 1 of what survives.
    expect(scoped?.alternateIndexes).toEqual([1])
    expect(scoped?.alternates[scoped.alternateIndexes[0]].lineId).toBe(4)
  })

  it('leaves a single-show result list untouched', () => {
    const single = [scene('t1', 1), scene('t1', 2)]
    const scoped = alternatesForTitle(single, [0])

    expect(scoped?.alternates).toEqual(single)
    expect(scoped?.alternateIndexes).toEqual([0])
  })

  it.each([
    ['an index past the end', [scene('t1', 1)], [5]],
    ['an empty result list', [], [0]],
    ['a negative index', [scene('t1', 1)], [-1]],
    ['nothing chosen at all', [scene('t1', 1)], []],
  ])('reports nothing to build for %s', (_case, matches, indexes) => {
    expect(alternatesForTitle(matches, indexes)).toBeNull()
  })

  /*
   * Several ticked results become several clips of one cut, which is the whole
   * point of ticking rather than taking one — a line a show keeps returning to is
   * a montage on its own.
   */
  it('points at every chosen scene, in the order they were given', () => {
    const show = [scene('t1', 1), scene('t1', 2), scene('t1', 3)]

    expect(alternatesForTitle(show, [0, 2])?.alternateIndexes).toEqual([0, 2])
  })

  /*
   * The results screen stops you ticking across shows, so this is the stale-list
   * case. Dropping the strays is what keeps the cut's footage and its title_id
   * describing the same show; retitling it around a later pick would not.
   */
  it('takes its show from the first pick and drops picks from any other', () => {
    const scoped = alternatesForTitle(mixed, [0, 1, 2])

    expect(scoped?.titleId).toBe('t1')
    // Indexes 0 and 2 of the mixed list are 0 and 1 of what survives; the t2
    // pick in between is gone rather than shifting the others.
    expect(scoped?.alternateIndexes).toEqual([0, 1])
    expect(scoped?.alternateIndexes.map((i) => scoped.alternates[i].lineId)).toEqual([1, 3])
  })

  it('makes a clip each for two picks of the same scene', () => {
    // Nothing stops the same moment being cut in twice, and the count of clips
    // must match the count of picks or the cut is not what was asked for.
    expect(alternatesForTitle([scene('t1', 1)], [0, 0])?.alternateIndexes).toEqual([0, 0])
  })
})

/*
 * One place decides which caption a clip gets, because the preview and the
 * encoder both ask this question and an answer that differed between them would
 * mean the preview stopped being what you are about to export.
 */
describe('resolveCaption', () => {
  const captioned = (mode: ClipCaptionMode, text = ''): MontageClip => ({
    ...clip(0, 0),
    caption: { mode, text },
  })

  it.each([
    ['no caption', { mode: 'none', text: '' } as Caption],
    ['real subtitles', { mode: 'subtitle', text: '' } as Caption],
    ['the cut’s own words', { mode: 'custom', text: 'six seasons and a movie' } as Caption],
  ])('gives an inheriting clip %s from the cut', (_case, cutCaption) => {
    const resolved = resolveCaption(captioned('inherit'), cutCaption)
    expect(resolved.mode).toBe(cutCaption.mode)
    expect(resolved.text).toBe(cutCaption.text)
  })

  /*
   * The wrinkle this design has to live with: every clip written before captions
   * had a cut-level setting holds an explicit 'none', which is indistinguishable
   * from someone deliberately choosing it. So it must not silently follow a new
   * default — the editor offers to convert them instead.
   */
  it('leaves a clip that was set to no caption alone, even when the cut says otherwise', () => {
    const cutCaption: Caption = { mode: 'subtitle', text: '' }
    const resolved = resolveCaption(captioned('none'), cutCaption)
    expect(resolved.mode).toBe('none')
    expect(resolved.text).toBe('')
  })

  it('keeps a clip’s own words rather than the cut’s', () => {
    const resolved = resolveCaption(captioned('custom', 'streets ahead'), {
      mode: 'custom',
      text: 'six seasons and a movie',
    })
    expect(resolved.mode).toBe('custom')
    expect(resolved.text).toBe('streets ahead')
  })

  it('does not leak an overriding clip’s leftover text into another mode', () => {
    // A clip switched from custom back to subtitles keeps its typed text so the
    // choice is reversible, but the caption that gets rendered must not carry it.
    const resolved = resolveCaption(captioned('subtitle', 'left over from earlier'), {
      mode: 'none',
      text: '',
    })
    expect(resolved.mode).toBe('subtitle')
  })

  /*
   * The look settles on its own, because "make this one bigger" and "make this
   * one say something else" are different requests and answering the first must
   * not silently answer the second.
   */
  it('takes the cut’s look when the clip has none', () => {
    const resolved = resolveCaption(captioned('inherit'), {
      mode: 'subtitle',
      text: '',
      look: { size: 1.5, placement: 'top' },
    })
    expect(resolved.look).toEqual({ size: 1.5, placement: 'top' })
  })

  it('lets a clip be sized on its own while still following the cut’s words', () => {
    const clip: MontageClip = {
      ...captioned('inherit'),
      caption: { mode: 'inherit', text: '', look: { size: 2, placement: 'bottom' } },
    }
    const resolved = resolveCaption(clip, {
      mode: 'custom',
      text: 'six seasons and a movie',
      look: { size: 1, placement: 'auto' },
    })
    expect(resolved.text).toBe('six seasons and a movie')
    expect(resolved.look).toEqual({ size: 2, placement: 'bottom' })
  })

  it('falls back to the default look for a cut saved before there was one', () => {
    expect(resolveCaption(captioned('inherit'), { mode: 'subtitle', text: '' }).look).toEqual(
      DEFAULT_LOOK,
    )
  })

  /*
   * Line edits belong to the clip whatever its mode is doing, and a clip that
   * has never been edited must resolve to an empty set rather than to undefined —
   * the renderer indexes it directly.
   */
  it('carries the clip’s own line edits, and never the cut’s anything', () => {
    const clip: MontageClip = {
      ...captioned('inherit'),
      caption: { mode: 'inherit', text: '', lines: { '12000': 'streets ahead' } },
    }
    expect(resolveCaption(clip, { mode: 'subtitle', text: '' }).lines).toEqual({
      '12000': 'streets ahead',
    })
    expect(resolveCaption(captioned('subtitle'), { mode: 'subtitle', text: '' }).lines).toEqual({})
  })
})

describe('clampCaptionSize', () => {
  it('keeps a size inside what the frame can hold', () => {
    expect(clampCaptionSize(1.4)).toBe(1.4)
    expect(clampCaptionSize(99)).toBe(MAX_CAPTION_SIZE)
    expect(clampCaptionSize(0)).toBe(MIN_CAPTION_SIZE)
  })

  /* The size also arrives from a query string, where anything can be typed. */
  it('reads a size that is not a number as the default', () => {
    expect(clampCaptionSize(Number('bigger'))).toBe(1)
  })
})

describe('cueKey', () => {
  /*
   * Keyed by start time in the episode, so an edit stays on the line it was made
   * on when the clip around it is trimmed or extended.
   */
  it('names a cue by where it is in the episode', () => {
    expect(cueKey({ startMs: 12_345 })).toBe('12345')
    expect(cueKey({ startMs: 12_345.4 })).toBe(cueKey({ startMs: 12_345 }))
  })
})

describe('clipBounds', () => {
  it('returns the matched window when nothing is adjusted', () => {
    expect(clipBounds(clip(0, 0))).toEqual({ startMs: 30_000, endMs: 36_000 })
  })

  it('extends outward for positive padding', () => {
    expect(clipBounds(clip(2000, 3000))).toEqual({ startMs: 28_000, endMs: 39_000 })
  })

  it('trims inward for negative padding', () => {
    // Start 1.5s later and end 2s earlier than the matched dialogue.
    expect(clipBounds(clip(-1500, -2000))).toEqual({ startMs: 31_500, endMs: 34_000 })
  })

  it('mixes a trimmed start with an extended end', () => {
    expect(clipBounds(clip(-1000, 4000))).toEqual({ startMs: 31_000, endMs: 40_000 })
  })

  it('never lets the clip start before zero', () => {
    const early: MontageClip = {
      ...clip(60_000, 0),
      alternates: [{ ...match, startMs: 1000, endMs: 4000 }],
    }
    expect(clipBounds(early)?.startMs).toBe(0)
  })

  it('enforces a minimum duration when both ends are trimmed past each other', () => {
    // The window is 6s; trimming 5s off each end would invert it.
    const bounds = clipBounds(clip(-5000, -5000))!
    expect(bounds.endMs - bounds.startMs).toBe(MIN_CLIP_MS)
    expect(bounds.endMs).toBeGreaterThan(bounds.startMs)
  })

  it('reports duration consistently with the bounds', () => {
    expect(clipDurationMs(clip(1000, 1000))).toBe(8000)
    expect(clipDurationMs(clip(-1000, -1000))).toBe(4000)
  })

  it('returns null when the clip has no match', () => {
    expect(clipBounds({ ...clip(0, 0), alternates: [] })).toBeNull()
    expect(clipDurationMs({ ...clip(0, 0), alternates: [] })).toBe(0)
  })
})

describe('newClip', () => {
  it('starts a clip with breathing room, following the cut, and audible', () => {
    const created = newClip({ description: 'the diner scene', alternates: [match] })

    // Literal seconds rather than the constants they come from: asserting a
    // default against its own definition passes whatever the default becomes.
    expect(created.padBeforeMs).toBe(1000)
    expect(created.padAfterMs).toBe(1000)
    // 'inherit', not 'none': one decision about captions for the whole cut. A clip
    // born with an explicit 'none' is indistinguishable from one deliberately set
    // to it, and so would never follow the cut again.
    expect(created.caption).toEqual({ mode: 'inherit', text: '' })
    expect(created.muted).toBe(false)
    expect(created.alternateIndex).toBe(0)
  })

  it('holds no location when the description named none', () => {
    expect(newClip({ description: 'the diner scene', alternates: [match] }).where).toBeNull()
  })

  it('carries the location the description named', () => {
    const where = { videoIds: ['v1'], label: 'Japan (S5E3)' }
    expect(newClip({ description: 'in Japan', alternates: [match], where }).where).toEqual(where)
  })

  it('starts on the alternate that was chosen rather than the best-scoring one', () => {
    const created = newClip({
      description: 'the diner scene',
      alternates: [match, match],
      alternateIndex: 1,
    })
    expect(created.alternateIndex).toBe(1)
  })

  /*
   * Guards a mass edit. The editor finds a clip by `c.id === next.id` and removes
   * one by `c.id !== clip.id`, so two clips sharing an id would be edited or
   * deleted together — and inserting several clips in a row is exactly how you get
   * two created inside the same millisecond.
   */
  it('gives every clip its own id, including ones made in the same instant', () => {
    const ids = [0, 1, 2].map(() => newClip({ description: 'x', alternates: [] }).id)
    expect(new Set(ids).size).toBe(3)
  })
})

/*
 * Guards the off-by-one in the editor's insert points, which render one per gap
 * including the gap after the last card. `at` counts the clips that come before
 * the new one, so the count of insert points is one more than the count of clips.
 */
describe('insertClip', () => {
  const named = (id: string): MontageClip => ({ ...clip(0, 0), id })
  const cut = [named('a'), named('b'), named('c')]
  const added = named('new')

  it.each([
    ['first at zero', 0, ['new', 'a', 'b', 'c']],
    ['between two clips', 1, ['a', 'new', 'b', 'c']],
    ['before the last clip', 2, ['a', 'b', 'new', 'c']],
    ['last at the clip count', 3, ['a', 'b', 'c', 'new']],
  ])('puts the clip %s', (_case, at, expected) => {
    expect(insertClip(cut, at, added).map((c) => c.id)).toEqual(expected)
  })

  /* The editor holds its clips in React state, so an in-place splice would change
   * the cut without anything re-rendering. */
  it('leaves the array it was given alone', () => {
    insertClip(cut, 1, added)
    expect(cut.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('makes the only clip of an empty cut', () => {
    expect(insertClip([], 0, added).map((c) => c.id)).toEqual(['new'])
  })
})

describe('isStillFormat', () => {
  it('identifies the single-frame formats', () => {
    expect(isStillFormat('png')).toBe(true)
    expect(isStillFormat('jpg')).toBe(true)
    expect(isStillFormat('gif')).toBe(false)
    expect(isStillFormat('mp4')).toBe(false)
    expect(isStillFormat('webm')).toBe(false)
  })
})
