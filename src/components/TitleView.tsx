'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, del, post } from '@/lib/client-api'
import { splitSceneDescriptions } from '@/lib/montage/split'
import { readSceneRequest } from '@/lib/montage/hints'
import { SceneSearch } from '@/components/SceneSearch'
import {
  Banner,
  Button,
  Card,
  Icon,
  ProgressBar,
  Textarea,
  cx,
  episodeLabel,
} from '@/components/ui'
import type { Montage } from '@/lib/montage/types'
import type { MontageSummary, TitleDetail } from '@/lib/queries'

const PLACEHOLDER = `Paste a whole thread and each line becomes a clip:

1. the one where he declares bankruptcy by shouting it
2. when she finally tells him about the merger
- the fire drill cold open
- anything with the stapler in jello`

export function TitleView({
  initialDetail,
  initialMontages,
}: {
  initialDetail: TitleDetail
  initialMontages: MontageSummary[]
}) {
  const router = useRouter()
  const [detail, setDetail] = useState(initialDetail)
  const [montages, setMontages] = useState(initialMontages)
  const [text, setText] = useState('')
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showEpisodes, setShowEpisodes] = useState(false)
  // The single-scene flow is the common case, so the list flow is folded away
  // rather than given equal billing.
  const [showPaste, setShowPaste] = useState(false)

  const titleId = initialDetail.title!.id

  const reload = useCallback(async () => {
    const [d, m] = await Promise.all([
      api<TitleDetail>(`/api/library/${titleId}`),
      api<{ montages: MontageSummary[] }>(`/api/montage?titleId=${titleId}`),
    ])
    setDetail(d)
    setMontages(m.montages)
  }, [titleId])

  const indexing = detail.job?.status === 'running' || detail.job?.status === 'queued'
  useEffect(() => {
    if (!indexing) return
    const timer = setInterval(() => {
      reload().catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [indexing, reload])

  /*
   * Parsed on the client so the list updates as you type, with no round-trip.
   *
   * The episode list goes in because two of the decisions need it: a quoted span
   * that names an episode is an address rather than dialogue and must not replace
   * the sentence around it, and the label below tells the user which episode each
   * line will be searched in. `TitleVideo` is structurally an `EpisodeRef`.
   *
   * The server re-reads all of this from its own copy of the episode list, so this
   * is a preview of what will happen and not an instruction.
   */
  const episodes = detail.videos
  const descriptions = useMemo(
    () => splitSceneDescriptions(text, { episodes }),
    [text, episodes],
  )
  const locations = useMemo(
    () =>
      new Map(
        descriptions.map((description) => [
          description,
          readSceneRequest(description, episodes).where?.label ?? null,
        ]),
      ),
    [descriptions, episodes],
  )
  /*
   * Which extracted lines the user has rejected.
   *
   * A thread carries commentary that reads exactly like a description — "really
   * the best build up of the concept" — and nothing can tell it apart from
   * "the one where he turns himself into a pickle" automatically. So the
   * extraction is shown before twenty searches run on it.
   *
   * Keyed by the text rather than by position, because the list is re-derived on
   * every keystroke and indices would shift under the ticks.
   */
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const selected = descriptions.filter((description) => !dropped.has(description))

  async function build() {
    setBuilding(true)
    setError(null)
    try {
      const { montage } = await post<{ montage: Montage }>('/api/montage', {
        titleId,
        text,
        descriptions: selected,
      })
      router.push(`/montage/${montage.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBuilding(false)
    }
  }

  async function reindex() {
    setError(null)
    try {
      await post(`/api/library/${titleId}`, {})
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const { title, videos, job } = detail
  if (!title) return null
  const missing = videos.filter((v) => v.status !== 'ok')
  const nothingIndexed = title.lineCount === 0

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/" className="text-xs text-faint hover:text-muted">
            ← Your shows
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{title.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {title.lineCount.toLocaleString()} passages of dialogue from {title.videoCount}{' '}
            {title.videoCount === 1 ? 'video' : 'videos'}
          </p>
        </div>
        <Button onClick={reindex} disabled={indexing} size="sm">
          {indexing ? 'Reading…' : nothingIndexed ? 'Check for subtitles again' : 'Look for new episodes'}
        </Button>
      </header>

      {job && (job.status === 'running' || job.status === 'queued') && (
        <Card className="space-y-2 p-4">
          <ProgressBar value={job.totalVideos ? job.processedVideos / job.totalVideos : 0} />
          <p className="text-xs text-muted">
            {job.status === 'queued'
              ? 'Waiting for another title to finish'
              : `Reading subtitles, ${job.processedVideos} of ${job.totalVideos} · ${job.currentVideo}`}
          </p>
        </Card>
      )}

      {error && <Banner>{error}</Banner>}

      {nothingIndexed && !indexing ? (
        <Banner>No text subtitles found, so there is nothing to search. Image-based subtitles can’t be read.</Banner>
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-semibold">Find a scene</h2>
            <p className="text-xs text-faint">matches meaning, not exact words</p>
          </div>

          <SceneSearch titleId={titleId} disabled={nothingIndexed} />

          <div className="border-t border-line pt-4">
            <button
              onClick={() => setShowPaste((v) => !v)}
              className="flex items-center gap-1.5 text-sm text-muted hover:text-ink"
            >
              <Icon.Chevron open={showPaste} />
              Paste a list, one clip per line
            </button>

            {showPaste && (
              <div className="mt-3 space-y-3">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={PLACEHOLDER}
                  rows={9}
                  className="font-mono text-[13px] leading-relaxed"
                  aria-label="One scene description per line"
                />
                {descriptions.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-faint">
                      Untick lines that aren’t scenes
                    </p>
                    <Card className="max-h-72 divide-y divide-line overflow-y-auto">
                      {descriptions.map((description) => {
                        const keep = !dropped.has(description)
                        return (
                          <label
                            key={description}
                            className="flex cursor-pointer items-start gap-2 px-3 py-2 text-sm transition-colors hover:bg-raised"
                          >
                            <input
                              type="checkbox"
                              checked={keep}
                              onChange={() =>
                                setDropped((current) => {
                                  const next = new Set(current)
                                  if (keep) next.add(description)
                                  else next.delete(description)
                                  return next
                                })
                              }
                              className="mt-1 shrink-0 accent-[var(--color-accent)]"
                            />
                            <span
                              className={cx(
                                'min-w-0 flex-1',
                                keep ? 'text-muted' : 'text-faint line-through',
                              )}
                            >
                              {description}
                            </span>
                            {/*
                              Where this line will be searched, when it said. Worth
                              showing before the searches run rather than after: a
                              wrong episode read out of a line is visible here in a
                              glance, and invisible in a cut of twenty clips.
                            */}
                            {locations.get(description) && (
                              <span className="shrink-0 text-xs text-faint">
                                in {locations.get(description)}
                              </span>
                            )}
                          </label>
                        )
                      })}
                    </Card>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-faint">
                    {descriptions.length === 0
                      ? 'Nothing detected yet'
                      : `${selected.length} of ${descriptions.length} selected`}
                  </p>
                  <Button
                    variant="primary"
                    onClick={build}
                    disabled={building || selected.length === 0 || nothingIndexed}
                  >
                    {building
                      ? 'Matching them up…'
                      : selected.length === 1
                        ? 'Find it'
                        : `Find all ${selected.length}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {montages.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted">Cuts you have made from this</h2>
          <Card className="divide-y divide-line">
            {montages.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <Link href={`/montage/${m.id}`} className="min-w-0 flex-1 hover:text-accent">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-faint">
                    {m.clipCount} {m.clipCount === 1 ? 'clip' : 'clips'} ·{' '}
                    {new Date(m.updatedAt).toLocaleDateString()}
                  </p>
                </Link>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!window.confirm(`Delete “${m.name}”?`)) return
                    await del(`/api/montage/${m.id}`)
                    await reload()
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <button
          onClick={() => setShowEpisodes((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink"
        >
          <Icon.Chevron open={showEpisodes} />
          Episodes
          {missing.length > 0 && (
            <span className="text-xs font-normal text-danger">
              {missing.length} unreadable
            </span>
          )}
        </button>

        {showEpisodes && (
          <Card className="max-h-96 divide-y divide-line overflow-y-auto">
            {videos.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {episodeLabel(v.season, v.episode, v.name)}
                </span>
                <span
                  className={v.status === 'ok' ? 'text-xs text-faint' : 'text-xs text-danger'}
                  title={v.note ?? undefined}
                >
                  {v.status === 'ok' ? 'searchable' : (v.note ?? v.status)}
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  )
}
