import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBEDDING_DIM } from '@/lib/search/embed'

export type DB = Database.Database

const DATA_DIR = process.env.JELLYMEME_DATA ?? join(process.cwd(), 'data')
const DB_PATH = join(DATA_DIR, 'jellymeme.db')
// The project was called Scene Scout; an install from then keeps its library.
const LEGACY_DB_PATH = join(DATA_DIR, 'scene-scout.db')

/**
 * sqlite-vec binds a vector as a raw little-endian float32 buffer.
 * Anything else (a JS array, a Float64Array) is silently wrong.
 */
export function toVectorBlob(values: Float32Array | number[]): Uint8Array {
  const f32 = values instanceof Float32Array ? values : Float32Array.from(values)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

let instance: DB | null = null

function migrate(db: DB) {
  const here = dirname(fileURLToPath(import.meta.url))
  // The .sql file sits next to this module in dev, but Next may relocate the
  // compiled output, so fall back to the source tree.
  let sql: string
  try {
    sql = readFileSync(join(here, 'schema.sql'), 'utf8')
  } catch {
    sql = readFileSync(join(process.cwd(), 'src/lib/db/schema.sql'), 'utf8')
  }
  db.exec(sql)

  // The vector index is created separately: its dimension comes from the
  // embedding model, so it cannot live in a static .sql file.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS line_vec USING vec0(
      embedding FLOAT[${EMBEDDING_DIM}] distance_metric=cosine,
      title_id TEXT,
      +video_id TEXT
    );
  `)

  addColumns(db)
  backfillLineFts(db)
}

/** Marks the one-time keyword-index backfill as done. */
const FTS_BACKFILL_KEY = 'schema.lineFtsBackfilled'

/**
 * Populates the keyword index for lines written before it existed.
 *
 * The triggers in schema.sql only fire on new writes, so a database indexed
 * before `line_fts` existed has a full vector index and an empty keyword one —
 * and keyword search silently returns nothing for the entire library.
 * `rebuild` reads straight from `line`, so this costs no re-indexing and no
 * calls to Jellyfin; 143k lines take well under a second.
 *
 * The completion marker is deliberate, and the obvious alternative is a trap:
 * `SELECT COUNT(*) FROM line_fts` does **not** count indexed rows. `line_fts`
 * is an external-content table, so an unqualified read is answered from `line`
 * — it returned 142,930 against a completely empty index, which is exactly the
 * value that makes a "skip if already populated" guard skip forever. Only a
 * MATCH query touches the index itself. A stored flag cannot be fooled that
 * way, and it is set even for an empty database, where the triggers will keep
 * every future write in step on their own.
 */
function backfillLineFts(db: DB) {
  const done = db.prepare('SELECT value FROM config WHERE key = ?').get(FTS_BACKFILL_KEY) as
    | { value: string }
    | undefined
  if (done) return

  db.exec(`INSERT INTO line_fts(line_fts) VALUES('rebuild')`)
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
    FTS_BACKFILL_KEY,
    '1',
  )
}

/**
 * Columns added to tables that already exist elsewhere.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema.sql is a no-op once a table is there, so
 * a column added to a definition never reaches a database that predates it. Each
 * of these is additive, carries a default for the rows already written, and is
 * skipped when the column is present — so schema.sql stays the description of a
 * fresh database and this is only the catch-up for an existing one.
 */
function addColumns(db: DB) {
  const later: { table: string; column: string; definition: string }[] = [
    {
      table: 'montage',
      column: 'caption_json',
      definition: `TEXT NOT NULL DEFAULT '{"mode":"none","text":""}'`,
    },
    { table: 'video', column: 'audio_index', definition: 'INTEGER' },
  ]

  for (const { table, column, definition } of later) {
    const existing = db.pragma(`table_info(${table})`) as { name: string }[]
    if (existing.some((c) => c.name === column)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function getDb(): DB {
  if (instance) return instance

  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(DB_PATH) && existsSync(LEGACY_DB_PATH)) {
    // WAL and shared-memory files belong to the database and move with it.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(LEGACY_DB_PATH + suffix)) renameSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix)
    }
  }
  const db = new Database(DB_PATH)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  sqliteVec.load(db)
  migrate(db)

  instance = db
  return db
}

/** Config is a tiny key/value table — only the Jellyfin connection lives here. */
export function getConfig(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value)
}

export function deleteConfig(key: string): void {
  getDb().prepare('DELETE FROM config WHERE key = ?').run(key)
}
