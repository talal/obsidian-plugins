#![allow(clippy::new_without_default)]
#![allow(clippy::collapsible_if)]

use wasm_bindgen::prelude::*;

mod world;

#[wasm_bindgen]
pub struct Compiler {
    world: world::MathWorld,
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
    pub fn compile_math(&self, source: &str, display: bool) -> Result<String, String> {
        let typst_source = if display {
            format!("$ {} $", source)
        } else {
            format!("${}$", source)
        };
        self.world.set_source(typst_source);

        let warned = typst::compile(&self.world);

        let document = warned.output.map_err(|errs| {
            errs.first()
                .map(|e| e.message.to_string())
                .unwrap_or_else(|| "Unknown compilation error".into())
        })?;

        let options = typst_html::HtmlOptions::default();
        let html_str = typst_html::html(&document, &options)
            .map_err(|e| format!("HTML serialization failed: {:?}", e))?;

        let start = html_str
            .find("<math")
            .ok_or("Failed to extract MathML from HTML output")?;
        let end = html_str
            .find("</math>")
            .ok_or("Failed to extract MathML from HTML output")?;

        Ok(html_str[start..end + 7].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compile_math() {
        let compiler = Compiler::new();
        let mathml = compiler.compile_math("x^2 + y^2 = z^2", false).unwrap();
        assert!(mathml.contains("<math"));
        assert!(mathml.contains("<msup>"));
        assert!(mathml.contains("<mi>𝑥</mi>"));
        assert!(mathml.contains("<mn>2</mn>"));
    }
}
