import { getDb, toVectorBlob } from '@/lib/db'
import { readSceneRequest, type EpisodeRef, type SceneRequest, type When } from '@/lib/montage/hints'
import { embed } from './embed'

export interface SceneMatch {
  lineId: number
  /** Which show or film this came from. Carried because a search may span the library. */
  titleId: string
  titleName: string
  videoId: string
  videoName: string
  season: number | null
  episode: number | null
  startMs: number
  endMs: number
  text: string
  /** 0–1, higher is better. Derived from cosine distance. */
  score: number
}

interface VecRow {
  rowid: number
  distance: number
}

interface LineRow {
  id: number
  video_id: string
  start_ms: number
  end_ms: number
  text: string
  name: string
  season: number | null
  episode: number | null
  title_id: string
  title_name: string
  runtime_ms: number | null
}

const LINE_COLUMNS = `l.id, l.video_id, l.start_ms, l.end_ms, l.text,
              v.name, v.season, v.episode, v.runtime_ms,
              t.id AS title_id, t.name AS title_name`

/**
 * Two windows this close together are the same moment seen through a different
 * window boundary, not two different scenes. Used to keep alternates distinct.
 */
const DISTINCT_MOMENT_MS = 20_000

/** Videos a description named, and where in them to look. Preferred, never required. */
export interface Preference {
  videoIds: string[]
  when: When | null
}

/** A search's results together with what it understood the query to be asking for. */
export interface SceneSearch {
  matches: SceneMatch[]
  request: SceneRequest
}

/**
 * How much of an episode counts as its opening or its ending.
 *
 * A position claim is handled the same way an episode claim is — as a partition,
 * not a nudge — because it is the same kind of statement: the user said where.
 * "The ending scene to Beach House" carries no information about what is *said*,
 * so scores inside the episode cluster tightly and a weighting small enough to be
 * safe is also too small to do anything. Measured on the real index, the spread
 * within one episode for a query like that is around 0.09, wider than any bonus
 * that would not otherwise distort ranking.
 *
 * Out-of-band candidates still follow immediately behind, so a misremembered
 * position costs one press of "Not this one" rather than the scene.
 */
const POSITION_BAND = 0.15

/**
 * Sorts the stretch of episode a description pointed at ahead of the rest.
 *
 * This has to be part of the ORDER BY rather than applied to the rows that come
 * back, or the LIMIT picks by score first and position is left to reshuffle
 * whatever happened to survive. Measured: partitioning afterwards, "the closing
 * scene of s5 e3" returned a line 75% of the way through Japan, because no line
 * from the last 15% of it was among the forty best-scoring.
 *
 * Interpolated rather than bound because it is a constant declared above, and an
 * unknown runtime sorts as out of band rather than as position zero.
 */
const POSITION_RANK: Record<When, string> = {
  opening: `CASE WHEN v.runtime_ms > 0 AND l.start_ms <= v.runtime_ms * ${POSITION_BAND} THEN 0 ELSE 1 END`,
  ending: `CASE WHEN v.runtime_ms > 0 AND l.start_ms >= v.runtime_ms * ${1 - POSITION_BAND} THEN 0 ELSE 1 END`,
}

/** Episodes as the hint parser needs them. Lives here because build.ts needs it too, and cannot import queries.ts. */
export function episodesForTitle(titleId: string | null): EpisodeRef[] {
  const db = getDb()
  const columns = 'SELECT id, name, season, episode FROM video'
  return (
    titleId === null
      ? db.prepare(`${columns} ORDER BY season, episode`).all()
      : db.prepare(`${columns} WHERE title_id = ? ORDER BY season, episode`).all(titleId)
  ) as EpisodeRef[]
}

function toMatch(row: LineRow, distance: number): SceneMatch {
  return {
    lineId: row.id,
    titleId: row.title_id,
    titleName: row.title_name,
    videoId: row.video_id,
    videoName: row.name,
    season: row.season,
    episode: row.episode,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    // vec0 cosine distance runs 0 (identical) to 2 (opposite).
    score: Math.max(0, 1 - distance / 2),
  }
}

/**
 * Reciprocal-rank-fusion constant. 60 is the value from the original paper and
 * the usual default; it is large enough that the top few ranks of one list do
 * not swamp the other, which is the whole point of fusing them.
 */
const RRF_K = 60

/**
 * How much a keyword hit counts relative to a semantic one.
 *
 * Above 1 because the two lists are not comparable in confidence. The vector
 * list is every nearest neighbour, however mediocre — at k=40 it always returns
 * forty rows even when nothing in the show is remotely related. The keyword
 * list has already been filtered to terms above `LEXICAL_MIN_IDF`, so anything
 * in it is an exact match on a word rare enough to be worth overriding
 * semantics for.
 *
 * Without this the two top ranks tie at 1/(K+1) and the tie-break decides,
 * which put the sole "copacetic" line second to an unrelated nearest neighbour
 * for the query "copacetic" — findable, but not the answer.
 */
const LEXICAL_WEIGHT = 1.5

/**
 * Words too common to narrow anything down.
 *
 * Kept deliberately short. BM25 already discounts frequent terms by their
 * document frequency, so this is not the mechanism that stops "the" mattering —
 * it only keeps the MATCH expression from being mostly noise, and keeps a query
 * that is *entirely* stopwords ("the one where") from matching every line in
 * the library at equal weight.
 */
const FTS_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'he', 'her',
  'him', 'his', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'she', 'so',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'were', 'when', 'where',
  'which', 'who', 'with', 'you', 'your',
])

/**
 * How informative a word must be before its keyword matches count as evidence,
 * measured as inverse document frequency: `ln(lines / lines containing it)`.
 *
 * This is the load-bearing part of mixing the two retrievals, and it exists
 * because equal-weight fusion measurably made results worse. "The part where he
 * shouts about being financially ruined" should find "I declare bankruptcy!",
 * but shares no word with it — so the keyword half matched *other* lines
 * containing "part" and "being", and promoted a line about dinner above the
 * right answer.
 *
 * Rarity separates the two cases, but it has to be rarity in an absolute sense
 * rather than a fraction of the corpus. A ratio cannot express this: in a
 * sixty-line index every word appears in "1%" of it, so "part" and "copacetic"
 * are indistinguishable. IDF divides by corpus size and so says what is
 * actually meant — 6 is roughly one line in four hundred.
 *
 * The cutoff also, correctly, disables keyword rescue on very small indexes:
 * ln(60) is 4.1, under the floor no matter how rare the word. Nothing is lost,
 * because the failure this fixes is one of scale. The vector search fetches 40
 * candidates, so in a sixty-line index it has already returned two thirds of
 * the corpus and cannot have buried anything; it was in a 10,665-line show that
 * the only "copacetic" line ranked 1837th.
 */
const LEXICAL_MIN_IDF = 6

/** The words of a description, minus the ones that narrow nothing. */
function queryTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  return terms.filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t))
}

/**
 * Quotes terms into an FTS5 MATCH expression.
 *
 * Joined with OR, never AND: a description is a paraphrase, not a quotation, so
 * requiring every term would return nothing for the queries this exists to fix.
 *
 * Quoting makes each term a literal. Without it a query containing OR, NEAR,
 * `*` or a stray quote is either read as operators or is a syntax error thrown
 * in the user's face.
 */
export function ftsMatchQuery(terms: string[]): string | null {
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * Line ids for a query, best keyword match first.
 *
 * `line_fts` is an external-content table over `line`, so this reads the same
 * text the vector index embedded — there is no second copy to drift.
 *
 * The table name cannot be aliased: FTS5 resolves both `MATCH` and `bm25()`
 * against the real name, and an alias fails with "no such column".
 */
function lexicalIds(
  titleId: string | null,
  queryText: string,
  k: number,
  videoIds?: string[],
): number[] {
  const db = getDb()

  // Scope shared by the corpus count, the rarity test and the search itself, so
  // "rare" always means rare *among the lines this search can actually return*.
  const scope: { sql: string; params: string[] } =
    videoIds && videoIds.length > 0
      ? {
          sql: `AND l.video_id IN (${videoIds.map(() => '?').join(',')})`,
          params: videoIds,
        }
      : titleId !== null
        ? { sql: 'AND l.title_id = ?', params: [titleId] }
        : { sql: '', params: [] }

  // `WHERE 1=1` so the optional scope clause appends uniformly.
  const { n: total } = db
    .prepare(`SELECT COUNT(*) AS n FROM line l WHERE 1=1 ${scope.sql}`)
    .get(...scope.params) as { n: number }
  if (total === 0) return []

  const countTerm = db.prepare(
    `SELECT COUNT(*) AS n
       FROM line_fts
       JOIN line l ON l.id = line_fts.rowid
      WHERE line_fts MATCH ? ${scope.sql}`,
  )

  const rare = queryTerms(queryText).filter((term) => {
    const expr = ftsMatchQuery([term])
    if (!expr) return false
    const { n } = countTerm.get(expr, ...scope.params) as { n: number }
    // df of 0 matches nothing; a low IDF means the word is ordinary, and
    // ordinary words are what the embedding is already good at.
    return n > 0 && Math.log(total / n) >= LEXICAL_MIN_IDF
  })

  const match = ftsMatchQuery(rare)
  if (!match) return []

  const rows = db
    .prepare(
      `SELECT l.id
         FROM line_fts
         JOIN line l ON l.id = line_fts.rowid
        WHERE line_fts MATCH ? ${scope.sql}
        ORDER BY bm25(line_fts)
        LIMIT ?`,
    )
    .all(match, ...scope.params, k) as { id: number }[]

  return rows.map((r) => r.id)
}

/** Rank lookup, 0-based, for one retrieval list. */
const rankMap = (ids: number[]) => new Map(ids.map((id, i) => [id, i]))

/**
 * Reciprocal rank fusion of the semantic and keyword lists.
 *
 * Rank-based rather than score-based on purpose: cosine distance and BM25 are
 * not on comparable scales, and any attempt to normalise them into one number
 * needs a weight that is really a guess about the query. Summing 1/(K + rank)
 * needs no such weight — a line both lists rank highly beats a line only one of
 * them likes, which is exactly the desired behaviour when a description mixes a
 * rare word with ordinary paraphrase.
 */
function fusedOrder(ids: number[], vectorRank: Map<number, number>, lexicalRank: Map<number, number>): number[] {
  const rrf = (id: number) => {
    const v = vectorRank.get(id)
    const l = lexicalRank.get(id)
    return (
      (v === undefined ? 0 : 1 / (RRF_K + v + 1)) +
      (l === undefined ? 0 : LEXICAL_WEIGHT / (RRF_K + l + 1))
    )
  }
  return [...ids].sort((a, b) => {
    const diff = rrf(b) - rrf(a)
    // Ties broken by semantic rank so ordering stays deterministic.
    if (diff !== 0) return diff
    return (vectorRank.get(a) ?? Infinity) - (vectorRank.get(b) ?? Infinity)
  })
}

/**
 * Ranks the named episodes exactly, rather than hoping they turn up in a wider KNN.
 *
 * `line_vec` cannot filter on `video_id` — it is an auxiliary column, not a
 * metadata one — so the alternative was to over-fetch neighbours across the whole
 * show and keep whichever happened to come from the right episode. That makes
 * honouring a hint a matter of luck. `vec_distance_cosine` returns the identical
 * distance the index does, and scanning one episode's ~300 lines takes 2ms
 * (a whole season, 15ms), so the hint is honoured deterministically instead.
 */
function rankPreferred(
  blob: Uint8Array,
  preference: Preference,
  limit: number,
  queryText?: string,
): SceneMatch[] {
  const placeholders = preference.videoIds.map(() => '?').join(',')
  const band =
    preference.when === null ? '0' : POSITION_RANK[preference.when]

  // Every line of the named episodes, with its position band. Scanning them is
  // cheap (one episode ~300 lines, a season ~15ms) and fusing needs the whole
  // set rather than a pre-truncated best-N: a keyword hit outside the top few
  // by distance is precisely what the lexical list is here to rescue.
  const rows = getDb()
    .prepare(
      `SELECT ${LINE_COLUMNS}, vec_distance_cosine(lv.embedding, ?) AS distance,
              ${band} AS band
         FROM line l
         JOIN line_vec lv ON lv.rowid = l.id
         JOIN video v ON v.id = l.video_id
         JOIN title t ON t.id = l.title_id
        WHERE l.video_id IN (${placeholders})
        ORDER BY distance`,
    )
    .all(blob, ...preference.videoIds) as (LineRow & { distance: number; band: number })[]

  if (rows.length === 0) return []

  const vectorRank = rankMap(rows.map((r) => r.id))
  const lexicalRank = queryText
    ? rankMap(lexicalIds(null, queryText, rows.length, preference.videoIds))
    : new Map<number, number>()

  const byId = new Map(rows.map((r) => [r.id, r]))
  const order = fusedOrder([...byId.keys()], vectorRank, lexicalRank)

  // The position partition stays primary: a description that said *where* in the
  // episode is a statement about where, and fusion reorders only within each
  // half of that split. Sorting the fused order by band is stable, so it keeps
  // the fused ranking inside each band.
  const banded = order
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.band - b.band)

  return banded.slice(0, limit).map((row) => toMatch(row, row.distance))
}

/**
 * Searches dialogue for a natural-language description.
 *
 * `titleId` of `null` searches every indexed title. That is opt-in rather than
 * the default: most of the time you know the show, and narrowing to it both
 * sharpens the results and keeps them fast. But a half-remembered line often
 * does not come with a title attached, and having to guess the show before you
 * are allowed to search is the wrong question to be asked.
 *
 * Returns `limit` *distinct moments*: because dialogue windows overlap by
 * design, a naive top-k would happily return five views of the same ten
 * seconds. We over-fetch and then greedily keep only candidates that are far
 * enough from everything already chosen, which is what makes the "try another
 * match" control in the editor actually show you something new.
 */
export async function searchScenes(
  titleId: string | null,
  query: string,
  limit = 5,
): Promise<SceneSearch> {
  const trimmed = query.trim()
  const empty: SceneRequest = { text: trimmed, where: null, when: null }
  if (!trimmed) return { matches: [], request: empty }

  // The single place a raw query becomes a request, so every caller of this gets
  // episode scoping without asking for it.
  const request = readSceneRequest(trimmed, episodesForTitle(titleId))
  const [vector] = await embed([request.text])
  const matches = searchScenesByVector(
    titleId,
    vector,
    limit,
    request.where ? { videoIds: request.where.videoIds, when: request.when } : undefined,
    // The same text that was embedded, not the raw query: an episode title the
    // hint parser stripped is not dialogue, and matching it lexically would
    // pull in every line that happens to share a word with the title.
    request.text,
  )

  return { matches, request }
}

export function searchScenesByVector(
  titleId: string | null,
  vector: Float32Array,
  limit = 5,
  /**
   * Videos to put first, when the description said where to look.
   *
   * Preference rather than restriction: the rest of the show still fills the list
   * below them, so "Not this one" can walk out of a wrongly-named episode, and an
   * episode with no indexed dialogue falls back to plain ranking instead of
   * returning nothing.
   */
  prefer?: Preference,
  /**
   * The description in words, enabling keyword retrieval alongside the vector
   * search. Optional: without it this behaves exactly as it always did, so a
   * caller that only has a vector loses nothing.
   */
  queryText?: string,
): SceneMatch[] {
  const db = getDb()

  // Over-fetch: most neighbours will be overlapping views of a few moments.
  // Unchanged for a library-wide search — the dedupe below only collapses
  // overlapping windows of the same video, and candidates from different titles
  // are distinct by construction, so fewer are discarded rather than more.
  const k = Math.max(limit * 8, 40)
  const blob = toVectorBlob(vector)
  const rows = (
    titleId === null
      ? db
          .prepare(
            `SELECT rowid, distance
               FROM line_vec
              WHERE embedding MATCH ?
                AND k = ?
              ORDER BY distance`,
          )
          .all(blob, k)
      : db
          .prepare(
            `SELECT rowid, distance
               FROM line_vec
              WHERE embedding MATCH ?
                AND k = ?
                AND title_id = ?
              ORDER BY distance`,
          )
          .all(blob, k, titleId)
  ) as VecRow[]

  const preferred =
    prefer && prefer.videoIds.length > 0 ? rankPreferred(blob, prefer, k, queryText) : []

  // Keyword candidates, fetched to the same depth as the vector ones. A line
  // the embedding ranked 1837th — which is where "copacetic" actually landed —
  // is unreachable by widening k alone, but it is the first keyword hit.
  const lexical = queryText ? lexicalIds(titleId, queryText, k) : []

  if (rows.length === 0 && lexical.length === 0 && preferred.length === 0) return []

  const vectorRank = rankMap(rows.map((r) => r.rowid))
  const lexicalRank = rankMap(lexical)
  const allIds = [...new Set([...rows.map((r) => r.rowid), ...lexical])]

  const byId = new Map(rows.map((r) => [r.rowid, r.distance]))
  const lines =
    allIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT ${LINE_COLUMNS}
         FROM line l
         JOIN video v ON v.id = l.video_id
         JOIN title t ON t.id = l.title_id
        WHERE l.id IN (${allIds.map(() => '?').join(',')})`,
          )
          .all(...allIds) as LineRow[])

  // A keyword-only hit has no distance from the KNN, so its true cosine
  // distance is measured here. Without this its `score` would be a placeholder,
  // and score is what the montage editor shows next to a clip.
  const missing = lines.filter((l) => !byId.has(l.id)).map((l) => l.id)
  if (missing.length > 0) {
    const measured = db
      .prepare(
        `SELECT l.id, vec_distance_cosine(lv.embedding, ?) AS distance
           FROM line l JOIN line_vec lv ON lv.rowid = l.id
          WHERE l.id IN (${missing.map(() => '?').join(',')})`,
      )
      .all(blob, ...missing) as { id: number; distance: number }[]
    for (const m of measured) byId.set(m.id, m.distance)
  }

  const lineById = new Map(lines.map((l) => [l.id, l]))
  const ranked = fusedOrder(
    lines.map((l) => l.id),
    vectorRank,
    lexicalRank,
  ).map((id) => toMatch(lineById.get(id)!, byId.get(id) ?? 2))

  // Preferred first, then the plain ranking behind them. A line in both appears
  // twice, and the dedupe below keeps the earlier — so the preferred copy, with
  // its position bonus, is the one that survives.
  const candidates = [...preferred, ...ranked]

  const chosen: SceneMatch[] = []
  for (const candidate of candidates) {
    const overlapsChosen = chosen.some(
      (c) =>
        c.videoId === candidate.videoId &&
        Math.abs(c.startMs - candidate.startMs) < DISTINCT_MOMENT_MS,
    )
    if (overlapsChosen) continue
    chosen.push(candidate)
    if (chosen.length >= limit) break
  }

  return chosen
}

/** Surrounding dialogue, used to show context and to caption a padded clip. */
export function contextLines(
  videoId: string,
  startMs: number,
  endMs: number,
  padMs = 15_000,
): { startMs: number; endMs: number; text: string }[] {
  return getDb()
    .prepare(
      `SELECT start_ms AS startMs, end_ms AS endMs, text
         FROM line
        WHERE video_id = ? AND end_ms > ? AND start_ms < ?
        ORDER BY start_ms`,
    )
    .all(videoId, startMs - padMs, endMs + padMs) as {
    startMs: number
    endMs: number
    text: string
  }[]
}
