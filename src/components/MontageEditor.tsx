'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { api, patch, post } from '@/lib/client-api'
import { ClipCard } from '@/components/ClipCard'
import { CaptionLookControls } from '@/components/CaptionControls'
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  ProgressBar,
  cx,
  formatBytes,
  formatTime,
  episodeLabel,
} from '@/components/ui'
import {
  clipDurationMs,
  insertClip,
  isStillFormat,
  newClip,
  type Caption,
  type CaptionMode,
  type Montage,
  type MontageClip,
  type OutputFormat,
} from '@/lib/montage/types'
import type { Where } from '@/lib/montage/hints'
import type { SceneMatch, SceneSearch } from '@/lib/search/search'
import type { RenderRecord } from '@/lib/render/render'

/**
 * What each format is for, in terms of where you are about to paste it.
 *
 * "VP9/Opus WebM" is true and useless; "smallest file, plays in browsers and
 * Discord" is what someone choosing between them needs.
 */
const FORMATS: { value: OutputFormat; label: string; hint: string }[] = [
  { value: 'mp4', label: 'Video', hint: 'MP4 with sound. Plays anywhere.' },
  { value: 'gif', label: 'GIF', hint: 'Silent, loops. For places that block video.' },
  { value: 'webm', label: 'WebM', hint: 'Smallest file. Browsers and Discord.' },
  { value: 'png', label: 'Still', hint: 'One lossless frame.' },
  { value: 'jpg', label: 'Photo', hint: 'One frame, smaller file.' },
]

/**
 * Why the scene dialog is open, which is the only thing that differs between its
 * two uses.
 *
 * Both are "type a line, pick a scene" against the same title-scoped endpoint, so
 * they share one dialog rather than two that drift apart. The intent decides what
 * the dialog says, what it starts with, and what happens to what comes back.
 */
type SearchIntent =
  | { kind: 'replace'; clip: MontageClip }
  /** `at` is how many clips come before the new one. See `insertClip`. */
  | { kind: 'insert'; at: number }

/** A scene the user picked out of the dialog's results. */
interface Chosen {
  matches: SceneMatch[]
  index: number
  /** Where the wording pointed, so an inserted clip can say what it understood. */
  where: Where | null
  /** What was typed, which becomes an inserted clip's description. */
  query: string
}

export function MontageEditor({
  initialMontage,
  initialRender,
}: {
  initialMontage: Montage
  initialRender: RenderRecord | null
}) {
  const id = initialMontage.id

  const [montage, setMontage] = useState<Montage>(initialMontage)
  const [error, setError] = useState<string | null>(null)
  const [render, setRender] = useState<RenderRecord | null>(initialRender)
  const [format, setFormat] = useState<OutputFormat>('mp4')
  const [maxWidth, setMaxWidth] = useState(720)
  const [stripAudio, setStripAudio] = useState(false)
  const [frameMs, setFrameMs] = useState(0)
  const [intent, setIntent] = useState<SearchIntent | null>(null)

  // Autosave: edits are frequent (an edge drag emits many), so coalesce them.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateClips = useCallback(
    (clips: MontageClip[]) => {
      setMontage((current) => ({ ...current, clips }))
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        patch(`/api/montage/${id}`, { clips }).catch((e) => setError((e as Error).message))
      }, 600)
    },
    [id],
  )

  const updateCaption = useCallback(
    (caption: Caption) => {
      setMontage((current) => ({ ...current, caption }))
      patch(`/api/montage/${id}`, { caption }).catch((e) => setError((e as Error).message))
    },
    [id],
  )

  const rendering = render?.status === 'running' || render?.status === 'queued'
  useEffect(() => {
    if (!rendering || !render) return
    const timer = setInterval(async () => {
      try {
        const d = await api<{ render: RenderRecord }>(`/api/render/${render.id}`)
        setRender(d.render)
      } catch {
        /* keep the last known state */
      }
    }, 800)
    return () => clearInterval(timer)
  }, [rendering, render])

  const totalMs = useMemo(
    () => montage.clips.reduce((sum, c) => sum + clipDurationMs(c), 0),
    [montage],
  )

  const still = isStillFormat(format)

  async function startRender() {
    setError(null)
    try {
      const d = await post<{ render: RenderRecord }>(`/api/montage/${id}/render`, {
        format,
        maxWidth,
        stripAudio: format === 'gif' ? true : stripAudio,
        fps: format === 'gif' ? 15 : 24,
        frameMs,
      })
      setRender(d.render)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const clips = montage.clips
  const unmatched = clips.filter((c) => c.alternates.length === 0).length

  return (
    <div className="space-y-6">
      <header className="min-w-0">
        <Link href={`/title/${montage.titleId}`} className="text-xs text-faint hover:text-muted">
          ← Back to the show
        </Link>
        <input
          value={montage.name}
          onChange={(e) => {
            const name = e.target.value
            setMontage({ ...montage, name })
            patch(`/api/montage/${id}`, { name }).catch(() => {})
          }}
          className="mt-1 w-full truncate border-none bg-transparent text-xl font-semibold text-ink focus:outline-none"
          aria-label="Name of this cut"
        />
        <p className="mt-1 text-sm text-muted">
          {clips.length} {clips.length === 1 ? 'clip' : 'clips'} · {formatTime(totalMs)}
          {unmatched > 0 && (
            <span className="text-danger"> · {unmatched} with nothing matched</span>
          )}
        </p>
      </header>

      {error && <Banner>{error}</Banner>}

      {/*
        The clips come first. This panel used to sit above them, so opening a cut
        showed you a format picker before it showed you your own footage.
      */}
      {clips.length === 0 ? (
        <EmptyState title="Nothing in this cut yet">
          <Link href={`/title/${montage.titleId}`} className="text-accent underline">
            Describe a scene to add one
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <CutCaption
            caption={montage.caption}
            overridden={
              clips.filter((clip) => clip.caption.mode !== 'inherit' || clip.caption.look).length
            }
            onChange={updateCaption}
            onClearOverrides={() =>
              updateClips(
                clips.map((clip) => ({
                  ...clip,
                  // Line edits survive. They are this clip's own words for its own
                  // moment, not a style choice that got out of step with the cut,
                  // and nothing else in the editor would bring them back.
                  caption: { mode: 'inherit', text: '', lines: clip.caption.lines },
                })),
              )
            }
          />

          {/*
            The insert points supply the spacing between cards, rather than sitting
            inside a gap something else defines. One element per gap, so there is
            no arithmetic relating a hairline's position to the index it inserts at.
          */}
          <div>
            {clips.map((clip, index) => (
              <div key={clip.id}>
                <InsertPoint at={index} total={clips.length} onInsert={setIntent} />
                <ClipCard
                  clip={clip}
                  cutCaption={montage.caption}
                  position={index}
                  total={clips.length}
                  onChange={(next) => updateClips(clips.map((c) => (c.id === next.id ? next : c)))}
                  onRemove={() => updateClips(clips.filter((c) => c.id !== clip.id))}
                  onMove={(direction) => {
                    const target = index + direction
                    if (target < 0 || target >= clips.length) return
                    const next = [...clips]
                    ;[next[index], next[target]] = [next[target], next[index]]
                    updateClips(next)
                  }}
                  onResearch={(target) => setIntent({ kind: 'replace', clip: target })}
                />
              </div>
            ))}
            <InsertPoint at={clips.length} total={clips.length} onInsert={setIntent} />
          </div>
        </div>
      )}

      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="mb-1.5 text-xs text-faint">Save it as</p>
            <div className="flex rounded-lg bg-raised p-0.5">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFormat(f.value)}
                  className={cx(
                    'rounded-md px-3 py-1.5 text-xs transition-colors',
                    format === f.value
                      ? 'bg-accent font-medium text-base'
                      : 'text-muted hover:text-ink',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs text-faint">Size</p>
            <select
              value={maxWidth}
              onChange={(e) => setMaxWidth(Number(e.target.value))}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs focus:border-accent focus:outline-none"
              aria-label="Width in pixels"
            >
              {[320, 480, 720, 1080].map((w) => (
                <option key={w} value={w}>
                  {w}px wide
                </option>
              ))}
            </select>
          </div>

          {!still && format !== 'gif' && (
            <label className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={stripAudio}
                onChange={(e) => setStripAudio(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              No sound at all
            </label>
          )}

          <div className="ml-auto pb-1">
            <Button
              variant="primary"
              onClick={startRender}
              disabled={rendering || clips.length === 0}
            >
              {rendering ? 'Making it…' : 'Make the file'}
            </Button>
          </div>
        </div>

        <p className="text-xs text-faint">{FORMATS.find((f) => f.value === format)?.hint}</p>

        {still && (
          <label className="block border-t border-line pt-4">
            <span className="mb-1 flex items-baseline justify-between text-xs text-faint">
              <span>Which moment to freeze</span>
              <span className="tabular-nums">
                {formatTime(frameMs)} of {formatTime(totalMs)}
              </span>
            </span>
            <input
              type="range"
              className="trim-range"
              min={0}
              max={Math.max(0, totalMs - 100)}
              step={100}
              value={Math.min(frameMs, Math.max(0, totalMs - 100))}
              onChange={(e) => setFrameMs(Number(e.target.value))}
              aria-label="Which moment to freeze"
            />
          </label>
        )}

        {render && rendering && (
          <div className="space-y-1.5">
            <ProgressBar value={render.progress} />
            <p className="text-xs text-muted">{render.stage}</p>
          </div>
        )}

        {render?.status === 'error' && <Banner>{render.error}</Banner>}

        {render?.status === 'done' && (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <a href={`/api/render/${render.id}/file?download`} download>
                <Button variant="primary" size="sm">
                  Download the {render.format.toUpperCase()}
                </Button>
              </a>
              <span className="text-xs text-faint">
                {render.fileSize ? formatBytes(render.fileSize) : ''}
              </span>
            </div>
            {render.format === 'gif' || render.format === 'png' || render.format === 'jpg' ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={`/api/render/${render.id}/file`}
                alt="The finished cut"
                className="max-h-96 rounded-lg"
              />
            ) : (
              <video
                src={`/api/render/${render.id}/file`}
                controls
                className="max-h-96 w-full rounded-lg bg-base"
              />
            )}
          </div>
        )}
      </Card>

      {intent && (
        <SearchDialog
          montageId={id}
          intent={intent}
          onClose={() => setIntent(null)}
          onPick={(chosen) => {
            // `where` is replaced along with the alternates because it describes
            // the search that produced them, not the original paste.
            updateClips(
              intent.kind === 'insert'
                ? insertClip(
                    clips,
                    intent.at,
                    newClip({
                      description: chosen.query,
                      alternates: chosen.matches,
                      alternateIndex: chosen.index,
                      where: chosen.where,
                    }),
                  )
                : clips.map((c) =>
                    c.id === intent.clip.id
                      ? {
                          ...c,
                          alternates: chosen.matches,
                          alternateIndex: chosen.index,
                          where: chosen.where,
                        }
                      : c,
                  ),
            )
            setIntent(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * One gap between cards, which you can put a clip into.
 *
 * The hairline is always visible. A zone that only appears on hover is invisible
 * to anyone who has not already guessed it is there, and on a touch screen there
 * is no hover to reveal it with — but thirty-four loud plus buttons would compete
 * with the footage they sit between, so it stays faint until pointed at.
 *
 * The label names the position rather than the action, because a screen reader
 * moving down the cut reads thirty-four of these in a row and "Add a clip" thirty
 * -four times says nothing about where.
 */
function InsertPoint({
  at,
  total,
  onInsert,
}: {
  at: number
  total: number
  onInsert: (intent: SearchIntent) => void
}) {
  const where =
    at === 0 ? 'at the start' : at === total ? 'at the end' : `before clip ${at + 1}`

  return (
    <button
      onClick={() => onInsert({ kind: 'insert', at })}
      aria-label={`Add a clip ${where}`}
      title={`Add a clip ${where}`}
      className="group flex w-full items-center gap-3 py-2"
    >
      <Hairline />
      <span className="grid size-6 place-items-center rounded-full border border-line text-faint transition-colors group-hover:border-accent group-hover:text-accent group-focus-visible:border-accent group-focus-visible:text-accent">
        <Icon.Plus />
      </span>
      <Hairline />
    </button>
  )
}

const Hairline = () => (
  <span className="h-px flex-1 bg-line transition-colors group-hover:bg-accent-soft group-focus-visible:bg-accent-soft" />
)

const CUT_CAPTION_MODES: { value: CaptionMode; label: string }[] = [
  { value: 'none', label: 'No caption' },
  { value: 'subtitle', label: 'Subtitles' },
  { value: 'custom', label: 'Custom' },
]

/**
 * The caption every clip in the cut follows.
 *
 * Here rather than in the export panel because it is an editorial decision, not an
 * output format — and above the clips because it is the decision you want to make
 * once instead of twenty times.
 */
function CutCaption({
  caption,
  overridden,
  onChange,
  onClearOverrides,
}: {
  caption: Caption
  overridden: number
  onChange: (caption: Caption) => void
  onClearOverrides: () => void
}) {
  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-faint">Captions</span>
        <div className="flex rounded-lg bg-raised p-0.5">
          {CUT_CAPTION_MODES.map((mode) => (
            <button
              key={mode.value}
              onClick={() => onChange({ ...caption, mode: mode.value })}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                caption.mode === mode.value
                  ? 'bg-accent font-medium text-base'
                  : 'text-muted hover:text-ink',
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {/*
          Clips set individually do not move when this changes — including every
          clip made before captions had a cut-level setting, which were all written
          as an explicit "no caption". So say so, and offer the way back.
        */}
        {overridden > 0 && (
          <button
            onClick={onClearOverrides}
            className="text-xs text-muted underline decoration-dotted hover:text-ink"
          >
            {overridden} {overridden === 1 ? 'clip is' : 'clips are'} set individually — make{' '}
            {overridden === 1 ? 'it' : 'them'} follow this
          </button>
        )}
      </div>

      {caption.mode === 'custom' && (
        <input
          value={caption.text}
          onChange={(e) => onChange({ ...caption, text: e.target.value })}
          placeholder="Caption for every clip"
          className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
        />
      )}

      {/*
        Set once here for every clip that has not been given its own. The words a
        clip says are per clip by nature; how big they are almost never is, which
        is why this one lives with the cut.
      */}
      {caption.mode !== 'none' && (
        <CaptionLookControls
          look={caption.look}
          onChange={(look) => onChange({ ...caption, look })}
        />
      )}
    </Card>
  )
}

/**
 * Type a line, pick a scene. Used both to replace a clip whose pasted wording was
 * too vague and to add one that was never in the paste at all.
 *
 * The endpoint is scoped to the cut's own title, which is what keeps an inserted
 * clip inside the one show a cut is allowed to hold.
 */
function SearchDialog({
  montageId,
  intent,
  onClose,
  onPick,
}: {
  montageId: string
  intent: SearchIntent
  onClose: () => void
  onPick: (chosen: Chosen) => void
}) {
  const [query, setQuery] = useState(intent.kind === 'insert' ? '' : intent.clip.description)
  const [found, setFound] = useState<SceneSearch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const heading = intent.kind === 'insert' ? 'Add a clip here' : 'Find a different scene'
  const submit = intent.kind === 'insert' ? 'Find it' : 'Look again'

  async function search() {
    setBusy(true)
    setError(null)
    try {
      setFound(
        await post<SceneSearch>(`/api/montage/${montageId}/search`, { query, limit: 8 }),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const matches = found?.matches

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{heading}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            <Icon.Close />
          </Button>
        </div>

        <div className="space-y-3 p-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              search()
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What happens in it, or what someone says…"
              autoFocus
            />
            <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
              {busy ? 'Looking…' : submit}
            </Button>
          </form>

          {error && <Banner>{error}</Banner>}
        </div>

        <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto border-t border-line">
          {matches?.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-faint">
              No dialogue in this show matched that.
            </p>
          )}
          {matches?.map((match, index) => (
            <button
              key={match.lineId}
              onClick={() =>
                onPick({
                  matches,
                  index,
                  where: found?.request.where ?? null,
                  query: query.trim(),
                })
              }
              className="block w-full px-4 py-3 text-left transition-colors hover:bg-raised"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-xs font-medium">
                  {episodeLabel(match.season, match.episode, match.videoName)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-faint">
                  {formatTime(match.startMs)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{match.text}</p>
            </button>
          ))}
        </div>
      </Card>
    </div>
  )
}
