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

/// Deterministic 64-bit FNV-1a hash formatted as hex
pub fn compute_content_hash(text: &str) -> String {
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
pub fn extract_inline_tags(text: &str) -> Vec<String> {
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

fn add_tags(tags: &mut Vec<String>, new_tags: Vec<String>) {
    for tag in new_tags {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
}

pub fn parse_block_header(line: &str) -> Option<(String, bool)> {
    let inner = line.strip_prefix("%%")?.strip_suffix("%%")?.trim();
    let mut parts = inner.split_whitespace();
    if parts.next()? != "card-start" {
        return None;
    }

    let mut block_id = String::new();
    let mut reversible = false;
    for part in parts {
        if let Some((key, value)) = part.split_once('=') {
            match key {
                "id" if syntax::is_valid_block_id(value) => block_id = value.to_string(),
                "reversible" => {
                    reversible = value == "true" || value == "1";
                }
                "direction" => {
                    reversible = value == "both";
                }
                _ => {}
            }
        } else if part == "reversible" {
            reversible = true;
        }
    }

    Some((block_id, reversible))
}

fn rewrite_block_header(original_line: &str, new_id: &str) -> String {
    let leading = &original_line[..original_line.len() - original_line.trim_start().len()];
    let trimmed = original_line.trim();
    let Some(inner) = trimmed
        .strip_prefix("%%")
        .and_then(|s| s.strip_suffix("%%"))
    else {
        return format!("{leading}%% card-start id={new_id} %%");
    };

    let inner = inner.trim();
    let mut parts: Vec<String> = inner.split_whitespace().map(|s| s.to_string()).collect();
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
    let leading = &original_line[..original_line.len() - original_line.trim_start().len()];
    let body = raw_line_without_id.trim();
    format!("{leading}{body} ^{new_id}")
}

fn parse_block_card(
    lines: &[&str],
    start_line: usize,
    header_line: &str,
    block_id: String,
    reversible: bool,
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
    for line in content_lines {
        add_tags(&mut tags, extract_inline_tags(line));
    }

    let content_hash = compute_content_hash(&format!("block:{reversible}:{front}:{back}"));
    Some((
        ParsedBlock {
            id: block_id,
            block_type: CardBlockType::Block,
            reversible,
            front,
            back,
            tags,
            content_hash,
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
    let front = front.trim();
    let back = back.trim();
    if front.is_empty() || back.is_empty() {
        return None;
    }

    let mut tags = note_inherited_tags.to_vec();
    add_tags(&mut tags, extract_inline_tags(raw_line));
    let content_hash = compute_content_hash(&format!("inline:{reversible}:{front}:{back}"));
    Some(ParsedBlock {
        id: block_id,
        block_type: CardBlockType::Inline,
        reversible,
        front: front.to_string(),
        back: back.to_string(),
        tags,
        content_hash,
        line_start: line_number,
        line_end: line_number,
    })
}

/// Parse all flashcard blocks from a note's markdown content (without modifying the note).
pub fn parse_markdown_blocks(content: &str, note_inherited_tags: &[String]) -> Vec<ParsedBlock> {
    parse_markdown_blocks_with_sections(content, note_inherited_tags, &[])
}

/// Parse flashcards with block-level ranges observed by Obsidian (without modifying the note).
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

        if let Some((block_id, reversible)) = parse_block_header(logical_line) {
            if let Some((block, end_line)) = parse_block_card(
                &lines,
                line_number,
                logical_line,
                block_id,
                reversible,
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

        if !cloze_scan.spans.is_empty() {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            let front = raw_line.trim().to_string();
            let content_hash = compute_content_hash(&format!("cloze:{front}"));
            blocks.push(ParsedBlock {
                id: block_id,
                block_type: CardBlockType::Cloze,
                reversible: false,
                front,
                back: String::new(),
                tags,
                content_hash,
                line_start: line_number,
                line_end: line_number,
            });
        }

        line_number += 1;
    }

    blocks
}

/// Single-pass note document transformer:
/// Parses cards, validates block IDs against `external_ids` (claimed by other files),
/// mints fresh 6-character lowercase base-36 IDs for missing or colliding blocks,
/// and rebuilds the note content.
pub fn sync_document(
    content: &str,
    external_ids: &HashSet<String>,
    note_inherited_tags: &[String],
    section_hints: &[ObsidianSectionHint],
) -> DocumentSyncResult {
    let raw_lines: Vec<&str> = content.lines().collect();
    let context = MarkdownContext::new(content, raw_lines.len(), section_hints);
    let mut out_lines: Vec<String> = raw_lines.iter().map(|s| s.to_string()).collect();
    let mut used_ids: HashSet<String> = HashSet::new();
    let mut all_known_ids: HashSet<String> = external_ids.clone();
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
        let leading_whitespace = line.len() - line.trim_start().len();
        let logical_line = line.trim_start().trim_end();
        let logical_start = line_start + leading_whitespace;

        if let Some((raw_block_id, reversible)) = parse_block_header(logical_line) {
            if let Some((mut block, end_line)) = parse_block_card(
                &raw_lines,
                line_number,
                logical_line,
                raw_block_id.clone(),
                reversible,
                note_inherited_tags,
                &context,
            ) {
                let id = if !raw_block_id.is_empty()
                    && syntax::is_valid_block_id(&raw_block_id)
                    && !external_ids.contains(&raw_block_id)
                    && !used_ids.contains(&raw_block_id)
                {
                    used_ids.insert(raw_block_id.clone());
                    all_known_ids.insert(raw_block_id.clone());
                    raw_block_id
                } else {
                    let new_id = syntax::generate_unique_block_id(&all_known_ids);
                    used_ids.insert(new_id.clone());
                    all_known_ids.insert(new_id.clone());
                    out_lines[line_number] = rewrite_block_header(&out_lines[line_number], &new_id);
                    modified = true;
                    new_id
                };

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
            let id = if !raw_block_id.is_empty()
                && syntax::is_valid_block_id(&raw_block_id)
                && !external_ids.contains(&raw_block_id)
                && !used_ids.contains(&raw_block_id)
            {
                used_ids.insert(raw_block_id.clone());
                all_known_ids.insert(raw_block_id.clone());
                raw_block_id
            } else {
                let new_id = syntax::generate_unique_block_id(&all_known_ids);
                used_ids.insert(new_id.clone());
                all_known_ids.insert(new_id.clone());
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &new_id);
                modified = true;
                new_id
            };

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
            let id = if !raw_block_id.is_empty()
                && syntax::is_valid_block_id(&raw_block_id)
                && !external_ids.contains(&raw_block_id)
                && !used_ids.contains(&raw_block_id)
            {
                used_ids.insert(raw_block_id.clone());
                all_known_ids.insert(raw_block_id.clone());
                raw_block_id
            } else {
                let new_id = syntax::generate_unique_block_id(&all_known_ids);
                used_ids.insert(new_id.clone());
                all_known_ids.insert(new_id.clone());
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &new_id);
                modified = true;
                new_id
            };

            block.id = id;
            blocks.push(block);
            line_number += 1;
            continue;
        }

        if !cloze_scan.spans.is_empty() {
            let mut tags = note_inherited_tags.to_vec();
            add_tags(&mut tags, extract_inline_tags(raw_line));
            let front = raw_line.trim().to_string();
            let content_hash = compute_content_hash(&format!("cloze:{front}"));

            let id = if !raw_block_id.is_empty()
                && syntax::is_valid_block_id(&raw_block_id)
                && !external_ids.contains(&raw_block_id)
                && !used_ids.contains(&raw_block_id)
            {
                used_ids.insert(raw_block_id.clone());
                all_known_ids.insert(raw_block_id.clone());
                raw_block_id
            } else {
                let new_id = syntax::generate_unique_block_id(&all_known_ids);
                used_ids.insert(new_id.clone());
                all_known_ids.insert(new_id.clone());
                out_lines[line_number] =
                    rewrite_inline_or_cloze_line(raw_lines[line_number], raw_line, &new_id);
                modified = true;
                new_id
            };

            blocks.push(ParsedBlock {
                id,
                block_type: CardBlockType::Cloze,
                reversible: false,
                front,
                back: String::new(),
                tags,
                content_hash,
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

#[cfg(test)]
mod tests {
    include!("parser_tests.rs");
}
