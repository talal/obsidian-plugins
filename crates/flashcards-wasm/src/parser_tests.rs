    use super::*;

    #[test]
    fn test_valid_block_id() {
        assert!(syntax::is_valid_block_id("k9x2mp"));
        assert!(syntax::is_valid_block_id("012345"));
        assert!(syntax::is_valid_block_id("abcdef"));
        assert!(syntax::is_valid_block_id("zzzzzz"));

        // Invalid: uppercase, wrong length, special characters
        assert!(!syntax::is_valid_block_id("K9X2MP"));
        assert!(!syntax::is_valid_block_id("k9x2m"));
        assert!(!syntax::is_valid_block_id("k9x2mp7"));
        assert!(!syntax::is_valid_block_id("k9-2mp"));
        assert!(!syntax::is_valid_block_id(""));
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
        let mut options = pulldown_cmark::Options::empty();
        options.insert(pulldown_cmark::Options::ENABLE_TABLES);
        options.insert(pulldown_cmark::Options::ENABLE_GFM);
        options.insert(pulldown_cmark::Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
        options.insert(pulldown_cmark::Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS);
        options.insert(pulldown_cmark::Options::ENABLE_MATH);
        options.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
        options.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
        options.insert(pulldown_cmark::Options::ENABLE_HEADING_ATTRIBUTES);
        options.insert(pulldown_cmark::Options::ENABLE_WIKILINKS);
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

