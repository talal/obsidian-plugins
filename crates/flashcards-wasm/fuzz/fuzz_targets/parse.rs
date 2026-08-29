#![no_main]

//! Comprehensive coverage-guided fuzzing for Markdown card parsing,
//! boundary extraction, section hint filtering, collision reconciliation,
//! and single-pass document synchronization invariants.

use flashcards_wasm::parser::syntax::is_valid_block_id;
use flashcards_wasm::parser::{
    parse_markdown_blocks, parse_markdown_blocks_with_sections, sync_document, ObsidianSectionHint,
};
use flashcards_wasm::types::{CardBlockType, ParsedBlock};
use libfuzzer_sys::fuzz_target;
use std::collections::HashSet;
use std::str;

fn assert_valid_blocks(input: &str, blocks: &[ParsedBlock], require_valid_id: bool) {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let line_count = normalized.lines().count().max(1);
    let mut seen_ids = HashSet::new();

    for block in blocks {
        assert!(!block.front.trim().is_empty(), "Front cannot be empty");
        if block.block_type == CardBlockType::Cloze {
            assert!(block.back.is_empty(), "Cloze back must be empty");
            assert!(!block.reversible, "Cloze cards cannot be reversible");
        } else {
            assert!(!block.back.trim().is_empty(), "Non-cloze back cannot be empty");
        }
        assert!(
            block.line_start <= block.line_end,
            "line_start ({}) <= line_end ({})",
            block.line_start,
            block.line_end
        );
        assert!(
            block.line_end < line_count,
            "line_end ({}) < line_count ({})",
            block.line_end,
            line_count
        );

        if require_valid_id {
            assert!(
                is_valid_block_id(&block.id),
                "Block ID '{}' must be a valid 6-char base-36 ID",
                block.id
            );
            assert!(
                seen_ids.insert(block.id.clone()),
                "Duplicate block ID '{}' in document sync output",
                block.id
            );
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(input) = str::from_utf8(data) else {
        return;
    };

    // 1. Basic parsing without hints
    let blocks = parse_markdown_blocks(input, &[]);
    assert_valid_blocks(input, &blocks, false);

    // 2. Parse with arbitrary inherited tags
    let tags: Vec<String> = data
        .chunks(5)
        .take(4)
        .filter_map(|chunk| str::from_utf8(chunk).ok().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty() && !s.contains(char::is_whitespace) && !s.contains('#'))
        .collect();

    let tagged_blocks = parse_markdown_blocks(input, &tags);
    assert_valid_blocks(input, &tagged_blocks, false);
    for block in &tagged_blocks {
        for tag in &tags {
            assert!(
                block.tags.contains(tag),
                "Parsed block must inherit note tag '{tag}'"
            );
        }
    }

    // 3. Parse with arbitrary, potentially chaotic/overlapping section ranges
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

    let hinted_blocks = parse_markdown_blocks_with_sections(input, &tags, &hints);
    assert_valid_blocks(input, &hinted_blocks, false);

    // 4. Synthesize arbitrary external collision IDs
    let mut external_ids = HashSet::new();
    for chunk in data.chunks(6).take(8) {
        if let Ok(s) = str::from_utf8(chunk) {
            let candidate: String = s.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
            if candidate.len() == 6 && is_valid_block_id(&candidate) {
                external_ids.insert(candidate);
            }
        }
    }

    // 5. Fuzz single-pass document synchronization with external collisions
    let sync_result = sync_document(input, &external_ids, &tags, &hints);
    let synced_text = sync_result.updated_content.as_deref().unwrap_or(input);

    assert_valid_blocks(synced_text, &sync_result.blocks, true);

    // Invariant: No minted block ID may collide with external IDs
    for block in &sync_result.blocks {
        assert!(
            !external_ids.contains(&block.id),
            "Minted ID '{}' must not exist in external collision set",
            block.id
        );
    }

    // 6. Invariant: Idempotency of rescans
    // Running sync_document a second time on synced_text (with the same external collisions)
    // MUST NOT modify the document further and MUST preserve all block IDs.
    let second_sync = sync_document(synced_text, &external_ids, &tags, &hints);
    assert_eq!(
        second_sync.updated_content, None,
        "Second pass on synced document must be completely idempotent (0 file modifications)"
    );
    assert_eq!(
        sync_result.blocks.len(),
        second_sync.blocks.len(),
        "Block counts must match exactly on rescan"
    );
    for (b1, b2) in sync_result.blocks.iter().zip(second_sync.blocks.iter()) {
        assert_eq!(b1.id, b2.id, "Block IDs must be preserved across rescans");
        assert_eq!(b1.block_type, b2.block_type);
        assert_eq!(b1.reversible, b2.reversible);
        assert_eq!(b1.front, b2.front);
        assert_eq!(b1.back, b2.back);
        assert_eq!(b1.tags, b2.tags);
        assert_eq!(b1.line_start, b2.line_start);
        assert_eq!(b1.line_end, b2.line_end);
    }
});
