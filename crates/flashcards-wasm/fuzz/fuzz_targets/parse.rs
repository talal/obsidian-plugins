#![no_main]

//! Coverage-guided fuzzing for Markdown/card-boundary parsing and document syncing.

use flashcards_wasm::parser::{
    parse_markdown_blocks, parse_markdown_blocks_with_sections, sync_document, ObsidianSectionHint,
};
use flashcards_wasm::types::{CardBlockType, ParsedBlock};
use libfuzzer_sys::fuzz_target;
use std::collections::HashSet;
use std::str;

fn assert_valid_blocks(input: &str, blocks: &[ParsedBlock]) {
    let line_count = input.lines().count();
    for block in blocks {
        assert!(!block.front.trim().is_empty());
        if block.block_type != CardBlockType::Cloze {
            assert!(!block.back.trim().is_empty());
        }
        assert!(block.line_start <= block.line_end);
        assert!(block.line_end < line_count);
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(input) = str::from_utf8(data) else {
        return;
    };

    let blocks = parse_markdown_blocks(input, &[]);
    assert_valid_blocks(input, &blocks);

    // Feed bounded, intentionally arbitrary section ranges as well.
    let line_count = input.lines().count();
    let hints: Vec<_> = data
        .chunks(3)
        .take(32)
        .map(|chunk| {
            let start = usize::from(chunk.first().copied().unwrap_or_default())
                .checked_rem(line_count.max(1))
                .unwrap_or_default();
            let end = usize::from(chunk.get(1).copied().unwrap_or_default())
                .checked_rem(line_count.max(1))
                .unwrap_or(start);
            ObsidianSectionHint {
                section_type: match chunk.get(2).copied().unwrap_or_default() % 6 {
                    0 => "code",
                    1 => "blockquote",
                    2 => "table",
                    3 => "yaml",
                    4 => "html",
                    _ => "paragraph",
                }
                .to_string(),
                line_start: start.min(end),
                line_end: start.max(end),
            }
        })
        .collect();
    let hinted_blocks = parse_markdown_blocks_with_sections(input, &[], &hints);
    assert_valid_blocks(input, &hinted_blocks);

    // Fuzz single-pass document sync
    let sync_result = sync_document(input, &HashSet::new(), &[], &hints);
    assert_valid_blocks(
        sync_result.updated_content.as_deref().unwrap_or(input),
        &sync_result.blocks,
    );
});
