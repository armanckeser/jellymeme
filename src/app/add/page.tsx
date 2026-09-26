import Link from 'next/link'
import { getConnectionInfo, requireJellyfinClient } from '@/lib/jellyfin/server'
import { readLibrary, readRemoteTitles } from '@/lib/queries'
import { AddShowsView } from '@/components/AddShowsView'
import { Banner, Button, EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function AddShowsPage() {
  const { connected } = getConnectionInfo()

  if (!connected) {
    return (
      <EmptyState title="No Jellyfin server connected yet">
        <Link href="/settings" className="mt-3 inline-block">
          <Button variant="primary" size="sm">
            Connect a server
          </Button>
        </Link>
      </EmptyState>
    )
  }

  // Read on the server so the shelf is on screen at first paint. A grid that
  // arrives after a spinner is the same gate as a search box, just slower.
  const shelf = await readRemoteTitles(requireJellyfinClient()).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  )

  if (shelf instanceof Error) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Add shows and films</h1>
        <Banner>{shelf.message}</Banner>
      </div>
    )
  }

  return (
    <AddShowsView
      initialTitles={shelf.titles}
      initialTotal={shelf.total}
      initialJobs={readLibrary().jobs}
    />
  )
}
