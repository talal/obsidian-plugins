use std::ops::Range;

use super::markdown::MarkdownContext;

#[derive(Debug, Default)]
pub(crate) struct ClozeScan {
    pub(crate) spans: Vec<Range<usize>>,
}

/// Find valid cloze spans using the Markdown source mask. `==` inside an
/// inline code or math event is therefore never considered a cloze marker.
pub(crate) fn scan_clozes(line: &str, base_offset: usize, context: &MarkdownContext) -> ClozeScan {
    let mut markers = Vec::new();
    let mut index = 0;
    while index < line.len() {
        if line[index..].starts_with("==")
            && context.is_eligible(base_offset + index..base_offset + index + 2)
        {
            markers.push(index);
            index += 2;
            continue;
        }

        let Some(character) = line[index..].chars().next() else {
            break;
        };
        index += character.len_utf8();
    }

    let mut spans = Vec::new();
    for pair in markers.chunks_exact(2) {
        let start = pair[0];
        let end = pair[1];
        if end > start + 2 && !line[start + 2..end].trim().is_empty() {
            spans.push(start..end + 2);
        }
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

/// Extract a trailing six-character lowercase hexadecimal block ID only when
/// the ID itself belongs to ordinary Markdown text.
pub(crate) fn split_trailing_block_id<'a>(
    line: &'a str,
    base_offset: usize,
    context: &MarkdownContext,
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

    let Some(id_offset) = id_part.find(id) else {
        return (trimmed_end, String::new());
    };
    let id_start = id_start + id_offset;
    let id_end = id_start + id.len();
    if !context.is_eligible(base_offset + position..base_offset + id_end) {
        return (trimmed_end, String::new());
    }

    (trimmed_end[..position].trim_end(), id.to_string())
}

pub(crate) fn is_valid_block_id(id: &str) -> bool {
    id.len() == 6
        && id
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}
