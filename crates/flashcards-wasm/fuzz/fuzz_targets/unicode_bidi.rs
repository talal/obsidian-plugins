#![no_main]

//! Dedicated coverage-guided fuzzing for RTL scripts (Urdu, Arabic, Hebrew, etc.),
//! Unicode bidirectional control characters (LRM, RLM, ALM, isolates, overrides),
//! zero-width characters, and mixed-direction flashcard markdown structures.

use flashcards_wasm::parser::syntax::is_valid_block_id;
use flashcards_wasm::parser::{parse_markdown_blocks, sync_document};
use flashcards_wasm::types::CardBlockType;
use libfuzzer_sys::fuzz_target;
use std::collections::HashSet;
use std::str;

const BIDI_CHARS: &[char] = &[
    '\u{200E}', // LRM
    '\u{200F}', // RLM
    '\u{061C}', // ALM
    '\u{202A}', // LRE
    '\u{202B}', // RLE
    '\u{202C}', // PDF
    '\u{202D}', // LRO
    '\u{202E}', // RLO
    '\u{2066}', // LRI
    '\u{2067}', // RLI
    '\u{2068}', // FSI
    '\u{2069}', // PDI
    '\u{FEFF}', // BOM / ZWNBSP
    '\u{200B}', // ZWSP
    '\u{200C}', // ZWNJ
    '\u{200D}', // ZWJ
];

const RTL_SNIPPETS: &[&str] = &[
    "تسی حج وی کیتی جاندے او",
    "لہو وی پیتی جاندے او",
    "زمین سورج دے گرد چکر کٹدی اے۔",
    "پاکستان دا دارالحکومت اسلام آباد اے۔",
    "سورج",
    "چاند",
    "ستارے",
    "שלום עולם",
    "مرحبا بالعالم",
    "English text mixed with اردو",
];

const DIVIDERS: &[&str] = &["::", ":::"];

struct ByteReader<'a> {
    data: &'a [u8],
    idx: usize,
}

impl<'a> ByteReader<'a> {
    fn next_byte(&mut self) -> u8 {
        if self.data.is_empty() {
            0
        } else {
            let b = self.data[self.idx % self.data.len()];
            self.idx = self.idx.wrapping_add(1);
            b
        }
    }

    fn inject_bidi(&mut self, s: &str) -> String {
        let mut out = String::new();
        let count = (self.next_byte() % 4) as usize;
        for _ in 0..count {
            let ch = BIDI_CHARS[(self.next_byte() as usize) % BIDI_CHARS.len()];
            out.push(ch);
        }
        out.push_str(s);
        let count_end = (self.next_byte() % 4) as usize;
        for _ in 0..count_end {
            let ch = BIDI_CHARS[(self.next_byte() as usize) % BIDI_CHARS.len()];
            out.push(ch);
        }
        out
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(raw_str) = str::from_utf8(data) else {
        return;
    };

    let mut reader = ByteReader { data, idx: 0 };
    let mut doc = String::new();

    // 1. Inline cards
    let q = RTL_SNIPPETS[(reader.next_byte() as usize) % RTL_SNIPPETS.len()];
    let a = RTL_SNIPPETS[(reader.next_byte() as usize) % RTL_SNIPPETS.len()];
    let sep = if reader.next_byte() % 2 == 0 { "::" } else { ":::" };
    let has_id = reader.next_byte() % 2 == 0;
    let id_suffix = if has_id { " ^j1029y" } else { "" };
    let inline_card = format!("{q} {sep} {a}{id_suffix}");
    doc.push_str(&reader.inject_bidi(&inline_card));
    doc.push_str("\n\n");

    // 2. Cloze cards
    let cloze_snippet = RTL_SNIPPETS[(reader.next_byte() as usize) % RTL_SNIPPETS.len()];
    let cloze_body = format!("زمین {{{{{}}}}} دے گرد چکر کٹدی اے۔", cloze_snippet);
    let cloze_id = if reader.next_byte() % 2 == 0 { " ^c3e2f1" } else { "" };
    let cloze_card = format!("{cloze_body}{cloze_id}");
    doc.push_str(&reader.inject_bidi(&cloze_card));
    doc.push_str("\n\n");

    // 3. Block cards
    let block_q = RTL_SNIPPETS[(reader.next_byte() as usize) % RTL_SNIPPETS.len()];
    let block_a = RTL_SNIPPETS[(reader.next_byte() as usize) % RTL_SNIPPETS.len()];
    let div = DIVIDERS[(reader.next_byte() as usize) % DIVIDERS.len()];
    let block_id = if reader.next_byte() % 2 == 0 { " id=n7s8y3" } else { "" };
    
    let start_header = format!("%% card-start{block_id} %%");
    doc.push_str(&reader.inject_bidi(&start_header));
    doc.push('\n');
    doc.push_str(&reader.inject_bidi(block_q));
    doc.push('\n');
    doc.push_str(&reader.inject_bidi(div));
    doc.push('\n');
    doc.push_str(&reader.inject_bidi(block_a));
    doc.push('\n');
    doc.push_str(&reader.inject_bidi("%% card-end %%"));
    doc.push_str("\n\n");

    // 4. Also append raw payload
    doc.push_str(raw_str);

    // Parse blocks
    let blocks = parse_markdown_blocks(&doc, &[]);
    for block in &blocks {
        assert!(!block.front.trim().is_empty(), "Front cannot be empty");
        if block.block_type == CardBlockType::Cloze {
            assert!(block.back.is_empty(), "Cloze back must be empty");
            assert!(!block.reversible, "Cloze cards cannot be reversible");
        } else {
            assert!(!block.back.trim().is_empty(), "Non-cloze back cannot be empty");
        }
        if !block.id.is_empty() {
            assert!(is_valid_block_id(&block.id), "ID '{}' must be a valid 6-char block ID", block.id);
        }
    }

    // Sync document
    let sync_res = sync_document(&doc, &HashSet::new(), &[], &[]);
    let updated = sync_res.updated_content.as_deref().unwrap_or(&doc);

    // All blocks from sync must have valid IDs and be unique
    let mut seen_ids = HashSet::new();
    for block in &sync_res.blocks {
        assert!(is_valid_block_id(&block.id), "Block ID '{}' must be valid", block.id);
        assert!(seen_ids.insert(block.id.clone()), "Duplicate block ID '{}'", block.id);
    }

    // Idempotency: resync must produce NO updates and exact same blocks
    let second_sync = sync_document(updated, &HashSet::new(), &[], &[]);
    assert_eq!(
        second_sync.updated_content, None,
        "Second sync pass on synced content must be idempotent"
    );
    assert_eq!(sync_res.blocks.len(), second_sync.blocks.len());
    for (b1, b2) in sync_res.blocks.iter().zip(second_sync.blocks.iter()) {
        assert_eq!(b1.id, b2.id);
        assert_eq!(b1.block_type, b2.block_type);
        assert_eq!(b1.reversible, b2.reversible);
        assert_eq!(b1.front, b2.front);
        assert_eq!(b1.back, b2.back);
    }
});
