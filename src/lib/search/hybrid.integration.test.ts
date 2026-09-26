import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Keyword rescue for rare words, at a corpus size where it matters.
 *
 * The mock server in `e2e.integration.test.ts` indexes about sixty lines, which
 * is deliberately too small for this to engage: with a corpus that size the
 * vector search already returns most of it, and no word in it is rare in the
 * absolute sense the IDF floor requires. So the case this guards — a real show
 * where the one line containing an unusual word ranked 1837th of 10,665 and was
 * therefore unreachable — cannot be reproduced there.
 *
 * Vectors here are synthetic and random rather than embedded. That is the
 * point: it pins the *retrieval* behaviour without depending on what a
 * particular model happens to think two sentences mean, so the test says
 * something specific and does not drift when the model changes.
 */

const DIM = 384
const CORPUS = 4000
const TITLE = 'title-hybrid'
const VIDEO = 'video-hybrid'

let dataDir: string
let db: import('../db').DB
let search: typeof import('./search')
let toVectorBlob: typeof import('../db').toVectorBlob

/** Deterministic pseudo-random so a failure is reproducible. */
function makeRandom(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function unitVector(random: () => number): Float32Array {
  const v = new Float32Array(DIM)
  let norm = 0
  for (let i = 0; i < DIM; i++) {
    v[i] = random() * 2 - 1
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jellymeme-hybrid-'))
  process.env.JELLYMEME_DATA = dataDir

  const dbMod = await import('../db')
  toVectorBlob = dbMod.toVectorBlob
  db = dbMod.getDb()
  search = await import('./search')

  db.prepare('INSERT INTO title (id, name, kind) VALUES (?, ?, ?)').run(TITLE, 'Hybrid Show', 'Series')
  db.prepare(
    'INSERT INTO video (id, title_id, name, season, episode, runtime_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(VIDEO, TITLE, 'Episode', 1, 1, 3_600_000)

  const random = makeRandom(20260920)
  const insertLine = db.prepare(
    'INSERT INTO line (video_id, title_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)',
  )
  const insertVec = db.prepare(
    'INSERT INTO line_vec (rowid, embedding, title_id, video_id) VALUES (?, ?, ?, ?)',
  )

  db.transaction(() => {
    for (let i = 0; i < CORPUS; i++) {
      // One line carries the rare word; one ordinary word is spread widely so
      // there is a common term available to (wrongly) match on.
      const text =
        i === 1500
          ? 'make him feel like everything is copacetic when it is clearly not'
          : `ordinary dialogue number ${i} about the dinner and the weather`
      // Distinct moments so the time-based dedupe cannot collapse them.
      const start = i * 30_000
      const { lastInsertRowid } = insertLine.run(VIDEO, TITLE, start, start + 4_000, text)
      insertVec.run(BigInt(lastInsertRowid), toVectorBlob(unitVector(random)), TITLE, VIDEO)
    }
  })()
})

afterAll(async () => {
  try {
    db?.close()
  } catch {
    /* already closed */
  }
  // Windows keeps a handle on the WAL briefly; a failed cleanup is not a failed test.
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
})

describe('hybrid retrieval', () => {
  it('indexes every line for keyword search as it is written', () => {
    // Asserted with MATCH, never COUNT(*). `line_fts` is an external-content
    // table, so an unqualified count is answered from `line` and reports a full
    // index even when nothing has been indexed at all — a check that cannot
    // fail, over a table that was in fact empty. Only MATCH reads the index.
    const rare = db
      .prepare(
        `SELECT l.id FROM line_fts JOIN line l ON l.id = line_fts.rowid
          WHERE line_fts MATCH ?`,
      )
      .all('"copacetic"') as { id: number }[]
    expect(rare).toHaveLength(1)

    const common = db
      .prepare(
        `SELECT COUNT(*) AS n FROM line_fts JOIN line l ON l.id = line_fts.rowid
          WHERE line_fts MATCH ?`,
      )
      .get('"ordinary"') as { n: number }
    expect(common.n).toBe(CORPUS - 1)
  })

  it('finds a rare word the vector search buried', () => {
    const random = makeRandom(7)
    const query = unitVector(random)

    // Where the rare line sits on semantics alone: with random vectors it is
    // somewhere in the middle of 4000, far outside the k=40 the KNN fetches.
    const vectorOnly = search.searchScenesByVector(TITLE, query, 5)
    expect(vectorOnly.some((m) => m.text.includes('copacetic'))).toBe(false)

    const hybrid = search.searchScenesByVector(TITLE, query, 5, undefined, 'copacetic')
    expect(hybrid[0].text).toContain('copacetic')
  })

  it('does not let an ordinary word outrank the semantic ranking', () => {
    const random = makeRandom(11)
    const query = unitVector(random)

    const vectorOnly = search.searchScenesByVector(TITLE, query, 5)
    // "dinner" is in nearly every line, so its IDF is far below the floor and it
    // must contribute nothing. This is the regression that equal-weight fusion
    // caused: a common word pulled an unrelated line above the right answer.
    const hybrid = search.searchScenesByVector(TITLE, query, 5, undefined, 'dinner')

    expect(hybrid.map((m) => m.lineId)).toEqual(vectorOnly.map((m) => m.lineId))
  })

  it('still ranks the rare word first when it arrives inside a sentence', () => {
    const random = makeRandom(7)
    const query = unitVector(random)

    const hybrid = search.searchScenesByVector(
      TITLE,
      query,
      5,
      undefined,
      'the bit where she says everything is copacetic',
    )
    expect(hybrid[0].text).toContain('copacetic')
  })

  it('leaves results untouched when no query text is supplied', () => {
    const random = makeRandom(3)
    const query = unitVector(random)

    const a = search.searchScenesByVector(TITLE, query, 5)
    const b = search.searchScenesByVector(TITLE, query, 5, undefined, undefined)
    expect(a.map((m) => m.lineId)).toEqual(b.map((m) => m.lineId))
  })
})

describe('keyword index backfill', () => {
  /**
   * The upgrade path: a database whose lines were all written before the
   * keyword index existed. Its triggers never fired, so only the one-time
   * rebuild can populate it — and getting this wrong is silent, because search
   * still works, just never on keywords.
   */
  it('indexes lines that predate the keyword index', async () => {
    const older = await mkdtemp(join(tmpdir(), 'jellymeme-backfill-'))
    const previous = process.env.JELLYMEME_DATA
    process.env.JELLYMEME_DATA = older

    try {
      vi.resetModules()
      const first = await import('../db')
      const before = first.getDb()

      // Rewind to a pre-FTS database: no triggers, no index, no marker. The
      // triggers have to go first — they reference the table.
      before.exec(`
        DROP TRIGGER IF EXISTS line_fts_insert;
        DROP TRIGGER IF EXISTS line_fts_delete;
        DROP TRIGGER IF EXISTS line_fts_update;
        DROP TABLE IF EXISTS line_fts;
        DELETE FROM config WHERE key = 'schema.lineFtsBackfilled';
      `)
      before.prepare('INSERT INTO title (id, name, kind) VALUES (?, ?, ?)').run('t', 'Old', 'Series')
      before
        .prepare('INSERT INTO video (id, title_id, name) VALUES (?, ?, ?)')
        .run('v', 't', 'Episode')
      before
        .prepare('INSERT INTO line (video_id, title_id, start_ms, end_ms, text) VALUES (?,?,?,?,?)')
        .run('v', 't', 0, 1000, 'everything is copacetic when it is clearly not')
      before.close()

      // Re-opening runs the migration, which must notice and rebuild.
      vi.resetModules()
      const second = await import('../db')
      const after = second.getDb()

      const hits = after
        .prepare(
          `SELECT l.id FROM line_fts JOIN line l ON l.id = line_fts.rowid
            WHERE line_fts MATCH ?`,
        )
        .all('"copacetic"') as { id: number }[]
      expect(hits).toHaveLength(1)
      after.close()
    } finally {
      process.env.JELLYMEME_DATA = previous
      vi.resetModules()
      await rm(older, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('ftsMatchQuery', () => {
  it('ORs terms so a paraphrase is not required to match in full', () => {
    expect(search.ftsMatchQuery(['declare', 'bankruptcy'])).toBe('"declare" OR "bankruptcy"')
  })

  it('quotes terms so FTS5 operators in a query cannot be executed or crash it', () => {
    // Unquoted, each of these is either an operator or a syntax error.
    expect(search.ftsMatchQuery(['or'])).toBe('"or"')
    expect(search.ftsMatchQuery(['near'])).toBe('"near"')
    expect(search.ftsMatchQuery(['a"b'])).toBe('"a""b"')
  })

  it('is null for nothing to search', () => {
    expect(search.ftsMatchQuery([])).toBeNull()
  })
})
