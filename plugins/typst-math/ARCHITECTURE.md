# Typst Math Plugin — Architecture

**Status:** Personal plugin, not published. Optimize for simplicity and minimal code surface.

## 1. Purpose & Scope

A minimal Obsidian plugin that:

1. Replaces Obsidian's default MathJax math rendering with Typst math syntax.
2. Compiles Typst math expressions to MathML via a WASM-compiled Typst compiler.
3. Relies on the browser's native MathML Core rendering — no SVG, no canvas, no separate renderer WASM.

Users write `$x^2 + y^2 = z^2$` (inline) and `$$...$$` (display) using **Typst math syntax** instead of LaTeX. The plugin intercepts Obsidian's math pipeline and renders via Typst → MathML instead of LaTeX → MathJax CHTML.

### Explicit non-goals

- No user-configurable font-family setting. Bundled New Computer Modern (NewCM) WOFF2 web fonts are loaded automatically; only inline and block font size are configurable in settings.
- No full Typst document support (code blocks, `.typ` files, etc.). Math expressions only.
- No LaTeX-to-Typst conversion or fallback. If you write LaTeX, it won't render — this is intentional.
- No Typst package imports inside math expressions.
- No syntax highlighting or editor extensions. The plugin does not touch the CodeMirror editor — it only replaces rendered output.
- No marketplace listing / multi-user support.

### 1.1 Accepted risk: Typst's HTML/MathML export is explicitly experimental

Typst's own documentation states HTML export (which MathML rides on) is
"under active development and incomplete... do not rely on this feature for
production use cases." For a personal, unpublished plugin this is an
acceptable trade-off, but it should be treated as a live risk, not a
footnote:

- MathML output structure may change between Typst releases without a
  deprecation period.
- The companion CSS (`EQUATION_CSS_STYLES`, §4.6) may drift out of sync with
  the MathML structure it's meant to correct — this is the sneakier failure
  mode, since it produces visually-wrong-but-not-crashing output rather than
  a hard error.

Mitigation: pin the exact Typst patch version (§8.2). The companion stylesheet is
no longer hand-copied — it is extracted from the compiled document at render
time (§4.6), so CSS and MathML always come from the same compiler build. A
version bump still warrants a visual spot-check (build-order phase 6, §9), but
the version-pairing hazard itself is gone.

---

## 2. How Obsidian Renders Math (Background)

Understanding the default pipeline is essential because we're replacing it.

### 2.1 Default pipeline

1. Obsidian's markdown parser identifies `$...$` (inline) and `$$...$$` (display/block) delimiters.
2. Obsidian calls `window.MathJax.tex2chtml(source, { display: boolean })` which returns an `<mjx-container>` element.
3. The element is inserted into the DOM inside a `<span>` wrapper with CSS classes `.math` and either `.math-inline` or `.math-block`.

### 2.2 Key API surface

From the `obsidian` module:

- `loadMathJax(): Promise<void>` — ensures the MathJax engine is loaded.
- `renderMath(source: string, display: boolean): HTMLElement` — renders LaTeX to an HTMLElement. We call this once with empty source to trigger MathJax stylesheet side-effects.

From the global `window.MathJax` object:

- `tex2chtml(source: string, opts: { display?: boolean }): HTMLElement` — the function we monkey-patch.

### 2.3 Critical DOM contract

Obsidian expects `tex2chtml` to return an element matching:

```html
<mjx-container class="Mathjax" jax="CHTML">...</mjx-container>
```

The tag name, class name, and `jax` attribute must be exactly these values or Obsidian will not recognize the element.

---

## 3. Interception Strategy

### 3.1 Primary: MathJax monkey-patch

Override `window.MathJax.tex2chtml` with our own function. This single override covers both reading mode and live preview across the main window and popout windows (`window-open` event). No CodeMirror extensions needed.

```
Obsidian calls MathJax.tex2chtml(source, { display })
  → Our override receives raw math source + display flag
  → If WASM compiler is ready:
      → Compile/cache lookup synchronously → inject innerHTML immediately
      → Return fully-rendered mjx-container with zero layout shift
  → If WASM is still initializing:
      → Return mjx-container wrapping <typst-math> with "loading" state
      → Element's connectedCallback completes async compile once ready
```

When WASM is ready (which is warmed up on layout ready), compilation and DOM population happen completely synchronously inside `tex2chtml`, matching native MathJax latency and eliminating any visual flicker or unstyled flash while typing or scrolling.

On `onunload()`, restore the original `tex2chtml` function across all patched windows.

### 3.2 Robust Updates via Custom Elements (Embeds)

For transcluded/embedded notes (`![[note]]`), Obsidian frequently clones elements before the WASM compiler has finished initializing. This would normally result in embeds permanently showing the "loading" placeholder.

Instead of relying on a `MarkdownPostProcessor`, we define a custom element `<typst-math>`. The MathJax override returns this element inside the `<mjx-container>`, with the math source and display flag stored as attributes:

```html
<mjx-container class="Mathjax" jax="CHTML">
	<typst-math source="x^2 + y^2" display>x^2 + y^2</typst-math>
</mjx-container>
```

Element attributes survive `cloneNode()`, which is what makes this work:
when Obsidian clones the container into an embed, the cloned
`<typst-math>` element carries `source`/`display` with it, its
`connectedCallback` fires on insertion into the new document, and it
re-renders itself using the now-loaded WASM compiler — reading state off
its own attributes rather than depending on any reference to the original
element or outer plugin state. This eliminates the need for any markdown
post-processing, and it's the reason the custom-element approach was chosen
over a `MarkdownPostProcessor` in the first place: a post-processor runs on
a schedule that can't guarantee it fires before or after any given clone
event, where `connectedCallback` fires deterministically on insertion.

---

## 4. WASM Compiler

### 4.1 Why WASM (not native binary)

A native Rust binary would be faster (~2-7ms vs ~5-20ms per expression) and simpler (direct access to the `typst-html` crate), but it cannot run on Obsidian Mobile (iOS/Android). WASM runs everywhere Obsidian runs — mobile support is the entire reason for this choice, which is why binary size (§4.4) is treated as a near-term concern rather than a deferred one.

### 4.2 Architecture

The Typst compiler is a Rust project compiled to WASM via `wasm-pack`. It exposes a single function to JavaScript: compile a Typst math expression and return the MathML string.

Rust side (custom WASM crate):

```
typst-math-wasm/
├── Cargo.toml   # depends on typst, typst-html, and wasm-bindgen
├── src/
│   ├── lib.rs   # wasm-bindgen entry: compile_math(source, display) -> String
│   └── world.rs # Minimal World trait implementation
```

The WASM crate:

1. Implements the Typst `World` trait with minimal requirements:
   - **Fonts:** No bundled Typst fonts are needed. The HTML target emits semantic MathML rather than laying out glyphs, so the browser selects and measures the math font. The plugin CSS intentionally reuses Obsidian's MathJax font stack to keep the visual style native.
   - **Source:** A single virtual `.typ` file that gets replaced each call.
   - **No packages:** Math-only, no imports.
   - **No file I/O:** Everything is in-memory.
2. Initializes the `World` once and reuses it across calls (amortized startup).
3. For each call:
   1. Wraps the source in a minimal Typst document:
      - Inline: `$<source>$`
      - Display: `$ <source> $`
   2. Compiles via `typst::compile::<HtmlDocument>(&world)`.
   3. Serializes to HTML via `typst_html::html(&document, &options)`.
   4. Extracts the `<math>...</math>` element from the HTML string.
   5. Returns the MathML string (or an error message).

### 4.3 HTML feature gate

Typst 0.15.1 gates HTML export behind `Feature::Html`. The WASM crate must enable this feature on the `Library` when constructing the `World` (done via `typst::Features::all()`). This will emit a warning ("html export is under active development") which we silently ignore since we only use the MathML subset — this warning is the same one referenced in §1.1's accepted-risk note, not a new concern.

### 4.4 Binary size, optimizations, and loading

The WASM binary will be ~15-20 MB uncompressed. Since mobile support is the
stated reason for choosing WASM over a native binary (§4.1), and mobile
users pay this size cost directly (install size, on-device storage — unlike
desktop where it's a one-time load), size mitigation is a first-phase
concern, not a "revisit if it becomes a problem" one:

- **Profile early:** run `cargo-bloat` or `twiggy` against the WASM crate as
  part of build-order phase 1 (§9), before the rest of the plugin is built
  around the current binary's shape. The full Typst compiler pulls in
  layout, PDF, and SVG export machinery unused by a math-only build; knowing
  which crates dominate the binary early makes a stripped-down dependency
  tree a first-class option instead of a late-stage rewrite.
- **Lazy loading:** don't load WASM until the first math expression is
  encountered. Before WASM is ready, return a placeholder (raw source text
  styled with a "loading" CSS class). Once WASM initializes, re-render all
  placeholders.
- **`wasm-opt`:** enabled with `-Oz` and the required WebAssembly feature flags
  in `Cargo.toml`. Revisit the flags after profiling the binary, since a
  smaller starting binary (via a stripped math-only dependency tree) may
  change the optimization trade-offs.
- **WASM module caching:** once compiled by the browser, the module is
  cached by V8's code cache. Subsequent loads are near-instant — this
  matters most on desktop; mobile Obsidian's WebView caching behavior is
  worth confirming rather than assumed.
- **Ship with plugin:** bundle the `.wasm` file in the plugin's `dist`
  directory (loaded from disk, no network fetch needed).

### 4.5 MathML coverage

Typst's MathML implementation (`typst-html/src/mathml.rs`, ~1,350 lines) covers:

| Typst construct        | MathML element(s)                     | Status          |
| ---------------------- | ------------------------------------- | --------------- |
| Fractions              | `<mfrac>`                             | ✅ Full         |
| Square/nth roots       | `<msqrt>`, `<mroot>`                  | ✅ Full         |
| Subscripts             | `<msub>`                              | ✅ Full         |
| Superscripts           | `<msup>`                              | ✅ Full         |
| Sub+superscripts       | `<msubsup>`                           | ✅ Full         |
| Under/overscripts      | `<munder>`, `<mover>`, `<munderover>` | ✅ Full         |
| Multiscripts           | `<mmultiscripts>`                     | ✅ Full         |
| Matrices               | `<mtable>`, `<mtr>`, `<mtd>`          | ✅ Full         |
| Operators              | `<mo>` with form/spacing attrs        | ✅ Full         |
| Identifiers            | `<mi>`                                | ✅ Full         |
| Numbers                | `<mn>`                                | ✅ Full         |
| Text                   | `<mtext>`                             | ✅ Full         |
| Fenced (parens, etc.)  | `<mrow>` + `<mo>`                     | ✅ Full         |
| Accents                | `<mover>` / `<munder>` + accent attr  | ✅ Full         |
| Primes                 | `<mo>` postfix                        | ✅ Full         |
| Spacing                | `<mspace>`                            | ✅ Full         |
| Multi-line equations   | `<mtable>` with alignment classes     | ✅ Full         |
| Cases                  | `<mtable>` with cases class           | ✅ Full         |
| Skewed fractions       | —                                     | ⚠️ Warn+fallback |
| Overline/underline     | —                                     | ⚠️ Warn+fallback |
| Cancel (strikethrough) | —                                     | ⚠️ Warn+fallback |

Items marked ⚠️ emit a warning during export and render only their base content (the math itself, without the decoration). These are edge cases that MathML Core doesn't have native support for.

### 4.6 MathML CSS styles

Typst defines companion stylesheet rules alongside MathML (alignment on `mtd`,
table `math-style`/`math-depth`/`math-shift` corrections, multiline row gaps,
fraction spacing, accent font features, script positioning).

Rather than injecting dynamic `<style>` tags into the DOM via JavaScript at
runtime, these rules are bundled directly into `styles.css` scoped to `typst-math`.
This allows Obsidian to manage stylesheet lifecycle natively across all windows
(including popouts) with zero runtime latency or DOM manipulation.

To prevent CSS drift across future Typst compiler version bumps, a Vitest test
in `tests/compiler.test.ts` validates that `styles.css` contains all companion rules
emitted by Typst's compiler.

---

## 5. Component Breakdown

```
typst-math/
├── manifest.json
├── package.json
├── styles.css                       # render-state styling, NewCM Math font stack, size variables
├── fonts/                           # bundled New Computer Modern Math WOFF2 font with full OpenType MATH table
├── src/
│   ├── main.ts                      # Plugin entry: MathJax override, Custom Element definition, multi-window
│   ├── compiler.ts                  # WASM loader, compileSync, compile, stylesheet accessor
│   ├── fonts.ts                     # Bundled font loading, single FontFace registration, cleanup
│   └── settings.ts                  # Settings defaults, normalization, and UI
├── ARCHITECTURE.md                  # this file
└── dist/                            # build output
    ├── main.js
    ├── manifest.json
    ├── styles.css
    ├── fonts/
    └── typst_math_wasm_bg.wasm

crates/typst-math-wasm/              # WASM crate
├── Cargo.toml
├── src/
│   ├── lib.rs                   # wasm-bindgen: compile_math(source, display) -> Result<String, String>
│   └── world.rs                 # Minimal World trait (fonts, virtual source file)
└── pkg/                         # wasm-pack output (generated at build time)
    ├── typst_math_wasm_bg.wasm
    ├── typst_math_wasm.js
    └── typst_math_wasm.d.ts
```

### 5.1 `src/main.ts` — Plugin entry (~150-170 lines)

Responsibilities:

1. On `onload()`:
   1. Load and normalize persisted settings, apply font-size CSS variables, and register the settings tab.
   2. After layout is ready: call `loadMathJax()` and `renderMath('', false)` for side-effects, patch `window.MathJax.tex2chtml`, load the bundled font once via `fontManager.load()`, and warm up the WASM compiler.
   3. Hook `app.workspace.on('window-open')` to patch popout windows, and `window-close` to clean up.
   4. The override returns `<mjx-container>` synchronously. If WASM is ready, it compiles and injects MathML synchronously on the spot; if not, it returns `<typst-math>` with loading state.
2. On `onunload()`:
   1. Restore the previous CSS variable values and original `tex2chtml` across all patched windows.
   2. Unload font face.

### 5.2 `src/compiler.ts` — WASM compiler wrapper (~60-70 lines)

Responsibilities:

1. Lazy-load and instantiate the WASM module on first call (or warmed on layout ready); a failed load resets its promise so the next math element retries instead of caching the failure.
2. Expose `compileSync(source: string, display: boolean): string` for instantaneous, zero-latency synchronous compilation when ready.
3. Expose `compile(source: string, display: boolean, plugin: Plugin): Promise<string>` for async callers when the compiler is still initializing.
4. Maintain a string result cache (`Map<string, string>` keyed on `source + display`) to skip recompilation for repeated expressions.
5. Extract Typst's static equation stylesheet once via `equation_stylesheet()` during initialization.

### 5.3 `../typst-math-wasm/src/lib.rs` — WASM entry (~120 lines)

Exports a `Compiler` struct wrapping the `MathWorld` to maintain state across calls:

```rust
#[wasm_bindgen]
pub struct Compiler {
    world: world::MathWorld,
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Compiler { /* ... */ }

    #[wasm_bindgen]
    pub fn equation_stylesheet(&self) -> Option<String> { /* ... */ }

    #[wasm_bindgen]
    pub fn compile_math(&self, source: &str, display: bool) -> Result<String, String> { /* ... */ }
}
```

Internally:

1. Wraps source in `$...$` or `$ ... $`.
2. Updates the virtual source file on the `World`.
3. Calls `typst::compile::<HtmlDocument>(&world)`.
4. Finds the first `<math>` element by tag identity walking the structured HTML DOM.
5. Serializes only that subtree via `html_in_bundle` and strips the doctype prefix.
6. Returns `Ok(mathml)` directly as a String (or formatted diagnostics on error).
7. Calls `typst::comemo::evict(0)` to keep memory flat.

### 5.4 `../typst-math-wasm/src/world.rs` — Minimal World (~80 lines)

Implements the `World` trait with HTML feature enabled and empty font book.

### 5.5 `styles.css` — render-state styling

Contains only plugin-owned rules: loading/error state styles, the bundled New Computer Modern Math font stack applied to rendered MathML, and the persisted font size variables.

### 5.6 `src/fonts.ts` — Bundled font loading & management

Responsibilities:

1. Single font configuration for `New Computer Modern Math` using `NewCMMath-Book.woff2`.
2. Expose `FontManager` class with `load(plugin)` and `unload()`:
   - On load: reads the WOFF2 file via `plugin.app.vault.adapter.readBinary`, constructs a single `FontFace` instance, loads it, and registers it into `document.fonts`.
   - On unload: removes the registered `FontFace` instance from `document.fonts`.
3. Loaded once on layout ready; individual equations do not await font loading.

---

## 6. Rendering Flow

### 6.1 Normal rendering (reading mode + live preview)

1. Obsidian parses markdown, finds `$...$` or `$$...$$`.
2. Obsidian calls `window.MathJax.tex2chtml(source, { display })`.
3. Our override:
   1. If WASM is ready:
      - Looks up cache or calls `compiler.compileSync(source, display)`.
      - Injects MathML directly into the element.
      - Returns `<mjx-container>` immediately. Zero layout flicker, zero macrotask delay.
   2. If WASM is not ready:
      - Sets element text content to `source` with class `typst-math-loading`.
      - Returns container. The custom element's `connectedCallback` awaits initialization and compiles as soon as WASM is loaded.
4. Browser renders the `<math>` element via native MathML Core.

### 6.2 WASM initialization

1. Layout ready triggers warm-up WASM load (or first math expression if layout ready hasn't fired).
2. Read `.wasm` file binary from the vault via `plugin.app.vault.adapter.readBinary`.
3. Instantiate via `wasm-bindgen` init function.
4. Mark compiler as ready.

### 6.3 Embedded notes

1. Obsidian clones the rendered DOM from the original note (including the `<mjx-container>` and its `<typst-math>` child).
2. If already rendered with `<math>`, it stays rendered.
3. If not yet rendered, the cloned `<typst-math>` element's `connectedCallback` fires and renders via the compiler.

---

## 7. Edge Cases & Decisions

| Case                                                                  | Decision                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WASM not loaded yet when math is encountered                          | Show raw source text as placeholder with `typst-math-loading` class; the element's own `connectedCallback` awaits initialization and renders when ready.                                                                                                        |
| WASM fails to load (corrupt file, unsupported platform)               | Log error to console, show raw source with error styling. The failed init promise resets, so the next expression retries. Do not crash the plugin.                                                                                                               |
| Typst compilation error (invalid math syntax)                         | Show raw source text with `typst-math-error` class and set all diagnostics (messages + hints) as the element's multi-line `title` (visible on hover).                                                                                                            |
| Empty math expression (`$$`)                                          | Return empty `<mjx-container>` — same behavior as MathJax with empty input.                                                                                                                                                                                      |
| Synchronous rendering                                                 | Once WASM is loaded, `compileSync` runs on the main thread and populates MathML synchronously inside `tex2chtml`. Instant rendering, zero layout shift.                                                                                                           |
| Expression contains Typst features beyond math (`#set`, `#let`, etc.) | Valid Typst features run normally. Embedded non-math HTML elements are cleanly rejected with a diagnostic.                                                                                                                                                       |
| MathJax CSS still loaded (from Obsidian's default)                    | Harmless. MathJax styles target `mjx-*` internal elements which we don't generate. Our MathML `<math>` elements use separate CSS.                                                                                                                                |
| Plugin disabled/unloaded mid-session                                  | `onunload()` restores original `tex2chtml` across all windows, unloads the math font, and clears state.                                                                                                                                                           |
| Invalid or missing font-size settings                                 | Normalize each value to the 8–48px range in 1px increments; missing or legacy percentage values use the 18px/20px defaults.                                                                                                                                      |
| Multiple vaults / windows                                             | Supported: registers `workspace.on('window-open')` to patch MathJax on popout windows, and restores on unload.                                                                                                                                                    |
| Typst version bump changes MathML output shape or CSS needs (§1.1)    | Treated as a breaking change requiring manual re-validation, not something to auto-update past without checking.                                                                                                                                                 |

---

## 8. Build & Toolchain

### 8.1 TypeScript / Plugin side

- Vite+ (`vp`) toolchain per repository conventions.
- `vite.config.ts`: `defineConfig` from `vite-plus`, CJS output to `dist/`, custom plugin to copy `manifest.json`, `styles.css`, and the `.wasm` file to `dist/` via `closeBundle()`.
- `package.json` scripts: `vp build`, `vp check`.
- External: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins.
- No runtime npm dependencies beyond `obsidian`.

### 8.2 Rust / WASM side

- Built separately with `wasm-pack build --target web --release` inside the `typst-math-wasm` directory.
- Output goes to `typst-math-wasm/pkg/`, which is generated locally and intentionally not committed. A clean checkout must run the WASM build before TypeScript checks or tests.
- Cargo profile: `[profile.release]` with `lto = true`, `codegen-units = 1`, `opt-level = "s"` (optimize for size), `strip = true`.
- Dependencies, pinned via **crates.io semver**, not git tags:
  ```toml
  typst = "=0.15.1"
  typst-html = "=0.15.1"
  wasm-bindgen = "..."
  ```
  `typst-html` is published normally on crates.io — pinning to a git tag instead would force cloning the full `typst` monorepo on every build for no reproducibility benefit, and would only be justified if a fix is needed that hasn't shipped in a release yet.

### 8.3 Build order

1. Unified via `just typst-math` (run within `nix develop`).
2. Checks for `wasm` directory and automatically compiles WASM (`wasm-pack build --target web --release`).
3. Runs `npm run lint` which triggers `vp check` (JS/TS), `cargo fmt`, and `cargo clippy`.
4. Runs `vp build`.
5. Copies `dist/` contents to vault's `.obsidian/plugins/typst-math/`.

---

## 9. Build Order (implementation phases)

Each phase is independently testable.

1. **WASM crate:** Minimal `World` + `compile_math()` function. Test with a simple Rust integration test that compiles `x^2 + y^2` and asserts the output contains `<math>`, `<msup>`, `<mi>x</mi>`, `<mn>2</mn>`. **Also profile binary size with `cargo-bloat`/`twiggy` at this stage** (§4.4) — mobile support is the reason WASM was chosen over a native binary, so size should shape the dependency tree from the start, not get revisited after the plugin is already built around a 15-20MB binary.
2. **Plugin skeleton:** `main.ts` with the MathJax monkey-patch. Load the WASM module. Compile a hardcoded expression to verify end-to-end wiring. At this point, inline and display math should render in both reading mode and live preview.
3. **Async loading:** Implement the placeholder pattern (show raw source while WASM loads, re-render when ready). Test by opening a note with math before WASM has finished initializing.
4. **Error handling:** Typst compilation errors displayed inline. Test with intentionally malformed Typst math.
5. **Embed support:** Implement the `<typst-math>` custom element's `connectedCallback` re-render path, driven entirely by its own `data-source`/`data-display` attributes (§3.2, §6.3) — no `MarkdownPostProcessor` involved. Test by embedding a note containing math via `![[note]]` and opening it before WASM has finished initializing, confirming the embedded copy re-renders independently of the source note's element.
6. **CSS styles:** Typst's equation stylesheet rules are bundled directly into `styles.css` (§4.6), with drift verification covered by a Vitest test against Typst's extracted rules. Still spot-check rendering of fractions, accents, and matrices against Typst's own HTML output after every future Typst version bump, per §1.1.
7. **Settings UI:** Register the plugin settings tab with separate inline and block pixel font-size sliders. Persist values with `loadData()`/`saveData()` and apply them through CSS variables without requiring a restart or manual CSS installation.
8. **Result cache:** `Map<string, string>` in `compiler.ts` to avoid re-compiling identical expressions. Measure before/after with a note containing 50+ math expressions.

---

## 10. Explicitly Deferred / Open Questions

- **Web Worker:** Running the WASM compiler in a Web Worker (off main thread) could improve UI responsiveness for complex expressions. `obsidian-typst-mate` uses a Web Worker + Comlink for its SVG pipeline, so the pattern is well-understood if profiling shows main-thread jank is a real problem here too — deferred until then, since this plugin's math-only, cached workload is lighter than a full-document Typst compiler.
- **Font customization:** The current CSS intentionally follows Obsidian's MathJax font stack. If that stack changes or a different visual style is wanted, update the CSS; font selection still belongs in the browser layer, not the Typst WASM `World`.
- **Syntax highlighting in editor:** Typst math syntax differs from LaTeX. Obsidian's editor highlights `$...$` content as LaTeX, which is misleading. A CodeMirror extension could provide proper Typst math highlighting, but this is a separate concern and significant complexity.
- **Typst version pinning and re-validation:** Covered in §1.1 and §7 — the WASM is built against Typst 0.15.1 exactly. Future Typst versions may change MathML output shape or the CSS needed to correct it. Pin the version, and treat every bump as requiring the visual-comparison step in build-order phase 6 before adopting it, not just a version number change.
