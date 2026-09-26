import type { Cue } from '@/lib/subtitles/parse'
import {
  DEFAULT_LOOK,
  clampCaptionSize,
  cueKey,
  type CaptionLook,
  type SubtitleEdits,
} from '@/lib/montage/types'

/**
 * Caption burning uses ASS subtitles rendered by libass rather than ffmpeg's
 * drawtext filter. drawtext cannot wrap text, has no outline control worth the
 * name, and needs brittle escaping for the apostrophes and colons that ordinary
 * dialogue is full of. libass handles wrapping, outlines and positioning, which
 * is exactly the meme-caption look.
 */

export type CaptionStyle = 'meme' | 'subtitle'

export interface AssOptions {
  width: number
  height: number
  style: CaptionStyle
  /** Size and placement. Omitted means the style's own defaults. */
  look?: CaptionLook
  fontName?: string
}

/** ASS colours are &HAABBGGRR — alpha first, then blue/green/red, not RGB. */
const WHITE = '&H00FFFFFF'
const BLACK = '&H00000000'

const DEFAULT_FONT = process.env.JELLYMEME_CAPTION_FONT ?? 'DejaVu Sans'

function timestamp(ms: number): string {
  const clamped = Math.max(0, ms)
  const centis = Math.floor(clamped / 10) % 100
  const seconds = Math.floor(clamped / 1000) % 60
  const minutes = Math.floor(clamped / 60_000) % 60
  const hours = Math.floor(clamped / 3_600_000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`
}

/** Escapes the few characters that are structural in an ASS event line. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
}

export interface AssEvent {
  startMs: number
  endMs: number
  text: string
}

export function buildAss(events: AssEvent[], options: AssOptions): string {
  const { width, height, style, look = DEFAULT_LOOK, fontName = DEFAULT_FONT } = options

  const meme = style === 'meme'
  // Clamped here as well as in the UI: the size also arrives from a query string
  // on the preview endpoint, where anything at all can be typed.
  const size = clampCaptionSize(look.size)

  // Scale type size with the output so captions look the same at 480p and 1080p.
  const fontSize = Math.round(height * (meme ? 0.085 : 0.055) * size)
  // The outline grows with the type, or large text ends up hairlined and thin
  // text on a bright frame ends up unreadable.
  const outline = Math.max(2, Math.round(height * (meme ? 0.006 : 0.004) * size))
  const marginV = Math.round(height * (meme ? 0.04 : 0.035))
  // 2 = bottom-centre, 8 = top-centre. Meme captions sit at the top unless asked.
  const top = look.placement === 'auto' ? meme : look.placement === 'top'
  const alignment = top ? 8 : 2
  const bold = meme ? -1 : 0
  const upper = meme

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${WHITE},${WHITE},${BLACK},${BLACK},${bold},0,0,0,100,100,0,0,1,${outline},0,${alignment},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const lines = events
    .filter((e) => e.text.trim() && e.endMs > e.startMs)
    .map((e) => {
      const text = escapeText(upper ? e.text.toUpperCase() : e.text)
      return `Dialogue: 0,${timestamp(e.startMs)},${timestamp(e.endMs)},Default,,0,0,0,,${text}`
    })

  return [header, ...lines, ''].join('\n')
}

/**
 * The cues with the user's rewrites in place of the words that were said.
 *
 * Timings are untouched, so a changed line still appears exactly when it was
 * spoken and stays in sync with the mouth saying it — the point is to fix a name
 * or land a joke, not to re-time the episode.
 *
 * Applied to the cues before they are windowed, because an edit is keyed by the
 * cue's place in the episode and the windowing is what throws that away.
 */
export function applyLineEdits(cues: Cue[], edits: SubtitleEdits | undefined): Cue[] {
  if (!edits || Object.keys(edits).length === 0) return cues
  return cues.map((cue) => {
    const edit = edits[cueKey(cue)]
    return edit === undefined ? cue : { ...cue, text: edit }
  })
}

/**
 * Converts the source cues overlapping a clip into caption events on the
 * clip's own timeline, which starts at zero after ffmpeg's input seek.
 */
export function cuesToClipEvents(cues: Cue[], clipStartMs: number, clipEndMs: number): AssEvent[] {
  return cues
    .filter((cue) => cue.endMs > clipStartMs && cue.startMs < clipEndMs)
    .map((cue) => ({
      startMs: Math.max(0, cue.startMs - clipStartMs),
      endMs: Math.min(clipEndMs - clipStartMs, cue.endMs - clipStartMs),
      text: cue.text,
    }))
}
