import { describe, it, expect } from 'vitest'
import { applyLineEdits, buildAss, cuesToClipEvents } from './ass'
import { DEFAULT_LOOK } from '@/lib/montage/types'
import type { Cue } from '@/lib/subtitles/parse'

const canvas = { width: 720, height: 405 }

/** The one Style line, which is where every look decision lands. */
const styleLine = (ass: string): string =>
  ass.split('\n').find((line) => line.startsWith('Style: Default,'))!

/** Style fields, in the order the Format line declares them. */
const styleField = (ass: string, index: number): string =>
  styleLine(ass).replace('Style: Default,', '').split(',')[index]

const FONT_SIZE = 1
const OUTLINE = 15
const ALIGNMENT = 17

const events = [{ startMs: 0, endMs: 2_000, text: 'streets ahead' }]

describe('buildAss', () => {
  it('scales the type with the frame so a caption reads the same at any size', () => {
    const small = buildAss(events, { width: 480, height: 270, style: 'meme' })
    const large = buildAss(events, { width: 1920, height: 1080, style: 'meme' })
    expect(Number(styleField(large, FONT_SIZE))).toBeCloseTo(
      Number(styleField(small, FONT_SIZE)) * 4,
      0,
    )
  })

  it('makes the text bigger when asked, and thickens the outline with it', () => {
    const normal = buildAss(events, { ...canvas, style: 'meme' })
    const big = buildAss(events, { ...canvas, style: 'meme', look: { size: 2, placement: 'auto' } })

    // Within a point of double: sizes are rounded to whole points, so doubling
    // one that was not whole to begin with lands a little either side.
    expect(Number(styleField(big, FONT_SIZE))).toBeCloseTo(
      Number(styleField(normal, FONT_SIZE)) * 2,
      -0.5,
    )
    expect(Number(styleField(big, OUTLINE))).toBeGreaterThan(Number(styleField(normal, OUTLINE)))
  })

  /* A size arrives from a query string on the preview endpoint, unchecked. */
  it('refuses a size that would not fit the frame', () => {
    const absurd = buildAss(events, {
      ...canvas,
      style: 'meme',
      look: { size: 40, placement: 'auto' },
    })
    expect(Number(styleField(absurd, FONT_SIZE))).toBeLessThan(canvas.height)
  })

  /*
   * 8 is top-centre and 2 is bottom-centre. 'auto' has to keep each style where
   * it has always been, or every cut made before placement was a choice
   * re-renders somewhere else.
   */
  it.each([
    ['meme', 'auto', '8'],
    ['subtitle', 'auto', '2'],
    ['meme', 'bottom', '2'],
    ['subtitle', 'top', '8'],
  ] as const)('puts %s text asked for %s at alignment %s', (style, placement, alignment) => {
    const ass = buildAss(events, { ...canvas, style, look: { ...DEFAULT_LOOK, placement } })
    expect(styleField(ass, ALIGNMENT)).toBe(alignment)
  })

  it('drops an event with nothing in it rather than drawing an empty box', () => {
    const ass = buildAss(
      [
        { startMs: 0, endMs: 1_000, text: '' },
        { startMs: 1_000, endMs: 2_000, text: 'still here' },
      ],
      { ...canvas, style: 'subtitle' },
    )
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1)
    expect(ass).toContain('still here')
  })
})

describe('applyLineEdits', () => {
  const cues: Cue[] = [
    { startMs: 10_000, endMs: 12_000, text: 'I am the one who knocks' },
    { startMs: 12_000, endMs: 14_000, text: 'and then I leave' },
  ]

  it('swaps the words of one line and leaves the rest of them alone', () => {
    const edited = applyLineEdits(cues, { '10000': 'I am the one who rings the bell' })
    expect(edited[0].text).toBe('I am the one who rings the bell')
    expect(edited[1]).toEqual(cues[1])
  })

  /* The whole point: a rewritten line still lands where it was spoken. */
  it('never moves a line it rewrites', () => {
    const edited = applyLineEdits(cues, { '10000': 'something else entirely' })
    expect(edited[0].startMs).toBe(cues[0].startMs)
    expect(edited[0].endMs).toBe(cues[0].endMs)
  })

  it('empties a line that was edited to nothing, so the burner drops it', () => {
    const edited = applyLineEdits(cues, { '12000': '' })
    expect(edited[1].text).toBe('')
    expect(buildAss(cuesToClipEvents(edited, 10_000, 14_000), { ...canvas, style: 'subtitle' }))
      .not.toContain('and then I leave')
  })

  it('leaves an edit for a cue that is no longer there without effect', () => {
    expect(applyLineEdits(cues, { '99999': 'from another trim' })).toEqual(cues)
  })

  it('returns the cues untouched when nothing was edited', () => {
    expect(applyLineEdits(cues, {})).toBe(cues)
    expect(applyLineEdits(cues, undefined)).toBe(cues)
  })
})
