import { buildMontage, buildChosenScenesMontage } from '@/lib/montage/build'
import { getDb } from '@/lib/db'
import { readMontageSummaries } from '@/lib/queries'
import { fail, handler, json } from '@/lib/api'
import { splitSceneDescriptions } from '@/lib/montage/split'
import { alternatesForTitle } from '@/lib/montage/types'
import type { SceneMatch } from '@/lib/search/search'

export const runtime = 'nodejs'

export const GET = handler(async (request: Request) => {
  const titleId = new URL(request.url).searchParams.get('titleId') ?? undefined
  return json({ montages: readMontageSummaries(titleId) })
})

/**
 * The refusal for a title nothing can be built from, or null when it is fine.
 *
 * "Not indexed" and "indexed but no readable subtitles" are different problems
 * with different fixes, and both entry points below have to say which one it is.
 */
function unusableTitle(titleId: string): Response | null {
  const title = getDb().prepare('SELECT line_count FROM title WHERE id = ?').get(titleId) as
    | { line_count: number }
    | undefined

  if (!title) return fail('That title has not been indexed yet', 404)
  if (title.line_count === 0) {
    return fail('That title has no indexed dialogue yet. Run indexing first.', 409)
  }
  return null
}

/**
 * Creates a montage, from either entry point:
 *
 * - `text`: paste a list of descriptions, every one becomes a clip
 * - `matches`: scenes already chosen from the search flow, one clip each
 */
export const POST = handler(async (request: Request) => {
  const { titleId, text, descriptions, name, matches, matchIndex, matchIndexes, description } =
    (await request.json()) as {
      titleId?: string
      text?: string
      /** Already reviewed by the user, so this is used instead of splitting `text`. */
      descriptions?: string[]
      name?: string
      matches?: SceneMatch[]
      matchIndex?: number
      /** Several ticked results, in the order to cut them. Wins over `matchIndex`. */
      matchIndexes?: number[]
      description?: string
    }

  if (matches?.length) {
    const inRange = (index: number) => Number.isInteger(index) && index >= 0 && index < matches.length
    // One index and a list of them are the same request with a different number
    // of scenes in it, so the list is the shape the rest of this works in.
    const chosenIndexes = (matchIndexes ?? [matchIndex ?? 0]).filter(inRange)
    if (chosenIndexes.length === 0) return fail('Pick a scene to build from')

    /*
     * The title is taken from the chosen scenes, not from the request.
     *
     * A library-wide search returns candidates from several shows while a cut
     * holds exactly one, so deriving the title here — and dropping the
     * candidates that belong to other shows — is what stops a montage being
     * filed under a title none of its footage came from. The browser does the
     * same filtering for its own sake; this is the copy that has to be right.
     */
    const scoped = alternatesForTitle(matches, chosenIndexes)
    if (!scoped) return fail('That scene is no longer available')

    const refusal = unusableTitle(scoped.titleId)
    if (refusal) return refusal

    return json({
      montage: buildChosenScenesMontage(
        scoped.titleId,
        description?.trim() || '',
        scoped.alternates,
        scoped.alternateIndexes,
        name,
      ),
    })
  }

  if (!titleId) return fail('Pick a show or movie first')
  const refusal = unusableTitle(titleId)
  if (refusal) return refusal

  if (!text?.trim()) return fail('Paste some scene descriptions to build a montage from')

  // The browser splits the paste as you type and shows the result for approval, so
  // when it sends a reviewed list that list wins. Splitting again here would
  // reinstate the entries the user just unticked.
  const reviewed = descriptions?.map((line) => line.trim()).filter(Boolean)
  if (reviewed?.length === 0) return fail('Nothing is selected to search for')

  if (!reviewed && splitSceneDescriptions(text).length === 0) {
    return fail('Could not find any scene descriptions in that text')
  }

  return json({ montage: await buildMontage(titleId, text, name, reviewed) })
})
