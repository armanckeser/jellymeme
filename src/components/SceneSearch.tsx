'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { post } from '@/lib/client-api'
import { Banner, Button, Card, Input, cx, episodeLabel, formatTime } from '@/components/ui'
import type { SceneMatch } from '@/lib/search/search'
import { alternatesForTitle, type Montage } from '@/lib/montage/types'

/**
 * The search entry point.
 *
 * Describe one moment, watch the candidates in place, take the one that is
 * right. It creates a one-clip cut so the editor, captioning and export paths
 * are shared with the paste flow rather than duplicated.
 *
 * One query is not always one scene, though. A line a show keeps coming back to
 * — "never seen it" — is a whole cut on its own, and the way to that used to be
 * pasting the same sentence several times and hoping the matcher handed back
 * different moments. So results can also be ticked: take as many as you want and
 * they become the clips of one cut, in the order they are listed.
 *
 * The candidates deliberately no longer show a match percentage. It was a cosine
 * distance dressed up as a confidence score, and the only question a reader has
 * is "is this the scene I meant" — which the dialogue answers and a number
 * cannot.
 *
 * With no `titleId` it searches the whole library, which is how it is used where
 * no show has been picked yet.
 */
type Scope = 'title' | 'everything'

export function SceneSearch({ titleId, disabled }: { titleId?: string; disabled: boolean }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SceneMatch[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [creating, setCreating] = useState<number | 'cut' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<number | null>(null)
  // Indexes into `matches`. Held as a set so ticking is order-free, and read back
  // in result order so the cut runs top to bottom as the screen reads, however
  // you got there.
  const [picked, setPicked] = useState<Set<number>>(new Set())
  // Narrowing to the show you are on is both sharper and what you usually want;
  // widening is a deliberate act, for the line that came without a title.
  const [scope, setScope] = useState<Scope>('title')

  const searchingEverything = !titleId || scope === 'everything'

  // The show the ticked scenes belong to, since a cut holds exactly one. Null
  // until the first tick, which is what makes the first pick the one that decides.
  const pickedTitleId = matches
    ? (matches[[...picked].sort((a, b) => a - b)[0] ?? -1]?.titleId ?? null)
    : null

  async function search(event: React.FormEvent) {
    event.preventDefault()
    setSearching(true)
    setError(null)
    setPreviewing(null)
    // Indexes into a result list mean nothing once the list changes underneath
    // them, and silently carrying ticks from the last query into this one would
    // put scenes nobody chose into the cut.
    setPicked(new Set())
    try {
      const data = await post<{ matches: SceneMatch[] }>('/api/scenes', {
        titleId: searchingEverything ? undefined : titleId,
        query,
        limit: 8,
      })
      setMatches(data.matches)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  function togglePick(index: number) {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  /**
   * Builds a cut out of the given results, one clip each.
   *
   * The same call whether it is the one scene a row's own button names or every
   * scene that has been ticked — a single clip is not a different kind of cut,
   * it is a cut with one clip in it.
   */
  async function makeCut(indexes: number[], pending: number | 'cut') {
    if (!matches || indexes.length === 0) return
    setCreating(pending)
    setError(null)
    try {
      // A cut holds one show, so only the candidates from the chosen scenes' own
      // show travel with it — otherwise "Not this one" would swap in a clip from
      // somewhere else entirely.
      const scoped = alternatesForTitle(matches, indexes)
      if (!scoped) throw new Error('That scene is no longer available')

      const { montage } = await post<{ montage: Montage }>('/api/montage', {
        titleId: scoped.titleId,
        matches: scoped.alternates,
        matchIndexes: scoped.alternateIndexes,
        description: query,
      })
      router.push(`/montage/${montage.id}`)
    } catch (e) {
      setError((e as Error).message)
      setCreating(null)
    }
  }

  return (
    <div className="space-y-3">
      {/* Above the box, because it qualifies what you are about to type. */}
      {titleId && (
        <div
          className="flex w-fit rounded-lg bg-raised p-0.5"
          role="group"
          aria-label="Where to search"
        >
          {(
            [
              ['title', 'In this show'],
              ['everything', 'Everything indexed'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              aria-pressed={scope === value}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                scope === value ? 'bg-accent font-medium text-base' : 'text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={search} className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="“when he puts his foot on the grill”"
          aria-label="Describe the moment you want"
          disabled={disabled}
        />
        <Button type="submit" variant="primary" disabled={searching || disabled || !query.trim()}>
          {searching ? 'Looking…' : 'Find it'}
        </Button>
      </form>

      {error && <Banner>{error}</Banner>}

      {matches?.length === 0 && (
        <p className="py-6 text-center text-sm text-faint">
          {searchingEverything
            ? 'Nothing in any indexed show matched that. Try what someone says, or what happens.'
            : 'Nothing in this show matched that. Try searching everything indexed, or describe what someone says.'}
        </p>
      )}

      {matches && matches.length > 0 && (
        <Card className="divide-y divide-line">
          {matches.map((match, index) => {
            const chosen = picked.has(index)
            // A cut holds one show. Rather than let a tick across shows fail at
            // the end, the rows that cannot join the cut say so while it is
            // being built.
            const otherShow = pickedTitleId !== null && match.titleId !== pickedTitleId

            return (
              <div key={match.lineId} className={cx('p-3', chosen && 'bg-raised/50')}>
                <div className="flex gap-3">
                  <input
                    type="checkbox"
                    checked={chosen}
                    onChange={() => togglePick(index)}
                    disabled={otherShow || creating !== null}
                    title={
                      otherShow
                        ? `A cut holds one show, and this one is from ${match.titleName}`
                        : undefined
                    }
                    aria-label={`Add ${episodeLabel(match.season, match.episode, match.videoName)} at ${formatTime(match.startMs)} to the cut`}
                    className="mt-0.5 size-4 shrink-0 accent-accent disabled:opacity-40"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        {/* Which show, but only when the answer was not a given. */}
                        {searchingEverything && (
                          <p className="truncate text-xs text-accent">{match.titleName}</p>
                        )}
                        <p className="truncate text-sm font-medium">
                          {episodeLabel(match.season, match.episode, match.videoName)}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-faint">
                        {formatTime(match.startMs)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-sm text-muted">{match.text}</p>
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => makeCut([index], index)}
                        disabled={creating !== null}
                      >
                        {creating === index ? 'Opening…' : 'This is the one'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPreviewing(previewing === index ? null : index)}
                      >
                        {previewing === index ? 'Hide' : 'Watch it first'}
                      </Button>
                    </div>

                    {previewing === index && (
                      <video
                        // A couple of seconds of lead-in so the moment has context.
                        src={`/api/preview/${match.videoId}?start=${Math.max(0, match.startMs - 2000)}`}
                        controls
                        autoPlay
                        className="mt-3 max-h-64 w-full rounded-lg bg-base"
                      />
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </Card>
      )}

      {/*
       * Only once something is ticked. An empty bar sitting under every search
       * would be one more thing to read on the way to the common answer, which
       * is still a single scene.
       */}
      {picked.size > 0 && (
        <div className="sticky bottom-3 flex items-center gap-3 rounded-card border border-accent/40 bg-surface px-3.5 py-2.5 shadow-lg">
          <p className="min-w-0 flex-1 text-sm text-muted">
            {picked.size} {picked.size === 1 ? 'scene' : 'scenes'} picked
          </p>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={creating !== null}>
            Clear
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => makeCut([...picked].sort((a, b) => a - b), 'cut')}
            disabled={creating !== null}
          >
            {creating === 'cut' ? 'Building…' : 'Cut these together'}
          </Button>
        </div>
      )}
    </div>
  )
}
