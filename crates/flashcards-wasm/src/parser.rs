#[path = "markdown.rs"]
mod markdown;
#[path = "syntax.rs"]
pub mod syntax;

use std::collections::HashSet;

use crate::types::{CardType, DocumentSyncResult, ParsedPrompt};
use markdown::MarkdownContext;
use serde::Deserialize;
use syntax::{scan_clozes, split_once_outside_clozes, split_trailing_block_id};

/// A block-level range supplied by Obsidian's MetadataCache.
#[derive(Debug, Clone, Deserialize)]
pub struct ObsidianSectionHint {
    #[serde(rename = "type")]
    pub section_type: String,
    pub line_start: usize,
    pub line_end: usize,
}

/// Extract inline `#tags` from a string
pub fn extract_inline_tags(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for word in text.split_whitespace() {
        let clean_word = syntax::trim_whitespace_and_invisible(word);
        if clean_word.starts_with('#') && clean_word.len() > 1 {
            let tag = clean_word
                .trim_start_matches('#')
                .trim_matches(|character: char| {
                    !character.is_alphanumeric()
                        && character != '/'
                        && character != '-'
                        && character != '_'
                });
            if !tag.is_empty() && !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    tags
}

fn add_tags(tags: &mut Vec<String>, new_tags: Vec<String>) {
    for tag in new_tags {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
}

pub fn parse_block_header(line: &str) -> Option<String> {
    let trimmed = syntax::trim_whitespace_and_invisible(line);
    let inner = trimmed.strip_prefix("%%")?.strip_suffix("%%")?;
    let inner = syntax::trim_whitespace_and_invisible(inner);
    let mut parts = inner.split_whitespace();
    let first = syntax::trim_whitespace_and_invisible(parts.next()?);
    if first != "card-start" {
        return None;
    }

    let mut block_id = String::new();
    for part in parts {
        let clean_part = syntax::trim_whitespace_and_invisible(part);
        if let Some((key, value)) = clean_part.split_once('=') {
            let key = syntax::trim_whitespace_and_invisible(key);
            let value = syntax::trim_whitespace_and_invisible(value);
            if key == "id" && syntax::is_valid_block_id(value) {
                block_id = value.to_string();
            }
        }
    }

    Some(block_id)
}

fn rewrite_block_header(original_line: &str, new_id: &str) -> String {
    let leading_len = original_line.len()
        - original_line
            .trim_start_matches(syntax::is_whitespace_or_invisible)
            .len();
    let leading = &original_line[..leading_len];
    let trimmed = syntax::trim_whitespace_and_invisible(original_line);
    let Some(inner) = trimmed
        .strip_prefix("%%")
        .and_then(|s| s.strip_suffix("%%"))
    else {
        return format!("{leading}%% card-start id={new_id} %%");
    };

    let inner = syntax::trim_whitespace_and_invisible(inner);
    let mut parts: Vec<String> = inner
        .split_whitespace()
        .map(|s| syntax::trim_whitespace_and_invisible(s).to_string())
        .collect();
    let mut has_id = false;
    for part in &mut parts {
        if part.starts_with("id=") {
            *part = format!("id={new_id}");
            has_id = true;
            break;
        }
    }

    if !has_id {
        if parts.is_empty() {
            parts.push("card-start".to_string());
        }
        parts.insert(1.min(parts.len()), format!("id={new_id}"));
    }

    format!("{leading}%% {} %%", parts.join(" "))
}

fn rewrite_inline_or_cloze_line(
    original_line: &str,
    raw_line_without_id: &str,
    new_id: &str,
) -> String {
    let leading_len = original_line.len()
        - original_line
            .trim_start_matches(syntax::is_whitespace_or_invisible)
            .len();
    let leading = &original_line[..leading_len];
    let body = syntax::trim_whitespace_and_invisible(raw_line_without_id);
    format!("{leading}{body} ^{new_id}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockDivider {
    Forward,
    Reverse,
}

fn parse_block_divider(line: &str) -> Option<BlockDivider> {
    let trimmed = syntax::trim_whitespace_and_invisible(line);
    match trimmed {
        "::" => Some(BlockDivider::Forward),
        ":::" => Some(BlockDivider::Reverse),
        _ => None,
    }
}

fn is_block_card_end(line: &str) -> bool {
    let trimmed = syntax::trim_whitespace_and_invisible(line);
    trimmed
        .strip_prefix("%%")
        .and_then(|v| v.strip_suffix("%%"))
        .is_some_and(|v| syntax::trim_whitespace_and_invisible(v) == "card-end")
}

fn parse_block_card(
    lines: &[&str],
    start_line: usize,
    header_line: &str,
    block_id: String,
    note_inherited_tags: &[String],
    context: &MarkdownContext,
) -> Option<(ParsedPrompt, usize)> {
    let end_line = ((start_line + 1)..lines.len()).find(|line| {
        if context.is_ignored_line(*line) {
            return false;
        }
        is_block_card_end(lines[*line])
    })?;

    let content_lines = &lines[start_line + 1..end_line];
    let mut front = String::new();
    let mut back = String::new();
    let mut is_back = false;
    let mut reversible = false;

    for line in content_lines {
        if !is_back && let Some(divider) = parse_block_divider(line) {
            is_back = true;
            reversible = divider == BlockDivider::Reverse;
            continue;
        }
        let target = if is_back { &mut back } else { &mut front };
        if !target.is_empty() {
            target.push('\n');
        }
        target.push_str(line);
    }

    if !is_back {
        return None;
    }

    let front = syntax::trim_whitespace_and_invisible(&front).to_string();
    let back = syntax::trim_whitespace_and_invisible(&back).to_string();
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(header_line));
    for line in content_lines {
        add_tags(&mut tags, extract_inline_tags(line));
    }

    Some((
        ParsedPrompt {
            id: block_id,
            card_type: CardType::Multiline,
            reversible,
            front,
            back,
            tags,
            line_start: start_line,
            line_end: end_line,
        },
        end_line,
    ))
}

fn parse_qa_prefix(line: &str, prefix: char) -> Option<&str> {
    let trimmed = syntax::trim_start_whitespace_and_invisible(line);
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if !first.eq_ignore_ascii_case(&prefix) {
        return None;
    }
    let colon = chars.next()?;
    if colon != ':' {
        return None;
    }
    let rest = chars.as_str();
    if rest.starts_with(syntax::is_whitespace_or_invisible) || rest.is_empty() {
        Some(syntax::trim_start_whitespace_and_invisible(rest))
    } else {
        None
    }
}

fn make_inline_prompt(
    front: &str,
    back: &str,
    block_id: String,
    reversible: bool,
    note_inherited_tags: &[String],
    raw_line: &str,
    line_number: usize,
) -> Option<ParsedPrompt> {
    let front = syntax::trim_whitespace_and_invisible(front);
    let back = syntax::trim_whitespace_and_invisible(back);
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(raw_line));
    Some(ParsedPrompt {
        id: block_id,
        card_type: CardType::Inline,
        reversible,
        front: front.to_string(),
        back: back.to_string(),
        tags,
        line_start: line_number,
        line_end: line_number,
    })
}

fn normalize_newlines(content: &str) -> std::borrow::Cow<'_, str> {
    if !content.contains('\r') {
        std::borrow::Cow::Borrowed(content)
    } else {
        std::borrow::Cow::Owned(content.replace("\r\n", "\n").replace('\r', "\n"))
    }
}

/// Parse all flashcard prompts from a note's markdown content (without modifying the note).
pub fn parse_markdown_prompts(
    content: &str,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> Vec<ParsedPrompt> {
    let normalized = normalize_newlines(content);
    let lines: Vec<&str> = normalized.lines().collect();
    let context = MarkdownContext::new(&normalized, lines.len(), section_hints);
    let mut prompts = Vec::new();
    let mut line_number = 0;

    while line_number < lines.len() {
        if context.is_ignored_line(line_number) {
            line_number += 1;
            continue;
        }

        let line = lines[line_number];
        let line_start = context.line_start(line_number);
        let leading_len = line.len()
            - line
                .trim_start_matches(syntax::is_whitespace_or_invisible)
                .len();
        let logical_line = syntax::trim_whitespace_and_invisible(line);
        let logical_start = line_start + leading_len;

        if logical_line.is_empty() {
            line_number += 1;
            continue;
        }

        // 1. Multiline Card: %% card-start %% ... %% card-end %%
        if let Some(block_id) = parse_block_header(logical_line) {
            if let Some((prompt, end_line)) = parse_block_card(
                &lines,
                line_number,
                logical_line,
                block_id,
                note_inherited_tags,
                &context,
            ) {
                prompts.push(prompt);
                line_number = end_line + 1;
            } else {
                line_number += 1;
            }
            continue;
        }

        // 2. Two-line Q/A Card: Q: ... \n A: ...
        if parse_qa_prefix(logical_line, 'Q').is_some()
            && line_number + 1 < lines.len()
            && !context.is_ignored_line(line_number + 1)
        {
            let next_line = lines[line_number + 1];
            let next_logical = syntax::trim_whitespace_and_invisible(next_line);
            if let Some(answer_text) = parse_qa_prefix(next_logical, 'A') {
                let (raw_q_line, block_id) =
                    split_trailing_block_id(logical_line, logical_start, &context);
                let question_text = parse_qa_prefix(raw_q_line, 'Q').unwrap_or(raw_q_line);
                let front = syntax::trim_whitespace_and_invisible(question_text);
                let back = syntax::trim_whitespace_and_invisible(answer_text);

                if !front.is_empty() && !back.is_empty() {
                    let mut tags = note_inherited_tags.to_vec();
                    add_tags(&mut tags, extract_inline_tags(logical_line));
                    add_tags(&mut tags, extract_inline_tags(next_logical));
                    prompts.push(ParsedPrompt {
                        id: block_id,
                        card_type: CardType::Qa,
                        reversible: false,
                        front: front.to_string(),
                        back: back.to_string(),
                        tags,
                        line_start: line_number,
                        line_end: line_number + 1,
                    });
                    line_number += 2;
                    continue;
                }
            }
        }

        let (raw_line, block_id) = split_trailing_block_id(logical_line, logical_start, &context);
        let cloze_scan = scan_clozes(raw_line, logical_start, &context);

        // 3. Inline Reversible Card: Term ::: Definition
        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, ":::", &context, &cloze_scan.spans)
            && let Some(prompt) = make_inline_prompt(
                front,
                back,
                block_id.clone(),
                true,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            prompts.push(prompt);
            line_number += 1;
            continue;
        }

        // 4. Inline Forward Card: Question :: Answer
        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, "::", &context, &cloze_scan.spans)
            && let Some(prompt) = make_inline_prompt(
                front,
                back,
                block_id.clone(),
                false,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            prompts.push(prompt);
            line_number += 1;
            continue;
        }

        // 5. Cloze Card: Sentence with {{cloze}}
        if !cloze_scan.spans.is_empty() && !syntax::is_inside_brackets(raw_line) {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            let front = syntax::trim_whitespace_and_invisible(raw_line).to_string();
            prompts.push(ParsedPrompt {
                id: block_id,
                card_type: CardType::Cloze,
                reversible: false,
                front,
                back: String::new(),
                tags,
                line_start: line_number,
                line_end: line_number,
            });
        }

        line_number += 1;
    }

    prompts
}

fn claim_or_mint_id(
    raw_block_id: &str,
    registry: &mut syntax::CollisionRegistry,
) -> (String, bool) {
    if let Some(id) = syntax::decode_block_id(raw_block_id)
        && registry.insert(id)
    {
        return (syntax::encode_block_id(id), false);
    }
    let new_id = registry.allocate_unique();
    (syntax::encode_block_id(new_id), true)
}

/// Single-pass note document transformer:
/// Parses cards, validates block IDs against `registry`,
/// mints fresh 6-character lowercase base-36 IDs for missing or colliding blocks,
/// and rebuilds the note content.
pub fn sync_document_with_reg(
    content: &str,
    registry: &mut syntax::CollisionRegistry,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> DocumentSyncResult {
    let normalized = normalize_newlines(content);
    let raw_lines: Vec<&str> = normalized.lines().collect();
    let context = MarkdownContext::new(&normalized, raw_lines.len(), section_hints);
    let mut out_lines: Vec<String> = raw_lines.iter().map(|s| s.to_string()).collect();
    let mut prompts = Vec::new();
    let mut modified = false;
    let mut line_number = 0;

    while line_number < raw_lines.len() {
        if context.is_ignored_line(line_number) {
            line_number += 1;
            continue;
        }

        let line = raw_lines[line_number];
        let line_start = context.line_start(line_number);
        let leading_len = line.len()
            - line
                .trim_start_matches(syntax::is_whitespace_or_invisible)
                .len();
        let logical_line = syntax::trim_whitespace_and_invisible(line);
        let logical_start = line_start + leading_len;

        if logical_line.is_empty() {
            line_number += 1;
            continue;
        }

        // 1. Multiline Card
        if let Some(raw_block_id) = parse_block_header(logical_line) {
            if let Some((mut prompt, end_line)) = parse_block_card(
                &raw_lines,
                line_number,
                logical_line,
                raw_block_id.clone(),
                note_inherited_tags,
                &context,
            ) {
                let (id, newly_minted) = claim_or_mint_id(&raw_block_id, registry);
                if newly_minted {
                    out_lines[line_number] = rewrite_block_header(&out_lines[line_number], &id);
                    modified = true;
                }

                prompt.id = id;
                prompts.push(prompt);
                line_number = end_line + 1;
            } else {
                line_number += 1;
            }
            continue;
        }

        // 2. Two-line Q/A Card
        if parse_qa_prefix(logical_line, 'Q').is_some()
            && line_number + 1 < raw_lines.len()
            && !context.is_ignored_line(line_number + 1)
        {
            let next_raw = raw_lines[line_number + 1];
            let next_logical = syntax::trim_whitespace_and_invisible(next_raw);
            if let Some(answer_text) = parse_qa_prefix(next_logical, 'A') {
                let (raw_q_line, raw_block_id) =
                    split_trailing_block_id(logical_line, logical_start, &context);
                let question_text = parse_qa_prefix(raw_q_line, 'Q').unwrap_or(raw_q_line);
                let front = syntax::trim_whitespace_and_invisible(question_text);
                let back = syntax::trim_whitespace_and_invisible(answer_text);

                if !front.is_empty() && !back.is_empty() {
                    let (id, newly_minted) = claim_or_mint_id(&raw_block_id, registry);
                    if newly_minted {
                        out_lines[line_number] =
                            rewrite_inline_or_cloze_line(raw_lines[line_number], raw_q_line, &id);
                        modified = true;
                    }

                    let mut tags = note_inherited_tags.to_vec();
                    add_tags(&mut tags, extract_inline_tags(logical_line));
                    add_tags(&mut tags, extract_inline_tags(next_logical));
                    prompts.push(ParsedPrompt {
                        id,
                        card_type: CardType::Qa,
                        reversible: false,
                        front: front.to_string(),
                        back: back.to_string(),
                        tags,
                        line_start: line_number,
                        line_end: line_number + 1,
                    });
                    line_number += 2;
                    continue;
                }
            }
        }

        let (raw_line, raw_block_id) =
            split_trailing_block_id(logical_line, logical_start, &context);
        let cloze_scan = scan_clozes(raw_line, logical_start, &context);

        // 3. Inline Reversible Card
        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, ":::", &context, &cloze_scan.spans)
            && let Some(mut prompt) = make_inline_prompt(
                front,
                back,
                raw_block_id.clone(),
                true,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            let (id, newly_minted) = claim_or_mint_id(&raw_block_id, registry);
            if newly_minted {
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &id);
                modified = true;
            }

            prompt.id = id;
            prompts.push(prompt);
            line_number += 1;
            continue;
        }

        // 4. Inline Forward Card
        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, "::", &context, &cloze_scan.spans)
            && let Some(mut prompt) = make_inline_prompt(
                front,
                back,
                raw_block_id.clone(),
                false,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            let (id, newly_minted) = claim_or_mint_id(&raw_block_id, registry);
            if newly_minted {
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &id);
                modified = true;
            }

            prompt.id = id;
            prompts.push(prompt);
            line_number += 1;
            continue;
        }

        // 5. Cloze Card
        if !cloze_scan.spans.is_empty() && !syntax::is_inside_brackets(raw_line) {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            let front = syntax::trim_whitespace_and_invisible(raw_line).to_string();

            let (id, newly_minted) = claim_or_mint_id(&raw_block_id, registry);
            if newly_minted {
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &id);
                modified = true;
            }

            prompts.push(ParsedPrompt {
                id,
                card_type: CardType::Cloze,
                reversible: false,
                front,
                back: String::new(),
                tags,
                line_start: line_number,
                line_end: line_number,
            });
        }

        line_number += 1;
    }

    let updated_content = if modified {
        let separator = if content.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut updated = out_lines.join(separator);
        if content.ends_with('\n') || content.ends_with("\r\n") {
            updated.push_str(separator);
        }
        Some(updated)
    } else {
        None
    };

    DocumentSyncResult {
        updated_content,
        prompts,
    }
}

/// Toggles an inline `#tag` (e.g. `#card/todo`, `#card/leech`) on the markdown line containing `prompt_id`.
pub fn toggle_tag_in_content(content: &str, prompt_id: &str, tag: &str) -> Option<String> {
    let clean_id = syntax::trim_whitespace_and_invisible(prompt_id);
    if !syntax::is_valid_block_id(clean_id) {
        return None;
    }
    let norm_tag = if tag.starts_with('#') {
        tag.to_string()
    } else {
        format!("#{tag}")
    };
    let bare_tag = norm_tag.trim_start_matches('#');

    let normalized = normalize_newlines(content);
    let mut lines: Vec<String> = normalized.lines().map(|s| s.to_string()).collect();
    let mut target_line_idx = None;

    let target_block_id = format!("^{clean_id}");
    let target_header_id = format!("id={clean_id}");

    for (idx, line) in lines.iter().enumerate() {
        if line.contains(&target_block_id) || line.contains(&target_header_id) {
            target_line_idx = Some(idx);
            break;
        }
    }

    let line_idx = target_line_idx?;
    let line = &lines[line_idx];
    let tags = extract_inline_tags(line);
    let has_tag = tags.iter().any(|t| t.eq_ignore_ascii_case(bare_tag));

    let updated_line = if has_tag {
        let mut words: Vec<&str> = line.split_whitespace().collect();
        words.retain(|word| {
            let clean = word.trim_matches(|c: char| {
                !c.is_alphanumeric() && c != '/' && c != '-' && c != '_' && c != '#'
            });
            !clean.trim_start_matches('#').eq_ignore_ascii_case(bare_tag)
        });
        let leading_len = line.len()
            - line
                .trim_start_matches(syntax::is_whitespace_or_invisible)
                .len();
        let leading = &line[..leading_len];
        format!("{leading}{}", words.join(" "))
    } else if line.contains(&target_block_id) {
        line.replace(&target_block_id, &format!("{norm_tag} {target_block_id}"))
    } else if line.contains(&target_header_id) {
        if let Some(rpos) = line.rfind("%%") {
            let prefix = line[..rpos].trim_end();
            format!("{prefix} {norm_tag} %%")
        } else {
            format!("{line} {norm_tag}")
        }
    } else {
        format!("{line} {norm_tag}")
    };

    lines[line_idx] = updated_line;
    let separator = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut result = lines.join(separator);
    if content.ends_with('\n') || content.ends_with("\r\n") {
        result.push_str(separator);
    }
    Some(result)
}

/// Adds a tag to the prompt's line in markdown content if not already present.
pub fn add_tag_in_content(content: &str, prompt_id: &str, tag: &str) -> Option<String> {
    let clean_id = syntax::trim_whitespace_and_invisible(prompt_id);
    if !syntax::is_valid_block_id(clean_id) {
        return None;
    }
    let norm_tag = if tag.starts_with('#') {
        tag.to_string()
    } else {
        format!("#{tag}")
    };
    let bare_tag = norm_tag.trim_start_matches('#');

    let normalized = normalize_newlines(content);
    let mut lines: Vec<String> = normalized.lines().map(|s| s.to_string()).collect();
    let mut target_line_idx = None;

    let target_block_id = format!("^{clean_id}");
    let target_header_id = format!("id={clean_id}");

    for (idx, line) in lines.iter().enumerate() {
        if line.contains(&target_block_id) || line.contains(&target_header_id) {
            target_line_idx = Some(idx);
            break;
        }
    }

    let line_idx = target_line_idx?;
    let line = &lines[line_idx];
    let tags = extract_inline_tags(line);
    if tags.iter().any(|t| t.eq_ignore_ascii_case(bare_tag)) {
        return Some(content.to_string());
    }

    let updated_line = if line.contains(&target_block_id) {
        line.replace(&target_block_id, &format!("{norm_tag} {target_block_id}"))
    } else if line.contains(&target_header_id) {
        if let Some(rpos) = line.rfind("%%") {
            let prefix = line[..rpos].trim_end();
            format!("{prefix} {norm_tag} %%")
        } else {
            format!("{line} {norm_tag}")
        }
    } else {
        format!("{line} {norm_tag}")
    };

    lines[line_idx] = updated_line;
    let separator = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut result = lines.join(separator);
    if content.ends_with('\n') || content.ends_with("\r\n") {
        result.push_str(separator);
    }
    Some(result)
}

/// Parse all flashcard prompts from a note's markdown content.
pub fn parse_markdown_blocks(content: &str, note_inherited_tags: &[String]) -> Vec<ParsedPrompt> {
    parse_markdown_prompts(content, note_inherited_tags, &[])
}

/// Parse flashcard prompts with block-level section hints.
pub fn parse_markdown_blocks_with_sections(
    content: &str,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> Vec<ParsedPrompt> {
    parse_markdown_prompts(content, note_inherited_tags, section_hints)
}

/// Synchronize a markdown document against an external ID set.
pub fn sync_document(
    content: &str,
    external_ids: &HashSet<String>,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> DocumentSyncResult {
    let mut registry = syntax::CollisionRegistry::with_capacity(external_ids.len());
    for s in external_ids {
        if let Some(id) = syntax::decode_block_id(s) {
            registry.insert(id);
        }
    }
    sync_document_with_reg(content, &mut registry, note_inherited_tags, section_hints)
}

#[cfg(test)]
mod tests {
    include!("parser_tests.rs");
}
