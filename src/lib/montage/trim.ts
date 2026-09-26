import type { Cue } from '@/lib/subtitles/parse'
import type { SceneMatch } from '@/lib/search/search'
import { MIN_CLIP_MS, trimWindow } from './types'

/**
 * The rules behind the trim timeline, with no React in them.
 *
 * All of it is arithmetic over the dialogue: where an edge is allowed to go,
 * which boundary it should land on, and what moving it would add or drop. Kept
 * out of the component because these are the parts that can be wrong in ways a
 * screenshot will not show — an edge that quietly exceeds the reachable range,
 * or a snap that lands a quarter second inside a word.
 */

export type Edge = 'start' | 'end'

/**
 * How close a dragged edge has to come to a line boundary to land on it.
 *
 * Generous on purpose: a cue edge is nearly always where you meant to stop, and
 * the alternative is clipping the first syllable off a word.
 */
export const SNAP_MS = 400

/**
 * Where one edge can go.
 *
 * Two rules, and deliberately no third: stay inside the filmstrip's window, and
 * leave the clip long enough to encode. In particular an edge is bounded by the
 * *other edge*, never by the matched dialogue — so a clip can be dragged clear of
 * the line it was found by, which is what you want when the search landed one
 * exchange early.
 */
export function edgeLimits(
  edge: Edge,
  match: SceneMatch,
  startMs: number,
  endMs: number,
): { lowest: number; highest: number } {
  const window = trimWindow(match)
  if (edge === 'start') {
    return { lowest: window.startMs, highest: Math.min(window.endMs, endMs - MIN_CLIP_MS) }
  }
  return { lowest: Math.max(window.startMs, startMs + MIN_CLIP_MS), highest: window.endMs }
}

/** Whether an edge could be put at a given moment, from where the clip is now. */
export const withinReach = (
  edge: Edge,
  target: number,
  match: SceneMatch,
  bounds: { startMs: number; endMs: number },
): boolean => {
  const limits = edgeLimits(edge, match, bounds.startMs, bounds.endMs)
  return target >= limits.lowest && target <= limits.highest
}

/**
 * Boundaries an edge can land on: every cue edge in view, plus where the match
 * itself began and ended, since returning a clip to "as matched" is a position
 * people want back.
 */
export function snapPoints(cues: Cue[], match: SceneMatch): number[] {
  const points = [match.startMs, match.endMs]
  for (const cue of cues) points.push(cue.startMs, cue.endMs)
  return [...new Set(points)].sort((a, b) => a - b)
}

export function snapTo(value: number, points: number[], toleranceMs = SNAP_MS): number {
  let best = value
  let bestDistance = toleranceMs
  for (const point of points) {
    const distance = Math.abs(point - value)
    if (distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }
  return best
}

/** The next boundary in a direction, for jumping line by line from the keyboard. */
export function nextBoundary(
  points: number[],
  current: number,
  direction: -1 | 1,
): number | null {
  // A one-millisecond deadband stops a boundary the edge is already sitting on
  // from counting as the next one, which would make the key do nothing.
  const candidates =
    direction === 1 ? points.filter((p) => p > current + 1) : points.filter((p) => p < current - 1)
  const target = direction === 1 ? candidates[0] : candidates[candidates.length - 1]
  return target ?? null
}

/**
 * Moves one edge, clamped and optionally snapped.
 *
 * Single funnel for dragging, arrow keys and the line buttons, so the reachable
 * range and the minimum clip length are enforced in exactly one place.
 */
export function moveEdge(
  edge: Edge,
  target: number,
  bounds: { startMs: number; endMs: number },
  match: SceneMatch,
  options: { snapTo?: number[] } = {},
): { startMs: number; endMs: number } {
  const wanted = options.snapTo ? snapTo(target, options.snapTo) : target
  const limits = edgeLimits(edge, match, bounds.startMs, bounds.endMs)
  const landed = Math.round(Math.min(limits.highest, Math.max(limits.lowest, wanted)))

  return edge === 'start'
    ? { startMs: landed, endMs: bounds.endMs }
    : { startMs: bounds.startMs, endMs: landed }
}

/**
 * Slides a whole clip along the episode, keeping its length.
 *
 * Moving both edges by hand means two drags that each have to respect the other
 * edge, and the order matters — you cannot push the start past where the end
 * currently is. Sliding the clip is the gesture for "same length, different
 * moment", and it is one drag.
 *
 * Takes a shift rather than a destination so a drag can be measured from where it
 * began. Applying successive deltas to already-moved bounds would let rounding
 * accumulate, and the clip would creep away from the pointer.
 */
export function moveClip(
  shiftMs: number,
  bounds: { startMs: number; endMs: number },
  match: SceneMatch,
): { startMs: number; endMs: number } {
  const window = trimWindow(match)
  const earliest = window.startMs - bounds.startMs
  const latest = window.endMs - bounds.endMs
  const shift = Math.round(Math.min(latest, Math.max(earliest, shiftMs)))
  return { startMs: bounds.startMs + shift, endMs: bounds.endMs + shift }
}

export interface TrimAction {
  key: string
  label: string
  /** The line itself, so the button says what it would do. */
  quote: string
  edge: Edge
  to: number
}

/**
 * Trimming expressed as the decision being made.
 *
 * "Include the line before" and "drop the last line" are the two intents behind
 * almost every adjustment. Offering them directly is the difference between
 * trimming dialogue and nudging milliseconds.
 */
export function trimActions(
  cues: Cue[],
  match: SceneMatch,
  startMs: number,
  endMs: number,
): TrimAction[] {
  if (cues.length === 0) return []

  // A cue straddling an edge by a hair is the same line, not the one outside it.
  const grace = 150
  const before = [...cues].reverse().find((cue) => cue.endMs <= startMs + grace)
  const after = cues.find((cue) => cue.startMs >= endMs - grace)
  const inside = cues.filter((cue) => cue.endMs > startMs + grace && cue.startMs < endMs - grace)

  const firstInside = inside[0]
  const lastInside = inside[inside.length - 1]

  const actions: TrimAction[] = []
  const bounds = { startMs, endMs }

  if (before && withinReach('start', before.startMs, match, bounds)) {
    actions.push({
      key: 'add-before',
      label: 'Add the line before',
      quote: before.text,
      edge: 'start',
      to: before.startMs,
    })
  }
  // Dropping the only line inside would leave a clip of no dialogue at all.
  if (firstInside && inside.length > 1 && withinReach('start', firstInside.endMs, match, bounds)) {
    actions.push({
      key: 'drop-first',
      label: 'Drop the first line',
      quote: firstInside.text,
      edge: 'start',
      to: firstInside.endMs,
    })
  }
  if (lastInside && inside.length > 1 && withinReach('end', lastInside.startMs, match, bounds)) {
    actions.push({
      key: 'drop-last',
      label: 'Drop the last line',
      quote: lastInside.text,
      edge: 'end',
      to: lastInside.startMs,
    })
  }
  if (after && withinReach('end', after.endMs, match, bounds)) {
    actions.push({
      key: 'add-after',
      label: 'Add the line after',
      quote: after.text,
      edge: 'end',
      to: after.endMs,
    })
  }

  return actions
}
