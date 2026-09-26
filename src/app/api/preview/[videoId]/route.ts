import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { fail, handler } from '@/lib/api'
import { audioStreamFor } from '@/lib/jellyfin/audio'

export const runtime = 'nodejs'

/**
 * Proxies a browser-playable preview stream from Jellyfin.
 *
 * Two jobs: keep the API key server-side, and let Jellyfin transcode whatever
 * exotic container the library holds into something a <video> element will
 * actually play. Range headers pass through in both directions so the player
 * can seek.
 */
export const GET = handler(
  async (request: Request, { params }: { params: Promise<{ videoId: string }> }) => {
    const { videoId } = await params
    const client = requireJellyfinClient()

    const search = new URL(request.url).searchParams
    const startMs = Number(search.get('start') ?? 0)
    const range = request.headers.get('range')

    const upstream = await fetch(
      client.previewUrl(
        videoId,
        Number.isFinite(startMs) ? startMs : 0,
        undefined,
        await audioStreamFor(client, videoId),
      ),
      {
        headers: range ? { Range: range } : {},
        cache: 'no-store',
      },
    )

    if (!upstream.ok || !upstream.body) {
      return fail(`Jellyfin returned ${upstream.status} for that video`, upstream.status)
    }

    const headers = new Headers()
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has('content-type')) headers.set('content-type', 'video/mp4')

    return new Response(upstream.body, { status: upstream.status, headers })
  },
)
