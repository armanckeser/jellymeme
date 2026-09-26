import { getDb } from '@/lib/db'
import { searchScenes } from '@/lib/search/search'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Searches dialogue directly, with no montage involved.
 *
 * This backs the "find one scene" flow, which is the common case: you want a
 * single moment, not a supercut. Omit `titleId` to search every indexed title —
 * for the half-remembered line that does not come with a show attached.
 */
export const POST = handler(async (request: Request) => {
  const { titleId, query, limit } = (await request.json()) as {
    titleId?: string
    query?: string
    limit?: number
  }

  if (!query?.trim()) return fail('Describe the scene you are looking for')

  const db = getDb()

  if (!titleId) {
    // Without a title the guard is library-wide, so an empty result still says
    // why rather than looking like nothing matched.
    const { total } = db.prepare('SELECT COALESCE(SUM(line_count), 0) AS total FROM title').get() as {
      total: number
    }
    if (total === 0) {
      return fail('Nothing is indexed yet. Add a show or film first.', 409)
    }
    return json(await searchScenes(null, query, Math.min(limit ?? 8, 25)))
  }

  const title = db.prepare('SELECT line_count FROM title WHERE id = ?').get(titleId) as
    | { line_count: number }
    | undefined

  if (!title) return fail('That title has not been indexed yet', 404)
  if (title.line_count === 0) {
    return fail('That title has no indexed dialogue yet. Run indexing first.', 409)
  }

  return json(await searchScenes(titleId, query, Math.min(limit ?? 8, 25)))
})
