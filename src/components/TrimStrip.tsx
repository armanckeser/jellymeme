'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { cx, formatTime } from '@/components/ui'
import { useClipCues } from '@/components/useClipCues'
import {
  TILE_HEIGHT,
  TILE_WIDTH,
  filmstripUrl,
  planFilmstrip,
  positionPercent,
  spanAtPercent,
  spineTiles,
  tileAt,
  tileOffsetPercent,
  timeAtPercent,
  type FilmstripPlan,
} from '@/lib/montage/filmstrip'
import { trimWindow } from '@/lib/montage/types'
import {
  moveClip,
  moveEdge,
  nextBoundary,
  snapPoints,
  trimActions,
  type Edge,
} from '@/lib/montage/trim'
import type { SceneMatch } from '@/lib/search/search'
import type { Cue } from '@/lib/subtitles/parse'

/**
 * The trim control.
 *
 * It replaced a pair of plus/minus steppers, which asked the wrong question. You
 * do not want the clip 250 ms longer; you want it to include the line that sets
 * the joke up, or to stop before the reaction that spoils it. So this shows the
 * footage either side of the cut and snaps to where the dialogue actually
 * starts and stops, and the two edges you are deciding about are on screen as
 * pictures rather than as numbers.
 */

/** Thumbnails along the timeline. Fixed, so the layout needs no measuring. */
const SPINE_TILES = 12

/** Arrow keys, and the same with shift held. */
const FINE_STEP_MS = 250
const COARSE_STEP_MS = 1000

/**
 * One thumbnail out of the sprite.
 *
 * `whole` fits the entire frame in its box, undistorted, and is used where the
 * picture is the point. `strip` fills a timeline cell of fixed height, which
 * squeezes the frame horizontally — legible for scanning, and the alternative
 * is either gaps in the timeline or measuring the container in JavaScript.
 */
function Tile({
  url,
  index,
  tiles,
  fit,
  className,
}: {
  url: string
  index: number
  tiles: number
  fit: 'whole' | 'strip'
  className?: string
}) {
  return (
    <div
      className={cx('bg-base bg-no-repeat', className)}
      style={{
        backgroundImage: `url(${url})`,
        backgroundSize: `${tiles * 100}% 100%`,
        backgroundPositionX: `${tileOffsetPercent(index, tiles)}%`,
        aspectRatio: fit === 'whole' ? `${TILE_WIDTH} / ${TILE_HEIGHT}` : undefined,
      }}
      aria-hidden
    />
  )
}

/** How far outside an edge counts as "just outside" when naming the dialogue there. */
const OUTSIDE_LOOKAHEAD_MS = 2_500

/**
 * The pair of frames at one edge: what is inside the cut, and what sits just
 * outside it.
 *
 * The dimmed one is the answer to "am I cutting off something I want" — the
 * question that made people fiddle with the steppers in the first place.
 */
function EdgeFrames({
  url,
  plan,
  atMs,
  edge,
  cues,
}: {
  url: string
  plan: FilmstripPlan
  atMs: number
  edge: Edge
  cues: Cue[]
}) {
  // The end bound is exclusive, so the last frame inside sits just before it.
  const insideAt = edge === 'start' ? atMs : atMs - plan.intervalMs
  const inside = tileAt(plan, insideAt)
  const outside = tileAt(plan, edge === 'start' ? insideAt - plan.intervalMs : atMs)

  const outsideFrom = edge === 'start' ? atMs - OUTSIDE_LOOKAHEAD_MS : atMs
  const outsideTo = edge === 'start' ? atMs : atMs + OUTSIDE_LOOKAHEAD_MS
  const spokenOutside = cues.find((cue) => cue.endMs > outsideFrom && cue.startMs < outsideTo)

  const kept = { index: inside, dim: false, caption: formatTime(atMs) }
  const lost = { index: outside, dim: true, caption: edge === 'start' ? 'before' : 'after' }
  const frames = edge === 'start' ? [lost, kept] : [kept, lost]

  return (
    <div className="w-60 max-w-[47%] min-w-0">
      <p className="mb-1 text-xs text-faint">{edge === 'start' ? 'Starts on' : 'Ends on'}</p>
      <div className="flex gap-1">
        {frames.map((frame) => (
          <div key={frame.caption} className="min-w-0 flex-1">
            <Tile
              url={url}
              index={frame.index}
              tiles={plan.tiles}
              fit="whole"
              className={cx(
                'rounded',
                frame.dim ? 'opacity-30 grayscale' : 'ring-1 ring-accent/70',
              )}
            />
            <p
              className={cx(
                'mt-0.5 text-center text-xs tabular-nums',
                frame.dim ? 'text-faint' : 'text-muted',
              )}
            >
              {frame.caption}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs text-faint">
        {edge === 'start' ? 'Just before: ' : 'Just after: '}
        {spokenOutside ? `“${spokenOutside.text}”` : 'no dialogue'}
      </p>
    </div>
  )
}

export interface TrimStripProps {
  videoId: string
  match: SceneMatch
  startMs: number
  endMs: number
  /**
   * Where the preview player has reached, in episode time, or null when nothing
   * is loaded. Drawn on the strip so the frame on screen has a place on the
   * timeline.
   */
  playheadMs?: number | null
  onChange: (bounds: { startMs: number; endMs: number }) => void
}

/** What a pointer took hold of, and the state it was in at the time. */
interface Grab {
  what: Edge | 'clip'
  clientX: number
  startMs: number
  endMs: number
}

export function TrimStrip({
  videoId,
  match,
  startMs,
  endMs,
  playheadMs,
  onChange,
}: TrimStripProps) {
  const plan = useMemo(() => {
    const window = trimWindow(match)
    return planFilmstrip(window.startMs, window.endMs)
  }, [match])

  const cues = useClipCues(videoId, plan.startMs, plan.endMs)
  const points = useMemo(() => snapPoints(cues, match), [cues, match])
  const url = useMemo(() => filmstripUrl(videoId, plan), [videoId, plan])

  const spine = useRef<HTMLDivElement>(null)
  const [grab, setGrab] = useState<Grab | null>(null)

  const move = useCallback(
    (edge: Edge, to: number, snap: boolean) => {
      onChange(
        moveEdge(edge, to, { startMs, endMs }, match, { snapTo: snap ? points : undefined }),
      )
    },
    [points, match, startMs, endMs, onChange],
  )

  const slide = useCallback(
    (shiftMs: number, from: { startMs: number; endMs: number }) => {
      onChange(moveClip(shiftMs, from, match))
    },
    [match, onChange],
  )

  function onPointerDown(what: Edge | 'clip', event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setGrab({ what, clientX: event.clientX, startMs, endMs })
  }

  function onPointerMove(what: Edge | 'clip', event: React.PointerEvent<HTMLDivElement>) {
    if (grab?.what !== what) return
    const track = spine.current?.getBoundingClientRect()
    if (!track || track.width === 0) return

    // Measured from where the grab started rather than from the last frame, so
    // the clip cannot drift away from the pointer over a long drag.
    if (what === 'clip') {
      const percent = ((event.clientX - grab.clientX) / track.width) * 100
      slide(spanAtPercent(plan, percent), { startMs: grab.startMs, endMs: grab.endMs })
      return
    }

    const percent = ((event.clientX - track.left) / track.width) * 100
    move(what, timeAtPercent(plan, percent), true)
  }

  function onKeyDown(edge: Edge, event: React.KeyboardEvent<HTMLDivElement>) {
    const current = edge === 'start' ? startMs : endMs
    const step = event.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS

    switch (event.key) {
      case 'ArrowLeft':
        move(edge, current - step, false)
        break
      case 'ArrowRight':
        move(edge, current + step, false)
        break
      // Page keys jump between line boundaries, which is the unit people
      // actually think in when they trim dialogue.
      case 'PageDown': {
        const target = nextBoundary(points, current, -1)
        if (target !== null) move(edge, target, false)
        break
      }
      case 'PageUp': {
        const target = nextBoundary(points, current, 1)
        if (target !== null) move(edge, target, false)
        break
      }
      case 'Home':
        move(edge, plan.startMs, false)
        break
      case 'End':
        move(edge, plan.endMs, false)
        break
      default:
        return
    }
    event.preventDefault()
  }

  function onClipKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const bounds = { startMs, endMs }
    const step = event.shiftKey ? COARSE_STEP_MS : FINE_STEP_MS

    switch (event.key) {
      case 'ArrowLeft':
        slide(-step, bounds)
        break
      case 'ArrowRight':
        slide(step, bounds)
        break
      case 'Home':
        slide(plan.startMs - startMs, bounds)
        break
      case 'End':
        slide(plan.endMs - endMs, bounds)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const startPercent = positionPercent(plan, startMs)
  const endPercent = positionPercent(plan, endMs)
  const durationMs = endMs - startMs

  const handle = (edge: Edge) => {
    const at = edge === 'start' ? startMs : endMs
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={edge === 'start' ? 'Clip start' : 'Clip end'}
        aria-valuemin={Math.round(plan.startMs)}
        aria-valuemax={Math.round(plan.endMs)}
        aria-valuenow={Math.round(at)}
        aria-valuetext={`${formatTime(at)} — clip is ${(durationMs / 1000).toFixed(1)} seconds`}
        onPointerDown={(e) => onPointerDown(edge, e)}
        onPointerMove={(e) => onPointerMove(edge, e)}
        onPointerUp={() => setGrab(null)}
        onPointerCancel={() => setGrab(null)}
        onKeyDown={(e) => onKeyDown(edge, e)}
        style={{ left: `${edge === 'start' ? startPercent : endPercent}%` }}
        className={cx(
          // Wide enough to grab on a touch screen while the visible bar stays thin.
          'absolute top-0 z-20 h-full w-6 -translate-x-1/2 cursor-ew-resize touch-none',
          'before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2',
          'before:rounded-full before:bg-accent',
          grab?.what === edge && 'before:w-1',
        )}
      >
        <span
          className={cx(
            'absolute left-1/2 top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2',
            'place-items-center rounded-full bg-accent text-[9px] font-bold text-base',
          )}
          aria-hidden
        >
          {edge === 'start' ? '◀' : '▶'}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Pushed apart so the two bright frames read as two ends of a clip
          rather than as one four-frame sequence. */}
      <div className="flex justify-between gap-6">
        <EdgeFrames url={url} plan={plan} atMs={startMs} edge="start" cues={cues} />
        <EdgeFrames url={url} plan={plan} atMs={endMs} edge="end" cues={cues} />
      </div>

      <div>
        <div ref={spine} className="relative h-12 rounded-lg bg-base select-none">
          {/*
            The picture is clipped to the rounded box; the controls are not. An
            edge parked at either extreme sits half outside the strip, and with the
            whole reachable range now usable that is a position people land on.
          */}
          <div className="absolute inset-0 overflow-hidden rounded-lg">
            <div className="flex h-full">
              {spineTiles(plan, SPINE_TILES).map((index, cell) => (
                <Tile
                  key={cell}
                  url={url}
                  index={index}
                  tiles={plan.tiles}
                  fit="strip"
                  className="h-full min-w-0 flex-1"
                />
              ))}
            </div>

            {/* Outside the cut, dimmed. The bright middle is what gets exported. */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-base/70"
              style={{ width: `${startPercent}%` }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-base/70"
              style={{ width: `${100 - endPercent}%` }}
            />
            {/* Where the matched dialogue itself sits, so added padding is visible. */}
            <div
              className="pointer-events-none absolute bottom-0 h-1 bg-accent/40"
              style={{
                left: `${positionPercent(plan, match.startMs)}%`,
                width: `${positionPercent(plan, match.endMs) - positionPercent(plan, match.startMs)}%`,
              }}
            />
          </div>

          {/*
            The cut itself is draggable: same length, different moment. Doing that
            with the two handles takes two drags in the right order, since neither
            edge can pass the other.
          */}
          <div
            role="slider"
            tabIndex={0}
            aria-label="Clip position"
            aria-valuemin={Math.round(plan.startMs)}
            aria-valuemax={Math.round(Math.max(plan.startMs, plan.endMs - durationMs))}
            aria-valuenow={Math.round(startMs)}
            aria-valuetext={`${formatTime(startMs)} to ${formatTime(endMs)}`}
            onPointerDown={(e) => onPointerDown('clip', e)}
            onPointerMove={(e) => onPointerMove('clip', e)}
            onPointerUp={() => setGrab(null)}
            onPointerCancel={() => setGrab(null)}
            onKeyDown={onClipKeyDown}
            style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
            className={cx(
              'absolute inset-y-0 z-10 touch-none border-y-2 border-accent/70',
              grab?.what === 'clip' ? 'cursor-grabbing' : 'cursor-grab',
            )}
          />

          {/* Outlined, or it disappears against a bright frame. */}
          {playheadMs != null && (
            <div
              className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-ink outline-1 outline-base"
              style={{ left: `${positionPercent(plan, playheadMs)}%` }}
              aria-hidden
            />
          )}

          {handle('start')}
          {handle('end')}
        </div>

        <div className="mt-1 flex items-baseline justify-between text-xs text-faint">
          <span className="tabular-nums">{formatTime(plan.startMs)}</span>
          <span className="tabular-nums text-muted">
            {formatTime(startMs)} → {formatTime(endMs)} · {(durationMs / 1000).toFixed(1)}s
          </span>
          <span className="tabular-nums">{formatTime(plan.endMs)}</span>
        </div>
      </div>

      <LineActions
        cues={cues}
        match={match}
        startMs={startMs}
        endMs={endMs}
        onMove={(edge, to) => move(edge, to, false)}
      />
    </div>
  )
}

/**
 * The line-level shortcuts, rendered from the actions the dialogue allows.
 */
function LineActions({
  cues,
  match,
  startMs,
  endMs,
  onMove,
}: {
  cues: Cue[]
  match: SceneMatch
  startMs: number
  endMs: number
  onMove: (edge: Edge, to: number) => void
}) {
  const actions = trimActions(cues, match, startMs, endMs)
  if (actions.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((action) => (
        <button
          key={action.key}
          onClick={() => onMove(action.edge, action.to)}
          className={cx(
            'flex min-w-0 max-w-full items-baseline gap-1.5 rounded-lg bg-raised px-2 py-1',
            'text-left text-xs text-muted transition-colors hover:bg-line hover:text-ink',
          )}
        >
          <span className="shrink-0">{action.label}</span>
          <span className="truncate text-faint">“{action.quote}”</span>
        </button>
      ))}
    </div>
  )
}
