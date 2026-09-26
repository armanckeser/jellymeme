import { getRender } from '@/lib/render/render'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

export const GET = handler(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const render = getRender(id)
    return render ? json({ render }) : fail('Render not found', 404)
  },
)
