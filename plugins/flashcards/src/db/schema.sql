PRAGMA user_version = 1;
PRAGMA foreign_keys = ON;

-- 1. Canonical Markdown Source Blocks (Extracted from Obsidian notes)
CREATE TABLE IF NOT EXISTS blocks (
  id            TEXT PRIMARY KEY,                                      -- 6-char lowercase base-36 block ID stamped in Markdown (e.g. 'k9x2mp')
  file_path     TEXT NOT NULL,                                         -- Vault-relative path to containing note (e.g. 'Notes/Biology.md')
  block_type    TEXT NOT NULL CHECK(block_type IN ('inline', 'block', 'cloze')), -- Block syntax format
  reversible    INTEGER NOT NULL DEFAULT 0 CHECK(reversible IN (0, 1)),-- 1 if bidirectional (::: or reversible=true), 0 otherwise
  front         TEXT NOT NULL,                                         -- Raw question / front markdown (full sentence with {{cloze}} for cloze)
  back          TEXT NOT NULL,                                         -- Raw answer / back markdown (empty string '' for cloze cards)
  tags          TEXT NOT NULL,                                         -- Space-separated tags ('german vocab')
  content_hash  TEXT NOT NULL,                                         -- FNV-1a 64-bit hex hash to detect text edits without resetting history
  updated_at    INTEGER NOT NULL,                                      -- Last modified timestamp in UTC epoch ms
  CHECK (block_type != 'cloze' OR reversible = 0)                      -- Cloze blocks must always have reversible = 0 (false)
) STRICT;

-- 2. Flashcards (Generated review items with FSRS scheduling state)
CREATE TABLE IF NOT EXISTS cards (
  id              INTEGER PRIMARY KEY,                                    -- Auto-incrementing internal integer ID
  block_id        TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,  -- Foreign key linking to source block
  direction       TEXT CHECK(direction IS NULL OR direction IN ('forward', 'reverse')), -- 'forward', 'reverse', or NULL (cloze only)
  state           INTEGER NOT NULL DEFAULT 0,                             -- FSRS state: 0=New, 1=Learning, 2=Review, 3=Relearning
  due_at          INTEGER NOT NULL,                                       -- Due timestamp in UTC epoch ms
  stability       REAL NOT NULL DEFAULT 0.0,                              -- FSRS memory stability (days)
  difficulty      REAL NOT NULL DEFAULT 0.0,                              -- FSRS card difficulty (1.0 to 10.0)
  reps            INTEGER NOT NULL DEFAULT 0,                             -- Total number of completed reviews
  lapses          INTEGER NOT NULL DEFAULT 0,                             -- Total number of lapsed (forgotten) reviews
  last_review     INTEGER,                                                -- Timestamp of last review in UTC epoch ms (NULL if new)
  learning_step   INTEGER NOT NULL DEFAULT 0,                             -- Current step index in learning phase
  relearning_step INTEGER NOT NULL DEFAULT 0                              -- Current step index in relearning phase
) STRICT;

-- Unique constraint ensuring 1 forward card, 1 reverse card (if reversible), or 1 cloze card per block
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_block_direction ON cards(block_id, ifnull(direction, 'cloze'));

-- Enforce: direction IS NULL iff the parent block's block_type = 'cloze'
CREATE TRIGGER IF NOT EXISTS trg_cards_insert_validate_direction
BEFORE INSERT ON cards
FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN (SELECT block_type FROM blocks WHERE id = NEW.block_id) = 'cloze' AND NEW.direction IS NOT NULL
        THEN RAISE(ABORT, 'Cloze cards must have NULL direction')
      WHEN (SELECT block_type FROM blocks WHERE id = NEW.block_id) != 'cloze' AND NEW.direction IS NULL
        THEN RAISE(ABORT, 'Non-cloze cards must have forward or reverse direction')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_cards_update_validate_direction
BEFORE UPDATE OF direction, block_id ON cards
FOR EACH ROW
BEGIN
  SELECT
    CASE
      WHEN (SELECT block_type FROM blocks WHERE id = NEW.block_id) = 'cloze' AND NEW.direction IS NOT NULL
        THEN RAISE(ABORT, 'Cloze cards must have NULL direction')
      WHEN (SELECT block_type FROM blocks WHERE id = NEW.block_id) != 'cloze' AND NEW.direction IS NULL
        THEN RAISE(ABORT, 'Non-cloze cards must have forward or reverse direction')
    END;
END;

-- 3. Study Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY,         -- Auto-incrementing session ID
  started_at        INTEGER NOT NULL,            -- Session start timestamp in UTC epoch ms
  ended_at          INTEGER,                     -- Session end timestamp in UTC epoch ms (NULL if active)
  card_count        INTEGER NOT NULL DEFAULT 0,  -- Total cards reviewed during this session
  forgot_count      INTEGER NOT NULL DEFAULT 0,  -- Total cards marked 'Again' (Forgot)
  remembered_count  INTEGER NOT NULL DEFAULT 0   -- Total cards marked 'Good' / 'Easy'
) STRICT;

-- 4. Immutable Review Logs (for undo, analytics, and FSRS optimization)
CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY,                                        -- Auto-incrementing review log ID
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, -- Parent session
  card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,    -- Reviewed card
  rating       INTEGER NOT NULL,                                           -- FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy
  state        INTEGER NOT NULL,                                           -- FSRS state at time of review
  due_at       INTEGER NOT NULL,                                           -- Next scheduled due timestamp in UTC epoch ms
  stability    REAL NOT NULL,                                              -- Computed stability after review
  difficulty   REAL NOT NULL,                                              -- Computed difficulty after review
  reviewed_at  INTEGER NOT NULL                                            -- Timestamp when review was submitted (UTC epoch ms)
) STRICT;

-- Performance indexes for fast review queues, dashboard filtering, and optimizer training
CREATE INDEX IF NOT EXISTS idx_blocks_file_path ON blocks(file_path);
CREATE INDEX IF NOT EXISTS idx_cards_block ON cards(block_id);
CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(reviewed_at);
