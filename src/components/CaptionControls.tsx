'use client'

import { useClipCues } from '@/components/useClipCues'
import { Button, cx, formatTime } from '@/components/ui'
import {
  DEFAULT_LOOK,
  MAX_CAPTION_SIZE,
  MIN_CAPTION_SIZE,
  clampCaptionSize,
  cueKey,
  type CaptionLook,
  type CaptionPlacement,
  type SubtitleEdits,
} from '@/lib/montage/types'

/**
 * The controls for how a caption looks and what it says, shared by the cut and
 * by a single clip.
 *
 * One component for both because the two are the same decision at two scopes,
 * and because a size slider that behaved differently in the two places would
 * make "set it once for the cut, then fix this one clip" into two things to
 * learn instead of one.
 */

const PLACEMENTS: { value: CaptionPlacement; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
]

/**
 * Size and placement.
 *
 * `look` may be undefined, which means "whatever `inherited` says" — that is the
 * state a clip is born in, and moving any control here is what makes it its own.
 * The controls still show the inherited values while that is true, because a
 * slider parked at 100% when the cut is at 150% would be lying about what is on
 * screen.
 */
export function CaptionLookControls({
  look,
  inherited = DEFAULT_LOOK,
  inheritLabel,
  onChange,
}: {
  look: CaptionLook | undefined
  /** What an absent `look` resolves to. */
  inherited?: CaptionLook
  /** Offered as the way back to `inherited`. Omit where there is nothing to inherit from. */
  inheritLabel?: string
  onChange: (look: CaptionLook | undefined) => void
}) {
  const active = look ?? inherited
  const percent = Math.round(active.size * 100)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex min-w-48 flex-1 items-center gap-2">
        <span className="shrink-0 text-xs text-faint">Text size</span>
        <input
          type="range"
          className="trim-range min-w-0 flex-1"
          min={MIN_CAPTION_SIZE}
          max={MAX_CAPTION_SIZE}
          step={0.05}
          value={active.size}
          onChange={(e) =>
            onChange({ ...active, size: clampCaptionSize(Number(e.target.value)) })
          }
          aria-label="Caption text size"
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">
          {percent}%
        </span>
      </label>

      <div className="flex items-center gap-2">
        <span className="text-xs text-faint">Sits</span>
        <div className="flex rounded-lg bg-raised p-0.5">
          {PLACEMENTS.map((placement) => (
            <button
              key={placement.value}
              onClick={() => onChange({ ...active, placement: placement.value })}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                active.placement === placement.value
                  ? 'bg-accent font-medium text-base'
                  : 'text-muted hover:text-ink',
              )}
            >
              {placement.label}
            </button>
          ))}
        </div>
      </div>

      {inheritLabel && look && (
        <button
          onClick={() => onChange(undefined)}
          className="text-xs text-muted underline decoration-dotted hover:text-ink"
        >
          {inheritLabel}
        </button>
      )}
    </div>
  )
}

/**
 * The real subtitle lines inside one clip, each one editable.
 *
 * The timings stay the show's and only the words are yours, which is what makes
 * this different from typing a custom caption: a rewritten line still lands on
 * the frame where it was spoken. So changing one word in one line of one clip is
 * a single edit rather than a decision to hand-time the whole caption.
 *
 * Cues come from the same endpoint the burner reads, so what is listed here is
 * exactly what will appear — including the lines that only clip the very edge of
 * the window, which is usually the cue to trim rather than to rewrite.
 */
export function SubtitleLineEditor({
  videoId,
  startMs,
  endMs,
  edits,
  onChange,
}: {
  videoId: string
  startMs: number
  endMs: number
  edits: SubtitleEdits
  onChange: (edits: SubtitleEdits) => void
}) {
  const cues = useClipCues(videoId, startMs, endMs)

  /**
   * An edit equal to the original is removed rather than stored.
   *
   * Otherwise typing a word and typing it back would leave the line permanently
   * marked as changed, and re-indexing the show — which can move a cue's text —
   * would be pinned to whatever it used to say.
   */
  function setLine(key: string, original: string, value: string) {
    const next = { ...edits }
    if (value === original) delete next[key]
    else next[key] = value
    onChange(next)
  }

  if (cues.length === 0) {
    return (
      <p className="text-xs text-faint">
        No dialogue in this clip. Extend it or write a custom caption.
      </p>
    )
  }

  const changed = cues.filter((cue) => edits[cueKey(cue)] !== undefined).length

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-faint">
          Edit a line, or clear it to drop it
        </p>
        {changed > 0 && (
          <button
            onClick={() => {
              const next = { ...edits }
              for (const cue of cues) delete next[cueKey(cue)]
              onChange(next)
            }}
            className="text-xs text-muted underline decoration-dotted hover:text-ink"
          >
            Put {changed === 1 ? 'the changed line' : `all ${changed} changed lines`} back
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {cues.map((cue) => {
          const key = cueKey(cue)
          const edit = edits[key]
          const edited = edit !== undefined

          return (
            <div key={key} className="flex items-start gap-2">
              {/* Timed from the start of the clip, because that is the clock the
                  preview underneath is playing on. */}
              <span className="w-10 shrink-0 pt-1.5 text-right text-xs tabular-nums text-faint">
                {formatTime(Math.max(0, cue.startMs - startMs))}
              </span>
              <textarea
                value={edit ?? cue.text}
                onChange={(e) => setLine(key, cue.text, e.target.value)}
                rows={cue.text.includes('\n') ? 2 : 1}
                spellCheck={false}
                className={cx(
                  'min-w-0 flex-1 resize-y rounded-lg border bg-surface px-2.5 py-1 text-sm focus:outline-none',
                  edited ? 'border-accent' : 'border-line focus:border-accent',
                )}
                aria-label={`Line at ${formatTime(Math.max(0, cue.startMs - startMs))}`}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLine(key, cue.text, cue.text)}
                disabled={!edited}
                aria-label="Put this line back to what was said"
                title="Put this line back to what was said"
              >
                Undo
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
