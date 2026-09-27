'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Card, Icon, Spinner, cx, episodeLabel } from '@/components/ui'
import { TrimStrip } from '@/components/TrimStrip'
import { CaptionLookControls, SubtitleLineEditor } from '@/components/CaptionControls'
import {
  DEFAULT_LOOK,
  activeMatch,
  clipBounds,
  paddingFor,
  resolveCaption,
  type Caption,
  type ClipCaptionMode,
  type MontageClip,
  type ResolvedCaption,
} from '@/lib/montage/types'

/** How long the user has to stop adjusting before a preview is worth building. */
const SETTLE_MS = 500

type PreviewStatus = 'ready' | 'building' | 'failed'

/**
 * Everything the preview endpoint needs to draw the same caption the export will.
 *
 * Every field that changes the pixels goes in, which is also what makes the URL
 * the cache key for them — two clips that resolve to the same caption over the
 * same seconds share one encode.
 */
function previewUrlFor(
  caption: ResolvedCaption,
  videoId: string,
  startMs: number,
  endMs: number,
): string {
  const params = new URLSearchParams({
    videoId,
    start: String(Math.round(startMs)),
    end: String(Math.round(endMs)),
    mode: caption.mode,
    size: String(caption.look.size),
    place: caption.look.placement,
  })
  if (caption.mode === 'custom') params.set('text', caption.text.trim())
  // Sorted so the same edits typed in a different order stay one URL, and so
  // the browser's own cache hits as often as the server's.
  if (caption.mode === 'subtitle') {
    const keys = Object.keys(caption.lines).sort()
    if (keys.length > 0) {
      params.set(
        'lines',
        JSON.stringify(Object.fromEntries(keys.map((key) => [key, caption.lines[key]]))),
      )
    }
  }
  return `/api/clip-preview?${params.toString()}`
}

interface PreviewRequest {
  url: string
  /** Episode time of the preview's first frame, which is where its clock starts. */
  startMs: number
}

/**
 * The preview currently on screen, which lags the clip being edited on purpose.
 *
 * Two rules keep this usable. Requests are debounced, because dragging an edge
 * emits a value several times a second and each one would otherwise start an
 * encode. And the previous preview stays visible until the next one exists,
 * because blanking the player on every adjustment is most of what made the old
 * editor feel broken.
 *
 * Readiness is probed with a one-byte range request: that forces the server to
 * finish building before the element is pointed at the URL, without downloading
 * the clip twice.
 *
 * `startMs` travels with the URL rather than being read from the clip, because
 * those two disagree for as long as a rebuild is in flight — and a playhead drawn
 * from the clip's current start would sit in the wrong place on exactly the
 * frames the user is watching to judge an adjustment.
 */
function useClipPreview(wanted: PreviewRequest | null): {
  url: string | null
  startMs: number | null
  status: PreviewStatus
  error: string | null
  retry: () => void
} {
  const [shown, setShown] = useState<PreviewRequest | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('ready')
  const [error, setError] = useState<string | null>(null)
  // Reading a segment crosses the network to Jellyfin, which times out
  // occasionally; a failed preview needs a way forward that is not a page reload.
  const [attempt, setAttempt] = useState(0)

  const wantedUrl = wanted?.url ?? null
  const wantedStartMs = wanted?.startMs ?? 0
  const shownUrl = shown?.url ?? null

  useEffect(() => {
    if (!wantedUrl || wantedUrl === shownUrl) return

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setStatus('building')
      setError(null)
      try {
        const response = await fetch(wantedUrl, {
          headers: { Range: 'bytes=0-0' },
          signal: controller.signal,
        })
        if (!response.ok && response.status !== 206) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? `Could not build a preview (${response.status})`)
        }
        setShown({ url: wantedUrl, startMs: wantedStartMs })
        setStatus('ready')
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('failed')
      }
    }, SETTLE_MS)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [wantedUrl, wantedStartMs, shownUrl, attempt])

  return {
    url: shownUrl,
    startMs: shown?.startMs ?? null,
    status,
    error,
    retry: () => setAttempt((n) => n + 1),
  }
}

/**
 * How far the playhead must move before the marker is redrawn.
 *
 * The strip spans about forty seconds, so eighty milliseconds is a pixel or two.
 * Redrawing every animation frame would re-render the card sixty times a second
 * to move a line less than that.
 */
const PLAYHEAD_STEP_MS = 80

const CAPTION_MODES = [
  { value: 'inherit', label: 'Follow the cut' },
  { value: 'none', label: 'No caption' },
  { value: 'subtitle', label: 'Subtitles' },
  { value: 'custom', label: 'Custom' },
] as const satisfies { value: ClipCaptionMode; label: string }[]

interface ClipCardProps {
  clip: MontageClip
  /** The cut's caption, which this clip uses unless it has its own. */
  cutCaption: Caption
  position: number
  total: number
  onChange: (clip: MontageClip) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
  onResearch: (clip: MontageClip) => void
}

export function ClipCard({
  clip,
  cutCaption,
  position,
  total,
  onChange,
  onRemove,
  onMove,
  onResearch,
}: ClipCardProps) {
  const match = activeMatch(clip)
  const bounds = clipBounds(clip)
  const caption = resolveCaption(clip, cutCaption)
  // Whether the user has asked for playback, which is not the same as whether the
  // element is playing: loading a new preview pauses it behind our back. Intent
  // survives that, which is what makes playback carry across a rebuild.
  const [wantsPlay, setWantsPlay] = useState(false)
  const [playheadOffsetMs, setPlayheadOffsetMs] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)

  const preview = useClipPreview(
    match && bounds
      ? {
          url: previewUrlFor(caption, match.videoId, bounds.startMs, bounds.endMs),
          startMs: bounds.startMs,
        }
      : null,
  )

  // A new preview replaces one the user was watching, so playback carries over
  // rather than making them press play again after every adjustment.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !preview.url || !wantsPlay) return
    void video.play().catch(() => setWantsPlay(false))
  }, [preview.url, wantsPlay])

  /*
   * Follows the playhead so the marker on the timeline can.
   *
   * Driven by the element's own events rather than by React state, because
   * playback starts and stops for reasons the component does not initiate — a
   * rebuilt preview resuming, the browser interrupting for another tab's audio.
   * Gate this on state instead and the marker freezes while the picture keeps
   * moving, which is worse than having no marker.
   *
   * Position is sampled per frame because `timeupdate` fires about four times a
   * second and reads as visibly steppy, and written only when the marker would
   * move far enough to see.
   */
  useEffect(() => {
    const video = videoRef.current
    if (!video || !preview.url) return

    let frame = 0
    const sample = () => {
      const at = video.currentTime * 1000
      setPlayheadOffsetMs((current) => (Math.abs(at - current) < PLAYHEAD_STEP_MS ? current : at))
    }
    const follow = () => {
      sample()
      frame = requestAnimationFrame(follow)
    }
    // Guarded: a second `play` without an intervening `pause` would otherwise
    // leave a loop running that nothing cancels.
    const start = () => {
      if (!frame) follow()
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
      sample()
    }

    video.addEventListener('play', start)
    video.addEventListener('pause', stop)
    video.addEventListener('seeked', sample)
    video.addEventListener('loadedmetadata', sample)

    return () => {
      stop()
      video.removeEventListener('play', start)
      video.removeEventListener('pause', stop)
      video.removeEventListener('seeked', sample)
      video.removeEventListener('loadedmetadata', sample)
    }
  }, [preview.url])

  const playheadMs = preview.startMs == null ? null : preview.startMs + playheadOffsetMs

  function togglePlay() {
    const video = videoRef.current
    if (!video) return
    if (wantsPlay) {
      video.pause()
      setWantsPlay(false)
      return
    }
    void video.play().catch(() => setWantsPlay(false))
    setWantsPlay(true)
  }

  if (!match || !bounds) {
    return (
      <Card className="border-danger/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-faint">Clip {position + 1}</p>
            <p className="mt-1 text-sm text-ink">“{clip.description}”</p>
            <p className="mt-2 text-sm text-danger">
              Nothing in this title’s dialogue matched that. Try describing what is said.
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" onClick={() => onResearch(clip)}>
              Search
            </Button>
            <Button size="sm" variant="danger" onClick={onRemove}>
              Remove
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="space-y-4 overflow-hidden p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-faint">
            Clip {position + 1} of {total}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium">
            {episodeLabel(match.season, match.episode, match.videoName)}
          </p>
          {/*
            Only shown when the hint was not honoured, because when it was, the
            line above already says the same thing — repeating it there would be
            noise on every clip to be useful on a few.

            Derived from the active match rather than recorded when the search
            ran, so pressing "Not this one" out of the named episode makes this
            appear and stepping back in makes it go. Says only that the clip is
            elsewhere: it arrives both from nothing in that episode scoring and
            from the user walking past what did, and this cannot tell which.
          */}
          {clip.where && !clip.where.videoIds.includes(match.videoId) && (
            <p className="mt-0.5 text-xs text-muted">
              You asked for {clip.where.label}. This is not from there.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMove(-1)}
            disabled={position === 0}
            aria-label="Move this clip earlier in the cut"
          >
            <Icon.Up />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMove(1)}
            disabled={position === total - 1}
            aria-label="Move this clip later in the cut"
          >
            <Icon.Down />
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={onRemove}
            aria-label="Remove this clip from the cut"
          >
            <Icon.Close />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="w-full shrink-0 sm:w-72">
          <div className="relative aspect-video overflow-hidden rounded-lg bg-base">
            {/*
              No key on the bounds: re-keying remounted the element on every
              adjustment, which threw away a loaded video and started a fresh
              transcode several times a second.
            */}
            {preview.url ? (
              <video
                ref={videoRef}
                src={preview.url}
                className="size-full object-contain"
                preload="auto"
                loop
                playsInline
                muted={clip.muted}
                onEnded={() => setWantsPlay(false)}
              />
            ) : (
              <div className="grid size-full place-items-center p-3">
                {preview.status === 'failed' ? (
                  <div className="space-y-2 text-center">
                    {/* Clamped: an ffmpeg diagnosis can run many lines and would
                        otherwise push the trim controls off the card. */}
                    <p className="line-clamp-3 text-xs break-words text-danger">{preview.error}</p>
                    <Button size="sm" onClick={preview.retry}>
                      Try again
                    </Button>
                  </div>
                ) : (
                  <Spinner label="Building preview" />
                )}
              </div>
            )}

            {preview.url && (
              <button
                onClick={togglePlay}
                className="absolute inset-0 grid place-items-center bg-base/40 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                aria-label={wantsPlay ? 'Pause this clip' : 'Play this clip'}
              >
                <span className="grid size-11 place-items-center rounded-full bg-accent text-base">
                  {wantsPlay ? <Icon.Pause /> : <Icon.Play />}
                </span>
              </button>
            )}

            {/* The clip on screen is a render behind the edits; say so. */}
            {preview.url && preview.status === 'building' && (
              <span className="absolute bottom-1.5 left-1.5 rounded bg-base/80 px-1.5 py-0.5 text-xs text-muted">
                catching up…
              </span>
            )}
          </div>
          <p className="mt-1.5 text-center text-xs text-faint">
            Exactly what exports, captions and all
          </p>
          {preview.url && preview.status === 'failed' && (
            <div className="mt-1 space-y-1 text-center">
              <p className="line-clamp-2 text-xs break-words text-danger">{preview.error}</p>
              <Button size="sm" onClick={preview.retry}>
                Try again
              </Button>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {clip.description && (
            <div className="rounded-lg bg-raised px-3 py-2">
              <p className="text-xs text-faint">You asked for</p>
              <p className="mt-0.5 text-sm">“{clip.description}”</p>
            </div>
          )}

          <div>
            <p className="text-xs text-faint">What is said here</p>
            <p className="mt-0.5 line-clamp-4 text-sm text-muted">{match.text}</p>
          </div>

          {clip.alternates.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-faint">
                Scene {clip.alternateIndex + 1} of {clip.alternates.length}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  onChange({
                    ...clip,
                    alternateIndex: (clip.alternateIndex + 1) % clip.alternates.length,
                  })
                }
              >
                Not this one
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onResearch(clip)}>
                Describe it differently
              </Button>
            </div>
          )}
        </div>
      </div>

      <TrimStrip
        videoId={match.videoId}
        match={match}
        startMs={bounds.startMs}
        endMs={bounds.endMs}
        playheadMs={playheadMs}
        onChange={(next) => onChange({ ...clip, ...paddingFor(match, next.startMs, next.endMs) })}
      />

      <div className="space-y-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Caption</span>
          <div className="flex rounded-lg bg-raised p-0.5">
            {CAPTION_MODES.map((mode) => (
              <button
                key={mode.value}
                onClick={() => onChange({ ...clip, caption: { ...clip.caption, mode: mode.value } })}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs transition-colors',
                  clip.caption.mode === mode.value
                    ? 'bg-accent font-medium text-base'
                    : 'text-muted hover:text-ink',
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {/* "Follow the cut" is only meaningful if it says what the cut currently is. */}
          {clip.caption.mode === 'inherit' && (
            <span className="text-xs text-faint">
              currently {CAPTION_MODES.find((mode) => mode.value === cutCaption.mode)?.label.toLowerCase()}
            </span>
          )}

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) => onChange({ ...clip, muted: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            Silence this clip
          </label>
        </div>

        {clip.caption.mode === 'custom' && (
          <input
            value={clip.caption.text}
            onChange={(e) =>
              onChange({ ...clip, caption: { ...clip.caption, text: e.target.value } })
            }
            placeholder="Caption text"
            className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
          />
        )}

        {/*
          Only where there is something to style. A clip showing no caption has
          no size, and the controls would sit there inviting an adjustment that
          changes nothing on screen.
        */}
        {caption.mode !== 'none' && (
          <CaptionLookControls
            look={clip.caption.look}
            inherited={cutCaption.look ?? DEFAULT_LOOK}
            inheritLabel="Match the cut"
            onChange={(look) => onChange({ ...clip, caption: { ...clip.caption, look } })}
          />
        )}

        {/*
          Keyed on the resolved mode, not the clip's: a clip following a cut that
          is set to real subtitles has lines to edit just as much as one that
          chose them itself.
        */}
        {caption.mode === 'subtitle' && (
          <SubtitleLineEditor
            videoId={match.videoId}
            startMs={bounds.startMs}
            endMs={bounds.endMs}
            edits={clip.caption.lines ?? {}}
            onChange={(lines) => onChange({ ...clip, caption: { ...clip.caption, lines } })}
          />
        )}
      </div>
    </Card>
  )
}
