# Obsidian → Anki Sync Plugin — Architecture

**Status:** Personal plugin, not published. Optimize for maintainability and clarity over configurability.

## 1. Purpose & Scope

A minimal Obsidian plugin that:

1. Parses flashcards written in plain markdown inside Obsidian notes.
2. Pushes them to Anki via a **purpose-built addon** running inside Anki (not AnkiConnect).
3. Writes generated identifiers back into the source file so re-syncing is idempotent.

**Obsidian is the source of truth.** Note creation, modification, and deletion are strictly one-way (Obsidian → Anki). Anki owns SRS review state only — this plugin never reads it back and never touches Anki's built-in note types (`Basic`, `Basic (and reversed card)`).

### Explicit non-goals

- Minimal settings UI.
- No cloze deletion, no image occlusion.
- No bidirectional sync. Editing a card's fields in the Anki browser will be silently overwritten on next sync from Obsidian.
- No automatic deletion of Anki notes when a card is removed from a file. Orphans are tagged, never deleted.
- No AnkiConnect dependency.

---

## 2. Card Syntax

### 2.1 Frontmatter Requirement

For a file to be processed by the sync engine, it **must** explicitly opt-in by including the `anki-deck` property in its YAML frontmatter. Files without this frontmatter are strictly ignored to prevent unintended ingestion of non-flashcard notes.

```yaml
---
anki-deck: 'Computer Science::Algorithms'
---
```

### 2.2 Inline cards

```
What is the capital of France? :: Paris
Mitochondria ::: Powerhouse of the cell
```

### 2.3 Block cards

Delimited by `%% card start ... %%` / `%% card end %%`. Body is separated into Front/Back by a horizontal rule of **3 or more dashes on their own line**.

```
%% card start %%
What is the capital of France?

----------------

Paris
%% card end %%
```

---

## 3. Core Philosophy

- **Obsidian is the source of truth.** Markdown files dictate the state of Anki cards.
- **Native GUIDs, plugin-generated.** Obsidian generates the unique ID for each card and dictates it to Anki. Anki's `notes.guid` column is untyped `TEXT` with **no format or uniqueness constraint** — any alphanumeric string is accepted. We use a NanoID rather than replicating Anki's own Base91 scheme, to avoid symbols that collide with Markdown syntax.
- **Bypass AnkiConnect.** It's too generic and too chatty for a personal, single-purpose sync tool. A purpose-built HTTP addon exposes one bulk endpoint instead of many small round-trips.

---

## 4. Components

### 4.1 The Addon (Anki side) — `anki-sync/anki-addon`

A lightweight HTTP server running on a background thread inside Anki, bound to **`127.0.0.1` only** (default port `8766`). Python package name: `obsidian_anki_sync`. Managed with `uv`; linted/type-checked with `ruff` and `ty`.

Basic shared-secret header check on every request, since a local unauthenticated HTTP server is still an attack surface even on loopback.

#### API boundary: read-only SQL exception

The addon's baseline rule is **strict API-only** — no raw SQL mutations, ever. All writes go through `col.update_note()`, `col.add_note()`, `col.decks`, etc., so Anki's own sync/mod-time bookkeeping stays correct.

**Documented exception:** Anki's search grammar has no `guid:` filter (confirmed against Anki's own search syntax and forum reports — GUID is not searchable in the browser or via `find_notes`). Since GUID-based lookup is the whole point of this design, the addon uses a **read-only** SQL query for lookup only:

```python
rows = col.db.list("select id from notes where guid = ?", uuid)
if len(rows) > 1:
    raise SyncError(f"Duplicate guid {uuid}: refusing to guess which note to update")
note_id = rows[0] if rows else None
```

Read-only queries can't corrupt sync state the way writes can, but because `guid` has no uniqueness constraint, a query must never blindly take the first match — hence the explicit duplicate check and hard failure. All subsequent reads/writes to the note go through `col.get_note()` / `col.update_note()` as normal.

#### Endpoints

- **`POST /syncNotes`** — bulk upsert. Payload: array of note objects (`uuid`, `deckName`, `modelName`, `fields`, `tags`).
- **`POST /markOrphaned`** — tags notes removed from Obsidian with `orphan`. Never deletes.
- **`GET /health`** — returns addon version + Anki profile-loaded status, so the TS shim can distinguish "Anki not running" from "Anki running but addon not loaded."

#### Bulk execution & partial application

The addon loops over the batch; each note is wrapped in its own `try`/`except`. One bad note (duplicate guid, missing note type, malformed field) does **not** abort the batch — the loop logs the error for that UUID and continues with the rest. Atomic all-or-nothing rollback is deliberately not used: a single malformed card in a 200-card vault sync should not block the other 199.

**Response contract** — always `200 OK` if the request itself reached the addon, with a per-item status map:

```json
{
	"4f90d13a41eBcD89QzXy2": "success",
	"9kLp2xQ7z...": "error: duplicate guid",
	"aB3dE9...": "error: model 'Custom' has no field 'Extra'"
}
```

The TS shim uses this map to decide which newly generated UUIDs are safe to treat as confirmed vs. which need retrying next sync (see §6).

A **separate, structured `500`** response is used only for handler-level failures that prevented any notes from being processed at all (malformed JSON body, Anki collection locked, profile not loaded):

```json
{ "error": "Anki collection is locked" }
```

This lets the TS shim show a distinct, accurate Obsidian Notice ("Sync failed: Anki database locked") rather than a generic failure message, and lets it separately detect connection-refused (Anki not running at all) as yet another distinct case.

#### Threading model

Heavy database writes (`col.add_note()`, `col.update_note()`) are explicitly thread-safe in modern Anki and _should_ run on a background thread to prevent UI freezes. However, UI refresh logic must run on the main thread.

The HTTP handler executes incoming requests via `mw.taskman.run_in_background(background_task, on_done)`:

- The `background_task` mutates the DB off the main thread, avoiding UI lockups even for large batch syncs.
- It bypasses `aqt.operations.CollectionOp` because that class rigidly expects a Rust `OpChanges` struct to update the UI, and crashes if a generic dictionary is returned.
- The `on_done` callback resolves the HTTP future and explicitly calls `aqt.gui_hooks.state_did_reset()` on the main thread to refresh the Anki UI safely.

#### Deck / model handling

- **Deck**: auto-created if missing (`col.decks.id(name, create=True)` is standard Anki behavior).
- **Note type (model)**: must already exist. If `modelName` doesn't exist, or `fields` contains a key not present on that model, the note fails with a descriptive error in the response map (see partial application above) rather than silently dropping data or auto-mutating a note type's schema.

---

### 4.2 The Obsidian Plugin ("Thick WASM, Thin Shim") — `anki-sync/obsidian-plugin`

#### Rust Core (WASM) — "The Brain"

- **Pure data processing.** Zero knowledge of Obsidian's JS API or filesystem. A `String -> (String, Payload)` pipeline, testable via `cargo test`.
- **Parser & HTML compiler.** Scans markdown for cards (inline and block forms), skipping ranges identified by `pulldown-cmark`'s event iterator as fenced code / math blocks. Compiles card bodies to HTML via `pulldown-cmark::html::push_html`. Typst math (if enabled) is pre-converted in TypeScript before being handed to WASM.
- **UUID generation.** `nanoid` crate, custom 62-character alphanumeric alphabet, 21-character IDs — no symbols, so IDs are safe to embed directly in Markdown.
- **ID injection.** Modifies the markdown text and injects new IDs.
- **Diff cache.** The WASM instance persists in memory for the lifetime of the plugin session, so repeated syncs within one Obsidian session are cheap. Across restarts, TypeScript persists a small JSON cache (per-card content hash, keyed by UUID) to the plugin's data directory and rehydrates it into Rust on load — the cache is a performance optimization only; correctness never depends on it, since Anki-side upserts are idempotent by guid regardless (§6).

#### TypeScript Shim — "The Dumb Orchestrator"

- **UI & commands.** Ribbon icon, settings, `Sync current file`, `Force sync current file (ignore cache)`, `Sync all files`. Command-triggered only — the plugin does **not** listen to vault change events to auto-sync, specifically to avoid the plugin's own `app.vault.modify()` write-back re-triggering itself in a loop. If auto-sync-on-save is ever added later, it must track its own recent writes (e.g. a short-lived "just wrote this path" set) and ignore matching change events.
- **Reentrancy guard.** `Sync all files` is disabled/no-ops while a sync is already in flight, with a status indicator shown in the UI, rather than allowing overlapping batch requests.
- **File I/O.** Reads raw `.md` via `app.vault`, passes to WASM.
- **Write-back.** Saves the WASM-modified `.md` string via `app.vault.modify()` — including newly injected UUIDs, even for cards whose network push later fails (see §6).
- **Network I/O.** POSTs the WASM-compiled payload to the addon via `requestUrl()`; distinguishes connection-refused ("Anki isn't running") from a `500` response ("sync failed: \<reason>") from a per-item `"error: ..."` entry in a `200` response (that specific card failed, sync otherwise succeeded).

---

## 5. Sync Flow

1. **Trigger:** user runs a sync command (guarded against reentrancy).
2. **Read (TS):** raw markdown text passed to Rust, along with the persisted diff cache.
3. **Process (Rust):** parses the tree, generates NanoIDs for new cards, compiles HTML, injects IDs into the text, updates the diff cache.
4. **Return (Rust):** structured `(modified_markdown, anki_payload, updated_cache)`.
5. **Write-back (TS):** saves `modified_markdown` to disk immediately — independent of whether the network push in step 6 succeeds.
6. **Push (TS):** POSTs `anki_payload` to the addon.
7. **Apply (Anki):** addon upserts by guid, per §4.1, returning a per-item status map or a structured error.
8. **Reconcile (TS):** persists the updated diff cache; surfaces per-item failures (if any) in a Notice; re-enables the sync command.

---

## 6. Resilience & Edge Cases

- **Write-back on partial failure.** If a new card's UUID is generated and injected into the markdown (step 3) but that card's network push fails (step 7), the file is **still saved** with the new UUID. This is intentional and harmless: because the addon upserts by guid, the next sync sees that UUID as an "existing" card lookup that returns no match, and simply creates it — no duplicate, no data loss.
- **Retry / idempotency.** The whole flow is idempotent by construction. If Obsidian closes mid-sync, any unsaved cache update is discarded; on next launch Rust re-diffs from the persisted cache (or from scratch if none exists) and re-pushes. A duplicated payload for an already-synced card just updates that note in place.
- **Anki unreachable vs. Anki erroring.** TS distinguishes connection-refused (Anki not running, or addon not loaded — checkable via `/health`) from a `500` (Anki running but the request itself failed) from per-item `"error: ..."` entries (Anki fine, this specific card is malformed). Each gets a distinct, accurate Notice rather than a generic "sync failed."
- **No self-triggered resync loops.** Sync is command-triggered only; the plugin does not watch for vault changes.
- **Manual Overrides.** If a user edits a card directly in Anki's UI, a standard Obsidian sync won't overwrite it because the file hash in Obsidian hasn't changed. The `Force sync current file (ignore cache)` command allows the user to explicitly bypass the cache, forcibly pushing Obsidian's state to Anki to overwrite manual Anki UI changes, while still keeping the cache tracking intact so orphan detection doesn't break.
- **No overlapping vault-wide syncs.** Reentrancy guard on the `Sync all files` command.

---

## 7. Finalized Decisions

- **Migration of existing cards:** ignored. All IDs are NanoIDs going forward; the parser accepts alphanumeric IDs, and old cards can be manually regenerated if needed.
- **Orphan handling:** automatically tagged `orphan` in Anki via `/markOrphaned`. Never auto-deleted — users review and delete manually in the Anki browser.
- **API-only rule:** raw SQL mutations are forbidden. Read-only SQL is permitted, solely for guid lookup, because no native search filter exists for it — with a hard failure on any duplicate-guid result.
- **Addon distribution:** lives in-repo under `anki-sync/anki-addon`, Python package `obsidian_anki_sync`, managed by `uv`, linted/type-checked with `ruff`/`ty`.

---

## 8. Testing Strategy (E2E)

### 8.1 Test Environment (Golden Base)

Automating Anki's first-run profile creation via scripting can be error-prone due to missing system Qt dependencies (e.g. `libglib`) in headless or minimal Python environments. Instead, the test suite relies on a pre-generated "golden base" directory (`e2e/fixtures/golden-base` containing a `Test` profile).

- **Execution:** The test runner (`pytest` or `vitest`) copies this golden base to a temporary directory before launching Anki.
- **Headless Mode:** Anki is spawned headlessly using `QT_QPA_PLATFORM=offscreen anki -b <temp-base-dir> -p Test`.
- **Isolation:** The test instance is isolated from the user's running Anki app via an overridden `XDG_RUNTIME_DIR`.

### 8.2 Test-Only Reset Endpoint

To avoid the slow penalty of restarting the Anki process for every test, the addon exposes a test-only `/__test__/reset` endpoint.

- It is strictly gated behind the `ANKI_SYNC_TEST_MODE=1` environment variable.
- Calling it wipes all notes and non-default decks, giving each test a clean slate instantly.

### 8.3 Test Layers

1. **Addon Layer (Python, `pytest`):** Uses HTTP requests against the headless Anki server (`127.0.0.1:8766`). Covers edge cases such as missing fields, duplicate guids, model mismatches, and partial application semantics on `syncNotes`.
2. **Plugin-Core Layer (TypeScript, `vitest`):** Exercises the real Rust/WASM parser and `SyncEngine` with mocked network and Obsidian APIs. Because the boundary between Obsidian and Anki is a simple JSON contract, standing up a headless Anki instance for the Node.js tests is unnecessary bloat. These tests rely on `vi.mock()` to fake network responses, verifying only that the payload generated is correct and ID injection/cache hydration behaves as intended.
