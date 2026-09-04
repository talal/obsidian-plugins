# Formatter Plugin — Architecture

**Status:** Personal plugin, not published. Optimize for simplicity and minimal code surface. Zero configuration.

## 1. Purpose & Scope

One formatting engine, two front ends, zero drift between them:

- **`formatter-cli`** — a command-line tool (`formatter-cli [PATHS]...`) for formatting vault files from a terminal or script. Accepts files, directories (recursively), or stdin when no paths are given or when `-` is passed. Skips rewriting files whose formatted content matches existing content to avoid unnecessary `mtime` churn and vault sync storms.
- **`formatter-wasm` + Obsidian plugin** — the same engine compiled to WebAssembly, wrapped by a TypeScript plugin that formats notes via CodeMirror 6 diff transactions, preserving folds, selections, and undo history.

Both are consumers of a single **`formatter-core`** crate. To match Obsidian's four-space indentation, the core delegates Markdown formatting to `dprint-plugin-markdown` with its PythonMarkdown list indentation mode.

### Explicit non-goals

- No config file, no per-project style options. One opinion.
- No "format on type" or format-on-save hook — formatting is explicitly on-demand through the CLI or plugin commands.
- No Node.js dependency anywhere in the _runtime_ path. `formatter-cli` is a plain native binary; the plugin's runtime cost is one `.wasm` file loaded by Obsidian's JS engine.

---

## 2. Workspace layout

```
formatter/                              # cargo workspace root
├── Cargo.toml                          # [workspace] members = [...]
├── crates/
│   ├── formatter-core/                 # logic wrapping dprint
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs                  # format() logic with LazyLock config
│   │
│   ├── formatter-cli/                  # bin crate, depends on formatter-core
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs                 # path, dir recursion, and stdin dispatch
│   │
│   └── formatter-wasm/                 # wasm-bindgen shim, depends on formatter-core
│       ├── Cargo.toml
│       └── src/lib.rs                  # #[wasm_bindgen] format_markdown(&str)
│
└── plugins/formatter/                  # TS wrapper
    ├── manifest.json
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.ts                     # command registration and plugin lifecycle
        ├── editor.ts                   # CM6 diff transaction and selection handling
        ├── diff.ts                     # Myers line diff and position/offset mapping
        ├── formatter.ts                # WasmFormatter lifecycle and fault isolation
        └── types.ts                    # DiffHunk and selection offset interfaces
```

---

## 3. Engine & Boundary Design

### 3.1 `formatter-core`

The engine passes the complete Markdown document to `dprint-plugin-markdown` without preprocessing. `dprint` owns line-ending normalization, Markdown syntax, list indentation, fenced code blocks, comments, math, and other recognized extensions. YAML metadata is passed through unchanged; the formatter does not parse, sort, or rewrite frontmatter.

The dprint configuration is statically initialized once via `std::sync::LazyLock` to eliminate configuration rebuild overhead during batch formatting.

### 3.2 Panic containment & Fault Isolation

dprint can panic on pathological input (found by fuzzing). `formatter-core::format` wraps formatting in `catch_unwind` so a panic becomes a per-input error in unwind-enabled targets (the CLI ships with `panic = "unwind"` in the `cli` release profile).

In WebAssembly, execution traps if a panic occurs. The plugin's `WasmFormatter` isolates this by discarding the cached instance on any trapped execution, ensuring subsequent formatting calls cleanly instantiate a fresh WASM instance rather than operating on poisoned memory.

### 3.3 CodeMirror 6 Diff & Transaction Engine

Instead of replacing the full document buffer (`editor.replaceRange(0, EOF)`), the plugin computes minimal line diffs (`diff.ts`) between the original document and formatted text:

1. **Common Prefix & Suffix Trimming**: Fast character scan snapped to line boundaries isolates only the modified slice.
2. **Line Myers Diff**: Computes minimal line replacement hunks (`DiffHunk[]`).
3. **Fold State Preservation**: Untouched sections of the document never have their CodeMirror node states or folds reset.
4. **Layout Stability**: In Live Preview mode, rendered widgets, math equations, callouts, and embeds in untouched sections remain mounted without DOM thrashing or visual flicker.
5. **Atomic Undo**: Changes are dispatched via `editor.transaction({ changes, selections }, '+format')`, providing a clean, single-step undo history.
6. **Multi-Cursor & Selection Mapping**: All active selections (anchor and head) from `editor.listSelections()` are mapped through the diff hunks so carats and highlighted ranges stay anchored to their intended positions.

### 3.4 Commands & Workflows

- **`format-current-note`**: Formats the active note. If the note is open in Editing view, it applies diff transactions. If open in Reading view, it formats the underlying file directly via vault APIs.
- **`format-selection`**: Formats only the actively selected Markdown text without modifying the rest of the document.
- **File Menu Context Menu**: Adds "Format note" when right-clicking Markdown files in the file explorer.
- **Startup Warmup**: The WASM module is pre-warmed in the background on `workspace.onLayoutReady`, removing cold-start delay from the first format invocation.
