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
        let typst_source = if display {
            format!("$ {} $", source)
        } else {
            format!("${}$", source)
        };
        self.world.set_source(typst_source);

        let warned = typst::compile::<HtmlDocument>(&self.world);
        let document = warned
            .output
            .map_err(|errors| format_diagnostics(&errors))?;

        let element = first_math_element(document.root_node())
            .ok_or_else(|| "Failed to extract MathML from HTML output".to_string())?;
        let resolver = LateLinkResolver::new(None, document.introspector().as_ref());
        let html = html_in_bundle(element, &HtmlOptions::default(), resolver.track()).map_err(
            |error| format!("HTML serialization failed: {}", format_diagnostics(&error)),
        )?;

        let mathml = html
            .strip_prefix(BUNDLE_DOCTYPE)
            .unwrap_or(&html)
            .to_string();
        let css = head_style_sheet(document.root());

        Ok(CompiledMath { mathml, css })
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
