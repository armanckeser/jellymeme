import { getMontage } from '@/lib/montage/build'
import { requireJellyfinClient } from '@/lib/jellyfin/server'
import { latestRenderFor, startRender } from '@/lib/render/render'
import { DEFAULT_RENDER_SETTINGS, isStillFormat, type RenderSettings } from '@/lib/montage/types'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

const FORMATS = new Set(['mp4', 'gif', 'webm', 'png', 'jpg'])

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params
  return json({ render: latestRenderFor(id) })
})

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params
  const montage = getMontage(id)
  if (!montage) return fail('Montage not found', 404)

  const body = (await request.json().catch(() => ({}))) as Partial<RenderSettings>

  const format = body.format ?? DEFAULT_RENDER_SETTINGS.format
  if (!FORMATS.has(format)) return fail(`Unsupported output format: ${format}`)

  const still = isStillFormat(format)

  const settings: RenderSettings = {
    format,
    // GIFs get big fast, so clamp harder than video.
    maxWidth: Math.min(Math.max(body.maxWidth ?? (format === 'gif' ? 480 : 720), 160), 1920),
    fps: Math.min(Math.max(body.fps ?? (format === 'gif' ? 15 : 24), 5), 60),
    // A still has no audio to strip, and a GIF never carries any.
    stripAudio: still || (body.stripAudio ?? format === 'gif'),
    frameMs: Math.max(0, body.frameMs ?? 0),
  }

  const client = requireJellyfinClient()
  return json({ render: startRender(montage, settings, client) })
})
