    use super::*;

    #[test]
    fn test_valid_block_id_parsing() {
        assert!(syntax::is_valid_block_id("k9x2mp"));
        assert!(syntax::is_valid_block_id("012345"));
        assert!(syntax::is_valid_block_id("abcdef"));
        assert!(syntax::is_valid_block_id("zzzzzz"));
        assert!(syntax::is_valid_block_id("000000"));
        assert!(syntax::is_valid_block_id("\u{200E}k9x2mp\u{200F}"));
        assert_eq!(syntax::decode_block_id("000000"), Some(0));
        assert_eq!(syntax::decode_block_id("zzzzzz"), Some(syntax::MAX_BLOCK_ID - 1));
    }

    #[test]
    fn test_invalid_length_block_id() {
        assert_eq!(syntax::decode_block_id(""), None);
        assert_eq!(syntax::decode_block_id("a"), None);
        assert_eq!(syntax::decode_block_id("12345"), None);
        assert_eq!(syntax::decode_block_id("1234567"), None);
        assert_eq!(syntax::decode_block_id("1234567890"), None);
        assert!(!syntax::is_valid_block_id("k9x2m"));
        assert!(!syntax::is_valid_block_id("k9x2mp7"));
        assert!(!syntax::is_valid_block_id(""));
    }

    #[test]
    fn test_invalid_uppercase_characters() {
        assert_eq!(syntax::decode_block_id("K9X2MP"), None);
        assert_eq!(syntax::decode_block_id("k9x2mP"), None);
        assert_eq!(syntax::decode_block_id("K9x2mp"), None);
        assert_eq!(syntax::decode_block_id("ZZZZZZ"), None);
        assert_eq!(syntax::decode_block_id("01234A"), None);
        assert!(!syntax::is_valid_block_id("K9X2MP"));
        assert!(!syntax::is_valid_block_id("k9x2Mp"));
    }

    #[test]
    fn test_invalid_non_base36_characters() {
        assert_eq!(syntax::decode_block_id("k9-2mp"), None);
        assert_eq!(syntax::decode_block_id("k9_2mp"), None);
        assert_eq!(syntax::decode_block_id("k9.2mp"), None);
        assert_eq!(syntax::decode_block_id("k9 2mp"), None);
        assert_eq!(syntax::decode_block_id("k9!2mp"), None);
        assert_eq!(syntax::decode_block_id("k9#2mp"), None);
        assert_eq!(syntax::decode_block_id("k9$2mp"), None);
        assert_eq!(syntax::decode_block_id("k9@2mp"), None);
        assert_eq!(syntax::decode_block_id("k9\n2mp"), None);
        assert!(!syntax::is_valid_block_id("k9-2mp"));
        assert!(!syntax::is_valid_block_id("k9_2mp"));
    }

    #[test]
    fn test_encode_decode_round_trip() {
        // Test boundary values
        let min_id: syntax::BlockId = 0;
        let max_id: syntax::BlockId = syntax::MAX_BLOCK_ID - 1;
        assert_eq!(syntax::encode_block_id(min_id), "000000");
        assert_eq!(syntax::decode_block_id("000000"), Some(min_id));
        assert_eq!(syntax::encode_block_id(max_id), "zzzzzz");
        assert_eq!(syntax::decode_block_id("zzzzzz"), Some(max_id));

        // Test round trip across various values
        let sample_ids = [
            0,
            1,
            35,
            36,
            1296,
            46656,
            1679616,
            60466176,
            1000000000,
            2176782335,
        ];
        for id in sample_ids {
            let encoded = syntax::encode_block_id(id);
            assert_eq!(encoded.len(), 6);
            assert_eq!(syntax::decode_block_id(&encoded), Some(id));
        }

        // Test round trip for specific known strings
        let sample_strs = ["k9x2mp", "012345", "abcdef", "w7n3rk", "8a1b2c", "37066d"];
        for s in sample_strs {
            let decoded = syntax::decode_block_id(s).expect("valid string");
            let re_encoded = syntax::encode_block_id(decoded);
            assert_eq!(re_encoded, s);
        }
    }

    #[test]
    fn test_generate_unique_block_id() {
        let mut existing = HashSet::new();
        let id1 = syntax::generate_unique_block_id(&existing);
        assert!(syntax::is_valid_block_id(&id1));
        existing.insert(id1.clone());

        let id2 = syntax::generate_unique_block_id(&existing);
        assert!(syntax::is_valid_block_id(&id2));
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_collision_registry_operations() {
        let mut registry = syntax::CollisionRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);

        let id1 = syntax::decode_block_id("k9x2mp").unwrap();
        let id2 = syntax::decode_block_id("w7n3rk").unwrap();

        // First insert succeeds
        assert!(registry.insert(id1));
        assert!(registry.contains(id1));
        assert!(!registry.contains(id2));
        assert_eq!(registry.len(), 1);

        // Duplicate insert returns false
        assert!(!registry.insert(id1));
        assert_eq!(registry.len(), 1);

        // Second ID insert succeeds
        assert!(registry.insert(id2));
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn test_forced_collision_deterministic_regeneration() {
        let mut registry = syntax::CollisionRegistry::new();
        let target_collision = syntax::decode_block_id("dup001").unwrap();
        let target_unique = syntax::decode_block_id("uniq99").unwrap();

        // Reserve target_collision first
        assert!(registry.insert(target_collision));

        // Inject RNG sequence: target_collision (collides), target_collision (collides again), target_unique (succeeds)
        let mut attempts = vec![target_unique, target_collision, target_collision];
        let allocated = registry.allocate_unique_with_rng(|| {
            attempts.pop().expect("RNG sequence exhausted")
        });

        assert_eq!(allocated, target_unique);
        assert!(registry.contains(target_unique));
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn test_scan_scoped_registry_across_multiple_documents() {
        let mut registry = syntax::CollisionRegistry::new();

        // Doc 1: Has one card with ID 'dup001' and one missing ID
        let doc1 = "Question 1 :: Answer 1 ^dup001\nQuestion 2 :: Answer 2\n";
        let res1 = sync_document_with_reg(doc1, &mut registry, &[], &[]);
        assert_eq!(res1.blocks.len(), 2);
        assert_eq!(res1.blocks[0].id, "dup001");
        assert!(syntax::is_valid_block_id(&res1.blocks[1].id));
        assert_ne!(res1.blocks[1].id, "dup001");
        assert_eq!(registry.len(), 2);

        // Doc 2: Has a card that collides with doc1's 'dup001', and one card with fresh 'uniq01'
        let doc2 = "Question 3 :: Answer 3 ^dup001\nQuestion 4 :: Answer 4 ^uniq01\n";
        let res2 = sync_document_with_reg(doc2, &mut registry, &[], &[]);
        assert_eq!(res2.blocks.len(), 2);
        assert!(res2.updated_content.is_some());
        let updated2 = res2.updated_content.unwrap();

        // Collision 'dup001' in Doc 2 was regenerated, while 'uniq01' was preserved!
        assert_ne!(res2.blocks[0].id, "dup001");
        assert!(syntax::is_valid_block_id(&res2.blocks[0].id));
        assert_eq!(res2.blocks[1].id, "uniq01");
        assert!(updated2.contains(&res2.blocks[0].id));
        assert!(updated2.contains("uniq01"));

        // Registry now holds all 4 unique IDs from both documents
        assert_eq!(registry.len(), 4);
    }

    #[test]
    fn test_block_retaining_own_existing_id_without_false_collision() {
        let mut registry = syntax::CollisionRegistry::new();
        let doc = "Q1 :: A1 ^own001\nQ2 ::: A2 ^own002\nThe capital is {{Paris}} ^own003\n";
        let res = sync_document_with_reg(doc, &mut registry, &[], &[]);

        // None of the blocks should be modified or considered collisions
        assert_eq!(res.updated_content, None);
        assert_eq!(res.blocks.len(), 3);
        assert_eq!(res.blocks[0].id, "own001");
        assert_eq!(res.blocks[1].id, "own002");
        assert_eq!(res.blocks[2].id, "own003");
        assert_eq!(registry.len(), 3);
    }

    #[test]
    fn test_multiple_generated_ids_during_same_scan() {
        let mut registry = syntax::CollisionRegistry::new();
        let mut doc = String::new();
        for i in 0..50 {
            doc.push_str(&format!("Question {i} :: Answer {i}\n"));
        }

        let res = sync_document_with_reg(&doc, &mut registry, &[], &[]);
        assert!(res.updated_content.is_some());
        assert_eq!(res.blocks.len(), 50);
        assert_eq!(registry.len(), 50);

        let mut seen = HashSet::new();
        for b in &res.blocks {
            assert!(syntax::is_valid_block_id(&b.id));
            assert!(seen.insert(b.id.clone()), "Every generated ID must be unique");
            assert!(registry.contains(syntax::decode_block_id(&b.id).unwrap()));
        }
    }

    #[test]
    fn test_parse_inline_cards() {
        let content = r#"
# Demo Note
Capital of France? :: Paris ^8a1b2c
die Entscheidung ::: the decision #german ^c9f4d1
"#;
        let tags = vec!["geography".to_string()];
        let blocks = parse_markdown_blocks(content, &tags);
        assert_eq!(blocks.len(), 2);

        assert_eq!(blocks[0].block_type, CardBlockType::Inline);
        assert!(!blocks[0].reversible);
        assert_eq!(blocks[0].front, "Capital of France?");
        assert_eq!(blocks[0].back, "Paris");
        assert_eq!(blocks[0].id, "8a1b2c");
        assert_eq!(blocks[0].tags, vec!["geography"]);

        assert_eq!(blocks[1].block_type, CardBlockType::Inline);
        assert!(blocks[1].reversible);
        assert_eq!(blocks[1].front, "die Entscheidung");
        assert_eq!(blocks[1].back, "the decision #german");
        assert_eq!(blocks[1].id, "c9f4d1");
        assert_eq!(blocks[1].tags, vec!["geography", "german"]);
    }

    #[test]
    fn test_parse_block_card() {
        let content = r#"
%% card-start id=37066d reversible=true %%
What are the largest cities of Pakistan?

...

- Karachi
- Lahore
- Faisalabad
%% card-end %%
"#;
        let tags = vec!["pakistan".to_string()];
        let blocks = parse_markdown_blocks(content, &tags);
        assert_eq!(blocks.len(), 1);

        let b = &blocks[0];
        assert_eq!(b.block_type, CardBlockType::Block);
        assert!(b.reversible);
        assert_eq!(b.id, "37066d");
        assert_eq!(b.front, "What are the largest cities of Pakistan?");
        assert!(b.back.contains("Karachi"));
        assert!(b.back.contains("Lahore"));
    }

    #[test]
    fn test_block_card_reversible_header_parsing() {
        let content1 = r#"
%% card-start id=37066d reversible=false %%
Question
...
Answer
%% card-end %%
"#;
        let content2 = r#"
%% card-start id=37066d reversible=true %%
Question
...
Answer
%% card-end %%
"#;
        let blocks1 = parse_markdown_blocks(content1, &[]);
        let blocks2 = parse_markdown_blocks(content2, &[]);
        assert!(!blocks1[0].reversible);
        assert!(blocks2[0].reversible);
    }

    #[test]
    fn test_reject_block_card_without_ellipsis_divider() {
        let content = r#"
%% card-start %%
Q: Capital of France

Paris
%% card-end %%
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 0, "Block cards require explicit ... divider");
    }

    #[test]
    fn test_parse_cloze_card() {
        let content = "The register {{%rax}} holds the return value. ^e3d2c1\n";
        let tags = vec!["cs".to_string()];
        let blocks = parse_markdown_blocks(content, &tags);
        assert_eq!(blocks.len(), 1);

        let b = &blocks[0];
        assert_eq!(b.block_type, CardBlockType::Cloze);
        assert!(!b.reversible);
        assert_eq!(b.id, "e3d2c1");
        assert_eq!(b.front, "The register {{%rax}} holds the return value.");
        assert_eq!(b.back, "");
    }

    #[test]
    fn test_parse_cloze_card_without_block_id() {
        let content = "The capital of France is {{Paris}}.\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);

        let b = &blocks[0];
        assert_eq!(b.block_type, CardBlockType::Cloze);
        assert_eq!(b.id, "");
        assert_eq!(b.front, "The capital of France is {{Paris}}.");
        assert_eq!(b.back, "");
    }

    #[test]
    fn test_parse_cloze_with_colons_inside_cloze() {
        let content = "The C++ namespace is {{std::vector}} ^123456\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_type, CardBlockType::Cloze);
        assert_eq!(blocks[0].id, "123456");
        assert_eq!(blocks[0].front, "The C++ namespace is {{std::vector}}");
        assert_eq!(blocks[0].back, "");
    }

    #[test]
    fn test_reject_highlights_and_anki_clozes() {
        let content = "Obsidian ==highlights== are not flashcards\nRegular text without colons\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 0, "Only {{...}} syntax is accepted as a cloze");
    }

    #[test]
    fn test_parse_inline_with_clozes_in_question() {
        let content = "What is `const` in Rust? :: A constant declaration ^123456\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_type, CardBlockType::Inline);
        assert_eq!(blocks[0].front, "What is `const` in Rust?");
        assert_eq!(blocks[0].back, "A constant declaration");
    }

    #[test]
    fn test_parse_math_expressions_without_misreading_exponent() {
        let content_without_id = "Energy formula :: E = mc^2\n";
        let blocks = parse_markdown_blocks(content_without_id, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Energy formula");
        assert_eq!(blocks[0].back, "E = mc^2");
        assert_eq!(blocks[0].id, ""); // No trailing block ID, exponent preserved!

        let content_with_id = "Energy formula :: E = mc^2 ^8a1b2c\n";
        let blocks_with_id = parse_markdown_blocks(content_with_id, &[]);
        assert_eq!(blocks_with_id.len(), 1);
        assert_eq!(blocks_with_id[0].front, "Energy formula");
        assert_eq!(blocks_with_id[0].back, "E = mc^2");
        assert_eq!(blocks_with_id[0].id, "8a1b2c");
    }

    #[test]
    fn test_reject_unclosed_block_card() {
        let content = r#"
%% card-start id=37066d reversible=true %%
What are the largest cities?
...
- Karachi
- Lahore
"#; // Missing %% card-end %%
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 0); // Unclosed block is rejected!
    }

    #[test]
    fn test_unclosed_block_does_not_hide_later_inline_card() {
        let content = r#"
%% card-start id=37066d %%
Question here
...
Answer here

Later question :: Later answer ^8a1b2c
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Later question");
        assert_eq!(blocks[0].back, "Later answer");
    }

    #[test]
    fn test_invalid_trailing_caret_token_remains_card_content() {
        let content = "Question :: Answer ^beta\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].back, "Answer ^beta");
        assert_eq!(blocks[0].id, "");
    }

    #[test]
    fn test_extract_tag_from_block_header() {
        let content = r#"
%% card-start id=37066d reversible=false #card/todo %%
Question here
...
Answer here
%% card-end %%
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].tags.contains(&"card/todo".to_string()));
    }

    #[test]
    fn test_ignore_code_blocks() {
        let content = r#"
# Notes with Rust Code

```rust
fn main() {
    let x = std::sync::Arc::new(5);
    let y = std::collections::HashMap::new();
}
```

Valid Question :: Valid Answer ^8a1b2c
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Valid Question");
        assert_eq!(blocks[0].back, "Valid Answer");
        assert_eq!(blocks[0].id, "8a1b2c");
    }

    #[test]
    fn test_block_code_does_not_close_block_card_early() {
        let content = r#"%% card-start id=37066d reversible=false %%
Question
...
```text
%% card-end %%
```
Answer
%% card-end %%
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].back.contains("%% card-end %%"));
        assert!(blocks[0].back.contains("Answer"));
    }

    #[test]
    fn test_ignore_tables() {
        let content = r#"
| Function | Description |
| --- | --- |
| std::vector::push_back | Append element |
| `std::map` | Key :: Value store |
| {{highlighted item}} | Details |

Real Question :: Real Answer ^123456
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Real Question");
        assert_eq!(blocks[0].back, "Real Answer");
    }

    #[test]
    fn test_ignore_blockquotes() {
        let content = r#"
> This is a quote with std::string::c_str and {{cloze}} highlight
> Another quote line :: not a card

Card Question :: Card Answer ^654321
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Card Question");
        assert_eq!(blocks[0].back, "Card Answer");
    }

    #[test]
    fn test_ignore_frontmatter() {
        let content = r#"---
title: Note Title :: Subtitle
author: John Doe
tags: [vocab, geography]
---

# Title
What is the capital of Japan? :: Tokyo ^fedcba
"#;
        let blocks = parse_markdown_blocks(content, &["inherited".to_string()]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "What is the capital of Japan?");
        assert_eq!(blocks[0].back, "Tokyo");
    }

    #[test]
    fn test_ignore_math_blocks() {
        let content = r#"
$$
f(x) = x^2 :: \text{where } x > 0
$$

Math Question :: Answer ^112233
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Math Question");
        assert_eq!(blocks[0].back, "Answer");
    }

    #[test]
    fn test_inline_code_inside_card_question() {
        let content = "What does `std::cmp::Ordering` do? :: Compares values ^aabbcc\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "What does `std::cmp::Ordering` do?");
        assert_eq!(blocks[0].back, "Compares values");
    }

    #[test]
    fn test_arabic_and_urdu_unicode_cards() {
        let content = r#"---
title: پنجابی دا ذخیرہ الفاظ
tags: [پنجابی, الفاظ]
---

# پنجابی دا ذخیرہ الفاظ

پانی ::: Water #ذخیرہ ^8a1b2c
سورج :: Sun ^c9f4d1
زمین سورج دے گرد {{چکر}} کٹدی اے۔ ^d3e2f1
"#;
        let blocks = parse_markdown_blocks(content, &["پنجابی".to_string()]);
        assert_eq!(blocks.len(), 3);

        // 1. Bidirectional card
        assert_eq!(blocks[0].block_type, CardBlockType::Inline);
        assert!(blocks[0].reversible);
        assert_eq!(blocks[0].front, "پانی");
        assert_eq!(blocks[0].back, "Water #ذخیرہ");
        assert_eq!(blocks[0].id, "8a1b2c");
        assert!(blocks[0].tags.contains(&"پنجابی".to_string()));
        assert!(blocks[0].tags.contains(&"ذخیرہ".to_string()));

        // 2. Forward card
        assert_eq!(blocks[1].block_type, CardBlockType::Inline);
        assert!(!blocks[1].reversible);
        assert_eq!(blocks[1].front, "سورج");
        assert_eq!(blocks[1].back, "Sun");
        assert_eq!(blocks[1].id, "c9f4d1");

        // 3. Cloze card
        assert_eq!(blocks[2].block_type, CardBlockType::Cloze);
        assert!(!blocks[2].reversible);
        assert_eq!(blocks[2].front, "زمین سورج دے گرد {{چکر}} کٹدی اے۔");
        assert_eq!(blocks[2].back, "");
        assert_eq!(blocks[2].id, "d3e2f1");
    }

    #[test]
    fn test_urdu_rtl_scratch_file() {
        let content = "تسی حج وی کیتی جاندے او :: لہو وی پیتی جاندے او ^j1029y\n\n%% card-start id=n7s8y3 %%\nتسی حج وی کیتی جاندے او\n...\nلہو وی پیتی جاندے او\n%% card-end %%\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].id, "j1029y");
        assert_eq!(blocks[0].front, "تسی حج وی کیتی جاندے او");
        assert_eq!(blocks[0].back, "لہو وی پیتی جاندے او");
        assert_eq!(blocks[1].id, "n7s8y3");
        assert_eq!(blocks[1].front, "تسی حج وی کیتی جاندے او");
        assert_eq!(blocks[1].back, "لہو وی پیتی جاندے او");

        let content_no_id = "تسی حج وی کیتی جاندے او :: لہو وی پیتی جاندے او\n\n%% card-start %%\nتسی حج وی کیتی جاندے او\n...\nلہو وی پیتی جاندے او\n%% card-end %%\n";
        let result = sync_document(content_no_id, &HashSet::new(), &[], &[]);
        assert!(result.updated_content.is_some());
        assert_eq!(result.blocks.len(), 2);

        // BiDi marks test (RLM, LRM, ALM, etc.) with dividers
        let content_bidi = "\u{200F}تسی حج وی کیتی جاندے او :: لہو وی پیتی جاندے او ^j1029y\u{200F}\n\n\u{200F}%% card-start id=n7s8y3 %%\u{200F}\nتسی حج وی کیتی جاندے او\n\u{200F}...\u{200F}\nلہو وی پیتی جاندے او\n\u{200F}%% card-end %%\u{200F}\n";
        let blocks_bidi = parse_markdown_blocks(content_bidi, &[]);
        assert_eq!(blocks_bidi.len(), 2, "BiDi marks should not break card parsing");
        assert_eq!(blocks_bidi[0].id, "j1029y");
        assert_eq!(blocks_bidi[0].front, "تسی حج وی کیتی جاندے او");
        assert_eq!(blocks_bidi[0].back, "لہو وی پیتی جاندے او");
        assert_eq!(blocks_bidi[1].id, "n7s8y3");
        assert_eq!(blocks_bidi[1].front, "تسی حج وی کیتی جاندے او");
        assert_eq!(blocks_bidi[1].back, "لہو وی پیتی جاندے او");

        // Test sync_document with BiDi marks and no IDs
        let content_bidi_no_id = "\u{200F}تسی حج وی کیتی جاندے او :: لہو وی پیتی جاندے او\u{200F}\n\n\u{200F}%% card-start %%\u{200F}\nتسی حج وی کیتی جاندے او\n\u{200F}…\u{200F}\nلہو وی پیتی جاندے او\n\u{200F}%% card-end %%\u{200F}\n";
        let sync_bidi = sync_document(content_bidi_no_id, &HashSet::new(), &[], &[]);
        assert!(sync_bidi.updated_content.is_some());
        assert_eq!(sync_bidi.blocks.len(), 2);
        let updated_bidi = sync_bidi.updated_content.unwrap();
        let resync_bidi = sync_document(&updated_bidi, &HashSet::new(), &[], &[]);
        assert_eq!(resync_bidi.updated_content, None, "Resync must be idempotent");
        assert_eq!(resync_bidi.blocks.len(), 2);
    }

    #[test]
    fn test_fuzz_reproduce_rescan_mismatch_6() {
        let data: &[u8] = &[
            84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 84, 91, 118, 96,
            10, 99, 116, 98, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87, 87,
            87, 87, 87, 87, 87, 87, 87, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123,
            123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123,
            123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 123, 87, 111, 110, 92, 0,
            0, 96, 0, 0, 0, 0, 0, 93, 0, 0, 0, 0, 119, 84, 84, 84, 84, 84, 84, 84, 84, 84, 93, 0,
            84, 84, 84, 84, 84, 84, 84, 58, 58, 58, 73, 96, 118, 74, 96, 73, 60, 118, 84, 91, 118,
            96, 10, 99, 116, 98, 111, 48, 0, 92, 0, 96, 0, 84, 60, 84, 84, 84, 74, 78, 49, 114,
            84, 84, 84, 84, 0, 0, 0, 0, 93, 0, 37, 0, 0, 0, 0, 74, 109, 97, 114, 107, 100, 111,
            119, 110, 10, 37, 37, 32, 97,
        ];
        let input = std::str::from_utf8(data).unwrap();
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

        let tags = vec![];
        let external_ids = HashSet::new();

        let sync_result = sync_document(input, &external_ids, &tags, &hints);
        let synced_text = sync_result.updated_content.as_deref().unwrap_or(input);
        println!("Synced text:\n{}", synced_text);
        println!("Synced blocks:\n{:#?}", sync_result.blocks);

        let second_sync = sync_document(synced_text, &external_ids, &tags, &hints);
        println!("Second sync:\n{:#?}", second_sync);
        assert_eq!(second_sync.updated_content, None);
    }





    #[test]
    fn test_sync_document_generates_missing_ids() {
        let input = r#"
# Biology
What is the powerhouse of the cell? :: Mitochondria
French word for apple ::: la pomme
The capital of Germany is {{Berlin}}.

%% card-start reversible=true %%
List three states of matter:
...
- Solid
- Liquid
- Gas
%% card-end %%
"#;
        let result = sync_document(input, &HashSet::new(), &[], &[]);
        assert!(result.updated_content.is_some());
        let updated = result.updated_content.unwrap();
        assert_eq!(result.blocks.len(), 4);

        for block in &result.blocks {
            assert!(syntax::is_valid_block_id(&block.id));
            assert!(updated.contains(&block.id));
        }

        // Re-syncing the updated document should produce NO modifications
        let second_sync = sync_document(&updated, &HashSet::new(), &[], &[]);
        assert!(second_sync.updated_content.is_none());
        assert_eq!(second_sync.blocks.len(), 4);
        for (b1, b2) in result.blocks.iter().zip(second_sync.blocks.iter()) {
            assert_eq!(b1.id, b2.id);
            assert_eq!(b1.front, b2.front);
            assert_eq!(b1.back, b2.back);
            assert_eq!(b1.reversible, b2.reversible);
        }
    }

    #[test]
    fn test_sync_document_replaces_duplicate_id() {
        let input = "Capital of France :: Paris ^dup001\nCapital of Italy :: Rome ^dup001\n";
        let result = sync_document(input, &HashSet::new(), &[], &[]);
        assert!(result.updated_content.is_some());
        let updated = result.updated_content.unwrap();
        assert_eq!(result.blocks.len(), 2);

        assert_eq!(result.blocks[0].id, "dup001");
        assert_ne!(result.blocks[1].id, "dup001");
        assert!(syntax::is_valid_block_id(&result.blocks[1].id));
        assert!(updated.contains(&result.blocks[1].id));
    }

    #[test]
    fn test_sync_document_replaces_externally_colliding_id() {
        let mut existing = HashSet::new();
        existing.insert("col001".to_string());

        let input = "Capital of Japan :: Tokyo ^col001\n";
        let result = sync_document(input, &existing, &[], &[]);
        assert!(result.updated_content.is_some());
        let updated = result.updated_content.unwrap();
        assert_eq!(result.blocks.len(), 1);

        assert_ne!(result.blocks[0].id, "col001");
        assert!(syntax::is_valid_block_id(&result.blocks[0].id));
        assert!(updated.contains(&result.blocks[0].id));
    }

    #[test]
    fn test_obsidian_section_hints_protect_stale_or_custom_block_ranges() {
        let content = "Not a card :: because this is code\nReal question :: Real answer\n";
        let hints = vec![ObsidianSectionHint {
            section_type: "code".to_string(),
            line_start: 0,
            line_end: 0,
        }];
        let blocks = parse_markdown_blocks_with_sections(content, &[], &hints);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front, "Real question");
    }

    #[test]
    fn test_fuzz_reproduce_crash() {
        let bytes: &[u8] = &[
            73, 110, 32, 58, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
            17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
            17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
            17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 58, 58, 58, 32, 67, 104, 101, 99,
            107, 32, 110, 97, 32, 32, 61, 61, 32, 74, 58, 32, 67, 104, 96, 32, 101, 99, 107, 32,
            101, 113, 117, 99, 46, 10, 96, 118, 96, 109, 61, 61, 91, 97, 10, 96, 118, 96, 109,
            61, 61, 91, 97, 114,
        ];
        let input = std::str::from_utf8(bytes).unwrap();
        let sync1 = sync_document(input, &HashSet::new(), &[], &[]);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(input);
        let sync2 = sync_document(synced_text, &HashSet::new(), &[], &[]);
        assert_eq!(sync2.updated_content, None);
    }

    #[test]
    fn test_fuzz_reproduce_protected_syntax() {
        let doc = r#"---
title: Fake Front :: Fake Back
summary: Fake Cloze {{answer}}
---

Real Question 1 :: Real Answer 1

Here is some code: `Fake Q :: Fake A ` and cloze `{{fake_cloze}}`.

```rust
// Code comment with :: separator: e}
%% card-start id=fake01 %%
Fake Block Q
...
Fake Block A
%% card-end %%
let x = std::sync::Arc::new(5);
```

%% card-start %%
Real Block Question
...
Real Block Answer
%% card-end %%

Formula: $f(x) :: y + ez$ and $x = {{cloze_math}}$

$$
E = mc^2 :: c^2 + e}
$$

| Column 1 | Column 2 |
| --- | --- |
| Cell :: Sep | Detail {{cloze}} |

> Quoted line :: not a card 
> Another quote with {{fake_cloze}}

<!-- Hidden comment :: fake card  -->

Real Cloze with {{valid cloze}} here.
"#;
        let blocks = parse_markdown_blocks(doc, &[]);
        assert_eq!(blocks.len(), 3);
    }

    #[test]
    fn test_fuzz_reproduce_rescan_mismatch() {
        let bytes: &[u8] = &[
            45, 58, 58, 58, 10, 10, 91, 61, 45, 58, 61, 45, 58, 58, 58, 58, 10, 10, 91, 52, 0,
            61, 45, 58, 93, 58, 58, 58, 58, 10, 10, 91, 58, 58, 58, 93, 58, 32,
        ];
        let input = std::str::from_utf8(bytes).unwrap();
        let sync1 = sync_document(input, &HashSet::new(), &[], &[]);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(input);
        println!("SYNC1 blocks: {:?}", sync1.blocks);
        println!("SYNC1 updated:\n{}", synced_text);
        let sync2 = sync_document(synced_text, &HashSet::new(), &[], &[]);
        println!("SYNC2 blocks: {:?}", sync2.blocks);
        assert_eq!(sync1.blocks.len(), sync2.blocks.len());
        assert_eq!(sync2.updated_content, None);
    }

    #[test]
    fn test_trailing_block_id_inside_code_is_ignored() {
        // Line ends with inline code containing `^abc123`
        let input = "Question :: Answer with `inline code ^abc123`";
        let blocks = parse_markdown_blocks(input, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, ""); // No valid block ID because it is inside code
        assert_eq!(blocks[0].back, "Answer with `inline code ^abc123`");

        // Line ends with valid block ID outside code
        let input2 = "Question :: Answer with `inline code` ^abc123";
        let blocks2 = parse_markdown_blocks(input2, &[]);
        assert_eq!(blocks2.len(), 1);
        assert_eq!(blocks2[0].id, "abc123");
        assert_eq!(blocks2[0].back, "Answer with `inline code`");
    }

    #[test]
    fn test_trailing_block_id_inside_math_is_ignored() {
        // Cloze card with trailing math containing caret
        let input = "The formula is {{energy}} with math $E = mc^2$";
        let blocks = parse_markdown_blocks(input, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, "");
    }

    #[test]
    fn test_fuzz_reproduce_rescan_block_count_mismatch_4() {
        let data: &[u8] = &[
            61, 8, 116, 10, 60, 115, 116, 58, 96, 116, 105, 0, 10, 116, 10, 8, 116, 10, 60, 115,
            116, 58, 96, 116, 105, 0, 10, 116, 10, 10, 10, 8, 116, 10, 60, 115, 116, 58, 96, 116,
            58, 110, 32, 61, 61, 32, 97, 114, 100, 107, 36, 58, 58, 110, 32, 61, 61, 32, 97, 114,
            10, 10, 114, 10, 10, 114, 10, 10, 10, 10, 10, 10, 10, 114, 10, 10, 10, 10, 42, 10,
            10, 10, 10, 10, 10, 10, 10, 10, 10, 114, 10, 10, 10, 65, 57, 57, 57, 123, 123, 58, 58,
            40, 32, 45, 32, 101, 10, 61, 32, 97, 114, 10, 10, 114, 10, 10, 114, 10, 10, 10, 10,
            10, 10, 10, 105, 0, 10, 10, 8, 116, 10, 60, 115, 116, 58, 96, 114, 10, 10, 10, 10,
            42, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 114, 10, 58, 58, 96, 10, 58, 58, 10, 10,
            10, 122, 10, 60, 73, 90, 90, 90, 122, 90, 90, 69, 32, 58, 58, 110, 73, 61, 10, 97,
            48, 61, 10, 32, 100, 58, 58, 58, 74, 10, 100, 45, 39, 58, 93, 58, 118, 58, 10, 10,
            91, 61, 45, 39, 58, 93, 58, 118, 60, 74, 109, 97, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
            9, 9, 100, 111, 93, 10, 10, 32, 61, 46, 58, 58, 96, 10, 58, 58, 10, 10, 10, 122, 10,
            60, 73, 90, 90, 90, 90, 90, 122, 90, 90, 69, 32, 58, 58, 110, 73, 61, 10, 97, 48, 61,
            10, 32, 100, 58, 10, 58, 62, 74, 10, 100, 58, 42,
        ];
        let input = std::str::from_utf8(data).unwrap();
        let tags: Vec<String> = data
            .chunks(5)
            .take(4)
            .filter_map(|chunk| std::str::from_utf8(chunk).ok().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty() && !s.contains(char::is_whitespace) && !s.contains('#'))
            .collect();
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

        let mut external_ids = HashSet::new();
        for chunk in data.chunks(6).take(8) {
            if let Ok(s) = std::str::from_utf8(chunk) {
                let candidate: String =
                    s.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
                if candidate.len() == 6 && syntax::is_valid_block_id(&candidate) {
                    external_ids.insert(candidate);
                }
            }
        }

        let sync1 = sync_document(input, &external_ids, &tags, &hints);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(input);
        let sync2 = sync_document(synced_text, &external_ids, &tags, &hints);
        assert_eq!(sync1.blocks.len(), sync2.blocks.len());
        assert_eq!(sync2.updated_content, None);
    }

    #[test]
    fn test_fuzz_reproduce_unicode_bidi_link_reference_definition() {
        let input = "[{{_}}]:\n___";
        let sync1 = sync_document(input, &HashSet::new(), &[], &[]);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(input);
        let sync2 = sync_document(synced_text, &HashSet::new(), &[], &[]);
        assert_eq!(sync1.blocks.len(), sync2.blocks.len());
        assert_eq!(sync2.updated_content, None);
    }

    #[test]
    fn test_fuzz_reproduce_unicode_bidi_heading() {
        const BIDI_CHARS: &[char] = &[
            '\u{200E}', '\u{200F}', '\u{061C}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}',
            '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}', '\u{FEFF}', '\u{200B}',
            '\u{200C}', '\u{200D}',
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
        const DIVIDERS: &[&str] = &["...", ". . .", "…"];

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

        let data: &[u8] = &[84, 58, 58, 123, 58, 58, 58, 125, 13, 45];
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
        let rev = if reader.next_byte() % 3 == 0 { " reversible=true" } else { "" };
        
        let start_header = format!("%% card-start{block_id}{rev} %%");
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
        let raw_str = std::str::from_utf8(data).unwrap();
        doc.push_str(raw_str);

        let sync1 = sync_document(&doc, &HashSet::new(), &[], &[]);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(&doc);
        let sync2 = sync_document(synced_text, &HashSet::new(), &[], &[]);
        assert_eq!(sync1.blocks.len(), sync2.blocks.len());
        for (b1, b2) in sync1.blocks.iter().zip(sync2.blocks.iter()) {
            assert_eq!(b1.reversible, b2.reversible);
        }
    }

    #[test]
    fn test_fuzz_reproduce_unicode_bidi_unclosed_paren() {
        let input = "[0]::[](\r){\n\n)0\r\n";
        let sync1 = sync_document(input, &HashSet::new(), &[], &[]);
        let synced_text = sync1.updated_content.as_deref().unwrap_or(input);
        let sync2 = sync_document(synced_text, &HashSet::new(), &[], &[]);
        assert_eq!(sync1.blocks.len(), sync2.blocks.len());
        assert_eq!(sync2.updated_content, None);
    }


