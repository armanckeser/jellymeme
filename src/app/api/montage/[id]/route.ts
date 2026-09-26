import { deleteMontage, getMontage, saveMontage } from '@/lib/montage/build'
import type { Caption, MontageClip } from '@/lib/montage/types'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params
  const montage = getMontage(id)
  return montage ? json({ montage }) : fail('Montage not found', 404)
})

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params
  const body = (await request.json()) as {
    name?: string
    caption?: Caption
    clips?: MontageClip[]
  }

  const updated = saveMontage(id, body)
  return updated ? json({ montage: updated }) : fail('Montage not found', 404)
})

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params
  return deleteMontage(id) ? json({ deleted: true }) : fail('Montage not found', 404)
})
