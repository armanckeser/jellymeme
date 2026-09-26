import { describe, it, expect } from 'vitest'
import { parseSubtitles, cleanCueText } from './parse'
import { buildWindows } from './window'

const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>Previously on the show...</i>

2
00:00:04,000 --> 00:00:06,000
- Hello there.
- General Kenobi.

3
00:00:06,200 --> 00:00:08,000
[DOOR SLAMS]

4
00:00:08,100 --> 00:00:10,000
MICHAEL: I declare bankruptcy!

5
00:01:30,000 --> 00:01:32,000
That is not how it works.
`

describe('parseSubtitles', () => {
  it('parses cues with timings in milliseconds', () => {
    const cues = parseSubtitles(SRT)
    expect(cues[0]).toEqual({
      startMs: 1000,
      endMs: 3500,
      text: 'Previously on the show...',
    })
  })

  it('joins multi-speaker cues and strips leading dashes', () => {
    const cues = parseSubtitles(SRT)
    expect(cues[1].text).toBe('Hello there. General Kenobi.')
  })

  it('drops cues that are pure sound effects', () => {
    const texts = parseSubtitles(SRT).map((c) => c.text)
    expect(texts).not.toContain('DOOR SLAMS')
  })

  it('strips speaker labels but keeps the dialogue', () => {
    const cues = parseSubtitles(SRT)
    expect(cues.some((c) => c.text === 'I declare bankruptcy!')).toBe(true)
  })

  it('handles CRLF line endings and a byte order mark', () => {
    const cues = parseSubtitles('﻿' + SRT.replace(/\n/g, '\r\n'))
    expect(cues).toHaveLength(4)
  })

  it('parses WebVTT with dot separators', () => {
    const vtt = `WEBVTT

00:00:02.000 --> 00:00:04.000
Some dialogue here
`
    expect(parseSubtitles(vtt)).toEqual([{ startMs: 2000, endMs: 4000, text: 'Some dialogue here' }])
  })

  it('ignores malformed blocks instead of throwing', () => {
    expect(parseSubtitles('not a subtitle file at all')).toEqual([])
    expect(parseSubtitles('1\n00:00:05,000 --> 00:00:01,000\nbackwards')).toEqual([])
  })

  it('sorts cues by start time', () => {
    const jumbled = `1
00:00:10,000 --> 00:00:11,000
second

2
00:00:01,000 --> 00:00:02,000
first
`
    expect(parseSubtitles(jumbled).map((c) => c.text)).toEqual(['first', 'second'])
  })
})

describe('cleanCueText', () => {
  it('removes ASS override blocks and font tags', () => {
    expect(cleanCueText('{\\an8}<font color="#fff">Up here</font>')).toBe('Up here')
  })

  it('removes music notes', () => {
    expect(cleanCueText('♪ singing a song ♪')).toBe('singing a song')
  })

  it('keeps longer all-caps lines that are probably dialogue', () => {
    expect(cleanCueText('WHY WOULD YOU EVER DO SOMETHING LIKE THAT')).toBe(
      'WHY WOULD YOU EVER DO SOMETHING LIKE THAT',
    )
  })
})

describe('buildWindows', () => {
  const cues = Array.from({ length: 10 }, (_, i) => ({
    startMs: i * 2000,
    endMs: i * 2000 + 1500,
    text: `line ${i}`,
  }))

  it('produces overlapping windows spanning multiple cues', () => {
    const windows = buildWindows(cues, { stride: 2, maxCues: 4, maxDurationMs: 20_000 })
    expect(windows[0].text).toBe('line 0 line 1 line 2 line 3')
    expect(windows[1].text).toBe('line 2 line 3 line 4 line 5')
    expect(windows[0].startMs).toBe(0)
  })

  it('never merges across a long silence', () => {
    const withGap = [
      { startMs: 0, endMs: 1000, text: 'before' },
      { startMs: 60_000, endMs: 61_000, text: 'after' },
    ]
    const windows = buildWindows(withGap, { maxGapMs: 3000 })
    expect(windows[0].text).toBe('before')
    expect(windows[0].endMs).toBe(1000)
  })

  it('caps window duration', () => {
    const windows = buildWindows(cues, { maxDurationMs: 5000, maxCues: 10, stride: 1 })
    for (const w of windows) expect(w.endMs - w.startMs).toBeLessThanOrEqual(5000)
  })

  it('covers every cue', () => {
    const windows = buildWindows(cues, { stride: 3, maxCues: 4 })
    expect(windows[windows.length - 1].lastCue).toBe(cues.length - 1)
  })

  it('covers cues that follow a silence, even when the stride would skip them', () => {
    // A window ending early at a gap must not let the stride jump over the
    // dialogue that starts the next scene.
    const withGaps = [
      { startMs: 0, endMs: 1000, text: 'a' },
      { startMs: 1500, endMs: 2500, text: 'b' },
      { startMs: 3000, endMs: 4000, text: 'c' },
      { startMs: 60_000, endMs: 61_000, text: 'scene two opens here' },
      { startMs: 61_500, endMs: 62_500, text: 'e' },
    ]
    const windows = buildWindows(withGaps, { stride: 2, maxCues: 3, maxGapMs: 3000 })
    const covered = new Set<number>()
    for (const w of windows) {
      for (let i = w.firstCue; i <= w.lastCue; i++) covered.add(i)
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    expect(windows.some((w) => w.text.includes('scene two opens here'))).toBe(true)
  })

  it('always makes progress rather than looping', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      startMs: i * 60_000,
      endMs: i * 60_000 + 1000,
      text: `isolated ${i}`,
    }))
    // Every cue is separated by a long silence, so every window holds one cue.
    const windows = buildWindows(many, { stride: 4, maxGapMs: 3000 })
    expect(windows).toHaveLength(50)
  })

  it('handles an empty input', () => {
    expect(buildWindows([])).toEqual([])
  })
})
