use std::collections::HashSet;
use std::ops::Range;

use super::markdown::MarkdownContext;

const BASE36_CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Check if a block ID is exactly 6 lowercase base-36 characters ([0-9a-z]).
pub fn is_valid_block_id(id: &str) -> bool {
    id.len() == 6
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

/// Generate a fresh 6-character lowercase base-36 string ([0-9a-z]).
pub fn gen_base36_len6() -> String {
    let mut bytes = [0u8; 6];
    if getrandom::fill(&mut bytes).is_err() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEED: AtomicU64 = AtomicU64::new(0x853c49e6748fea9b);
        let val = SEED.fetch_add(0x9e3779b97f4a7c15, Ordering::Relaxed);
        let be = val.to_be_bytes();
        bytes.copy_from_slice(&be[..6]);
    }
    let mut result = String::with_capacity(6);
    for b in bytes {
        result.push(BASE36_CHARS[(b as usize) % 36] as char);
    }
    result
}

/// Generate a unique 6-character lowercase base-36 block ID that does not collide with existing_ids.
pub fn generate_unique_block_id(existing_ids: &HashSet<String>) -> String {
    loop {
        let id = gen_base36_len6();
        if !existing_ids.contains(&id) {
            return id;
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct ClozeScan {
    pub(crate) spans: Vec<Range<usize>>,
}

/// Find valid cloze spans using `{{...}}` syntax and the Markdown source mask.
/// `{{...}}` inside an inline code or math event is therefore never considered a cloze marker.
pub(crate) fn scan_clozes(line: &str, base_offset: usize, context: &MarkdownContext) -> ClozeScan {
    let mut markers = Vec::new();
    let mut index = 0;
    while index < line.len() {
        if line[index..].starts_with("{{")
            && context.is_eligible(base_offset + index..base_offset + index + 2)
        {
            markers.push((index, 0)); // 0 = open '{{'
            index += 2;
            continue;
        }
        if line[index..].starts_with("}}")
            && context.is_eligible(base_offset + index..base_offset + index + 2)
        {
            markers.push((index, 1)); // 1 = close '}}'
            index += 2;
            continue;
        }

        let Some(character) = line[index..].chars().next() else {
            break;
        };
        index += character.len_utf8();
    }

    let mut spans = Vec::new();
    let mut i = 0;
    while i < markers.len() {
        if markers[i].1 == 0 {
            // Find the earliest matching '}}' after this '{{'
            let mut j = i + 1;
            while j < markers.len() && markers[j].1 != 1 {
                j += 1;
            }
            if j < markers.len() && markers[j].1 == 1 {
                let start = markers[i].0;
                let end = markers[j].0;
                if end > start + 2 && !line[start + 2..end].trim().is_empty() {
                    spans.push(start..end + 2);
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }

    ClozeScan { spans }
}

pub(crate) fn split_once_outside_clozes<'a>(
    line: &'a str,
    base_offset: usize,
    separator: &str,
    context: &MarkdownContext,
    cloze_spans: &[Range<usize>],
) -> Option<(&'a str, &'a str)> {
    for (index, _) in line.char_indices() {
        if separator == "::" && line[index..].starts_with(":::") {
            continue;
        }
        if !line[index..].starts_with(separator) {
            continue;
        }

        let separator_end = index + separator.len();
        if !context.is_eligible(base_offset + index..base_offset + separator_end)
            || is_inside_brackets(&line[..index])
            || cloze_spans
                .iter()
                .any(|span| span.start <= index && index < span.end)
        {
            continue;
        }

        return Some((&line[..index], &line[separator_end..]));
    }
    None
}

fn is_inside_brackets(prefix: &str) -> bool {
    let mut depth = 0isize;
    for c in prefix.chars() {
        if c == '[' {
            depth += 1;
        } else if c == ']' {
            depth = (depth - 1).max(0);
        }
    }
    depth > 0
}

/// Extract a trailing 6-character lowercase base-36 block ID only when
/// the ID itself belongs to ordinary Markdown text.
pub(crate) fn split_trailing_block_id<'a>(
    line: &'a str,
    _base_offset: usize,
    _context: &MarkdownContext,
) -> (&'a str, String) {
    let trimmed_end = line.trim_end();
    let Some(position) = trimmed_end.rfind(" ^") else {
        return (trimmed_end, String::new());
    };

    let id_start = position + 2;
    let id_part = &trimmed_end[id_start..];
    let id = id_part.trim();
    if !is_valid_block_id(id) {
        return (trimmed_end, String::new());
    }

    (trimmed_end[..position].trim_end(), id.to_string())
}
