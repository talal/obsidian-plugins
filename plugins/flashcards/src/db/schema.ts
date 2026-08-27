export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blocks (
  note_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  block_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  front_raw TEXT NOT NULL,
  back_raw TEXT NOT NULL,
  tags TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, block_id),
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  state INTEGER NOT NULL,
  due INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  last_review INTEGER,
  learning_step INTEGER NOT NULL DEFAULT 0,
  relearning_step INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (note_id, block_id) REFERENCES blocks(note_id, block_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  deck_filter TEXT NOT NULL,
  cards_studied INTEGER NOT NULL DEFAULT 0,
  forgot_count INTEGER NOT NULL DEFAULT 0,
  remembered_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  review_item_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  state INTEGER NOT NULL,
  due INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  review_time INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_note ON blocks(note_id);
CREATE INDEX IF NOT EXISTS idx_review_items_due ON review_items(due);
CREATE INDEX IF NOT EXISTS idx_review_logs_item ON review_logs(review_item_id);
CREATE INDEX IF NOT EXISTS idx_review_logs_time ON review_logs(review_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_path ON notes(path);

PRAGMA user_version = 1;
`;
