#![no_main]

//! Coverage-guided fuzzing of the Typst→MathML pipeline.
//!
//! Input layout: byte 0 selects display mode (odd = display), bytes 1.. are
//! the Typst source (interpreted lossily, so arbitrary bytes are fair game).
//!

use libfuzzer_sys::fuzz_target;
use std::sync::OnceLock;
use typst_math_wasm::Compiler;

fn compiler() -> &'static Compiler {
    static COMPILER: OnceLock<Compiler> = OnceLock::new();
    COMPILER.get_or_init(Compiler::new)
}

const FORBIDDEN_ELEMENTS: &[&str] = &[
    "<script",
    "<svg",
    "<iframe",
    "<object",
    "<embed",
    "<img",
    "<video",
    "<audio",
    "<template",
];

const FORBIDDEN_ATTRIBUTES: &[&str] = &[
    " style=", "onclick=", "onerror=", "onload=", " href=", " src=",
];

fuzz_target!(|data: &[u8]| {
    if data.is_empty() {
        return;
    }
    let display = data[0] & 1 == 1;
    // Length-derived so sampling stays independent of the display bit.
    let verify_purity = data.len() & 0x07 == 0;
    let source = String::from_utf8_lossy(&data[1..]);

    let compiled = match compiler().compile_math(&source, display) {
        Ok(compiled) => compiled,
        Err(diagnostic) => {
            assert!(!diagnostic.trim().is_empty(), "empty diagnostic");
            return;
        }
    };

    let mathml = compiled.mathml();
    assert!(mathml.starts_with("<math"), "bad root: {mathml}");
    assert!(mathml.ends_with("</math>"), "bad tail: {mathml}");

    let lowered = mathml.to_ascii_lowercase();
    for tag in FORBIDDEN_ELEMENTS {
        assert!(!lowered.contains(tag), "forbidden element {tag}: {mathml}");
    }
    for attribute in FORBIDDEN_ATTRIBUTES {
        assert!(
            !lowered.contains(attribute),
            "forbidden attribute {attribute}: {mathml}"
        );
    }

    if display {
        assert!(
            mathml.starts_with("<math display=\"block\">"),
            "display marker missing: {mathml}"
        );
    }

    // Purity contract: output is a pure function of (source, display).
    // Sampled (~1 in 8): every compile ends with a comemo cache eviction,
    // so each verification pays for a full cold recompile.
    if verify_purity {
        let again = compiler().compile_math(&source, display).unwrap();
        assert_eq!(again.mathml(), mathml, "non-deterministic mathml");
    }
});
