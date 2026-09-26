import 'server-only'
import { getDb } from '@/lib/db'
import { JellyfinClient } from './client'

/**
 * The audio stream clips of a video should carry, or undefined for the default.
 *
 * Read from the index when it recorded one. Videos indexed before the column
 * existed are looked up once and the answer stored, so a library does not need
 * re-indexing to stop playing dubs.
 */
export async function audioStreamFor(
  client: JellyfinClient,
  videoId: string,
): Promise<number | undefined> {
  const db = getDb()
  const row = db.prepare('SELECT audio_index FROM video WHERE id = ?').get(videoId) as
    | { audio_index: number | null }
    | undefined

  let index = row?.audio_index ?? null
  if (index === null) {
    const item = await client.item(videoId)
    index = JellyfinClient.pickAudioStream(item?.MediaSources) ?? -1
    db.prepare('UPDATE video SET audio_index = ? WHERE id = ?').run(index, videoId)
  }
  return index >= 0 ? index : undefined
}
