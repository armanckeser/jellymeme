import Link from 'next/link'
import { getConnectionInfo } from '@/lib/jellyfin/server'
import { readLibrary, readMontageSummaries } from '@/lib/queries'
import { LibraryView } from '@/components/LibraryView'
import { Button } from '@/components/ui'

// Reads live index state on every visit.
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const { connected } = getConnectionInfo()

  if (!connected) {
    return (
      <div className="mx-auto max-w-lg space-y-5 py-12 text-center">
        <h1 className="text-2xl font-semibold">Find any scene by describing it</h1>
        <p className="text-sm text-muted">
          Jellymeme reads the subtitles in your Jellyfin library, so you can ask for the moment you
          half-remember and get the clip. It talks to Jellyfin over its API and never needs access to
          your files.
        </p>
        <Link href="/settings" className="inline-block">
          <Button variant="primary">Connect your Jellyfin server</Button>
        </Link>
      </div>
    )
  }

  const { titles, jobs } = readLibrary()
  return <LibraryView initialTitles={titles} initialJobs={jobs} montages={readMontageSummaries()} />
}
