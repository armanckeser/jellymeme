import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { startIndexJobs } from '@/lib/index/indexer'
import { readLibrary } from '@/lib/queries'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Guard against a request that would queue an entire server by accident. A real
 * library is a couple of hundred titles, so this sits far above any honest
 * selection.
 */
const MAX_TITLES_PER_REQUEST = 500

/** Everything Jellymeme has indexed locally, plus any in-flight index jobs. */
export const GET = handler(async () => json(readLibrary()))

/**
 * Queues indexing for a set of titles.
 *
 * Bulk on purpose: picking a dozen shows off a shelf and pressing one button is
 * the whole point of the browse surface, and the queue runs them one at a time
 * so choosing many costs patience rather than a thrashed machine.
 */
export const POST = handler(async (request: Request) => {
  const body = (await request.json().catch(() => ({}))) as {
    titleIds?: string[]
    force?: boolean
  }

  const titleIds = [...new Set(body.titleIds ?? [])].filter((id) => typeof id === 'string' && id)
  if (titleIds.length === 0) return fail('Pick at least one show or film to index')
  if (titleIds.length > MAX_TITLES_PER_REQUEST) {
    return fail(`That is more than ${MAX_TITLES_PER_REQUEST} titles in one go`)
  }

  const client = requireJellyfinClient()
  const items = await client.items(titleIds)
  if (items.length === 0) return fail('None of those titles exist on the Jellyfin server', 404)

  const jobs = startIndexJobs(client, items, { force: body.force })

  return json({
    jobs,
    // Reported rather than ignored, so the UI can say which of the chosen titles
    // the server did not know about instead of quietly indexing fewer.
    missing: titleIds.filter((id) => !items.some((item) => item.Id === id)),
  })
})
