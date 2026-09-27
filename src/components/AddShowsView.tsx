'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api, post } from '@/lib/client-api'
import { Banner, Button, EmptyState, Input, cx } from '@/components/ui'
import type { IndexJob } from '@/lib/index/indexer'
import type { LibrarySnapshot, RemoteTitle, RemoteTitles } from '@/lib/queries'

/**
 * Choosing what to make searchable.
 *
 * The old version of this was a search box that returned nothing until you
 * typed, with an Index button per result — so adding four shows meant four
 * searches and four clicks, and you could not see what you already had. Here the
 * whole library arrives at once, the box filters what is already on screen, and
 * a selection is indexed in one go.
 */

type Filter = 'all' | 'series' | 'movies' | 'new'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'series', label: 'Shows' },
  { value: 'movies', label: 'Films' },
  { value: 'new', label: 'Not added' },
]

/** What a title is currently doing, which decides how its card behaves. */
type CardState = 'selectable' | 'selected' | 'queued' | 'indexing' | 'searchable' | 'unusable'

function cardState(title: RemoteTitle, job: IndexJob | undefined, selected: boolean): CardState {
  if (job?.status === 'running') return 'indexing'
  if (job?.status === 'queued') return 'queued'
  // Indexed but with nothing to search: every episode's subtitles were missing
  // or unusable. Worth saying out loud — roughly a third of a real library has
  // no text subtitle track, and silence here reads as a bug in the app.
  if (title.indexed && title.lineCount === 0) return 'unusable'
  if (title.indexed) return 'searchable'
  return selected ? 'selected' : 'selectable'
}

export function AddShowsView({
  initialTitles,
  initialTotal,
  initialJobs,
}: {
  initialTitles: RemoteTitle[]
  initialTotal: number
  initialJobs: IndexJob[]
}) {
  const [titles, setTitles] = useState(initialTitles)
  const [total, setTotal] = useState(initialTotal)
  const [jobs, setJobs] = useState(initialJobs)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const loadTitles = useCallback(async () => {
    const data = await api<RemoteTitles>('/api/titles')
    setTitles(data.titles)
    setTotal(data.total)
  }, [])

  const jobsByTitle = useMemo(() => new Map(jobs.map((job) => [job.titleId, job])), [jobs])
  const working = jobs.some((job) => job.status === 'running' || job.status === 'queued')

  // Poll only while something is indexing, then stop.
  useEffect(() => {
    if (!working) return
    const timer = setInterval(async () => {
      try {
        const snapshot = await api<LibrarySnapshot>('/api/library')
        setJobs(snapshot.jobs)
        // Counts change as titles finish, so the cards need the fresh numbers.
        await loadTitles()
      } catch {
        /* keep the last known state */
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [working, loadTitles])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return titles.filter((title) => {
      if (needle && !title.name.toLowerCase().includes(needle)) return false
      if (filter === 'series') return title.kind === 'Series'
      if (filter === 'movies') return title.kind === 'Movie'
      if (filter === 'new') return !title.indexed
      return true
    })
  }, [titles, query, filter])

  const selectableVisible = visible.filter(
    (title) => cardState(title, jobsByTitle.get(title.id), false) === 'selectable',
  )

  function toggle(titleId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(titleId)) next.delete(titleId)
      else next.add(titleId)
      return next
    })
  }

  async function indexSelected() {
    setSubmitting(true)
    setError(null)
    try {
      const result = await post<{ jobs: IndexJob[]; missing: string[] }>('/api/library', {
        titleIds: [...selected],
      })
      setJobs((current) => {
        const merged = new Map(current.map((job) => [job.titleId, job]))
        for (const job of result.jobs) merged.set(job.titleId, job)
        return [...merged.values()]
      })
      setSelected(new Set())
      if (result.missing.length > 0) {
        setError(`${result.missing.length} of those are no longer on the server.`)
      }
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const indexedCount = titles.filter((title) => title.indexed).length

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Add shows and films</h1>
        <p className="mt-1 text-sm text-muted">Pick what you want clips from.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name…"
            aria-label="Filter your library by name"
          />
        </div>
        <div className="flex rounded-lg bg-raised p-0.5">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              className={cx(
                'rounded-md px-2.5 py-1.5 text-xs transition-colors',
                filter === option.value
                  ? 'bg-accent font-medium text-base'
                  : 'text-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Banner>{error}</Banner>}

      {working && (
        <Banner tone="info">
          {jobs.filter((j) => j.status === 'running').map((job) => (
            <span key={job.titleId}>
              Reading {job.titleName} — {job.processedVideos} of {job.totalVideos || '…'}
              {job.currentVideo && ` · ${job.currentVideo}`}
            </span>
          ))}
          {jobs.filter((j) => j.status === 'queued').length > 0 && (
            <span className="text-faint">
              {' '}
              · {jobs.filter((j) => j.status === 'queued').length} waiting
            </span>
          )}
        </Banner>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-faint">
          <span>
            {visible.length} of {total} · {indexedCount} already searchable
          </span>
          {selectableVisible.length > 0 && (
            <button
              onClick={() =>
                setSelected(new Set([...selected, ...selectableVisible.map((title) => title.id)]))
              }
              className="text-muted underline hover:text-ink"
            >
              Select all {selectableVisible.length} shown
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <EmptyState title="Nothing here matches that">
            Try a shorter name.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {visible.map((title) => (
              <TitleCard
                key={title.id}
                title={title}
                state={cardState(title, jobsByTitle.get(title.id), selected.has(title.id))}
                job={jobsByTitle.get(title.id)}
                onToggle={() => toggle(title.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/*
        Fixed rather than inline so choosing the twentieth title does not require
        scrolling back to the top to act on the selection.
      */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> selected
            </p>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="primary" onClick={indexSelected} disabled={submitting}>
                {submitting ? 'Adding…' : `Add ${selected.size}`}
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* Keeps the last row of posters clear of the selection bar. */}
      {selected.size > 0 && <div className="h-14" aria-hidden />}
    </div>
  )
}

function TitleCard({
  title,
  state,
  job,
  onToggle,
}: {
  title: RemoteTitle
  state: CardState
  job: IndexJob | undefined
  onToggle: () => void
}) {
  const poster = (
    <div
      className={cx(
        'relative aspect-[2/3] overflow-hidden rounded-lg bg-raised',
        state === 'selected' && 'ring-2 ring-accent',
        state === 'unusable' && 'opacity-50',
      )}
    >
      {title.imageUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={title.imageUrl}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <span className="grid size-full place-items-center p-2 text-center text-xs text-faint">
          {title.name}
        </span>
      )}

      {state === 'selected' && (
        <span
          className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-accent text-xs font-bold text-base"
          aria-hidden
        >
          ✓
        </span>
      )}
      {state === 'searchable' && (
        <span className="absolute inset-x-0 bottom-0 bg-base/80 px-1.5 py-0.5 text-center text-[11px] text-accent">
          searchable
        </span>
      )}
      {state === 'unusable' && (
        <span className="absolute inset-x-0 bottom-0 bg-base/85 px-1.5 py-0.5 text-center text-[11px] text-danger">
          no subtitles
        </span>
      )}
      {state === 'queued' && (
        <span className="absolute inset-x-0 bottom-0 bg-base/80 px-1.5 py-0.5 text-center text-[11px] text-muted">
          waiting
        </span>
      )}
      {state === 'indexing' && (
        <span className="absolute inset-x-0 bottom-0 bg-base/85 px-1.5 py-0.5 text-center text-[11px] text-accent">
          reading {job?.totalVideos ? `${job.processedVideos}/${job.totalVideos}` : '…'}
        </span>
      )}
    </div>
  )

  const label = (
    <p className="mt-1 line-clamp-2 text-xs text-muted">
      {title.name}
      {title.year && <span className="text-faint"> {title.year}</span>}
    </p>
  )

  // An already-added title is a place to go, not a checkbox — including one with
  // no subtitles yet, whose page is where it gets checked again.
  if (state === 'searchable' || state === 'unusable') {
    return (
      <Link href={`/title/${title.id}`} className="group block text-left">
        {poster}
        <p className="mt-1 line-clamp-2 text-xs text-muted group-hover:text-ink">
          {title.name}
          {title.year && <span className="text-faint"> {title.year}</span>}
        </p>
      </Link>
    )
  }

  if (state === 'queued' || state === 'indexing') {
    return (
      <div className="text-left">
        {poster}
        {label}
      </div>
    )
  }

  return (
    <button
      onClick={onToggle}
      className="block text-left"
      aria-pressed={state === 'selected'}
      aria-label={`${state === 'selected' ? 'Deselect' : 'Select'} ${title.name}`}
    >
      {poster}
      {label}
    </button>
  )
}
