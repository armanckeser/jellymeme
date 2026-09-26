-- Jellymeme schema.
--
-- Plain SQL rather than an ORM: sqlite-vec exposes its index as a virtual
-- table that no ORM models well, and mixing generated query builders with raw
-- vec0 statements costs more than it saves at this size.

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A series or movie the user has chosen to index.
CREATE TABLE IF NOT EXISTS title (
  id           TEXT PRIMARY KEY,          -- Jellyfin item id
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- 'Series' | 'Movie'
  year         INTEGER,
  indexed_at   INTEGER,                   -- epoch ms, NULL while never indexed
  video_count  INTEGER NOT NULL DEFAULT 0,
  line_count   INTEGER NOT NULL DEFAULT 0
);

-- One row per episode (or the single file of a movie).
CREATE TABLE IF NOT EXISTS video (
  id              TEXT PRIMARY KEY,       -- Jellyfin item id
  title_id        TEXT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  season          INTEGER,
  episode         INTEGER,
  media_source_id TEXT,
  runtime_ms      INTEGER,
  subtitle_status TEXT NOT NULL DEFAULT 'pending', -- pending | ok | none | error
  subtitle_note   TEXT,
  -- Which subtitle stream we indexed. Kept so the renderer can re-fetch the
  -- original cues (with their real timings) to burn as captions, rather than
  -- storing a second copy of every subtitle.
  subtitle_index  INTEGER,
  -- Which audio stream clips should carry. Dual-language releases often put a
  -- dub first, and Jellyfin's transcoder takes the default track unless told.
  -- NULL until looked up; -1 when there is no English track to prefer.
  audio_index     INTEGER,
  indexed_at      INTEGER
);

CREATE INDEX IF NOT EXISTS video_title_idx ON video(title_id);

-- An overlapping window of dialogue. This is the unit that gets embedded and
-- the unit a search result points at.
CREATE TABLE IF NOT EXISTS line (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES video(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL,
  text     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS line_video_idx ON line(video_id);
CREATE INDEX IF NOT EXISTS line_title_idx ON line(title_id);
CREATE INDEX IF NOT EXISTS line_time_idx  ON line(video_id, start_ms);

-- Keyword index over the same windows the vector index covers.
--
-- Embeddings encode meaning, which is what makes "the one where he declares
-- bankruptcy" work, but it is also why they are weak on rare, distinctive
-- vocabulary: a word like "copacetic" is split into subword pieces whose
-- average lands nowhere near the whole word. Measured on a real index, the one
-- line containing it ranked 1837th of 10665 for that query, behind a line about
-- Percocet -- the model matching fragments, not meaning. BM25 does the opposite
-- and weights exactly those rare terms highest, so the two are complementary
-- and `search.ts` fuses them rather than choosing.
--
-- External content: the text lives once, in `line`, and FTS5 reads it through
-- content_rowid. The triggers below are what keep the two in step, including
-- the bulk deletes re-indexing a video does.
--
-- Porter stemming so a query saying "declares" reaches a line saying "declare".
CREATE VIRTUAL TABLE IF NOT EXISTS line_fts USING fts5(
  text,
  content='line',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS line_fts_insert AFTER INSERT ON line BEGIN
  INSERT INTO line_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS line_fts_delete AFTER DELETE ON line BEGIN
  INSERT INTO line_fts(line_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS line_fts_update AFTER UPDATE ON line BEGIN
  INSERT INTO line_fts(line_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO line_fts(rowid, text) VALUES (new.id, new.text);
END;

-- A saved montage. Clips live as JSON: their shape is driven entirely by the
-- editor UI and has no relational queries run against it.
CREATE TABLE IF NOT EXISTS montage (
  id          TEXT PRIMARY KEY,
  title_id    TEXT NOT NULL REFERENCES title(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  clips_json  TEXT NOT NULL DEFAULT '[]',
  -- The caption every clip in the cut inherits unless it sets its own.
  caption_json TEXT NOT NULL DEFAULT '{"mode":"none","text":""}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS montage_title_idx ON montage(title_id);

-- Render jobs, tracked in the database so progress survives a dev-server
-- reload and the UI can poll a single source of truth.
CREATE TABLE IF NOT EXISTS render (
  id         TEXT PRIMARY KEY,
  montage_id TEXT NOT NULL REFERENCES montage(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,              -- queued | running | done | error
  progress   REAL NOT NULL DEFAULT 0,
  stage      TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL,
  file_path  TEXT,
  file_size  INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS render_montage_idx ON render(montage_id);
