#![no_main]

//! Dedicated coverage-guided fuzzing for protected Markdown boundaries:
//! Verifies that fake card syntax (::, :::, {{...}}, %% card-start %%) inside
//! inline code (`...`), fenced code (```...```), inline math ($...$),
//! display math ($$...$$), tables, blockquotes, HTML comments (<!--...-->),
//! and frontmatter are strictly ignored, while valid cards outside are parsed and synced.

use flashcards_wasm::parser::{parse_markdown_blocks, sync_document};
use libfuzzer_sys::fuzz_target;
use std::collections::HashSet;
use std::str;

fuzz_target!(|data: &[u8]| {
    let Ok(raw_payload) = str::from_utf8(data) else {
        return;
    };

    let inline_safe = raw_payload.replace(['\r', '\n', '`', '$', '<', '>', '{', '}'], " ");
    let block_safe = raw_payload.replace(['\r', '\n', '`', '$'], " ").replace("%%", "");

    // 1. Construct markdown document embedding fake card syntax in all protected containers
    let mut doc = String::new();

    // YAML frontmatter with fake cards
    doc.push_str("---\n");
    doc.push_str(&format!("title: Fake Front :: Fake Back {inline_safe}\n"));
    doc.push_str(&format!("summary: Fake Cloze {{{{answer}}}} {inline_safe}\n"));
    doc.push_str("---\n\n");

    // Valid Card 1 before protected blocks
    doc.push_str("Real Question 1 :: Real Answer 1\n\n");

    // Inline Code with fake cards
    doc.push_str(&format!("Here is some code: `Fake Q :: Fake A {inline_safe}` and cloze `{{{{fake_cloze}}}}`.\n\n"));

    // Fenced Code Block with fake block cards & inline cards
    doc.push_str("```rust\n");
    doc.push_str(&format!("// Code comment with :: separator: {block_safe}\n"));
    doc.push_str("%% card-start id=fake01 %%\nFake Block Q\n...\nFake Block A\n%% card-end %%\n");
    doc.push_str("let x = std::sync::Arc::new(5);\n");
    doc.push_str("```\n\n");

    // Valid Card 2 between protected blocks
    doc.push_str("%% card-start %%\nReal Block Question\n...\nReal Block Answer\n%% card-end %%\n\n");

    // Inline Math with fake cards
    let inline_math_safe = inline_safe.trim();
    doc.push_str(&format!("Formula: $f(x) :: y + {inline_math_safe}z$ and $x = {{{{cloze_math}}}}$\n\n"));

    // Display Math with fake cards
    doc.push_str("$$\n");
    doc.push_str(&format!("E = mc^2 :: c^2 + {block_safe}\n"));
    doc.push_str("$$\n\n");

    // Table with fake cards
    doc.push_str("| Column 1 | Column 2 |\n");
    doc.push_str("| --- | --- |\n");
    doc.push_str(&format!("| Cell :: Sep {inline_safe} | Detail {{{{cloze}}}} |\n\n"));

    // Blockquote with fake cards
    doc.push_str(&format!("> Quoted line :: not a card {inline_safe}\n"));
    doc.push_str("> Another quote with {{fake_cloze}}\n\n");

    // HTML Comments with fake cards
    let html_safe = inline_safe.replace('-', " ");
    doc.push_str(&format!("<!-- Hidden comment :: fake card {html_safe} -->\n\n"));

    // Valid Card 3 after protected blocks
    doc.push_str("Real Cloze with {{valid cloze}} here.\n");

    // 2. Parse blocks
    let blocks = parse_markdown_blocks(&doc, &[]);

    // Exactly 3 real cards must be found: Real Question 1, Real Block Question, Real Cloze
    assert_eq!(
        blocks.len(),
        3,
        "Expected exactly 3 valid cards, found {} in doc:\n{}",
        blocks.len(),
        doc
    );
    assert_eq!(blocks[0].front, "Real Question 1");
    assert_eq!(blocks[0].back, "Real Answer 1");

    assert_eq!(blocks[1].front, "Real Block Question");
    assert_eq!(blocks[1].back, "Real Block Answer");

    assert!(blocks[2].front.contains("{{valid cloze}}"));

    // 3. Document synchronization
    let sync_res = sync_document(&doc, &HashSet::new(), &[], &[]);
    let updated = sync_res.updated_content.as_deref().unwrap_or(&doc);

    // Verify that protected regions remained 100% uncorrupted
    assert!(updated.contains("```rust"));
    assert!(updated.contains("%% card-start id=fake01 %%\nFake Block Q"));
    assert!(updated.contains("<!-- Hidden comment :: fake card"));
    assert!(updated.contains("| Column 1 | Column 2 |"));
    assert!(updated.contains("$$\nE = mc^2 :: c^2"));

    // 4. Second sync pass must be completely idempotent (0 modifications)
    let second_sync = sync_document(updated, &HashSet::new(), &[], &[]);
    assert_eq!(
        second_sync.updated_content, None,
        "Second sync pass must be idempotent"
    );
    assert_eq!(second_sync.blocks.len(), 3);
});
