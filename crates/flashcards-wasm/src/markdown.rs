use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::ops::Range;

use super::ObsidianSectionHint;
use super::syntax;

/// Source-aware Markdown information shared by all card-syntax parsing.
///
/// `eligible` is a byte mask over the original source. Bytes belonging to
/// ordinary Markdown text are eligible for card syntax; code, math, and raw
/// HTML events are not. `ignored_lines` is the block-level guard used before
/// parsing custom multi-line card directives.
pub(crate) struct MarkdownContext {
    line_starts: Vec<usize>,
    eligible: Vec<bool>,
    ignored_lines: Vec<bool>,
}

impl MarkdownContext {
    pub(crate) fn new(
        content: &str,
        total_lines: usize,
        section_hints: &[ObsidianSectionHint],
    ) -> Self {
        let line_starts = line_starts(content);
        let mut context = Self {
            line_starts,
            eligible: vec![false; content.len()],
            ignored_lines: vec![false; total_lines],
        };

        // Obsidian's cache is the app's authoritative block-level view. It can
        // be stale or unavailable, so pulldown-cmark below remains a defensive
        // source-based fallback rather than being replaced by these hints.
        for hint in section_hints {
            if is_ignored_section_type(&hint.section_type) {
                context.mark_line_range(hint.line_start, hint.line_end);
            }
        }

        let options = Options::ENABLE_TABLES
            | Options::ENABLE_GFM
            | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
            | Options::ENABLE_MATH
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_FOOTNOTES;

        let mut protected_depth = 0usize;
        for (event, range) in Parser::new_ext(content, options).into_offset_iter() {
            let source_range = clamp_range(range, content.len());

            match event {
                Event::Start(tag) => {
                    if is_protected_start(&tag) {
                        protected_depth += 1;
                        context.mark_range_lines(&source_range);
                    } else if protected_depth > 0 {
                        context.mark_range_lines(&source_range);
                    }
                }
                Event::End(tag_end) => {
                    if protected_depth > 0 {
                        context.mark_range_lines(&source_range);
                    }
                    if is_protected_end(&tag_end) {
                        protected_depth = protected_depth.saturating_sub(1);
                    }
                }
                Event::Text(_) if protected_depth == 0 => {
                    context.mark_eligible(&source_range);
                }
                Event::DisplayMath(_) => {
                    context.mark_range_lines(&source_range);
                }
                Event::Code(_) | Event::InlineMath(_) => {
                    if content[source_range.clone()].contains('\n') {
                        context.mark_range_lines(&source_range);
                    }
                }
                Event::Html(raw) | Event::InlineHtml(raw) => {
                    if raw.trim_start().starts_with("<!--") {
                        context.mark_range_lines(&source_range);
                    } else if protected_depth == 0 {
                        context.mark_eligible(&source_range);
                    }
                }
                _ if protected_depth > 0 => {
                    context.mark_range_lines(&source_range);
                }
                _ => {}
            }
        }

        // Keep explicit guards for multiline syntax that pulldown-cmark
        // does not natively represent as structured block tags:
        context.mark_frontmatter(content);
        context.mark_display_math(content);
        context.mark_html_comments(content);
        context.mark_link_reference_definitions(content);
        context
    }

    pub(crate) fn line_start(&self, line: usize) -> usize {
        self.line_starts.get(line).copied().unwrap_or_default()
    }

    pub(crate) fn is_ignored_line(&self, line: usize) -> bool {
        self.ignored_lines.get(line).copied().unwrap_or(false)
    }

    pub(crate) fn is_eligible(&self, range: Range<usize>) -> bool {
        if range.start >= range.end || range.end > self.eligible.len() {
            return false;
        }
        self.eligible[range].iter().all(|eligible| *eligible)
    }

    fn mark_eligible(&mut self, range: &Range<usize>) {
        if range.start < range.end && range.end <= self.eligible.len() {
            self.eligible[range.clone()].fill(true);
        }
    }

    fn mark_range_lines(&mut self, range: &Range<usize>) {
        if self.ignored_lines.is_empty() || range.start >= range.end {
            return;
        }

        let start_line = self.offset_to_line(range.start);
        let end_line = self.offset_to_line(range.end.saturating_sub(1));
        self.mark_line_range(start_line, end_line);
    }

    fn mark_line_range(&mut self, start_line: usize, end_line: usize) {
        if start_line >= self.ignored_lines.len() {
            return;
        }
        let end_line = end_line.min(self.ignored_lines.len() - 1);
        if start_line <= end_line {
            self.ignored_lines[start_line..=end_line].fill(true);
        }
    }

    fn offset_to_line(&self, offset: usize) -> usize {
        match self.line_starts.binary_search(&offset) {
            Ok(line) => line,
            Err(line) => line.saturating_sub(1),
        }
    }

    fn mark_frontmatter(&mut self, content: &str) {
        let lines: Vec<&str> = content.lines().collect();
        let Some(first) = lines.first() else {
            return;
        };

        let marker = first.trim();
        if marker != "---" {
            return;
        }

        for (index, line) in lines.iter().enumerate() {
            if index >= self.ignored_lines.len() {
                break;
            }
            self.ignored_lines[index] = true;
            if index > 0 && line.trim() == marker {
                break;
            }
        }
    }

    fn mark_display_math(&mut self, content: &str) {
        let lines: Vec<&str> = content.lines().collect();
        let mut in_math_block = false;
        let mut block_start = 0;

        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("$$") {
                if in_math_block {
                    self.mark_line_range(block_start, index);
                    in_math_block = false;
                } else if rest.is_empty() || !rest.contains("$$") {
                    in_math_block = true;
                    block_start = index;
                }
            }
        }
    }

    fn mark_html_comments(&mut self, content: &str) {
        let lines: Vec<&str> = content.lines().collect();
        let mut in_comment = false;
        let mut comment_start = 0;

        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if !in_comment {
                if trimmed.starts_with("<!--") && !trimmed.contains("-->") {
                    in_comment = true;
                    comment_start = index;
                }
            } else if trimmed.contains("-->") {
                self.mark_line_range(comment_start, index);
                in_comment = false;
            }
        }
    }

    fn mark_link_reference_definitions(&mut self, content: &str) {
        for (index, line) in content.lines().enumerate() {
            if index >= self.ignored_lines.len() {
                break;
            }
            if is_link_reference_definition_start(line) {
                self.ignored_lines[index] = true;
            }
        }
    }
}

fn line_starts(content: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

fn clamp_range(range: Range<usize>, content_len: usize) -> Range<usize> {
    range.start.min(content_len)..range.end.min(content_len)
}

fn is_ignored_section_type(section_type: &str) -> bool {
    matches!(
        section_type,
        "blockquote" | "callout" | "code" | "html" | "table" | "yaml"
    )
}

fn is_protected_start(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::BlockQuote(_)
            | Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::MetadataBlock(_)
            | Tag::Table(_)
            | Tag::FootnoteDefinition(_)
    )
}

fn is_protected_end(tag_end: &TagEnd) -> bool {
    matches!(
        tag_end,
        TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::MetadataBlock(_)
            | TagEnd::Table
            | TagEnd::FootnoteDefinition
    )
}

fn is_link_reference_definition_start(line: &str) -> bool {
    let trimmed = syntax::trim_start_whitespace_and_invisible(line);
    let Some(after_open) = trimmed.strip_prefix('[') else {
        return false;
    };
    let mut escaped = false;
    let mut has_non_whitespace = false;
    for (idx, ch) in after_open.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            return false;
        }
        if ch == ']' {
            if !has_non_whitespace {
                return false;
            }
            let rest = syntax::trim_start_whitespace_and_invisible(&after_open[idx + 1..]);
            return rest.starts_with(':') && !rest.starts_with("::");
        }
        if !syntax::is_whitespace_or_invisible(ch) {
            has_non_whitespace = true;
        }
    }
    false
}
