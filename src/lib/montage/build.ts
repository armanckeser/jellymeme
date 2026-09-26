import { randomUUID } from 'node:crypto'
import { getDb } from '@/lib/db'
import { embed } from '@/lib/search/embed'
import {
  episodesForTitle,
  searchScenesByVector,
  type Preference,
  type SceneMatch,
} from '@/lib/search/search'
import { readSceneRequest, type SceneRequest } from './hints'
import { MAX_DESCRIPTIONS, splitSceneDescriptions } from './split'
import { DEFAULT_CAPTION, newClip, type Caption, type Montage, type MontageClip } from './types'

/** How many candidates to keep per description so "try another match" has somewhere to go. */
const ALTERNATES_PER_CLIP = 6

/** The videos a description named, in the shape search wants them. */
const preferenceFor = (request: SceneRequest): Preference | undefined =>
  request.where ? { videoIds: request.where.videoIds, when: request.when } : undefined

interface MontageRow {
  id: string
  title_id: string
  name: string
  source_text: string
  caption_json: string | null
  clips_json: string
  created_at: number
  updated_at: number
}

const rowToMontage = (row: MontageRow): Montage => ({
  id: row.id,
  titleId: row.title_id,
  name: row.name,
  sourceText: row.source_text,
  // Null only if a row somehow predates the column being added.
  caption: row.caption_json ? (JSON.parse(row.caption_json) as Caption) : DEFAULT_CAPTION,
  clips: JSON.parse(row.clips_json) as MontageClip[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/**
 * Turns pasted text into a montage draft.
 *
 * Every description becomes a clip using its best match, with alternates
 * attached. Nothing blocks on user input: the montage is watchable immediately
 * and the editor is for fixing the ones that landed wrong. Descriptions that
 * match nothing still become clips, flagged with no alternates, so the user can
 * see what failed rather than silently losing a line.
 */
export async function buildMontage(
  titleId: string,
  sourceText: string,
  name?: string,
  /**
   * The descriptions to use, when the caller has already reviewed them. Omit to
   * split `sourceText` here — the raw paste is stored either way, so a montage
   * always records what it was made from rather than only what survived.
   */
  reviewed?: string[],
): Promise<Montage> {
  // Loaded once for the whole paste: the episode list is what tells a quoted
  // episode title from quoted dialogue, and it is the same list for every line.
  const episodes = episodesForTitle(titleId)
  const descriptions = reviewed
    ? reviewed.map((line) => line.trim()).filter(Boolean).slice(0, MAX_DESCRIPTIONS)
    : splitSceneDescriptions(sourceText, { episodes })

  const requests = descriptions.map((description) => readSceneRequest(description, episodes))
  // What gets embedded is the description with any episode title removed, not the
  // raw line. The title was the half that matched no dialogue.
  const vectors = await embed(requests.map((request) => request.text))

  const clips: MontageClip[] = requests.map((request, i) => newClip({
    // The user's own words, not what we searched for, because this is what the
    // editor shows them next to the clip.
    description: descriptions[i],
    where: request.where,
    alternates: searchScenesByVector(
      titleId,
      vectors[i],
      ALTERNATES_PER_CLIP,
      preferenceFor(request),
      // Same text that was embedded, so a pasted line naming an unusual word
      // reaches it lexically as well as semantically.
      request.text,
    ),
  }))

  const now = Date.now()
  const montage: Montage = {
    id: randomUUID(),
    titleId,
    name: name?.trim() || `Montage ${new Date(now).toLocaleString()}`,
    sourceText,
    caption: DEFAULT_CAPTION,
    clips,
    createdAt: now,
    updatedAt: now,
  }

  getDb()
    .prepare(
      `INSERT INTO montage (id, title_id, name, source_text, caption_json, clips_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      montage.id,
      montage.titleId,
      montage.name,
      montage.sourceText,
      JSON.stringify(montage.caption),
      JSON.stringify(montage.clips),
      montage.createdAt,
      montage.updatedAt,
    )

  return montage
}

/**
 * Creates a montage from scenes already chosen in the search results.
 *
 * The common case is one moment, trimmed exactly right. But one query often
 * answers a whole cut — every time anyone says "never seen it" — so the results
 * screen lets you tick several, and each ticked scene becomes a clip here, in
 * the order the results listed them.
 *
 * Every clip gets the same candidate list, differing only in which one it
 * starts on, so "Not this one" works on a clip that came from a tick exactly as
 * it does on one that came from a paste. They also share the one description,
 * because they do share it: the query is what all of them are.
 */
export function buildChosenScenesMontage(
  titleId: string,
  description: string,
  alternates: SceneMatch[],
  alternateIndexes: number[] = [0],
  name?: string,
): Montage {
  const now = Date.now()
  const chosen = alternateIndexes.map((index) => alternates[index])

  const montage: Montage = {
    id: randomUUID(),
    titleId,
    name: name?.trim() || chosenScenesName(description, chosen),
    sourceText: description,
    caption: DEFAULT_CAPTION,
    clips: alternateIndexes.map((alternateIndex) =>
      newClip({ description, alternates, alternateIndex }),
    ),
    createdAt: now,
    updatedAt: now,
  }

  getDb()
    .prepare(
      `INSERT INTO montage (id, title_id, name, source_text, caption_json, clips_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      montage.id,
      montage.titleId,
      montage.name,
      montage.sourceText,
      JSON.stringify(montage.caption),
      JSON.stringify(montage.clips),
      montage.createdAt,
      montage.updatedAt,
    )

  return montage
}

/**
 * What to call a cut made out of search results.
 *
 * One scene is named by where it is, because that is what distinguishes it from
 * the others you might have taken. Several are named by what you searched for,
 * because that is the only thing they have in common — and a list of five
 * timestamps is not a name.
 */
function chosenScenesName(description: string, chosen: (SceneMatch | undefined)[]): string {
  const query = description.trim()
  if (chosen.length > 1) {
    return query ? `${query} · ${chosen.length} scenes` : `${chosen.length} scenes`
  }
  const only = chosen[0]
  return only ? `${only.videoName} · ${formatClock(only.startMs)}` : 'Untitled clip'
}

function formatClock(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function getMontage(id: string): Montage | null {
  const row = getDb().prepare('SELECT * FROM montage WHERE id = ?').get(id) as
    | MontageRow
    | undefined
  return row ? rowToMontage(row) : null
}

export function listMontages(titleId?: string): Montage[] {
  const db = getDb()
  const rows = (
    titleId
      ? db.prepare('SELECT * FROM montage WHERE title_id = ? ORDER BY updated_at DESC').all(titleId)
      : db.prepare('SELECT * FROM montage ORDER BY updated_at DESC').all()
  ) as MontageRow[]
  return rows.map(rowToMontage)
}

export function saveMontage(
  id: string,
  patch: { name?: string; caption?: Caption; clips?: MontageClip[] },
): Montage | null {
  const existing = getMontage(id)
  if (!existing) return null

  const updated: Montage = {
    ...existing,
    name: patch.name ?? existing.name,
    caption: patch.caption ?? existing.caption,
    clips: patch.clips ?? existing.clips,
    updatedAt: Date.now(),
  }

  getDb()
    .prepare(
      'UPDATE montage SET name = ?, caption_json = ?, clips_json = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      updated.name,
      JSON.stringify(updated.caption),
      JSON.stringify(updated.clips),
      updated.updatedAt,
      id,
    )

  return updated
}

export function deleteMontage(id: string): boolean {
  return getDb().prepare('DELETE FROM montage WHERE id = ?').run(id).changes > 0
}
