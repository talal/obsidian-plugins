use std::collections::HashSet;
use std::ops::Range;

use super::markdown::MarkdownContext;

const BASE36_CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Check if a character is a BiDi control, zero-width, or formatting mark.
pub fn is_bidi_or_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200E}' // LRM (Left-to-Right Mark)
        | '\u{200F}' // RLM (Right-to-Left Mark)
        | '\u{061C}' // ALM (Arabic Letter Mark)
        | '\u{202A}'..='\u{202E}' // LRE, RLE, PDF, LRO, RLO
        | '\u{2066}'..='\u{2069}' // LRI, RLI, FSI, PDI
        | '\u{200B}' // ZWSP (Zero Width Space)
        | '\u{200C}' // ZWNJ (Zero Width Non-Joiner)
        | '\u{200D}' // ZWJ (Zero Width Joiner)
        | '\u{2060}' // WJ (Word Joiner)
        | '\u{FEFF}' // BOM (Byte Order Mark)
    )
}

/// Check if a character is whitespace or an invisible/BiDi mark.
pub fn is_whitespace_or_invisible(c: char) -> bool {
    c.is_whitespace() || is_bidi_or_invisible(c)
}

/// Trim leading and trailing whitespace and invisible/BiDi marks.
pub fn trim_whitespace_and_invisible(s: &str) -> &str {
    s.trim_matches(is_whitespace_or_invisible)
}

/// Trim leading whitespace and invisible/BiDi marks.
pub fn trim_start_whitespace_and_invisible(s: &str) -> &str {
    s.trim_start_matches(is_whitespace_or_invisible)
}

/// Trim trailing whitespace and invisible/BiDi marks.
pub fn trim_end_whitespace_and_invisible(s: &str) -> &str {
    s.trim_end_matches(is_whitespace_or_invisible)
}

/// Check if a block ID is exactly 6 lowercase base-36 characters ([0-9a-z]).
pub fn is_valid_block_id(id: &str) -> bool {
    let clean = trim_whitespace_and_invisible(id);
    clean.len() == 6
        && clean
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

pub(crate) fn is_inside_brackets(prefix: &str, initial_depth: usize) -> bool {
    let mut square_depth = initial_depth as isize;
    let mut paren_depth = 0isize;
    for c in prefix.chars() {
        if c == '[' {
            square_depth += 1;
        } else if c == ']' {
            square_depth = (square_depth - 1).max(0);
        } else if c == '(' {
            paren_depth += 1;
        } else if c == ')' {
            paren_depth = (paren_depth - 1).max(0);
        }
    }
    square_depth > 0 || paren_depth > 0
}

pub(crate) fn has_unmatched_closing_bracket(suffix: &str) -> bool {
    let mut square_depth = 0isize;
    let mut paren_depth = 0isize;
    for c in suffix.chars() {
        if c == '[' {
            square_depth += 1;
        } else if c == ']' {
            square_depth -= 1;
            if square_depth < 0 {
                return true;
            }
        } else if c == '(' {
            paren_depth += 1;
        } else if c == ')' {
            paren_depth -= 1;
            if paren_depth < 0 {
                return true;
            }
        }
    }
    false
}

pub(crate) fn has_unmatched_opening_bracket(s: &str) -> bool {
    let mut square_depth = 0isize;
    let mut paren_depth = 0isize;
    for c in s.chars() {
        if c == '[' {
            square_depth += 1;
        } else if c == ']' {
            square_depth = (square_depth - 1).max(0);
        } else if c == '(' {
            paren_depth += 1;
        } else if c == ')' {
            paren_depth = (paren_depth - 1).max(0);
        }
    }
    square_depth > 0 || paren_depth > 0
}

pub(crate) fn bracket_depth_delta(line: &str) -> isize {
    let mut delta = 0isize;
    for c in line.chars() {
        if c == '[' || c == '(' {
            delta += 1;
        } else if c == ']' || c == ')' {
            delta -= 1;
        }
    }
    delta
}

pub(crate) fn split_once_outside_clozes<'a>(
    line: &'a str,
    base_offset: usize,
    separator: &str,
    context: &MarkdownContext,
    cloze_spans: &[Range<usize>],
    initial_bracket_depth: usize,
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
            || is_inside_brackets(&line[..index], initial_bracket_depth)
            || has_unmatched_closing_bracket(&line[separator_end..])
            || has_unmatched_opening_bracket(&line[separator_end..])
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

/// Extract a trailing 6-character lowercase base-36 block ID from the end of a line.
pub(crate) fn split_trailing_block_id<'a>(
    line: &'a str,
    base_offset: usize,
    context: &MarkdownContext,
) -> (&'a str, String) {
    let trimmed_end = trim_end_whitespace_and_invisible(line);
    let Some(caret_pos) = trimmed_end.rfind('^') else {
        return (trimmed_end, String::new());
    };

    let id_part = trim_whitespace_and_invisible(&trimmed_end[caret_pos + 1..]);
    if !is_valid_block_id(id_part) {
        return (trimmed_end, String::new());
    }

    let prefix = &trimmed_end[..caret_pos];
    // Block ID must be preceded by whitespace, bidi marker, or start of line
    if caret_pos > 0 && !prefix.ends_with(is_whitespace_or_invisible) {
        return (trimmed_end, String::new());
    }

    let byte_pos = base_offset + caret_pos;
    if !context.is_eligible(byte_pos..byte_pos + 1 + id_part.len()) {
        return (trimmed_end, String::new());
    }

    (
        trim_end_whitespace_and_invisible(prefix),
        id_part.to_string(),
    )
}

pub(crate) fn has_unclosed_inline_code(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            let run_len = i - start;
            let mut found_closing = false;
            while i < bytes.len() {
                if bytes[i] == b'`' {
                    let close_start = i;
                    while i < bytes.len() && bytes[i] == b'`' {
                        i += 1;
                    }
                    let close_run_len = i - close_start;
                    if close_run_len == run_len {
                        found_closing = true;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            if !found_closing {
                return true;
            }
        } else {
            i += 1;
        }
    }
    false
}
