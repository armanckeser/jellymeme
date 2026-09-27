'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client-api'
import { SceneSearch } from '@/components/SceneSearch'
import { Button, Card, ProgressBar, cx } from '@/components/ui'
import type { IndexJob } from '@/lib/index/indexer'
import type { LibrarySnapshot, LibraryTitle, MontageSummary } from '@/lib/queries'

/**
 * The first thing you see.
 *
 * Two questions get answered without a click: what can I search, and what was I
 * in the middle of making. Adding a show is a separate surface because you do it
 * rarely, and it used to be the only thing on this page — a search box that
 * returned nothing until you typed, above a list of what you already had.
 */
export function LibraryView({
  initialTitles,
  initialJobs,
  montages,
}: {
  initialTitles: LibraryTitle[]
  initialJobs: IndexJob[]
  montages: MontageSummary[]
}) {
  const [titles, setTitles] = useState(initialTitles)
  const [jobs, setJobs] = useState(initialJobs)

  // Titles with no readable subtitles cannot be searched, so they are not part of
  // the promise made below.
  const searchable = titles.filter((title) => title.lineCount > 0).length

  const refresh = useCallback(async () => {
    const snapshot = await api<LibrarySnapshot>('/api/library')
    setTitles(snapshot.titles)
    setJobs(snapshot.jobs)
  }, [])

  // Poll only while something is indexing, then stop.
  const working = jobs.some((job) => job.status === 'running' || job.status === 'queued')
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => {
      refresh().catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [working, refresh])

  if (titles.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-5 py-12 text-center">
        <h1 className="text-2xl font-semibold">Find any scene by describing it</h1>
        <p className="text-sm text-muted">Add a few shows to start searching them.</p>
        <Link href="/add" className="inline-block">
          <Button variant="primary">Add shows</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">What do you want a clip from?</h1>
          <p className="mt-1 text-sm text-muted">
            {titles.length} {titles.length === 1 ? 'title' : 'titles'}
          </p>
        </div>
        <Link href="/add">
          <Button size="sm">Add more</Button>
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {titles.map((title) => (
          <TitleTile
            key={title.id}
            title={title}
            job={jobs.find((job) => job.titleId === title.id && job.status !== 'done')}
          />
        ))}
      </div>

      {/*
        Below the grid on purpose. The grid is this page's answer to "what can I
        search"; this is the shortcut for the rarer case where you remember the
        line but not which show it is from, and putting a search box at the top of
        this page is the arrangement the redesign removed.
      */}
      {searchable > 1 && (
        <section className="space-y-2 border-t border-line pt-6">
          <h2 className="text-sm font-semibold">Search all {searchable} shows</h2>
          <SceneSearch disabled={false} />
        </section>
      )}

      {montages.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted">Pick up where you left off</h2>
          <Card className="divide-y divide-line">
            {montages.slice(0, 6).map((montage) => (
              <Link
                key={montage.id}
                href={`/montage/${montage.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{montage.name}</p>
                  <p className="truncate text-xs text-faint">
                    {montage.titleName} · {montage.clipCount}{' '}
                    {montage.clipCount === 1 ? 'clip' : 'clips'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-faint">
                  {new Date(montage.updatedAt).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </Card>
        </section>
      )}
    </div>
  )
}

function TitleTile({ title, job }: { title: LibraryTitle; job: IndexJob | undefined }) {
  const unusable = title.lineCount === 0 && !job

  const tile = (
    <>
      <div
        className={cx(
          'relative aspect-[2/3] overflow-hidden rounded-lg bg-raised transition-colors',
          unusable && 'opacity-50',
          'group-hover:ring-2 group-hover:ring-accent/60',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/image/${title.id}?h=300`}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
        {job?.status === 'running' && (
          <div className="absolute inset-x-0 bottom-0 space-y-1 bg-base/85 px-2 py-1.5">
            <ProgressBar value={job.totalVideos ? job.processedVideos / job.totalVideos : 0} />
            <p className="truncate text-[11px] text-muted">
              reading {job.processedVideos}/{job.totalVideos || '…'}
            </p>
          </div>
        )}
        {job?.status === 'queued' && (
          <span className="absolute inset-x-0 bottom-0 bg-base/80 px-2 py-1 text-center text-[11px] text-muted">
            waiting to be read
          </span>
        )}
        {unusable && (
          <span className="absolute inset-x-0 bottom-0 bg-base/85 px-2 py-1 text-center text-[11px] text-danger">
            no usable subtitles
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm">{title.name}</p>
      <p className="text-xs text-faint">
        {unusable
          ? 'nothing to search'
          : `${title.lineCount.toLocaleString()} passages${
              title.videosWithoutSubtitles > 0
                ? ` · ${title.videosWithoutSubtitles} skipped`
                : ''
            }`}
      </p>
    </>
  )

  // Still a link when there is nothing to search: subtitles can arrive after the
  // title was added (Bazarr, Jellyfin's OpenSubtitles, a better release), and the
  // title page is where it gets checked again.
  return (
    <Link href={`/title/${title.id}`} className="group block">
      {tile}
    </Link>
  )
}
