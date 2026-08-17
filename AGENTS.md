# Obsidian Plugins Development Guide

Conventions and setup instructions for AI coding agents working in this repo. See [agents.md](https://agents.md/) for the general spec.

## Directory structure

- Each plugin lives under its own subdirectory inside `plugins/`.
- Reference documentations for plugin development are cloned and kept up-to-date under `docs/` (git ignored).
- Rust/WASM components reside in their own subdirectories within `crates/`.

## Commands

Do not use `nix develop --command` or `npx`. The tools in `nix/devShell.nix` and `node_modules/.bin` are available in `PATH` so use local executables directly.

- **Build:** `vp run -r build`
- **Build (WASM):** `wasm-pack build crates/<crate> --target web`
- **Lint:** `vp lint`
- **Lint (Rust):** `cargo clippy --workspace --all-targets -- -D warnings`
- **Formatting**: `vp fmt`
- **Formatting (Rust)**: `cargo fmt --all`
- **Test**: `vp test` (or `vp test plugins/<plugin>`)
- **Test (Rust)**: `cargo test --workspace` (or `cargo test -p <crate>`)
- Prefer to run targeted tests because the full test suite is slow to run.
- The `Justfile` is intended for users only. **Do not use the `Justfile`**, run commands directly using `vp` and `cargo`.

## Ground rules

- Never create Git commits unless explicitly asked.
- Never push to Git remotes.
- Never create a GitHub issue or pull request.
- **Do not install tools globally.** Use `vp install` or add package to `nix/devShell.nix`.

## Coding rules

- **Make the smallest coherent change.**
- **Debug, don't guess.**
- Do not add backward compatibility unless explicitly requested.
- Performance is key, both high level (design) and low level (impl).
- Avoid redundant code and abstractions; avoid unnecessary complexity and nesting.
- Concise one-liners are fine, but prioritize clarity over cleverness.
- **Every changed or added behaviour must have a test**. Do not add tests for standard-library or third-party functions. The exception is deliberate behaviour or integration tests, which may cross those boundaries by design.
- When fixing a bug or regression, first write a test for it that fails, then change the code to fix the bug and make sure the test passes.
- Write self-documenting code: clear names, obvious structure, minimal comments.
- No section-separator comments (e.g. `// ---- Protocols ----` or `// === Input ===`). Code structure should be clear from the code itself.
- **Comment sparingly — code says _what_, comments say _why_.** Add a comment only when the reasoning is non-obvious and cannot be carried by a clear name or the code itself. Do not write narrating comments that restate the next line, do not pad logic with multi-line prose, and do not repeat the same rationale at several sites — put one concise note at the source of truth and let the others stand on their own. Tests whose names already describe intent need no explanatory comment. Reserve longer explanation for genuinely complex or non-obvious logic (e.g. a security check whose threat model isn't apparent), and keep even that as tight as it can be. Over-commenting is noise that ages badly and obscures the code it wraps.
- When a change invalidates documented behavior or structure, update the relevant document in `docs/`.
- Put any files you generate (plan, reports, scratch output) under `.agents/scratch/` directory.
- Run proportionate validation, review the diff, and report commands that could not run because dependencies or platform toolchains are unavailable.
- Prefer AST-based tools and codemods (jscodeshift) over manual or regex-based refactors, except for tiny edits.
- For any code search that requires understanding of syntax or code structure, you should default to using `ast-grep`, see ast-grep skill for usage details. Avoid using text-only search tools unless a plain-text search is explicitly requested.

### Toolchain

- **Self-Contained `dist` Folder:** `vite.config.ts` must be configured to output everything required for the plugin into a `dist/` subdirectory for easy copying, including `.wasm` assets using Vite's static asset handlers or `vite-plus` hooks.
- **Vite+ Unified Toolchain:** This project uses Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`.
- **Distinct from Vite:** Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`.

### JavaScript

- Prefer plain `for..in/of` loops over iterator methods like `map`/`reduce`.

### TypeScript

- Avoid `any` and type casting (`as`).
- Avoid runtime overhead just to get the types right.

### Rust & WASM

- All Rust crates must use the latest Rust edition (currently **2024**).
- Enforce idiomatic Rust by utilizing `cargo clippy --fix --workspace` and `cargo fmt`. Always leverage the newest syntactical idioms (e.g., `let_chains` for collapsed nested `if let` statements).
- **Fuzz Testing:** `cargo fuzz` is highly encouraged and expected for all Rust/WASM crates that handle complex inputs to catch edge-case panics. Use existing fuzzers in `crates/*/fuzz` as reference implementations.

### UI & Styles

- **No Boilerplate CSS:** Only include a `styles.css` file if the plugin introduces UI elements that genuinely require custom styling.

### Plugin Architecture & Lifecycle

- **Organize code across multiple files**: Split functionality into separate modules rather than placing everything in `main.ts`.
- **Minimal `main.ts`**: Keep `main.ts` small and focused strictly on the plugin lifecycle (`onload`, `onunload`, registering commands/events). Delegate feature logic to dedicated modules (`settings.ts`, `commands/`, `ui/`, `utils/`, `types.ts`).
- **File size limit**: If any file exceeds ~200-300 lines, break it into smaller, focused modules.
- **Safe listener cleanup**: Register all DOM, app, and interval listeners using Obsidian lifecycle helpers (`this.registerEvent`, `this.registerDomEvent`, `this.registerInterval`) so the plugin unloads cleanly without leaking memory or timers.
- **Startup performance**: Keep startup light. Avoid heavy or blocking work during `onload`; defer initialization or use lazy loading.
- **Vault access**: Batch disk access and avoid excessive vault scans. Debounce or throttle expensive operations triggered by file system events.

### Commands & Settings

- **Commands**: Register user-facing commands via `this.addCommand(...)`. Use stable command IDs; never rename or remove command IDs once released.
- **Settings**: Provide sensible defaults and validation for plugin configuration. Persist settings with `this.loadData()` and `this.saveData()`.

### Manifest Rules (`manifest.json`)

- Must contain all required manifest fields: `id`, `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`, `isDesktopOnly`.
- For local development, plugin directory name must match `manifest.json` `id`.
- Never change `id` after release; treat it as stable API.
- Keep `minAppVersion` accurate whenever using newer Obsidian APIs.

### Security, Privacy, and Compliance

- **Local-first**: Operate offline and local to the vault by default. Only make network requests when strictly required for the core feature.
- **No telemetry**: Do not collect analytics or tracking data without explicit, opt-in user consent and prominent disclosure in settings and documentation.
- **No remote code execution**: Never fetch and `eval` remote scripts or execute dynamic remote code.
- **Vault containment**: Never access, read, or write files outside the user's vault.
- **Privacy**: Never collect or transmit vault contents, note titles, or personal data unless essential to the feature and explicitly consented to by the user.

### UX & Copy Guidelines

- Use sentence case for headings, modal titles, setting names, and buttons.
- Use clear, action-oriented imperatives for instructions and command descriptions.
- Use **bold** for literal UI elements and labels (e.g. **Settings**).
- Use arrow notation for in-app navigation paths: **Settings → Community plugins**.
- Keep strings concise, natural, and free of technical jargon.

### Mobile Support

- Avoid Node.js or Electron APIs unless `isDesktopOnly` is explicitly set to `true` in `manifest.json`.
- Keep memory and storage usage lightweight to accommodate mobile constraints.

## Manual Vault Testing

To test plugins in Obsidian:
1. Build the target plugin: `vp run build` (and WASM if applicable: `wasm-pack build crates/<crate> --target web`).
2. Copy files from `plugins/<plugin>/dist/` (`main.js`, `manifest.json`, `styles.css` if present, `.wasm` if present) to:
   ```
   <Vault>/.obsidian/plugins/<plugin-id>/
   ```
3. Reload plugins / Obsidian and enable the plugin in **Settings → Community plugins**.

## Token-efficient verification

- Do not stream verbose successful build, migration, reset, or test output into the conversation.
- Capture complete verification output in a local artifact in `.agents/scratch/` directory.
- Report only the command, exit status, duration, suite summary, warnings, and relevant failure excerpt.
- On failure, inspect the smallest useful log section first and expand only when needed.
- Preserve full logs locally in `.agents/scratch/` when they are required as evidence.
- When a verification command is still running, inspect its artifact only after completion. Read the smallest useful failure excerpt; never load full passing artifacts unless exact evidence is required.
- Before loading long skill, browser, or tool documentation, read only the required instructions. If the tool requires its full documentation, keep it out of user-facing updates and summarize only the rules relevant to the task. Do not reload the same documentation in the same task.

## References

- [Obsidian API Documentation](https://docs.obsidian.md)
- [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)
- [Obsidian Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Obsidian Style Guide](https://help.obsidian.md/style-guide)
