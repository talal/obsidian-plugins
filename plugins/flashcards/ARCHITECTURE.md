# Flashcards Plugin — Architecture Specification

**Status:** Current Architecture (v3 — Pure Rust Engine)

## 1. Overview & Core Philosophy

The Flashcards plugin enables spaced repetition learning directly within Obsidian notes powered by a **Fat Rust Core** compiled to WebAssembly and a **Thin TypeScript Shell** for the Obsidian UI, vault I/O, and lifecycle management.

### Core Principles
- **Markdown is the canonical source of truth**: Cards are authored in notes using clean, native Obsidian syntax with 6-character lowercase base-36 block IDs (`^k9x2mp`). Notes contain only human-readable content—never repetition counts, stability floats, or scheduling metadata.
- **Zero Frontmatter Pollution**: Notes never require frontmatter modification or note-level UUIDs. The plugin only stamps IDs on card prompts that need them.
- **Pure Rust Engine (`crates/flashcards-wasm`)**:
  - In-memory `FlashcardsStore` holding parsed prompts, materialized FSRS scheduling cards, review event history, and file sync fingerprints.
  - Zero external database runtime dependencies: no `sql.js`, no SQLite WASM, no Node.js or Electron dependencies. Fully compatible with desktop and mobile.
  - Ultra-fast binary snapshot persistence via `postcard` to `cards.bin`.
  - Official `fsrs` crate from crates.io (`version 6.6.1`) for state evaluation, load-balanced scheduling, sibling dispersion, and on-device weight optimization.
  - AST-aware Markdown parser with `pulldown-cmark` protection for code blocks, display math, tables, callouts, and blockquotes.
  - Scan-scoped `CollisionRegistry` for O(1) deduplication and deterministic generation of base-36 IDs (`^k9x2mp`).
  - Native Markdown tag manipulation in Rust (`toggle_prompt_tag`, `add_prompt_tag`): TypeScript performs zero regex or string surgery on markdown files.
- **Thin TypeScript Shell (`plugins/flashcards`)**:
  - Obsidian UI components built in Svelte 5 styled exclusively with official Obsidian CSS variables.
  - Focused review modal (`ReviewModal`) powered by a unified `ReviewSession` controller.
  - Inventory and scheduling dashboard (`DashboardView`).
  - `NoteScanner`: Pure Obsidian Vault I/O (`cachedRead`, `metadataCache`, file events), zero parsing logic.
- **Domain Hierarchy**:
  - **Note (`.md` file)**: Physical vault file tracked by modification time and size.
  - **Prompt**: Logical question/answer unit extracted from markdown (inline forward, inline reversible, two-line Q/A, cloze, multiline).
  - **Card**: Materialized FSRS study item (forward, reverse, or cloze).
  - **Review**: Immutable historical log entry recording grade, timestamps, and interval deltas.

---

## 2. Card Syntax in Markdown

### 2.1 Simple Forward Cards (Inline)
Single-line question and answer separated by `::` (with or without spaces) and a trailing 6-character lowercase base-36 block ID. Produces `reversible = false` (1 forward card):
```markdown
Capital of France? :: Paris ^k9x2mp
```

### 2.2 Bi-directional Cards (Inline)
Single-line card separated by `:::`. Produces `reversible = true` (1 prompt, 2 cards: Forward: Q → A, Reverse: A → Q):
```markdown
Photosynthesis ::: Process converting sunlight to glucose ^b8w1pq
```

### 2.3 Two-Line Q/A Cards
Strictly adjacent two-line question and answer. Block ID is stamped on the **Question line**:
```markdown
Q: What is Rust? #programming ^r7m2kq
A: A systems programming language focusing on safety and speed.
```
- Non-reversible (1 forward card).
- Strict adjacency: no blank line between `Q:` and `A:`.
- Tags and block ID live on the `Q:` line for consistency with inline syntax.

### 2.4 Cloze Deletion Cards
Uses explicit `{{cloze}}` double curly brace syntax. All clozes in a card are revealed in-place:
```markdown
The capital of Japan is {{Tokyo}} ^j9a1kp

Photosynthesis produces {{oxygen}} and {{glucose}}. ^w7n3rk
```
- Non-reversible.
- **In-Place Seamless Reveal**:
  - **Question State**: Cloze spans are masked in-place as `[ ... ]` pills (`.fc-cloze-mask`).
  - **Answer State**: Masked pills unmask into highlighted `<mark>` answers (`.fc-cloze-revealed`) directly in-place.

### 2.5 Block Cards (Multi-line)
Wrapped inside Obsidian comment markers `%% ... %%` so metadata is completely invisible in Reading View and Live Preview:
```markdown
%% card-start id=m1x8yz %%
#card/history
What are the three branches of government?

:::

- Legislative
- Executive
- Judicial
%% card-end %%
```
- **Divider & Direction**:
  - `::` on its own line: Forward block card (`reversible = false`).
  - `:::` on its own line: Bidirectional block card (`reversible = true`).

### 2.6 Markdown Protection & AST Boundaries
Card syntax is parsed with AST source protection:
1. `pulldown-cmark` generates an eligibility byte mask over the document.
2. Inline code spans, fenced code blocks, display math, tables, blockquotes, callouts, raw HTML, and YAML metadata are strictly protected from matching card separators or cloze markers.
3. Non-card prose in notes is ignored gracefully without causing parser errors or aborting scans.

### 2.7 Tag Manipulation in Markdown
All tag toggling and injection is performed by the Rust WASM parser:
- **`#card/todo` Toggle (Hotkey <kbd>T</kbd> during review)**:
  - Rust WASM searches for `#card/todo` on the prompt and removes it, or inserts it before the block ID (`content #card/todo ^id`).
- **`#card/leech` Marking**:
  - Automatically added by Rust WASM when review lapses reach the user-configured leech threshold.
- Zero regex or string replacement in TypeScript.

---

## 3. Storage Architecture: Pure Rust & Postcard Binary Snapshot

### 3.1 Eliminating SQLite (`sql.js`)
Previous versions relied on `sql.js` (SQLite compiled to WASM), which required bundling a 1.2 MB WASM binary, managing schema migrations, handling dual-slot transactional file sync (`cards.a.db` / `cards.b.db`), and performing complex SQL query mapping.

The v3 architecture completely replaces SQLite with an in-memory Rust store serialized to `<vault-dir>/.flashcards/cards.bin` via **Postcard**:
- **Binary Size**: Plugin bundle reduced from ~1.3 MB to ~97 kB.
- **Speed**: Snapshot serialization and deserialization takes < 1 ms for thousands of cards.
- **Portability**: Pure Rust with zero POSIX or Electron assumptions—runs natively on Android, iOS, Windows, macOS, and Linux.
- **Data Isolation**: Stored in `<vault-dir>/.flashcards/cards.bin` (separate from the plugin code directory) ensuring plugin updates, reinstalls, or multi-device configurations (`.obsidian` vs `.obsidian-mobile`) never overwrite or fragment review history.

### 3.2 In-Memory Store Structure (`crates/flashcards-wasm/src/types.rs`)

```rust
pub struct FlashcardsStore {
    pub prompts: HashMap<String, Prompt>,
    pub cards: HashMap<u32, Card>,
    pub reviews: Vec<ReviewLog>,
    pub file_sync: HashMap<String, FileSyncState>,
    pub next_card_id: u32,
    pub next_review_id: u32,
}
```

- **`prompts`**: Keyed by 6-character lowercase base-36 prompt ID (`^k9x2mp`). Contains file path, card type, reversibility, front/back text, tags, and line ranges.
- **`cards`**: Materialized FSRS study items keyed by integer `card_id`. Contains FSRS stability, difficulty, reps, lapses, learning steps, state, and `due_at` epoch timestamp.
- **`reviews`**: Immutable append-only event ledger storing review grades, review timestamp, scheduled days, and previous state parameters (enabling exact 1-step undo).
- **`file_sync`**: Maps file paths to modification timestamps and file sizes for instantaneous change detection.

### 3.3 On-Demand Ephemeral Lifecycle & Syncthing Synchronization

The plugin employs an **ephemeral engine lifecycle** optimized for multi-device workflows where Desktop (e.g. NixOS) runs Obsidian 24/7 and Mobile (e.g. Android) runs periodically, synchronized via **Syncthing**:

```
[Idle State] (0 MB RAM, no timers) ──► Action Triggered (Review / Dashboard / Sync)
                                                 │
                                                 ▼
[Load & Merge] ◄── Read <vault>/.flashcards/cards.bin (< 0.5 ms)
      │
      ▼
[Active Work] (Grade cards / Render stats / Scan notes)
      │
      ▼
[Persist & Drop] ──► Pre-save check ──► Write cards.bin (< 0.5 ms) ──► Drop engine (null)
```

#### 1. Ephemeral Memory Model
- **Zero Idle Memory**: While Obsidian sits open on Desktop without a review session or dashboard open, `engine` is `null`. No background interval polling, no memory leaks, and zero CPU usage.
- **Instantaneous On-Demand Loading**: Because `postcard` deserialization takes < 0.5 ms, `SnapshotStore.loadEngine()` reads `cards.bin` directly when an action begins (**Study all cards**, **Study in tab**, **Study deck**, **Open dashboard**, or **Sync**).
- **Immediate Disk Freshness**: When you perform reviews on Android and Syncthing syncs `cards.bin` to Desktop, Desktop's next review or dashboard access automatically reads the latest synchronized snapshot without requiring background polling or reload watchers.
- **Teardown on Close**: When a review session or modal finishes or closes, final state is persisted and the engine reference is dropped from memory for garbage collection.

#### 2. CRDT-Like Deterministic Merge (`FlashcardsStore::merge`)
Because reviews are immutable, timestamped historical events, two stores can be merged deterministically without loss of user progress:
- **Semantic Card Identity**: Cards are correlated semantically by `(prompt_id, direction)` rather than raw integer IDs. If two devices create new cards while offline with the same integer ID, the incoming card and its associated review logs are safely remapped to a fresh unique ID, completely preventing ID collisions.
- **Card State Resolution**: If the same card was updated on multiple devices, the state with the later `last_review` timestamp wins (breaking ties with higher repetitions).
- **Review Log Union**: Reviews from both devices are deduplicated by `(card_id, review_time, rating)`, remapped if needed, merged, and chronologically sorted.
- **Prompt & File Sync Merging**: Prompts and file sync fingerprints take the version with the newer `updated_at`/`modified_at` timestamp.
- **ID Counter Propagation**: `next_card_id` and `next_review_id` advance to ensure future allocations never collide with existing merged items.

#### 3. Pre-Save Safety Guard (`SnapshotStore.saveEngine`)
Before serializing to disk, `SnapshotStore` checks if `cards.bin` on disk has changed (by `mtime` or `size`). If external changes were delivered by Syncthing while the current session was active, those external changes are merged into memory *first* before writing back.

#### 4. Syncthing Conflict File Auto-Resolution (`cards.sync-conflict-*.bin`)
If concurrent offline reviews on both devices cause Syncthing to emit conflict files (`cards.sync-conflict-*.bin`):
1. `SnapshotStore.resolveSyncConflicts()` scans `.flashcards/` for matching conflict patterns.
2. The conflict snapshot is decoded and merged into the engine via `merge_from_bytes()`.
3. The conflict file is deleted from disk via `adapter.remove()`.
4. The consolidated store is saved as the canonical `cards.bin`.

---

## 4. Note Scanner & Vault Synchronization

`NoteScanner` (`src/scanner/NoteScanner.ts`) is a pure Obsidian Vault I/O coordinator:
1. **Incremental Change Detection**: Compares `file.stat.mtime` and `file.stat.size` against `engine.is_file_unchanged(file.path, mtime, size)`. Unchanged notes are skipped without reading file content from disk.
2. **Batch Synchronization**: Reads modified notes using `app.vault.cachedRead()`, extracts inherited tags from `metadataCache`, and passes the content to `WasmBridge.syncNote()`.
3. **ID Assignment**: If any prompt lacks an ID or has a duplicate ID, Rust WASM allocates unique IDs and returns `updated_content`. `NoteScanner` modifies the note via `app.vault.modify()`.
4. **Snapshot Persistence**: At the end of the scan, writes the binary snapshot to `.flashcards/cards.bin` via `app.vault.adapter.writeBinary()`.
5. **Stale Note Pruning**: `engine.prune_deleted_files()` removes deleted notes and orphaned cards in a single step.

---

## 5. Review Sessions & User Interface

### 5.1 Unified Review Architecture (`ReviewSession.ts`)
Review logic is decoupled from UI presentation:
- **`ReviewSession`**: Encapsulates card grading, interval calculation, FSRS schedule update, leech detection, undo restoration, and tag toggling.
- **`ReviewModal` (`src/ui/ReviewModal.ts`)**: Dedicated modal dialog hosting the review canvas, providing clean ephemeral memory cleanup and strict hotkey/focus containment across desktop and mobile.

### 5.2 Review Flow & Keyboard Shortcuts

| Key | Context | Action |
| :--- | :--- | :--- |
| <kbd>Space</kbd> / <kbd>Enter</kbd> | Question hidden | Reveal answer |
| <kbd>Space</kbd> / <kbd>Enter</kbd> / <kbd>3</kbd> | Answer revealed | Grade **Remembered** (Good) |
| <kbd>F</kbd> / <kbd>1</kbd> | Anytime | Grade **Forgot** (Again) |
| <kbd>U</kbd> / <kbd>Ctrl+Z</kbd> | Anytime | Undo last review |
| <kbd>T</kbd> | Anytime | Toggle `#card/todo` tag on current card |
| <kbd>Esc</kbd> | Modal | Exit review session |

### 5.3 Immediate Persistence & Checkpoint Safety
- Reviews use a **write-through model**: every graded card immediately updates the in-memory engine and persists a fresh binary snapshot to `cards.bin` on disk (< 0.5 ms).
- Calling `undo()` restores the card's previous scheduling parameters (stability, difficulty, reps, lapses, due date) directly from the popped review log and writes the updated snapshot to disk.
- There is no deferred write-back cache; state on disk is always identical to the live review session. When the modal closes, the engine reference is dropped for immediate garbage collection.

### 5.4 Hierarchical Tag Decks (`TagPickerModal.svelte`)
- Organizes tags into an interactive, collapsible tree matching Obsidian's nested tag syntax (`#language/german/vocab`).
- Parent decks automatically aggregate cards and due statistics from all descendant sub-tags in Rust/WASM.
- Selecting a parent tag cascades to include all nested children; selecting some children places the parent in an indeterminate state.
- The study queue matches cards by exact tag or sub-tag prefix (`language` matches `#language` and `#language/german`), identical to Anki deck behavior.

### 5.5 Queue Semantics & Intra-day Steps
- **Review Cards**: Scheduled on multi-day calendar intervals and eligible for review on or before the study rollover cutoff (`due_at <= due_cutoff_ms`, e.g. 4:00 AM tomorrow).
- **Intra-day Learning & Relearning**: Steps are defined in minutes (e.g. `10m`). Cards are only due once their step timer has elapsed (`due_at <= now_ms`), preventing recently failed cards from re-entering the queue prematurely.
- **Due Badge Formatting**: Formats timestamps accurately based on elapsed time:
  - Elapsed / Intra-day: `"Due now"`
  - Future Intra-day: `"In 10m"`, `"In 2h"`
  - Next Study Day / Multi-day: `"Tomorrow"`, `"In {N}d"`
  - Overdue: `"Overdue ({N}d)"`
- **Session Queue Completion**: When all due cards have been studied, study sessions complete cleanly with a notice (`"All due cards completed for now!"`) rather than falling back to un-due vault cards.

---

## 6. Registered Commands

| Command ID | Name | Scope | Description |
| :--- | :--- | :--- | :--- |
| `study-all-cards` | **Flashcards: Study all cards** | Global | Launches review queue for all due cards in a floating modal. |
| `study-deck` | **Flashcards: Study deck** | Global | Opens Tag Picker prompt to select tags and study filtered cards. |
| `open-dashboard` | **Flashcards: Open dashboard** | Global | Opens the Flashcards Inventory & Scheduling dashboard leaf view. |
| `sync` | **Flashcards: Sync** | Global | Scans notes across the vault, stamps missing IDs, and updates snapshot. |
| `insert-card-block` | **Flashcards: Insert card block** | Editor | Inserts `%% card-start %%\n\n::\n\n%% card-end %%` template at cursor. |

---

## 7. Directory Structure

```
crates/flashcards-wasm/
├── Cargo.toml
├── src/
│   ├── fsrs.rs          # FSRS-6 core scheduling engine, load balancing & item calculations
│   ├── lib.rs           # FlashcardsEngine WASM exports & JS bridge helpers
│   ├── markdown.rs      # pulldown-cmark AST byte-masking
│   ├── optimizer.rs     # On-device weight training over historical review logs
│   ├── parser.rs        # Single-pass sync_document_with_reg & tag manipulation
│   ├── parser_tests.rs  # Comprehensive unit tests for parser and tag modifiers (64 tests)
│   ├── store.rs         # In-memory FlashcardsStore, Postcard binary serialization, review log
│   ├── syntax.rs        # BlockId (u32), CollisionRegistry, base-36 encode/decode, cloze parsing
│   └── types.rs         # Domain types (Prompt, Card, ReviewLog, FsrsParams, DashboardStats)
└── fuzz/
    └── fuzz_targets/parse.rs # libFuzzer target for sync_document

plugins/flashcards/
├── manifest.json
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts              # Lightweight plugin lifecycle & commands (<300 lines)
│   ├── settings.ts          # Settings tab & FSRS optimizer UI
│   ├── storage.ts           # Snapshot persistence & Syncthing conflict resolution (<200 lines)
│   ├── types.ts             # TypeScript interfaces matching Rust types
│   ├── wasm.ts              # WASM bridge loader & FlashcardsEngine wrappers (<230 lines)
│   ├── scanner/
│   │   └── NoteScanner.ts   # Pure Obsidian vault I/O scanner (<210 lines)
│   ├── ui/
│   │   ├── DashboardView.ts # Inventory & stats leaf view
│   │   ├── ReviewModal.ts   # Review modal shell (<60 lines)
│   │   ├── ReviewSession.ts # Unified study session controller (<120 lines)
│   │   ├── TagPickerModal.ts# Deck/tag selector modal (<60 lines)
│   │   └── components/
│   │       ├── DashboardView.svelte
│   │       ├── ReviewBottomBar.svelte
│   │       ├── ReviewCardCanvas.svelte
│   │       ├── ReviewCompletionScreen.svelte
│   │       ├── ReviewModal.svelte
│   │       ├── ReviewTopBar.svelte
│   │       └── TagPickerModal.svelte
│   └── utils/
│       ├── clozeFormat.ts     # Safe HTML-escaped cloze text formatting
│       ├── dashboardCards.ts  # Prompt grouping & reverse card metrics consolidation
│       ├── dashboardFilter.ts # Tag matching & text search filters
│       ├── fsrsParams.ts      # FSRS settings parser
│       ├── reviewMetrics.ts   # Progress & retention calculations
│       ├── studyDay.ts        # Rollover hour & study day date calculations
│       ├── studySteps.ts      # Step duration parsing
│       └── tagTree.ts         # Hierarchical tag tree construction & cascading selection
└── tests/
    └── flashcards.test.ts     # Vitest integration test suite (38 tests)
```
