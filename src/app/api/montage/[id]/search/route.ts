import { getMontage } from '@/lib/montage/build'
import { searchScenes } from '@/lib/search/search'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Re-runs the search for one clip with different wording.
 *
 * This is the escape hatch when the pasted description was too vague: the user
 * rewrites it in their own words and gets a fresh set of candidates.
 */
export const POST = handler(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { query, limit } = (await request.json()) as { query?: string; limit?: number }

    if (!query?.trim()) return fail('Enter something to search for')

    const montage = getMontage(id)
    if (!montage) return fail('Montage not found', 404)

    return json(await searchScenes(montage.titleId, query, Math.min(limit ?? 6, 20)))
  },
)
