import { requireJellyfinClient } from '@/lib/jellyfin/server'
import {
  cancelJob,
  removeTitleIndex,
  startIndexJob,
  titleRemovalCost,
} from '@/lib/index/indexer'
import { readTitleDetail } from '@/lib/queries'
import { fail, handler, json } from '@/lib/api'

export const runtime = 'nodejs'

type Ctx = { params: Promise<{ titleId: string }> }

/** Index status for one title, including which episodes had no usable subtitles. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { titleId } = await params
  return json(readTitleDetail(titleId))
})

/** Starts (or restarts) indexing for a title. */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { titleId } = await params
  const client = requireJellyfinClient()

  const body = (await request.json().catch(() => ({}))) as { force?: boolean }
  const item = await client.item(titleId)
  if (!item?.Id) return fail('That title no longer exists on the Jellyfin server', 404)

  return json({ job: startIndexJob(client, item, { force: body.force }) })
})

/**
 * Cancels a running index job, or removes the local index when idle.
 *
 * Removing an index cascades into every cut made from the title, so it will not
 * do that silently: without `confirm=1` it reports what would be lost and
 * changes nothing. Losing an afternoon's editing to an unlabelled button is not
 * a recoverable mistake — the render files are deleted too.
 */
export const DELETE = handler(async (request: Request, { params }: Ctx) => {
  const { titleId } = await params
  const params_ = new URL(request.url).searchParams

  if (params_.get('action') === 'cancel') {
    return json({ cancelled: cancelJob(titleId) })
  }

  const cost = titleRemovalCost(titleId)
  if (cost.montages > 0 && params_.get('confirm') !== '1') {
    return json(
      {
        error: `That would also delete ${cost.montages} ${
          cost.montages === 1 ? 'cut' : 'cuts'
        } made from this title, and ${cost.renders} exported ${
          cost.renders === 1 ? 'file' : 'files'
        }. Repeat with confirm=1 to go ahead.`,
        ...cost,
      },
      { status: 409 },
    )
  }

  await removeTitleIndex(titleId)
  return json({ deleted: true, ...cost })
})
