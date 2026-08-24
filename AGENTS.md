# Obsidian Plugins Development Guide

Instructions for coding agents working in this repository.

These are personal, unpublished Obsidian plugins. Optimize for correctness, maintainability, performance, and a small code surface rather than backwards compatibility unless the task says otherwise.

## Directory structure

- `plugins/` contains the TypeScript Obsidian plugins.
- `crates/` contains Rust and WASM components shared by plugins.
- Read a plugin's `ARCHITECTURE.md` before making architectural or cross-component changes.
- Reference documentation may be available under the gitignored `docs/` directory.

## Core principles

- These are defaults, not absolutes. Deviate when the task clearly requires it, and briefly explain why.
- Make the smallest coherent change that fully solves the task.
- Debug and inspect existing behavior before guessing.
- Prefer simple, direct implementations over new abstractions.
- Prioritize clarity over cleverness; avoid unnecessary complexity and nesting.
- Follow existing patterns unless there is a concrete reason to improve them.
- Do not add backwards compatibility, migration layers, or fallback paths unless required.
- Preserve performance-sensitive behavior and avoid unnecessary runtime work.
- Write self-documenting code: clear names, obvious structure, minimal comments.
- Keep comments focused on non-obvious reasoning rather than narrating code; code says _what_, comments say _why_.
- Add or update tests for meaningful behavior changes. Bug fixes should normally include regression coverage.
- Fuzz parsers, render boundaries, and user-text handling when the code accepts arbitrary text.
- Use structural tools such as `ast-grep` when syntax-aware search or transformation is useful; otherwise use the simplest appropriate search/editing tool.

## Safety

- Do not create commits, push, or modify Git state unless explicitly asked.
- Do not install tools globally.
- Do not run `just install-*` recipes unless explicitly asked; they modify the user's vault directory.
- Put generated plans, reports, logs, and other temporary artifacts under `.agents/scratch/`.
- Current plugins target both desktop and mobile. Do not introduce Node.js or Electron runtime dependencies unless deliberately changing that requirement.
- Do not add telemetry, remote code execution, or transmission of vault contents.

## Commands

The development environment already exposes repository-local and Nix-provided tools in `PATH`. Do not use `npx` or `nix develop --command`.

Prefer targeted commands while iterating:

- Plugin quality gate (format, lint, type check): `npm run check -w <plugin>`
- Plugin build: `npm run build -w <plugin>`
- Plugin tests: `npm run test -w <plugin>`
- Plugin code formatting: `npm run fmt -w <plugin>`
- Plugin linting: `npm run lint -w <plugin>`
- Plugin type checking only: `npm run check:types -w <plugin>`
- Rust tests: `cargo test -p <crate>`
- Rust lint: `cargo clippy -p <crate> --all-targets -- -D warnings`
- Rust formatting: `cargo fmt -p <crate>`

Use workspace-wide checks when a change crosses boundaries or before finalizing when proportionate.

## Verification

- Run proportionate validation for the code changed and review the final diff.
- Prefer targeted tests during iteration; broaden validation when the change warrants it.
- Report checks that could not run because required dependencies or platform capabilities are unavailable.

## Plugin Development

### Architecture & Lifecycle

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
