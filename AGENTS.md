# Agent Development Guide

Conventions and setup instructions for AI coding agents working in this repo. See [agents.md](https://agents.md/) for the general spec.

This repository contains my personal Obsidian plugins. When an AI agent is assisting with creating a new plugin or modifying an existing one, it must strictly adhere to the following conventions and best practices.

## Directory Structure

- Each plugin lives under its own subdirectory (e.g., `anki-sync`).
- Docs for plugin development should be cloned and kept up-to-date under the `docs/` subdirectory.
- Rust/WASM components (e.g., `typst-math-wasm`, `anki-sync-wasm`, `formatter-wasm`) reside in their own `crates/` directories within the respective plugin folders.

## Build Automation & Justfile

- The repository root contains a `Justfile` which provides recipes for building plugins (e.g., `just anki-sync`, `just formatter`, `just typst-math`) and their WASM components.
- **Note:** The `Justfile` is intended for users only. As an agent, you should **not** use the `Justfile`. Instead, you should manually build outputs and use the local task runners like `vp` to interact with plugins.

## Version Control

- Never create a commit.
- The only vcs operations you are allowed are `git diff` and `git show`.

## Testing & Development Workflow

- All plugin functionality must be verified through automated testing rather than manual vault testing.
- Rely heavily on golden fixtures (e.g., `tests/fixtures/before.md` and `after.md`) and unit tests (`vp test` and `cargo test`) as the single source of truth for correctness.
- **E2E Testing:** End-to-end testing against third-party applications (like Anki) is done via headless test harnesses in the `e2e/` directory. Run them using `uv` (e.g., `uvx --with pytest --with requests pytest e2e/addon`).
- **Fuzz Testing:** `cargo fuzz` is highly encouraged and expected for all Rust/WASM crates that parse markdown or handle complex inputs to catch edge-case panics. Use existing fuzzers in `crates/*/fuzz` as reference implementations.

## Plugin Conventions and Best Practices

### ID & Naming

- **No Prefix:** Do not use the `obsidian-` prefix for the plugin `id` in `manifest.json`. Keep names simple and direct.

### Versioning

- **Static Version:** Because these are personal plugins, do not implement automated version-bumping logic. Keep `version` static.

### Build & Output Configuration

- **Self-Contained `dist` Folder:** `vite.config.ts` must be configured to output everything required for the vault into a `dist/` subdirectory for easy copying, including `.wasm` assets using Vite's static asset handlers or `vite-plus` hooks.

### Linting & Toolchain

- **Vite+ Unified Toolchain:** This project uses Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`.
- **Distinct from Vite:** Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`.
- `package.json` scripts should use `vp build`, `vp check`, `vp test`, etc.

### Rust & WASM Toolchain

- All Rust crates must use the latest Rust edition (currently **2024**).
- Enforce idiomatic Rust by utilizing `cargo clippy --fix --workspace` and `cargo fmt`. Always leverage the newest syntactical idioms (e.g., `let_chains` for collapsed nested `if let` statements).

### UI & Styles

- **No Boilerplate CSS:** Only include a `styles.css` file if the plugin introduces UI elements that genuinely require custom styling.
