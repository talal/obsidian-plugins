# Flashcards Plugin — Architecture Specification

**Status:** Personal plugin, not published. Optimize for simplicity and minimal code surface.

## 1. Overview & Core Philosophy

The Flashcards plugin enables spaced repetition learning directly within Obsidian notes powered by the official **FSRS-6 (`fsrs-rs`)** engine compiled to WebAssembly.

### Core Principles
- **Markdown is the canonical source of truth**: Cards are defined directly in notes using clean, intuitive syntax. Notes contain only human-readable content and simple IDs—never timestamps, repetition metrics, or scheduling metadata.
- **Fast Rust WASM Core (`crates/flashcards-wasm`)**:
  - Official `fsrs` crate from crates.io (`version 6.6.1`).
  - On-device **weight optimizer** (trains personalized memory curves on review history in milliseconds).
  - Source-aware Markdown/card parsing with `pulldown-cmark` offset events, Obsidian section hints, tag extraction, line tracking, and deterministic FNV-1a content hashing.
- **SQLite Relational Engine (`sql.js`)**:
  - Portable SQLite database (`cards.db`) with atomic crash-safe file persistence.
  - Anki-style **04:00 AM Day Rollover** for late-night study queues and daily streak/retention metrics.
- **Zero-Pollution Persistence (`data.json`)**:
  - Only explicitly configured overrides are written to `data.json`.
  - Default values ($R=0.90$, Max Interval $=36500$, 21 FSRS weights, Fuzzing) are resolved natively by the engine.
- **Resilient identity model**: Moving blocks inside notes, rephrasing questions, or renaming/moving files never resets or breaks a card's review history (`Note UUID -> Block ID`).
- **Cross-platform compliance**: Fully supports Obsidian Desktop and Mobile (iOS / Android) via self-contained WASM binaries without native Node.js/Electron dependencies.
- **Native Markdown rendering**: Flashcards are rendered in Svelte 5 during review using Obsidian's native `MarkdownRenderer`, preserving LaTeX math, wikilinks, code blocks, and attachments.

---

## 2. Card Syntax in Markdown

### 2.1 Simple Forward Cards (Inline)
Single-line question and answer separated by `::`:
```markdown
Capital of Pakistan? :: Islamabad ^37066d
```

### 2.2 Bi-directional Cards (Inline)
Single-line card separated by `:::`. Generates two independent review items (Forward: $Q \to A$, Reverse: $A \to Q$):
```markdown
Capital of Pakistan? ::: Islamabad ^37066d
```

### 2.3 Block Cards (Multi-line)
Wrapped inside Obsidian comment markers `%% ... %%` so metadata is **completely invisible in Reading View and Live Preview**:
```markdown
%% card-start id=37066d direction=both %%
What are the largest cities of Pakistan?

...

- Karachi
- Lahore
- Faisalabad
%% card-end %%
```
- **Attributes** (`key=val` on `card-start` line):
  - `id`: Unique block ID (auto-generated 6-char hex).
  - `direction`: `forward` (default if omitted), `reverse`, or `both`.
- **Divider**: A standalone line containing only `...` or `. . .` separates Front (Question) from Back (Answer) symmetrically for both forward and reverse directions.

### 2.4 Cloze Deletion Cards
Uses Obsidian's native `==highlight==` syntax. In MVP (v1), all clozes in a card are revealed simultaneously:
```markdown
The capital city of Pakistan is ==Islamabad== ^37066d

The three largest cities of Pakistan are ==Karachi==, ==Lahore==, and ==Faisalabad==. ^a8910b
```
- **In-Place Seamless Reveal**: Cloze deletions render the sentence once without repeating the text below or requiring a divider line:
  - **Question State**: Highlights are masked in-place as `[ ... ]` pills.
  - **Answer State**: The `[ ... ]` pill unmasks into a highlighted `<mark>` answer directly in-place.

### 2.5 Parser boundaries

The scanner treats Markdown syntax and flashcard syntax as two layers over the same source ranges:

1. Obsidian's `MetadataCache` supplies cached frontmatter, inherited tags, and root-level section ranges to the WASM bridge.
2. The Rust parser independently runs `pulldown-cmark` with source offsets. This remains the correctness fallback when the cache is unavailable or stale after a file change.
3. Card syntax is examined only in ordinary Markdown text ranges. Inline code, fenced or indented code, inline/display math, blockquotes, tables, YAML/TOML metadata, footnote definitions, and raw HTML are protected.
4. `:::` is considered before `::`; `::` inside a valid `==...==` span is not a card separator.
5. Block-card openers and closers are exact `%% card-start ... %%` and `%% card-end %%` lines. They are checked only after protected lines have been excluded, so examples inside fenced code cannot become cards.

The parser preserves the existing `==...==` cloze syntax. Equality operators in ordinary prose remain intentionally ambiguous; code and math delimiters are the supported way to exclude them.

---

## 3. Identity Model & Robust Tracking

A card's global identity is derived from a composite key: **`Note UUID -> Block ID`**.

```
Note Frontmatter: id: 550e8400-e29b-41d4-a716-446655440000 (UUID)
                  │
                  └── Block ID: 37066d (6-char hex)
                              │
                              └── Composite Key: 550e8400-e29b-41d4-a716-446655440000:37066d
```

### Why this is resilient:
1. **File Renames & Folder Moves**: The note's `frontmatter.id` remains constant. Renaming files updates only the relative `notes.path` record in SQLite without touching card schedules.
2. **Block Reordering & Edits**: Moving a block up or down in a note or fixing typos retains its `block_id`. The card's FSRS memory stability and difficulty remain intact.
3. **Collision Detection & Self-Healing (Duplicate Note Prevention)**:
   - If a user duplicates a note file (or copies frontmatter) such that two different notes share the same `id` UUID, `NoteScanner` automatically detects the collision on scan, regenerates a fresh unique UUID for the conflicting note, writes it to the note's frontmatter, and notifies the user.
   - If a user copy-pastes a block inside a note resulting in duplicate block IDs (e.g. two `^8a1b2c`), `NoteScanner` detects the intra-note duplicate, generates a fresh unique block ID, updates the markdown, and cleanly synchronizes both cards.
4. **Block ID Generation**: Length-6 lowercase hex `[0-9a-f]` matching Obsidian's native block link generation (`src/scanner/identity.ts:1`):
   ```ts
   const genBlockId = (): string =>
     Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
   ```
5. **Ignored Notes (`cards-ignore`)**: If a note's frontmatter contains `cards-ignore: true` (boolean or string `"true"`), `NoteScanner.ts:38` marks `notes.ignored = 1` and skips parsing. Ignored cards remain in SQLite but are excluded from `getDueReviewItems`, `getAllCards`, `getUniqueTags`, and `getDashboardStats` (`WHERE n.ignored = 0`). Clearing the flag restores the cards with full history; `notes.ignored` is backfilled via `ensureColumn`.

---

## 4. SQLite Database Storage

### 4.1 Cross-Platform Engine & Crash-Safe Persistence
- **Runtime (In-Memory SQLite via sql.js WASM)**:
  - SQLite runs entirely in memory via `sql.js` WASM bridge.
  - On startup, Obsidian loads the binary byte buffer from `<vault>/.obsidian/plugins/flashcards/cards.db` and passes it into WASM.
  - All SQL queries, state transitions, and search filters execute in microseconds in-memory without disk I/O bottlenecks.
- **Disk Persistence (Crash-Safe Atomic Swap)**:
  - After card reviews or debounced note synchronizations, `DatabaseManager` exports the serialized database buffer and validates the SQLite header (`SQLite format 3`).
  - The plugin writes bytes to a temporary sibling file: `<vault>/.obsidian/plugins/flashcards/cards.db.writing`.
  - Upon verifying write integrity, it swaps `cards.db.writing` $\to$ `cards.db` (via `rename`; falls back to `writeBinary` + `remove` on adapters that do not replace on rename).
  - If a sudden power loss, mobile suspension, or sync collision interrupts a write, `cards.db` remains 100% intact and uncorrupted. On startup, a valid `cards.db.writing` is promoted even when `cards.db` is also present (covers crash between the two writes); if `cards.db` is missing, the `.writing` file is recovered. Corrupt files fail `PRAGMA integrity_check` and are discarded.
- **Multi-Device Sync**:
  - `cards.db` resides in `.obsidian/plugins/flashcards/`.
  - For cross-device sync (Desktop $\leftrightarrow$ Mobile), users syncing via Obsidian Sync should enable **"Installed community plugins" & "Plugin settings & data"** in Obsidian Sync settings, or include `.obsidian/plugins/flashcards/` in their Git / Syncthing sync rules.

### 4.2 Database Schema

```sql
-- Notes containing flashcards
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,       -- UUID from note frontmatter
  path TEXT NOT NULL,             -- Vault-relative path (e.g. 'Notes/Biology.md')
  mtime INTEGER NOT NULL,         -- Last modified timestamp
  ignored INTEGER NOT NULL DEFAULT 0  -- 1 when frontmatter `cards-ignore: true`
);

-- Canonical markdown blocks containing card definitions
CREATE TABLE IF NOT EXISTS blocks (
  note_id TEXT NOT NULL,          -- References notes(note_id)
  block_id TEXT NOT NULL,         -- Markdown block ID (e.g. '37066d')
  block_type TEXT NOT NULL,       -- 'inline_forward', 'inline_both', 'block', 'cloze'
  direction TEXT NOT NULL,        -- 'forward', 'reverse', 'both'
  front_raw TEXT NOT NULL,
  back_raw TEXT NOT NULL,
  tags TEXT NOT NULL,             -- Space-separated tags inherited from note/block (e.g. 'german vocabulary')
  content_hash TEXT NOT NULL,     -- FNV-1a 64-bit hex hash to detect edits
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, block_id),
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
);

-- Individual directional review instances (FSRS scheduling state)
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,            -- e.g. '{note_id}:{block_id}:forward'
  note_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'forward' or 'reverse'
  state INTEGER NOT NULL,         -- 0=New, 1=Learning, 2=Review, 3=Relearning
  due INTEGER NOT NULL,           -- Epoch ms timestamp
  stability REAL NOT NULL,        -- FSRS memory stability
  difficulty REAL NOT NULL,       -- FSRS card difficulty
  reps INTEGER NOT NULL,          -- Total reviews count
  lapses INTEGER NOT NULL,        -- Total forgot count
  last_review INTEGER,            -- Epoch ms of last review (or NULL)
  learning_step INTEGER NOT NULL DEFAULT 0,    -- Current learning phase index
  relearning_step INTEGER NOT NULL DEFAULT 0,  -- Current relearning phase index
  FOREIGN KEY (note_id, block_id) REFERENCES blocks(note_id, block_id) ON DELETE CASCADE
);

-- Study sessions tracking active review workflows
CREATE TABLE IF NOT EXISTS sessions (
  session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,          -- Epoch ms
  ended_at INTEGER,                     -- Epoch ms (NULL while active)
  deck_filter TEXT NOT NULL,            -- 'all' or tags filter (e.g. 'german vocab')
  cards_studied INTEGER NOT NULL DEFAULT 0,
  forgot_count INTEGER NOT NULL DEFAULT 0,
  remembered_count INTEGER NOT NULL DEFAULT 0
);

-- Immutable review logs for undo, analytics, and FSRS optimization
-- Note: Only FK is on sessions; review_item_id is not FK-constrained to allow
-- retention of logs after prune (orphan cleanup via explicit DELETE).
CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,          -- References sessions(session_id)
  review_item_id TEXT NOT NULL,         -- References review_items(id) (no FK)
  rating INTEGER NOT NULL,              -- 1=Again/Forgot, 2=Hard, 3=Good/Remembered, 4=Easy
  state INTEGER NOT NULL,
  due INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  review_time INTEGER NOT NULL,         -- Epoch ms
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_note ON blocks(note_id);
CREATE INDEX IF NOT EXISTS idx_review_items_due ON review_items(due);
CREATE INDEX IF NOT EXISTS idx_review_logs_item ON review_logs(review_item_id);
CREATE INDEX IF NOT EXISTS idx_review_logs_time ON review_logs(review_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_path ON notes(path);

PRAGMA user_version = 1;  -- Schema version; PRAGMA foreign_keys = ON enforced at runtime
```

---

## 5. Scheduling & Optimization Engine (`fsrs-rs`)

- **Core Library**: Official Rust `fsrs` crate in `crates/flashcards-wasm`.
- **Directional Review Split**:
  - For forward cards: 1 review item (`{note_id}:{block_id}:forward`).
  - For bi-directional cards: 2 distinct review items (`{note_id}:{block_id}:forward` and `{note_id}:{block_id}:reverse`), each maintaining its own independent stability, difficulty, and review due date.
- **Rating Actions**:
  - MVP exposes 2-button grading: **Forgot** (`Again` / Rating 1) and **Remembered** (`Good` / Rating 3). The Rust engine computes all 4 FSRS candidates (`Again`/`Hard`/`Good`/`Easy`) internally, but the UI maps only `Forgot → Again` and `Remembered → Good` (see `src/ui/ReviewModal.ts:92` and `src/ui/components/ReviewStage.svelte:129`).
  - Underlying FSRS model supports `Hard` (2) and `Easy` (4); extending the UI to 4 buttons requires mapping those candidates without DB migration.

### 5.1 Plugin Settings & FSRS Configuration

Persisted in `<vault>/.obsidian/plugins/flashcards/data.json` and configurable in the Plugin Settings tab:

| Setting | Type | Format / Default | Description |
| :--- | :--- | :--- | :--- |
| **Desired retention** | Number (%) | `90` (90%) | Target retention rate ($0.80 - 0.99$, mapped to `request_retention: 0.90`). |
| **Maximum interval** | Number (days) | `36500` (100 years) | Maximum interval cap in days (mapped to `maximum_interval`). |
| **Learning steps** | String | `10m 1d` | Space-separated durations for new cards. Units: `m` (minutes), `h` (hours), `d` (days) (e.g. `10m 9h 2d`). |
| **Relearning steps** | String | `10m` | Space-separated durations after lapsed/forgot cards. Units: `m`, `h`, `d`. |
| **Weights** | String / Array | `""` (empty by default) | Custom FSRS weight parameters `w`. Empty uses FSRS-6 defaults; populated when optimized. |
| **Fuzz** | Boolean | `true` | Toggle to apply small random interval variations to prevent card clustering (mapped to `enable_fuzz`). |
| **Next day starts at** | Number (hours) | `4` (4:00 AM) | Cutoff hour past midnight when cards become due for the next study day (`rolloverHour`). |

#### Settings Actions:
- **Optimize Weights Button**: Executes the Rust `fsrs-rs` optimizer across historical logs in `review_logs` via WASM, calculating optimal personalized weights in milliseconds without blocking the UI.
- **Reset to Defaults Button**: Restores all FSRS parameters, retention goals, and step intervals to recommended defaults (clears `data.json`).
- **Optimize Database Button** (also `Flashcards: Optimize database` command): Runs `PRAGMA integrity_check`, prunes stale `notes` via `validPaths`, deletes orphaned `blocks`/`review_items`, executes `VACUUM` + `PRAGMA optimize`, and persists atomically (see `src/db/DatabaseManager.ts:272`).

---

## 6. UI Components & Design System (Svelte 5)

All UI views are built with Svelte 5 (using runes) and mounted directly into Obsidian containers (`Modal.contentEl` and `ItemView.contentEl`).

### 6.1 Design System & Typography
The visual design, CSS design tokens, animations, and interaction model provide a modern, minimalist card review experience:
- Semantic DOM structure and accessible iconography.
- Smooth CSS theme tokens, transitions, and subtle elevation shadows.
- Svelte 5 runes reactive state machine, keyboard shortcut handler, and in-place reveal animations.

---

### 6.2 Review Workspace View / Modal
Distraction-free, responsive active recall review interface:

1. **Top Header & Breadcrumbs**:
   - Single top-left close button (`Esc`).
   - Active deck breadcrumb navigation (`All Cards / Due cards` or `#german #vocab / Due cards`).
   - Animated circular progress indicator ring + numeric counter (`1 / 5`, `2 / 5`).
   - Keyboard cheatsheet trigger (`?`).

2. **Flashcard Stage & Reveal Animation**:
   - Centered floating card with elevation shadows (`box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.08)`), rounded corners (`14px`), and subtle border.
   - **Card Meta Header**: Note title, `Reverse` badge, `Todo` badge, and humanized due status.
   - **Front Content**: Centered typography rendered via Obsidian's `MarkdownRenderer`.
   - **Reveal Divider**: Clean, continuous 1px solid separator line with smooth reveal animation (for standard Q/A & block cards).
   - **In-Place Cloze**: Cloze cards unmask `[ ... ]` into highlighted answers directly in-place without duplicating sentences.
   - **Inside-Card Subtle Hint (Desktop)**: Static, minimalist helper text at the bottom of the card (`Press Space to reveal answer` $\to$ `Press Space if remembered, F if forgot`).

3. **Responsive Mobile Action Bar & Touch Navigation**:
   - **Clamped Bottom Bar (Mobile Only)**: Pinned to the bottom of the screen with thumb-friendly large tap targets (**Show Answer** $\to$ **Forgot** and **Remembered**).
   - **Screen-Half Tap / Swipe Navigation**: Tapping anywhere on the left half of the screen/workspace (outside the card and buttons) navigates to **Previous Card**; tapping the right half advances to **Next Card / Skip**. Also supports horizontal swipe gestures.
   - **Desktop Shortcut-Only**: Bottom toolbar is completely omitted on desktop for a distraction-free, keyboard-driven study experience.

4. **Keyboard & Touch Navigation**:
   - <kbd>Space</kbd>: Reveal Answer $\to$ Mark Remembered (`Good` / Rating 3) after reveal.
   - <kbd>F</kbd>: Mark Forgot (`Again` / Rating 1) after reveal.
   - <kbd>↓</kbd> / <kbd>↑</kbd>: Reveal / Hide Answer (zero rating effect).
   - <kbd>→</kbd> / <kbd>←</kbd> (or Tap Right/Left screen): Next / Previous Card (zero rating effect, no DB write).
   - <kbd>T</kbd>: Toggle `#todo/card` tag on active card block (`src/ui/ReviewModal.ts:165`).
   - <kbd>Ctrl+Z</kbd> / <kbd>Cmd+Z</kbd>: Undo last review action within the active session.
   - <kbd>?</kbd> / <kbd>Shift+/</kbd>: Slide-in shortcuts cheatsheet drawer.
   - <kbd>Esc</kbd>: Close drawer or modal.

5. **Completion Screen & Notifications**:
   - Finished state with the Lucide `party-popper` icon and session summary metrics:
     - **Cards Studied**: Count of reviews completed in the session.
     - **Session Retention**: Accuracy rate (e.g. `94%` Remembered).
     - **Session Duration**: Formatted study time (e.g. `3m 42s`).
   - Toast notification feedback banner for card review and tagging actions.

---

### 6.3 Flashcards Dashboard View (`ItemView`)
Dedicated Obsidian workspace tab and view (`flashcards-dashboard-view`) displaying a live inventory table and daily study metrics:

#### Header Stats Bar (from `sessions`):
- **Studied Today**: Count of cards studied today.
- **Daily Retention**: Average retention percentage today.
- **Study Streak**: Continuous consecutive daily study streak.

#### Inventory Columns:
1. **Note**: Basename of the note. Clickable to open and navigate to the note in the editor.
2. **Front**: Question text. Clickable to jump directly to the exact block in the note (`note.md#^id`).
3. **Back**: Answer text. Clickable to jump directly to the exact block in the note.
4. **Due**: Next due date (humanized: `In 2 days`, `Tomorrow`, `Overdue by 1d`, or `New` if never reviewed).
5. **Reviews**: Total review count (`reps`).
6. **Last Practiced**: Humanized relative date (e.g. `2 hours ago`, `Yesterday`, `Never`).

#### Dashboard Actions & Features:
- Real-time search filter across notes, questions, and answers.
- Status filter pills (**All**, **Due today**, **New**, **Learning**, **Review**).
- Column sorting (sort by due date, note name, review count, etc.).
- Primary **Start Review** button in header.

---

## 7. Commands & Synchronization Flow

To keep the plugin lightweight and predictable, cards are scanned and synchronized on-demand via explicit commands rather than heavy continuous background watchers.

### 7.1 Registered Commands

| Command Name | Scope | Description |
| :--- | :--- | :--- |
| **`Flashcards: Study all cards`** | Global | Launches the practice review queue directly for all cards in the entire vault. |
| **`Flashcards: Study deck`** | Global | Opens a Tag Picker prompt to select tags (e.g. `german vocab`). Dynamically builds a pseudo-deck on the fly and launches a filtered review session. |
| **`Flashcards: Open dashboard`** | Global | Opens the Flashcards Inventory & Scheduling dashboard tab. |
| **`Flashcards: Scan current note`** | Editor | Scans the active note for cards (`%% card-start %%`, `::`, `:::`, `==...==`), mints missing IDs, inherits note `tags:`, updates SQLite, and shows a summary notice. |
| **`Flashcards: Scan entire vault`** | Global | Scans all notes across the vault, stamps missing IDs, syncs tags, and updates the entire database. |
| **`Flashcards: Insert card block`** | Editor | Generates a fresh block ID and inserts `%% card-start id=xyz123 %%` + newline + `...` divider + `%% card-end %%` (`%% card-start id=xyz123 %%\n\n...\n\n%% card-end %%`), placing the cursor on the front-content line between the header and divider. |
| **`Flashcards: Optimize FSRS weights`** | Global | Runs the `fsrs-rs` optimizer over `review_logs`, updates weights in `data.json`, and notifies the user upon completion. |
| **`Flashcards: Optimize database`** | Global | Runs database integrity checks, prunes stale notes, cleans orphaned blocks/items, executes `VACUUM`, and optimizes query planner. |

---

### 7.2 Pseudo-Decks (Tag-Based Study Sessions)
- **No Database Overhead**: The database has no explicit "decks" table.
- **On-the-Fly Assembly**: When the user runs `Flashcards: Study deck`, `TagPickerModal` accepts space-separated tags (e.g. `german english`). `DatabaseManager.getDueReviewItems` filters via `src/utils/dashboardFilter.ts:9` `matchCardTags` (case-insensitive, hierarchical: `vocab` matches `vocab/level1` via `startsWith(tag + '/')`, OR across filters).
- **Tag Inheritance**: Each `blocks.tags` row inherits tags normalized by Obsidian's `parseFrontMatterTags` from the file cache, plus any inline `#tags` found in the raw line / block header / block inner content (extracted by `parser.rs` `extract_inline_tags`). Example: frontmatter `tags: [german]` + line `... #vocab` → stored as `german vocab`.

---

### 7.3 Synchronization Flow

```
Command Triggered ('Scan current note' / 'Scan entire vault')
                         │
                         ▼
            Check frontmatter `cards-ignore`
                 ┌─────────┴─────────┐
         true: Mark│              false│
         notes.ignored=1             │
         (skip parse,                ▼
          exclude from          Check Note Frontmatter ID
          queues)       ┌───────────┴───────────┐
                   Has ID│                       │Missing ID & contains cards
                        │                       │
                        │              Generate UUID (crypto.randomUUID) and
                        │              insert into note frontmatter via processFrontMatter
                        ▼                       ▼
               Read Obsidian MetadataCache section hints and frontmatter tags
                         │
                         ▼
               Parse Card Blocks via Rust WASM (crates/flashcards-wasm):
               - One pulldown-cmark offset pass builds protected source ranges
               - Inline `::` / `:::` + Block `%% card-start %%` + Cloze `==..==`
               - Code and math spans cannot contribute card delimiters or clozes
               - Extract trailing ` ^id` or `id=...` and validate 6-char hex
                         │
                         ▼
               Deduplicate & Mint IDs (src/scanner/identity.ts):
               - `deduplicateBlockIds` blanks second occurrence of duplicate `block_id`
               - If any `block_id` is empty, generate fresh hex via `generateBlockId()` + `stampBlockId()`
               - Write updated markdown back to vault (preserves line offsets)
                         │
                         ▼
               Sync to SQLite (`cards.db` via DatabaseManager):
               - Upsert `notes(path, mtime, ignored=0)` (cleans old path on rename)
               - Upsert `blocks` with FNV-1a `content_hash` (detect edits)
               - Generate `review_items` for new directions (state=New, due=now); prune obsolete directions when `direction` changes
               - Prune deleted blocks (`DELETE FROM blocks WHERE note_id=? AND block_id=?` for missing IDs)
               - No-op delete of stale `notes` on vault-wide scan (`pruneDeletedNotes`)
               - Persist atomically: export → `cards.db.writing` (header check) → swap → `cards.db`
```

---

## 8. Directory & Module Layout

### 8.1 Rust WASM Core (`crates/flashcards-wasm/`)
```
crates/flashcards-wasm/
├── Cargo.toml                    # dependencies: fsrs = "6.6", wasm-bindgen, serde, getrandom, pulldown-cmark
├── src/
    ├── lib.rs                    # wasm-bindgen interface & exports
    ├── types.rs                  # Rust data structures (Card, Rating, State, FsrsParams)
    ├── fsrs.rs                   # FsrsEngine scheduling bridge using official fsrs crate
    ├── parser.rs                 # Card orchestration, block directives, tags & FNV-1a content hashes
    ├── markdown.rs               # pulldown-cmark offset map and protected Markdown ranges
    ├── syntax.rs                 # Source-aware card separators, clozes, and block IDs
    └── optimizer.rs              # On-device weight training over review_logs
└── fuzz/
    ├── Cargo.toml                # cargo-fuzz harness
    ├── fuzz_targets/parse.rs     # no-panic and ParsedBlock invariant checks
    └── seeds/parse/              # Curated .md seeds plus ignored generated corpus inputs
```

### 8.2 TypeScript & Svelte 5 Plugin (`plugins/flashcards/`)
```
plugins/flashcards/
├── manifest.json
├── package.json
├── vite.config.ts
├── styles.css
├── ARCHITECTURE.md
├── src/
│   ├── main.ts                   # Plugin lifecycle: register commands, views, events, init WASM
│   ├── settings.ts               # Plugin settings & configuration tab (sparse data.json)
│   ├── wasm.ts                   # WASM binary loader & typed bridge for Rust and sql.js
│   ├── types.ts                  # Domain models, UI state, card types, FsrsParams
│   ├── db/
│   │   ├── schema.ts             # SQLite DDL and indexes
│   │   └── DatabaseManager.ts    # SQLite WASM manager with atomic swaps & 4 AM rollover
│   ├── scanner/
│   │   ├── identity.ts           # Block ID generation, note-ID collision & duplicate-ID healing
│   │   └── NoteScanner.ts        # Note UUID stamping, block ID minting & markdown sync
│   ├── utils/
│   │   ├── studySteps.ts         # Parse `10m 1d` learning/relearning step strings → ms arrays
│   │   └── dashboardFilter.ts    # Tag matching (hierarchical, case-insensitive) & search filtering
│   └── ui/
│       ├── ReviewModal.ts        # Modal review runner
│       ├── DashboardView.ts      # Dashboard ItemView controller
│       ├── TagPickerModal.ts     # Deck selector modal
│       └── components/
│           ├── ReviewStage.svelte        # Svelte 5 review stage, MarkdownRenderer & shortcuts
│           ├── DashboardView.svelte      # Dashboard statistics & inventory browser
│           └── TagPickerModal.svelte     # Tag picker UI component
└── tests/
    └── flashcards.test.ts        # Study day rollover & boundary unit tests
```

## 9. Parser validation

Parser regressions live beside the Rust parser tests and cover code/math exclusion, block-level protection, malformed block cards, Unicode, and source line tracking. The Rust WASM core fuzz harness (`crates/flashcards-wasm/fuzz`) runs the `parse` target against curated `.md` seeds and grows the seed directory with coverage-guided mutations via `cargo fuzz run parse seeds/parse`. The fuzz target accepts arbitrary valid UTF-8 Markdown, exercises both cache-free and Obsidian-section-hinted parsing, and asserts that parsing never panics and every returned block has valid non-empty fields and line bounds.
