# Formatter Plugin — Architecture

**Status:** Personal plugin, not published. Optimize for simplicity and minimal code surface. Zero configuration.

## 1. Purpose & Scope

One formatting engine, two front ends, zero drift between them:

- **`formatter-cli`** — a command-line tool (`format` / `check`) for running against a vault from a terminal, script, or CI/pre-commit hook.
- **`formatter-wasm` + Obsidian plugin** — the same engine compiled to WebAssembly, wrapped by a thin TypeScript plugin that formats the active note on save, inside Obsidian itself.

Both are consumers of a single **`formatter-core`** crate. To minimize custom code surface, the core logic relies on `dprint-plugin-markdown` configured strictly with a 4-space indent rule.

### Explicit non-goals

- No config file, no per-project style options. One opinion.
- No "format on type" — only on-demand (CLI invocation) or on-save (plugin).
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
│   │       └── main.rs                 # subcommand dispatch
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
        ├── main.ts                     # save-hotkey intercept
        ├── formatter.ts                # loads .wasm, calls format_markdown
        └── settings.ts                 # "Format on Save" toggle
```

---

## 3. `formatter-core`: the engine

### 3.1 Architecture

The engine delegates markdown formatting to `dprint-plugin-markdown`, which strictly respects line width and indentation settings. To prevent `dprint` from mangling Obsidian-specific syntax, the engine performs a pre-processing step:

- **Protection**: We locate regions that should be left completely untouched, such as:
  - ` ``` ... ``` ` fenced code blocks (handled by core to bypass exotic whitespace normalizer)
  - `%% ... %%` Obsidian comments (handled by dprint)
  - `$$ ... $$` math blocks (handled by dprint)
- **Frontmatter Sorting**: YAML frontmatter keys are alphabetized, with `created` forced to the top and `aliases` next, followed by everything else, and `tags` at the bottom.

These protections ensure that `dprint` processes the core Markdown structure without destroying Obsidian's non-standard extensions.
