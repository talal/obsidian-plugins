    use super::*;

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

        assert_eq!(blocks[0].card_type, CardType::InlineForward);
        assert_eq!(blocks[0].front_raw, "Capital of France?");
        assert_eq!(blocks[0].back_raw, "Paris");
        assert_eq!(blocks[0].block_id, "8a1b2c");
        assert_eq!(blocks[0].tags, vec!["geography"]);

        assert_eq!(blocks[1].card_type, CardType::InlineBoth);
        assert_eq!(blocks[1].front_raw, "die Entscheidung");
        assert_eq!(blocks[1].back_raw, "the decision #german");
        assert_eq!(blocks[1].block_id, "c9f4d1");
        assert_eq!(blocks[1].tags, vec!["geography", "german"]);
    }

    #[test]
    fn test_parse_block_card() {
        let content = r#"
%% card-start id=37066d direction=both %%
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
        assert_eq!(b.card_type, CardType::Block);
        assert_eq!(b.direction, CardDirection::Both);
        assert_eq!(b.block_id, "37066d");
        assert_eq!(b.front_raw, "What are the largest cities of Pakistan?");
        assert!(b.back_raw.contains("Karachi"));
        assert!(b.back_raw.contains("Lahore"));
    }

    #[test]
    fn test_block_card_hash_changes_on_header_edit() {
        let content1 = r#"
%% card-start id=37066d direction=forward %%
Question
...
Answer
%% card-end %%
"#;
        let content2 = r#"
%% card-start id=37066d direction=both %%
Question
...
Answer
%% card-end %%
"#;
        let blocks1 = parse_markdown_blocks(content1, &[]);
        let blocks2 = parse_markdown_blocks(content2, &[]);
        assert_ne!(blocks1[0].content_hash, blocks2[0].content_hash);
    }

    #[test]
    fn test_parse_cloze_card() {
        let content = "The register ==%rax== holds the return value. ^e3d2c1\n";
        let tags = vec!["cs".to_string()];
        let blocks = parse_markdown_blocks(content, &tags);
        assert_eq!(blocks.len(), 1);

        let b = &blocks[0];
        assert_eq!(b.card_type, CardType::Cloze);
        assert_eq!(b.block_id, "e3d2c1");
        assert_eq!(b.front_raw, "The register ==%rax== holds the return value.");
    }

    #[test]
    fn test_parse_cloze_card_without_block_id() {
        let content = "The capital of France is ==Paris==.\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);

        let b = &blocks[0];
        assert_eq!(b.card_type, CardType::Cloze);
        assert_eq!(b.block_id, "");
        assert_eq!(b.front_raw, "The capital of France is ==Paris==.");
    }

    #[test]
    fn test_parse_cloze_with_colons_inside_highlight() {
        let content = "The C++ namespace is ==std::vector== ^123456\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].card_type, CardType::Cloze);
        assert_eq!(blocks[0].block_id, "123456");
        assert_eq!(blocks[0].front_raw, "The C++ namespace is ==std::vector==");
    }

    #[test]
    fn test_parse_inline_with_highlights_in_question() {
        let content = "What is ==const== in Rust? :: A constant declaration ^123456\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].card_type, CardType::InlineForward);
        assert_eq!(blocks[0].front_raw, "What is ==const== in Rust?");
        assert_eq!(blocks[0].back_raw, "A constant declaration");
    }

    #[test]
    fn test_parse_math_expressions_without_misreading_exponent() {
        let content_without_id = "Energy formula :: E = mc^2\n";
        let blocks = parse_markdown_blocks(content_without_id, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Energy formula");
        assert_eq!(blocks[0].back_raw, "E = mc^2");
        assert_eq!(blocks[0].block_id, ""); // No trailing block ID, exponent preserved!

        let content_with_id = "Energy formula :: E = mc^2 ^8a1b2c\n";
        let blocks_with_id = parse_markdown_blocks(content_with_id, &[]);
        assert_eq!(blocks_with_id.len(), 1);
        assert_eq!(blocks_with_id[0].front_raw, "Energy formula");
        assert_eq!(blocks_with_id[0].back_raw, "E = mc^2");
        assert_eq!(blocks_with_id[0].block_id, "8a1b2c");
    }

    #[test]
    fn test_reject_unclosed_block_card() {
        let content = r#"
%% card-start id=37066d direction=both %%
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
        assert_eq!(blocks[0].front_raw, "Later question");
        assert_eq!(blocks[0].back_raw, "Later answer");
    }

    #[test]
    fn test_invalid_trailing_caret_token_remains_card_content() {
        let content = "Question :: Answer ^beta\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].back_raw, "Answer ^beta");
        assert_eq!(blocks[0].block_id, "");
    }

    #[test]
    fn test_extract_tag_from_block_header() {
        let content = r#"
%% card-start id=37066d direction=forward #todo/card %%
Question here
...
Answer here
%% card-end %%
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].tags.contains(&"todo/card".to_string()));
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
        assert_eq!(blocks[0].front_raw, "Valid Question");
        assert_eq!(blocks[0].back_raw, "Valid Answer");
        assert_eq!(blocks[0].block_id, "8a1b2c");
    }

    #[test]
    fn test_block_code_does_not_close_block_card_early() {
        let content = r#"%% card-start id=37066d direction=forward %%
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
        assert!(blocks[0].back_raw.contains("%% card-end %%"));
        assert!(blocks[0].back_raw.contains("Answer"));
    }

    #[test]
    fn test_double_backtick_code_span_is_not_a_cloze() {
        let content = "This is code: ``a == b``.\n";
        assert!(parse_markdown_blocks(content, &[]).is_empty());
    }

    #[test]
    fn test_ignore_tables() {
        let content = r#"
| Function | Description |
| --- | --- |
| std::vector::push_back | Append element |
| `std::map` | Key :: Value store |
| ==highlighted item== | Details |

Real Question :: Real Answer ^123456
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Real Question");
        assert_eq!(blocks[0].back_raw, "Real Answer");
    }

    #[test]
    fn test_ignore_blockquotes() {
        let content = r#"
> This is a quote with std::string::c_str and ==cloze== highlight
> Another quote line :: not a card

Card Question :: Card Answer ^654321
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Card Question");
        assert_eq!(blocks[0].back_raw, "Card Answer");
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
        assert_eq!(blocks[0].front_raw, "What is the capital of Japan?");
        assert_eq!(blocks[0].back_raw, "Tokyo");
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
        assert_eq!(blocks[0].front_raw, "Math Question");
        assert_eq!(blocks[0].back_raw, "Answer");
    }

    #[test]
    fn test_inline_code_inside_card_question() {
        let content = "What does `std::cmp::Ordering` do? :: Compares values ^aabbcc\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "What does `std::cmp::Ordering` do?");
        assert_eq!(blocks[0].back_raw, "Compares values");
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
زمین سورج دے گرد ==چکر== کٹدی اے۔ ^d3e2f1
"#;
        let blocks = parse_markdown_blocks(content, &["پنجابی".to_string()]);
        assert_eq!(blocks.len(), 3);

        // 1. Bidirectional card
        assert_eq!(blocks[0].card_type, CardType::InlineBoth);
        assert_eq!(blocks[0].front_raw, "پانی");
        assert_eq!(blocks[0].back_raw, "Water #ذخیرہ");
        assert_eq!(blocks[0].block_id, "8a1b2c");
        assert!(blocks[0].tags.contains(&"پنجابی".to_string()));
        assert!(blocks[0].tags.contains(&"ذخیرہ".to_string()));

        // 2. Forward card
        assert_eq!(blocks[1].card_type, CardType::InlineForward);
        assert_eq!(blocks[1].front_raw, "سورج");
        assert_eq!(blocks[1].back_raw, "Sun");
        assert_eq!(blocks[1].block_id, "c9f4d1");

        // 3. Cloze card
        assert_eq!(blocks[2].card_type, CardType::Cloze);
        assert_eq!(blocks[2].front_raw, "زمین سورج دے گرد ==چکر== کٹدی اے۔");
        assert_eq!(blocks[2].block_id, "d3e2f1");
    }

    #[test]
    fn test_equality_operators_in_inline_code_are_not_clozes() {
        let content = "In JavaScript, `a == 1` and `b == 2` check equality.\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert!(blocks.is_empty());
    }

    #[test]
    fn test_code_equality_does_not_corrupt_inline_card_state() {
        let content = "Code if (`x == y`) :: Check equality ^abc123\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Code if (`x == y`)");
        assert_eq!(blocks[0].back_raw, "Check equality");
        assert_eq!(blocks[0].block_id, "abc123");
    }

    #[test]
    fn test_equality_operators_in_inline_math_are_not_clozes() {
        let content = "Logic uses $a == b$ and $c == d$.\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert!(blocks.is_empty());
    }

    #[test]
    fn test_math_separator_does_not_split_a_card() {
        let content = "Math $x :: y$ is valid :: Valid answer ^abc123\n";
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Math $x :: y$ is valid");
        assert_eq!(blocks[0].back_raw, "Valid answer");
    }

    #[test]
    fn test_block_card_markers_inside_fenced_code_are_ignored() {
        let content = r#"
```markdown
%% card-start id=abc123 direction=both %%
Fake question
...
Fake answer
%% card-end %%
```

Real question :: Real answer ^def456
"#;
        let blocks = parse_markdown_blocks(content, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].front_raw, "Real question");
        assert_eq!(blocks[0].back_raw, "Real answer");
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
        assert_eq!(blocks[0].front_raw, "Real question");
    }
