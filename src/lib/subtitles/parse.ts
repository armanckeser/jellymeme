export interface Cue {
  startMs: number
  endMs: number
  text: string
}

const TIMECODE =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/

function toMs(h: string, m: string, s: string, frac: string): number {
  // SRT uses milliseconds, but some muxers emit 2-digit centiseconds.
  const ms = frac.length === 2 ? Number(frac) * 10 : Number(frac.padEnd(3, '0'))
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + ms
}

/**
 * Strips the markup that shows up in real-world subtitle files so it does not
 * pollute the embeddings.
 *
 * Covers HTML-ish tags (<i>, <font color=…>), ASS override blocks ({\an8}),
 * the leading hyphens that mark alternating speakers, music notes, and the
 * bracketed/parenthesised sound cues and speaker labels that SDH tracks carry.
 */
export function cleanCueText(raw: string): string {
  let text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    // ALL-CAPS speaker labels: "MICHAEL: what?" — keep the dialogue, drop the name.
    .replace(/^\s*[A-Z][A-Z0-9 .'#-]{1,24}:\s*/gm, '')
    .replace(/[♪♫♪♫]/g, ' ')
    // Leading dashes denoting a new speaker within one cue.
    .replace(/^\s*[-–—]\s*/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // An all-caps cue that survived the label strip is almost always a sound
  // effect or a sign; it carries no dialogue meaning.
  if (text.length > 2 && text === text.toUpperCase() && /[A-Z]{3}/.test(text)) {
    const words = text.split(' ')
    if (words.length <= 4) text = ''
  }
  return text
}

/**
 * Parses SRT or WebVTT. Jellyfin can emit either, and the only structural
 * difference that matters here is the fractional-seconds separator and an
 * optional WEBVTT preamble.
 */
export function parseSubtitles(input: string): Cue[] {
  const body = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const cues: Cue[] = []

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const tcIndex = lines.findIndex((l) => TIMECODE.test(l))
    if (tcIndex === -1) continue

    const m = TIMECODE.exec(lines[tcIndex])
    if (!m) continue

    const startMs = toMs(m[1], m[2], m[3], m[4])
    const endMs = toMs(m[5], m[6], m[7], m[8])
    if (endMs <= startMs) continue

    const text = cleanCueText(lines.slice(tcIndex + 1).join('\n'))
    if (!text) continue

    cues.push({ startMs, endMs, text })
  }

  return cues.sort((a, b) => a.startMs - b.startMs)
}
