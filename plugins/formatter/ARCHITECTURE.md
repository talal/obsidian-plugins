# Formatter Plugin — Architecture

**Status:** Personal plugin, not published. Optimize for simplicity and minimal code surface. Zero configuration.

## 1. Purpose & Scope

One formatting engine, two front ends, zero drift between them:

- **`formatter-cli`** — a command-line tool (`formatter-cli [PATHS]...`) for formatting vault files from a terminal or script. With no paths, it formats stdin.
- **`formatter-wasm` + Obsidian plugin** — the same engine compiled to WebAssembly, wrapped by a thin TypeScript plugin that formats the current note through an Obsidian command.

Both are consumers of a single **`formatter-core`** crate. To match Obsidian's four-space indentation, the core delegates Markdown formatting to `dprint-plugin-markdown` with its PythonMarkdown list indentation mode.

### Explicit non-goals

- No config file, no per-project style options. One opinion.
- No "format on type" or format-on-save hook — formatting is explicitly on-demand through the CLI or plugin command.
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
│   │       └── lib.rs                  # format() logic
│   │
│   ├── formatter-cli/                  # bin crate, depends on formatter-core
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs                 # path and stdin dispatch
│   │
│   └── formatter-wasm/                 # wasm-bindgen shim, depends on formatter-core
│       ├── Cargo.toml
│       └── src/lib.rs                  # #[wasm_bindgen] format_markdown(&str)
│
└── obsidian-plugin/                    # TS wrapper
    ├── manifest.json
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.ts                     # command and plugin lifecycle
        ├── formatter.ts                # loads .wasm, calls format_markdown
        └── logger.ts                   # error logging
```

---

## 3. `formatter-core`: the engine

### 3.1 Architecture

The engine passes the complete Markdown document to `dprint-plugin-markdown` without preprocessing. dprint owns line-ending normalization, Markdown syntax, list indentation, fenced code blocks, comments, math, and other extensions it recognizes. YAML metadata is passed through unchanged; the formatter does not add, sort, parse, or rewrite frontmatter.
