import type { Cue } from './parse'

export interface DialogueWindow {
  startMs: number
  endMs: number
  text: string
  /** Index of the first cue, used to reconstruct exact line timings later. */
  firstCue: number
  lastCue: number
}

export interface WindowOptions {
  /** Stop growing a window once it covers this much screen time. */
  maxDurationMs?: number
  /** Never merge across a silence longer than this — it signals a scene change. */
  maxGapMs?: number
  /** Upper bound on cues per window, so rapid-fire dialogue stays searchable. */
  maxCues?: number
  /** How many cues to advance between windows. Lower = more overlap. */
  stride?: number
}

const DEFAULTS: Required<WindowOptions> = {
  maxDurationMs: 14_000,
  maxGapMs: 3_000,
  maxCues: 6,
  stride: 2,
}

/**
 * Groups subtitle cues into overlapping dialogue windows.
 *
 * This is the step that makes semantic search work. A single cue ("No.") has
 * almost no meaning on its own, and a description like "when he refuses to sign
 * the contract and storms out" spans several lines. Embedding overlapping
 * multi-cue windows means a description can match the *passage* it describes,
 * and the overlap keeps a scene from being split down the middle by an
 * unlucky boundary.
 */
export function buildWindows(cues: Cue[], options: WindowOptions = {}): DialogueWindow[] {
  const { maxDurationMs, maxGapMs, maxCues, stride } = { ...DEFAULTS, ...options }
  const windows: DialogueWindow[] = []
  if (cues.length === 0) return windows

  let i = 0
  while (i < cues.length) {
    const first = cues[i]
    let lastIndex = i
    const parts: string[] = [first.text]

    for (let j = i + 1; j < cues.length && j < i + maxCues; j++) {
      const cue = cues[j]
      if (cue.startMs - cues[lastIndex].endMs > maxGapMs) break
      if (cue.endMs - first.startMs > maxDurationMs) break
      parts.push(cue.text)
      lastIndex = j
    }

    windows.push({
      startMs: first.startMs,
      endMs: cues[lastIndex].endMs,
      text: parts.join(' ').replace(/\s+/g, ' ').trim(),
      firstCue: i,
      lastCue: lastIndex,
    })

    // The tail of the file is already fully covered by the last window.
    if (lastIndex >= cues.length - 1) break

    // Advance by the stride, but never step past a cue no window has covered.
    // A window cut short by a silence covers fewer cues than the stride, and
    // stepping blindly would drop the lines just after the gap from the index
    // entirely — exactly the dialogue that opens a new scene.
    i = Math.min(i + stride, lastIndex + 1)
  }

  return windows
}
