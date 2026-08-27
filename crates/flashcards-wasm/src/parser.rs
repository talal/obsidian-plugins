#[path = "markdown.rs"]
mod markdown;
#[path = "syntax.rs"]
mod syntax;

use crate::types::{CardDirection, CardType, ParsedBlock};
use markdown::MarkdownContext;
use serde::Deserialize;
use syntax::{scan_clozes, split_once_outside_clozes, split_trailing_block_id};

/// A block-level range supplied by Obsidian's MetadataCache.
///
/// The cache can be unavailable or briefly stale after a file change. The
/// Rust Markdown pass therefore validates the source independently and uses
/// these ranges as additional block-level protection only.
#[derive(Debug, Clone, Deserialize)]
pub struct ObsidianSectionHint {
    #[serde(rename = "type")]
    pub section_type: String,
    pub line_start: usize,
    pub line_end: usize,
}

/// Deterministic 64-bit FNV-1a hash formatted as hex
fn compute_content_hash(text: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

/// Extract inline `#tags` from a string
fn extract_inline_tags(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for word in text.split_whitespace() {
        if word.starts_with('#') && word.len() > 1 {
            let tag = word
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

/// Parse all flashcard blocks from a note's markdown content.
pub fn parse_markdown_blocks(content: &str, note_inherited_tags: &[String]) -> Vec<ParsedBlock> {
    parse_markdown_blocks_with_sections(content, note_inherited_tags, &[])
}

/// Parse flashcards with block-level ranges observed by Obsidian.
pub fn parse_markdown_blocks_with_sections(
    content: &str,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> Vec<ParsedBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let context = MarkdownContext::new(content, lines.len(), section_hints);
    let mut blocks = Vec::new();
    let mut line_number = 0;

    while line_number < lines.len() {
        if context.is_ignored_line(line_number) {
            line_number += 1;
            continue;
        }

        let line = lines[line_number];
        let line_start = context.line_start(line_number);
        let leading_whitespace = line.len() - line.trim_start().len();
        let logical_line = line.trim_start().trim_end();
        let logical_start = line_start + leading_whitespace;

        if let Some((block_id, direction)) = parse_block_header(logical_line) {
            if let Some((block, end_line)) = parse_block_card(
                &lines,
                line_number,
                logical_line,
                block_id,
                direction,
                note_inherited_tags,
                &context,
            ) {
                blocks.push(block);
                line_number = end_line + 1;
            } else {
                // A malformed opener must not swallow later independent cards.
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
                CardType::InlineBoth,
                CardDirection::Both,
                note_inherited_tags,
                InlineCardSource {
                    raw_line,
                    line_number,
                },
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
                CardType::InlineForward,
                CardDirection::Forward,
                note_inherited_tags,
                InlineCardSource {
                    raw_line,
                    line_number,
                },
            )
        {
            blocks.push(block);
            line_number += 1;
            continue;
        }

        if !cloze_scan.spans.is_empty() {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            blocks.push(ParsedBlock {
                block_id,
                card_type: CardType::Cloze,
                direction: CardDirection::Forward,
                front_raw: raw_line.to_string(),
                back_raw: raw_line.to_string(),
                tags,
                content_hash: compute_content_hash(raw_line),
                line_start: line_number,
                line_end: line_number,
            });
        }

        line_number += 1;
    }

    blocks
}

fn parse_block_header(line: &str) -> Option<(String, CardDirection)> {
    let inner = line.strip_prefix("%%")?.strip_suffix("%%")?.trim();
    let mut parts = inner.split_whitespace();
    if parts.next()? != "card-start" {
        return None;
    }

    let mut block_id = String::new();
    let mut direction = CardDirection::Forward;
    for part in parts {
        if let Some((key, value)) = part.split_once('=') {
            match key {
                "id" if syntax::is_valid_block_id(value) => block_id = value.to_string(),
                "direction" => {
                    direction = match value {
                        "both" => CardDirection::Both,
                        "reverse" => CardDirection::Reverse,
                        _ => CardDirection::Forward,
                    };
                }
                _ => {}
            }
        }
    }

    Some((block_id, direction))
}

fn parse_block_card(
    lines: &[&str],
    start_line: usize,
    header_line: &str,
    block_id: String,
    direction: CardDirection,
    note_inherited_tags: &[String],
    context: &MarkdownContext,
) -> Option<(ParsedBlock, usize)> {
    let end_line = ((start_line + 1)..lines.len()).find(|line| {
        if context.is_ignored_line(*line) {
            return false;
        }
        let candidate = lines[*line].trim();
        candidate
            .strip_prefix("%%")
            .and_then(|value| value.strip_suffix("%%"))
            .is_some_and(|value| value.trim() == "card-end")
    })?;

    let content_lines = &lines[start_line + 1..end_line];
    let block_raw = content_lines.join("\n");
    let mut front = String::new();
    let mut back = String::new();
    let mut is_back = false;

    for line in content_lines {
        let trimmed = line.trim();
        if !is_back && (trimmed == "..." || trimmed == ". . .") {
            is_back = true;
            continue;
        }
        let target = if is_back { &mut back } else { &mut front };
        if !target.is_empty() {
            target.push('\n');
        }
        target.push_str(line);
    }

    let front = front.trim().to_string();
    let back = back.trim().to_string();
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(header_line));
    add_tags(&mut tags, extract_inline_tags(&block_raw));

    let content_hash = compute_content_hash(&format!("{header_line}\n{block_raw}"));
    Some((
        ParsedBlock {
            block_id,
            card_type: CardType::Block,
            direction,
            front_raw: front,
            back_raw: back,
            tags,
            content_hash,
            line_start: start_line,
            line_end: end_line,
        },
        end_line,
    ))
}

struct InlineCardSource<'a> {
    raw_line: &'a str,
    line_number: usize,
}

fn make_inline_block(
    front: &str,
    back: &str,
    block_id: String,
    card_type: CardType,
    direction: CardDirection,
    note_inherited_tags: &[String],
    source: InlineCardSource<'_>,
) -> Option<ParsedBlock> {
    let front = front.trim();
    let back = back.trim();
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(source.raw_line));
    Some(ParsedBlock {
        block_id,
        card_type,
        direction,
        front_raw: front.to_string(),
        back_raw: back.to_string(),
        tags,
        content_hash: compute_content_hash(source.raw_line),
        line_start: source.line_number,
        line_end: source.line_number,
    })
}

fn add_tags(tags: &mut Vec<String>, new_tags: Vec<String>) {
    for tag in new_tags {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
}

#[cfg(test)]
mod tests {
    include!("parser_tests.rs");
}
