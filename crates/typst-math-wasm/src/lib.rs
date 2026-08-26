use typst::comemo::Track;
use typst::diag::SourceDiagnostic;
use typst::model::LateLinkResolver;
use typst_html::{HtmlDocument, HtmlElement, HtmlNode, HtmlOptions, html_in_bundle, tag};
use wasm_bindgen::prelude::*;

mod world;

/// Prefix unconditionally emitted by `html_in_bundle` before the serialized root.
const BUNDLE_DOCTYPE: &str = "<!DOCTYPE html>";

#[wasm_bindgen]
pub struct Compiler {
    world: world::MathWorld,
}

impl Default for Compiler {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Compiler {
        #[cfg(debug_assertions)]
        console_error_panic_hook::set_once();

        Self {
            world: world::MathWorld::new(),
        }
    }

    #[wasm_bindgen]
    pub fn compile_math(&self, source: &str, display: bool) -> Result<CompiledMath, String> {
        // Edge whitespace is visually meaningless in math and would otherwise
        // feed Typst's block-promotion heuristic in inline mode.
        let source = source.trim();
        let typst_source = if display {
            // The set rule pins display mode even for empty or broken-up
            // sources, where Typst's `block: auto` would emit an inline root.
            format!("#set math.equation(block: true)\n$ {} $", source)
        } else {
            format!("${}$", source)
        };
        self.world.set_source(typst_source);

        let result = (|| {
            let warned = typst::compile::<HtmlDocument>(&self.world);
            let document = warned
                .output
                .map_err(|errors| format_diagnostics(&errors))?;
            let element = first_math_element(document.root_node())
                .ok_or_else(|| "Failed to extract MathML from HTML output".to_string())?;
            if let Some(foreign_tag) = first_foreign_tag(element) {
                return Err(format!(
                    "embedded non-math content ({foreign_tag}) is not supported"
                ));
            }
            let resolver = LateLinkResolver::new(None, document.introspector().as_ref());
            let html = html_in_bundle(element, &HtmlOptions::default(), resolver.track()).map_err(
                |error| format!("HTML serialization failed: {}", format_diagnostics(&error)),
            )?;

            let mut mathml = html
                .strip_prefix(BUNDLE_DOCTYPE)
                .unwrap_or(&html)
                .to_string();
            if display && mathml.starts_with("<math>") {
                // Typst promotes equations to block via parse-time delimiter
                // whitespace, so empty or broken-up sources yield a bare root.
                // The plugin contract promises display mode, so pin the attribute.
                let root = "<math>".len();
                mathml.replace_range(..root, "<math display=\"block\">");
            }
            let css = head_style_sheet(document.root());

            Ok(CompiledMath { mathml, css })
        })();

        // Memoization misses on every call (engine state participates in the
        // cache key), so entries accumulate per render and grow memory without
        // bound. Renders are single-shot; drop the cache to stay flat.
        typst::comemo::evict(0);

        result
    }
}

/// A compiled equation: MathML plus Typst's own MathML stylesheet, when the
/// compiled document provides one.
#[derive(Debug)]
#[wasm_bindgen]
pub struct CompiledMath {
    mathml: String,
    css: Option<String>,
}

#[wasm_bindgen]
impl CompiledMath {
    #[wasm_bindgen(getter)]
    pub fn mathml(&self) -> String {
        self.mathml.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn css(&self) -> Option<String> {
        self.css.clone()
    }
}

/// Returns the tag of the first non-MathML element in the subtree, if any.
///
/// Embedded `#code` values serialize as styled HTML islands rather than
/// MathML; they are rejected upstream instead of failing later validation.
fn first_foreign_tag(element: &HtmlElement) -> Option<String> {
    if !tag::mathml::is_mathml(element.tag) {
        return Some(element.tag.resolve().to_string());
    }
    element.children.iter().find_map(|child| match child {
        HtmlNode::Element(nested) => first_foreign_tag(nested),
        HtmlNode::Frame(_) => Some(String::from("frame")),
        _ => None,
    })
}

/// Returns the first MathML root in document order.
fn first_math_element(node: &HtmlNode) -> Option<&HtmlElement> {
    match node {
        HtmlNode::Element(element) => {
            if element.tag == tag::mathml::math {
                return Some(element);
            }
            element.children.iter().find_map(first_math_element)
        }
        _ => None,
    }
}

/// Returns the equation stylesheet Typst injects into `<head>`, when present.
fn head_style_sheet(root: &HtmlElement) -> Option<String> {
    let head = root.children.iter().find_map(|node| match node {
        HtmlNode::Element(element) if element.tag == tag::head => Some(element),
        _ => None,
    })?;

    let mut css = String::new();
    for node in &head.children {
        let HtmlNode::Element(element) = node else {
            continue;
        };
        if element.tag != tag::style {
            continue;
        }
        for child in &element.children {
            if let HtmlNode::Text(text, _) = child {
                css.push_str(text);
            }
        }
    }
    (!css.is_empty()).then_some(css)
}

/// Formats Typst diagnostics as readable multi-line text.
fn format_diagnostics(errors: &[SourceDiagnostic]) -> String {
    let mut lines = Vec::new();
    for error in errors {
        if error.message.trim().is_empty() {
            continue;
        }
        lines.push(error.message.to_string());
        for hint in &error.hints {
            lines.push(format!("hint: {}", hint.v));
        }
    }
    if lines.is_empty() {
        return "Unknown compilation error".into();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst::syntax::Span;

    #[test]
    fn compiles_inline_math_to_mathml() {
        let compiler = Compiler::new();
        let compiled = compiler.compile_math("x^2 + y^2 = z^2", false).unwrap();

        assert!(compiled.mathml.starts_with("<math>"));
        assert!(compiled.mathml.contains("<msup>"));
        assert!(compiled.mathml.contains("<mi>𝑥</mi>"));
        assert!(compiled.mathml.contains("<mn>2</mn>"));
    }

    #[test]
    fn returns_the_equation_stylesheet_from_the_document_head() {
        let compiler = Compiler::new();
        let compiled = compiler.compile_math("x + y", true).unwrap();

        let css = compiled.css.expect("stylesheet present alongside math");
        assert!(css.contains("mtable"));
    }

    #[test]
    fn marks_display_math_as_block() {
        let compiler = Compiler::new();
        let compiled = compiler.compile_math("x + y", true).unwrap();

        assert!(compiled.mathml.starts_with("<math display=\"block\">"));
    }

    #[test]
    fn pins_display_mode_for_degenerate_sources() {
        let compiler = Compiler::new();

        for source in ["", " ", "a$b$c"] {
            let compiled = compiler.compile_math(source, true).unwrap();
            assert!(
                compiled.mathml.starts_with("<math display=\"block\">"),
                "source {source:?}: {}",
                compiled.mathml
            );
        }
    }

    #[test]
    fn rejects_embedded_non_math_content() {
        let compiler = Compiler::new();

        let error = compiler.compile_math("#true", false).unwrap_err();
        assert!(error.contains("non-math content"));

        // Content-producing expressions remain valid MathML.
        let compiled = compiler.compile_math(r#"#text("m/s")"#, false).unwrap();
        assert!(compiled.mathml.contains("<mtext>"));
    }

    #[test]
    fn returns_typst_diagnostics() {
        let compiler = Compiler::new();
        let error = compiler.compile_math("#let =", false).unwrap_err();

        assert!(!error.is_empty());
    }

    #[test]
    fn handles_adversarial_sources_without_panicking() {
        let compiler = Compiler::new();
        let corpus = [
            "",
            " ",
            "\0",
            "\u{202e}",
            "😀\u{fffd}",
            "<script>alert(1)</script>",
            "</math><script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            "\"quotes\" & <angles>",
            "\\frac{x}{y}",
            "$$x$$",
            "#let =",
        ];

        for source in corpus {
            assert_mathml_or_diagnostic(&compiler, source, false);
            assert_mathml_or_diagnostic(&compiler, source, true);
        }

        for seed in 0..64 {
            let source = format!("x\0{seed} + y^{seed} _ z");
            assert_mathml_or_diagnostic(&compiler, &source, seed % 2 == 0);
        }
    }

    fn assert_mathml_or_diagnostic(compiler: &Compiler, source: &str, display: bool) {
        match compiler.compile_math(source, display) {
            Ok(compiled) => {
                assert!(compiled.mathml.starts_with("<math"));
                assert!(compiled.mathml.ends_with("</math>"));
                assert!(!compiled.mathml.to_ascii_lowercase().contains("<script"));
                assert!(!compiled.mathml.to_ascii_lowercase().contains("<svg"));
            }
            Err(error) => assert!(!error.trim().is_empty()),
        }
    }

    fn element(tag_name: &str, children: Vec<HtmlNode>) -> HtmlNode {
        let tag = typst_html::HtmlTag::intern(tag_name).expect("static tag is valid");
        HtmlNode::Element(HtmlElement::new(tag).with_children(children.into_iter().collect()))
    }

    fn math_with(text: &str) -> HtmlNode {
        element("math", vec![HtmlNode::text(text, Span::detached())])
    }

    fn collect_element_texts(element: &HtmlElement, out: &mut Vec<String>) {
        for child in &element.children {
            match child {
                HtmlNode::Text(text, _) => out.push(text.to_string()),
                HtmlNode::Element(nested) => collect_element_texts(nested, out),
                _ => {}
            }
        }
    }

    #[test]
    fn finds_first_math_root_in_document_order() {
        let tree = element(
            "div",
            vec![
                element("p", vec![HtmlNode::text("leading", Span::detached())]),
                math_with("first"),
                element("span", vec![math_with("nested")]),
                math_with("last"),
            ],
        );

        let found = first_math_element(&tree).expect("a math root exists");
        let mut texts = Vec::new();
        collect_element_texts(found, &mut texts);

        assert_eq!(texts, ["first"]);
    }

    #[test]
    fn reports_missing_math_root() {
        let tree = element(
            "div",
            vec![element(
                "p",
                vec![HtmlNode::text("plain", Span::detached())],
            )],
        );

        assert!(first_math_element(&tree).is_none());
    }

    fn as_element(node: &HtmlNode) -> &HtmlElement {
        match node {
            HtmlNode::Element(element) => element,
            _ => panic!("expected an element node"),
        }
    }

    #[test]
    fn extracts_the_style_sheet_from_the_document_head() {
        let sheet = "mtable { math-style: inherit; }";
        let tree = element(
            "html",
            vec![
                element(
                    "head",
                    vec![element(
                        "style",
                        vec![HtmlNode::Text(sheet.into(), Span::detached())],
                    )],
                ),
                element("body", vec![math_with("x")]),
            ],
        );

        assert_eq!(head_style_sheet(as_element(&tree)), Some(sheet.to_string()));
    }

    #[test]
    fn reports_missing_or_empty_style_sheets() {
        let without_head = element("html", vec![element("body", vec![math_with("x")])]);
        assert_eq!(head_style_sheet(as_element(&without_head)), None);

        let empty_style = element(
            "html",
            vec![element("head", vec![element("style", vec![])])],
        );
        assert_eq!(head_style_sheet(as_element(&empty_style)), None);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod leak_probe {
    use super::*;

    fn rss_kb() -> u64 {
        std::fs::read_to_string("/proc/self/statm")
            .map(|content| {
                content
                    .split_whitespace()
                    .nth(1)
                    .and_then(|resident| resident.parse::<u64>().ok())
                    .unwrap_or(0)
                    * 4
            })
            .unwrap_or(0)
    }

    /// Long-running Linux-only regression guard (~70s): memo-cache eviction
    /// must keep memory flat across repeated compiles. Run explicitly via
    /// `cargo test -p typst-math-wasm --release -- --ignored`.
    #[test]
    #[ignore = "long-running soak; run via cargo test -p typst-math-wasm --release -- --ignored"]
    fn repeated_compiles_do_not_grow_memory() {
        let compiler = Compiler::new();
        // Warm-up pass so one-time initialization is not mistaken for growth.
        for _ in 0..100 {
            let _ = compiler.compile_math("#true", true);
        }
        let mut baseline = rss_kb();
        for round in 0..6 {
            for _ in 0..10_000 {
                let _ = compiler.compile_math("#true", true);
            }
            let current = rss_kb();
            let delta = current - baseline;
            println!("round {}: rss={current}kB delta={delta}kB", round + 1);
            // Eviction keeps the memo cache flat; allow allocator jitter only.
            assert!(delta < 4096, "memory grew {delta}kB across 10k compiles");
            baseline = current;
        }
    }
}
