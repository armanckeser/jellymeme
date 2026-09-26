import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { readRemoteTitles } from '@/lib/queries'
import { handler, json } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Everything on the Jellyfin server, annotated with what Jellymeme has
 * indexed.
 *
 * Returned unfiltered by default. Deciding what to make searchable is a
 * browsing job — you look over your shelf and pick — so the whole shelf comes
 * down at once and filtering happens in the browser.
 */
export const GET = handler(async (request: Request) => {
  const query = new URL(request.url).searchParams.get('q') ?? undefined
  return json(await readRemoteTitles(requireJellyfinClient(), query))
})
