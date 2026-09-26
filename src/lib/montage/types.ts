import type { SceneMatch } from '@/lib/search/search'
import type { Where } from './hints'

export type CaptionMode = 'none' | 'subtitle' | 'custom'

/**
 * Where a caption sits in the frame.
 *
 * 'auto' keeps each mode's own habit — meme text at the top, real subtitles at
 * the bottom — which is what every caption did before this was a choice, so an
 * existing cut re-renders exactly as it did.
 */
export type CaptionPlacement = 'auto' | 'top' | 'bottom'

/**
 * How a caption looks, as opposed to what it says.
 *
 * `size` is a multiplier, not a point size. The renderer picks type size from
 * the frame height so captions read the same at 480p and at 1080p; a point size
 * here would undo that and make "bigger" mean "bigger only at this export
 * width".
 */
export interface CaptionLook {
  size: number
  placement: CaptionPlacement
}

/** What a caption looks like when nobody has said otherwise. */
export const DEFAULT_LOOK: CaptionLook = { size: 1, placement: 'auto' }

/** Outside this the text either cannot be read or cannot fit the frame. */
export const MIN_CAPTION_SIZE = 0.5
export const MAX_CAPTION_SIZE = 3

export const clampCaptionSize = (size: number): number =>
  Number.isFinite(size) ? Math.min(MAX_CAPTION_SIZE, Math.max(MIN_CAPTION_SIZE, size)) : 1

/**
 * Replacement text for individual subtitle cues, keyed by `cueKey`.
 *
 * This is what makes "real subtitles" editable rather than take-it-or-leave-it:
 * keep the timings the show shipped, change the words on one line of one clip.
 * An entry whose text is empty leaves that cue with nothing to draw, which is
 * how a line is removed rather than rewritten.
 *
 * Lives on a clip and never on a cut. A cut spans several episodes, so it has no
 * shared set of lines that an edit could mean.
 */
export type SubtitleEdits = Record<string, string>

/**
 * Identity of a cue within its episode.
 *
 * Its start time, because that is the one thing about a cue that does not move
 * when the clip around it does. Keyed by position within the clip instead, every
 * edit would slide onto a different line the moment an edge was dragged out far
 * enough to pick up one more.
 */
export const cueKey = (cue: { startMs: number }): string => String(Math.round(cue.startMs))

export interface Caption {
  mode: CaptionMode
  /** Used when mode is 'custom'. */
  text: string
  /**
   * Absent on cuts saved before captions had a look, which read as DEFAULT_LOOK.
   * Optional rather than backfilled so old rows need no migration.
   */
  look?: CaptionLook
}

/**
 * What a single clip may hold, which is one more thing than a cut can.
 *
 * 'inherit' means "whatever the cut says", and it is the state new clips are born
 * in — a twenty-clip montage should take one decision about captions, not twenty.
 * Modelled as a fourth mode rather than a separate "overridden" flag so a clip
 * states what it is instead of leaving it to be worked out from two fields.
 */
export type ClipCaptionMode = CaptionMode | 'inherit'

export interface ClipCaption {
  mode: ClipCaptionMode
  text: string
  /**
   * This clip's own look, or absent to follow the cut's.
   *
   * Deliberately independent of `mode`: making one clip's caption larger should
   * not also break it out of "follow the cut" and freeze the words it shows at
   * whatever the cut happened to say at the time.
   */
  look?: CaptionLook
  /**
   * Rewrites of the real subtitle lines inside this clip.
   *
   * Never inherited — these are lines from one episode at one moment, and the
   * clip next to it has different ones. They survive a mode change so switching
   * to your own words and back does not throw the rewrites away.
   */
  lines?: SubtitleEdits
}

/** What a cut starts with, and what an inheriting clip gets when nothing is set. */
export const DEFAULT_CAPTION: Caption = { mode: 'none', text: '' }

export interface MontageClip {
  id: string
  /** The pasted description this clip came from. Kept so the user can re-search it. */
  description: string
  /** Candidate matches, best first. `alternateIndex` selects the active one. */
  alternates: SceneMatch[]
  alternateIndex: number
  /** Seconds of extra footage before/after the matched dialogue window. */
  padBeforeMs: number
  padAfterMs: number
  caption: ClipCaption
  muted: boolean
  /**
   * The episode the description named, if it named one.
   *
   * Kept so the editor can say what it understood, and say so when the match it
   * ended up with is not from there. Clips written before this existed read as
   * null, which is also what a description with no location in it gives.
   */
  where: Where | null
}

/** Default breathing room around the matched dialogue, so clips do not start mid-word. */
export const DEFAULT_PAD_BEFORE_MS = 1_000
export const DEFAULT_PAD_AFTER_MS = 1_000

/**
 * A clip id, which only has to be unique within one cut.
 *
 * Deliberately not `crypto.randomUUID()`. Clips are now created in the browser as
 * well as on the server, and that API is undefined outside a secure context —
 * which this app is not when it is served over plain HTTP on the LAN, beside
 * Jellyfin. An id here is a React key and a lookup handle, nothing more.
 */
let clipsCreated = 0
function clipId(): string {
  clipsCreated += 1
  return `clip-${Date.now().toString(36)}-${clipsCreated.toString(36)}`
}

/**
 * Builds a clip with the defaults every clip starts life with.
 *
 * One definition for three callers: a pasted montage, a single chosen scene, and
 * the editor inserting one by hand. It was two copies of the same literal before
 * the third arrived.
 */
export function newClip(input: {
  description: string
  alternates: SceneMatch[]
  alternateIndex?: number
  where?: Where | null
}): MontageClip {
  return {
    id: clipId(),
    description: input.description,
    alternates: input.alternates,
    alternateIndex: input.alternateIndex ?? 0,
    padBeforeMs: DEFAULT_PAD_BEFORE_MS,
    padAfterMs: DEFAULT_PAD_AFTER_MS,
    caption: { mode: 'inherit', text: '' },
    muted: false,
    where: input.where ?? null,
  }
}

/**
 * The cut with one more clip in it, at a position counted in clips before it.
 *
 * `at` is how many clips precede the new one, so 0 puts it first and
 * `clips.length` puts it last — which is what lets the editor render one insert
 * point per gap, including the gap after the last card, from a single index.
 *
 * Returns a new array. The editor holds its clips in React state, so splicing the
 * array it was handed would change the cut without anything re-rendering.
 */
export function insertClip(
  clips: MontageClip[],
  at: number,
  clip: MontageClip,
): MontageClip[] {
  return [...clips.slice(0, at), clip, ...clips.slice(at)]
}

export interface Montage {
  id: string
  titleId: string
  name: string
  sourceText: string
  /** What every clip gets unless it says otherwise. */
  caption: Caption
  clips: MontageClip[]
  createdAt: number
  updatedAt: number
}

/**
 * A caption with nothing left to inherit: everything the burner needs to draw it.
 *
 * Distinct from `Caption` because the two optional fields there are questions —
 * "whose look?", "which lines?" — and a renderer must not be able to receive one
 * that has not been answered.
 */
export interface ResolvedCaption extends Caption {
  look: CaptionLook
  lines: SubtitleEdits
}

/**
 * The caption a clip will actually be rendered with.
 *
 * One place decides this, because the preview and the export must agree — a
 * preview that resolves inheritance differently from the encoder is the exact
 * class of bug the shared preview pipeline exists to prevent.
 *
 * The three parts settle separately. The mode and its text come from the cut
 * unless the clip states its own; the look comes from the clip if it has one and
 * from the cut otherwise, whatever the mode is doing; the line edits are always
 * the clip's, because there is nowhere else they could come from.
 */
export function resolveCaption(clip: MontageClip, cutCaption: Caption): ResolvedCaption {
  const look = clip.caption.look ?? cutCaption.look ?? DEFAULT_LOOK
  const lines = clip.caption.lines ?? {}

  if (clip.caption.mode === 'inherit') {
    return { mode: cutCaption.mode, text: cutCaption.text, look, lines }
  }
  return { mode: clip.caption.mode, text: clip.caption.text, look, lines }
}

export type OutputFormat = 'mp4' | 'gif' | 'webm' | 'png' | 'jpg'

export interface RenderSettings {
  format: OutputFormat
  /** Longest edge in pixels. GIFs default lower to keep file size sane. */
  maxWidth: number
  fps: number
  /** Silent output regardless of per-clip mute — what a "gif" usually means. */
  stripAudio: boolean
  /** For still formats: which moment of the finished cut to freeze, in ms. */
  frameMs: number
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  format: 'mp4',
  maxWidth: 720,
  fps: 24,
  stripAudio: false,
  frameMs: 0,
}

export const STILL_FORMATS: OutputFormat[] = ['png', 'jpg']
export const isStillFormat = (format: OutputFormat): boolean => STILL_FORMATS.includes(format)

export const activeMatch = (clip: MontageClip): SceneMatch | undefined =>
  clip.alternates[clip.alternateIndex]

/**
 * Narrows search candidates to the one title the chosen scenes belong to.
 *
 * A cut belongs to exactly one show — `montage.title_id` is NOT NULL — but a
 * library-wide search returns candidates from several. Handing those to a clip
 * as its alternates would let "Not this one" quietly swap in footage from a
 * different series while the cut still claimed the original title, and the
 * export would then read a video the montage has no relationship to.
 *
 * Takes a list because one search can become several clips: tick four results
 * and each becomes a clip of the same cut. The first pick names the title and
 * any later pick from another show is dropped rather than silently retitling
 * the cut — the results screen stops you selecting across shows, so reaching
 * this is a stale-results case, not an ordinary one.
 *
 * Returns null when nothing chosen is still there, which is the caller's cue
 * that there is nothing to build.
 */
export function alternatesForTitle(
  matches: SceneMatch[],
  chosenIndexes: number[],
): { titleId: string; alternates: SceneMatch[]; alternateIndexes: number[] } | null {
  const chosen = chosenIndexes.map((index) => matches[index]).filter(Boolean)
  const first = chosen[0]
  if (!first) return null

  const alternates = matches.filter((match) => match.titleId === first.titleId)
  return {
    titleId: first.titleId,
    alternates,
    // Every chosen scene from that title survives the filter by definition, so
    // the -1s being dropped here are only the picks from other shows.
    alternateIndexes: chosen.map((match) => alternates.indexOf(match)).filter((i) => i >= 0),
  }
}

/**
 * A clip can never be trimmed shorter than this. Below roughly a quarter of a
 * second ffmpeg may land between keyframes and emit nothing at all.
 */
export const MIN_CLIP_MS = 250

/**
 * How far either side of the matched dialogue a clip can reach.
 *
 * This is the *only* limit on where a clip's edges may go. Both edges can be put
 * anywhere in that span, including entirely before or entirely after the
 * dialogue that was matched — a search result is a place to start looking, not a
 * region the clip has to overlap.
 *
 * Fifteen seconds is also about as wide as the window can be before the
 * filmstrip's tile cap makes the thumbnails too coarse to pick a frame from.
 */
export const MAX_PAD_MS = 15_000

/**
 * The span of the episode a clip's edges can reach, which is what the editor
 * has to show a filmstrip of.
 *
 * Derived from the match rather than from the current bounds so it does not
 * move while you drag — a timeline that rescales under the handle you are
 * holding is unusable, and a fixed window means one cached filmstrip serves
 * every adjustment of a clip.
 */
export function trimWindow(match: SceneMatch): { startMs: number; endMs: number } {
  return {
    startMs: Math.max(0, match.startMs - MAX_PAD_MS),
    endMs: match.endMs + MAX_PAD_MS,
  }
}

/**
 * Turns absolute in/out points back into the padding the clip model stores.
 *
 * The clamp is on the in/out points themselves rather than on the two padding
 * numbers, which is what lets a clip sit anywhere in the window. Clamping the
 * padding separately caps each edge relative to the dialogue and so pins the clip
 * to the region it was matched from: the start could never pass the match's end,
 * nor the end precede the match's start.
 */
export function paddingFor(
  match: SceneMatch,
  startMs: number,
  endMs: number,
): { padBeforeMs: number; padAfterMs: number } {
  const window = trimWindow(match)
  const reachable = (value: number) =>
    Math.min(window.endMs, Math.max(window.startMs, Math.round(value)))
  return {
    padBeforeMs: match.startMs - reachable(startMs),
    padAfterMs: reachable(endMs) - match.endMs,
  }
}

/**
 * The actual in/out points for a clip once the user's adjustments are applied.
 *
 * Padding is signed on both ends: positive extends the clip outward, negative
 * pulls it inward. A matched dialogue window is frequently longer than the
 * moment you actually want, so trimming in matters as much as padding out.
 */
export function clipBounds(clip: MontageClip): { startMs: number; endMs: number } | null {
  const match = activeMatch(clip)
  if (!match) return null

  const startMs = Math.max(0, match.startMs - clip.padBeforeMs)
  const endMs = match.endMs + clip.padAfterMs

  // Trimming both ends inward can cross them over; keep a floor.
  if (endMs - startMs < MIN_CLIP_MS) {
    return { startMs, endMs: startMs + MIN_CLIP_MS }
  }
  return { startMs, endMs }
}

export const clipDurationMs = (clip: MontageClip): number => {
  const bounds = clipBounds(clip)
  return bounds ? bounds.endMs - bounds.startMs : 0
}
