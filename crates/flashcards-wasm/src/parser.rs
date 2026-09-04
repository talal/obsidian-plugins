#[path = "markdown.rs"]
mod markdown;
#[path = "syntax.rs"]
pub mod syntax;

use std::collections::HashSet;

use crate::types::{CardBlockType, DocumentSyncResult, ParsedBlock};
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
) -> Option<(ParsedBlock, usize)> {
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
        ParsedBlock {
            id: block_id,
            block_type: CardBlockType::Block,
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

fn make_inline_block(
    front: &str,
    back: &str,
    block_id: String,
    reversible: bool,
    note_inherited_tags: &[String],
    raw_line: &str,
    line_number: usize,
) -> Option<ParsedBlock> {
    let front = syntax::trim_whitespace_and_invisible(front);
    let back = syntax::trim_whitespace_and_invisible(back);
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(raw_line));
    Some(ParsedBlock {
        id: block_id,
        block_type: CardBlockType::Inline,
        reversible,
        front: front.to_string(),
        back: back.to_string(),
        tags,
        line_start: line_number,
        line_end: line_number,
    })
}

/// Parse all flashcard blocks from a note's markdown content (without modifying the note).
pub fn parse_markdown_blocks(content: &str, note_inherited_tags: &[String]) -> Vec<ParsedBlock> {
    parse_markdown_blocks_with_sections(content, note_inherited_tags, &[])
}

fn normalize_newlines(content: &str) -> std::borrow::Cow<'_, str> {
    if !content.contains('\r') {
        std::borrow::Cow::Borrowed(content)
    } else {
        std::borrow::Cow::Owned(content.replace("\r\n", "\n").replace('\r', "\n"))
    }
}

/// Parse flashcards with block-level ranges observed by Obsidian (without modifying the note).
pub fn parse_markdown_blocks_with_sections(
    content: &str,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> Vec<ParsedBlock> {
    let normalized = normalize_newlines(content);
    let lines: Vec<&str> = normalized.lines().collect();
    let context = MarkdownContext::new(&normalized, lines.len(), section_hints);
    let mut blocks = Vec::new();
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

        if let Some(block_id) = parse_block_header(logical_line) {
            if let Some((block, end_line)) = parse_block_card(
                &lines,
                line_number,
                logical_line,
                block_id,
                note_inherited_tags,
                &context,
            ) {
                blocks.push(block);
                line_number = end_line + 1;
            } else {
                line_number += 1;
            }
            continue;
        }

        let (raw_line, block_id) = split_trailing_block_id(logical_line, logical_start, &context);
        let cloze_scan = scan_clozes(raw_line, logical_start, &context);

        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, ":::", &context, &cloze_scan.spans)
            && let Some(block) = make_inline_block(
                front,
                back,
                block_id.clone(),
                true,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            blocks.push(block);
            line_number += 1;
            continue;
        }

        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, "::", &context, &cloze_scan.spans)
            && let Some(block) = make_inline_block(
                front,
                back,
                block_id.clone(),
                false,
                note_inherited_tags,
                raw_line,
                line_number,
            )
        {
            blocks.push(block);
            line_number += 1;
            continue;
        }

        if !cloze_scan.spans.is_empty() && !syntax::is_inside_brackets(raw_line) {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            let front = syntax::trim_whitespace_and_invisible(raw_line).to_string();
            blocks.push(ParsedBlock {
                id: block_id,
                block_type: CardBlockType::Cloze,
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

    blocks
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
    let mut blocks = Vec::new();
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

        if let Some(raw_block_id) = parse_block_header(logical_line) {
            if let Some((mut block, end_line)) = parse_block_card(
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

                block.id = id;
                blocks.push(block);
                line_number = end_line + 1;
            } else {
                line_number += 1;
            }
            continue;
        }

        let (raw_line, raw_block_id) =
            split_trailing_block_id(logical_line, logical_start, &context);
        let cloze_scan = scan_clozes(raw_line, logical_start, &context);

        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, ":::", &context, &cloze_scan.spans)
            && let Some(mut block) = make_inline_block(
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

            block.id = id;
            blocks.push(block);
            line_number += 1;
            continue;
        }

        if let Some((front, back)) =
            split_once_outside_clozes(raw_line, logical_start, "::", &context, &cloze_scan.spans)
            && let Some(mut block) = make_inline_block(
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

            block.id = id;
            blocks.push(block);
            line_number += 1;
            continue;
        }

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

            blocks.push(ParsedBlock {
                id,
                block_type: CardBlockType::Cloze,
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
        blocks,
    }
}

/// Single-pass note document transformer (backward-compatible wrapper).
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
