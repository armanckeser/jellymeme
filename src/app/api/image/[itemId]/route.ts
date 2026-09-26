import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { handler } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Proxies artwork from Jellyfin so the API key never reaches the browser.
 */
/** Bounds what a caller can make Jellyfin resize to. */
const MAX_HEIGHT = 800
const DEFAULT_HEIGHT = 400

export const GET = handler(
  async (request: Request, { params }: { params: Promise<{ itemId: string }> }) => {
    const { itemId } = await params
    const client = requireJellyfinClient()

    // The browse grid shows the whole library at once, so it asks for small
    // posters; a full-size one per title is megabytes of pointless downscaling.
    const requestedHeight = Number(new URL(request.url).searchParams.get('h'))
    const maxHeight = Number.isFinite(requestedHeight)
      ? Math.min(MAX_HEIGHT, Math.max(40, requestedHeight))
      : DEFAULT_HEIGHT

    const upstream = await fetch(client.imageUrl(itemId, maxHeight), { cache: 'no-store' })
    if (!upstream.ok || !upstream.body) {
      return new Response(null, { status: 404 })
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
      },
    })
  },
)
