import { getRender } from '@/lib/render/render'
import { fail, handler, serveFile } from '@/lib/api'

export const runtime = 'nodejs'

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  gif: 'image/gif',
  webm: 'video/webm',
  png: 'image/png',
  jpg: 'image/jpeg',
}

/** Serves a finished render, with range support so the preview player can seek. */
export const GET = handler(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const render = getRender(id)

    if (!render) return fail('Render not found', 404)
    if (render.status !== 'done' || !render.filePath) {
      return fail(`Render is ${render.status}`, 409)
    }

    return serveFile(request, render.filePath, {
      contentType: MIME[render.format] ?? 'application/octet-stream',
      filename: `jellymeme-${id.slice(0, 8)}.${render.format}`,
      disposition: new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline',
      // A render's bytes never change, but it can be deleted; revalidate cheaply.
      cacheControl: 'private, no-cache',
    })
  },
)
