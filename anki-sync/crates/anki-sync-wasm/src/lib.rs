use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnkiNotePayload {
    pub uuid: String,
    pub deck_name: String,
    pub model_name: String,
    pub fields: HashMap<String, String>,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub modified_markdown: String,
    pub anki_payload: Vec<AnkiNotePayload>,
    pub updated_cache: HashMap<String, String>,
    pub current_file_ids: Vec<String>,
}

fn generate_id() -> String {
    let alphabet: [char; 62] = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H',
        'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
        's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    ];
    assert_eq!(alphabet.len(), 62);
    nanoid::nanoid!(21, &alphabet)
}

fn hash_content(front: &str, back: &str, is_reversed: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update(front.as_bytes());
    hasher.update(b"|||");
    hasher.update(back.as_bytes());
    hasher.update(b"|||");
    hasher.update(if is_reversed { b"1" } else { b"0" });
    format!("{:x}", hasher.finalize())
}

#[wasm_bindgen]
pub fn markdown_to_html(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_MATH);

    let parser = Parser::new_ext(markdown, options);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);

    let trimmed = html_output.trim();
    if trimmed.starts_with("<p>")
        && trimmed.ends_with("</p>")
        && trimmed.matches("<p>").count() == 1
    {
        trimmed[3..trimmed.len() - 4].to_string()
    } else {
        html_output
    }
}

#[derive(Default)]
struct CardParams {
    id: Option<String>,
    deck: Option<String>,
    reverse: bool,
}

fn parse_card_start(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with("%% card start") && trimmed.ends_with("%%") {
        let params_start = "%% card start".len();
        let params_end = trimmed.len() - 2;
        if params_end >= params_start {
            return Some(trimmed[params_start..params_end].trim().to_string());
        } else {
            return Some("".to_string());
        }
    }
    None
}

fn parse_card_end(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with("%% card end") && trimmed.ends_with("%%") {
        let params_start = "%% card end".len();
        let params_end = trimmed.len() - 2;
        if params_end >= params_start {
            return Some(trimmed[params_start..params_end].trim().to_string());
        } else {
            return Some("".to_string());
        }
    }
    None
}

fn is_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Standard markdown horizontal rules
    if trimmed.len() >= 3 && trimmed.chars().filter(|&c| c != ' ').all(|c| c == '-') {
        return true;
    }
    if trimmed.len() >= 3 && trimmed.chars().filter(|&c| c != ' ').all(|c| c == '*') {
        return true;
    }

    // Support ::: (matches inline syntax, doesn't create an HR)
    if trimmed.len() >= 3 && trimmed.chars().filter(|&c| c != ' ').all(|c| c == ':') {
        return true;
    }

    // Support dots like ... or . . .
    if trimmed.len() >= 3 && trimmed.chars().filter(|&c| c != ' ').all(|c| c == '.') {
        return true;
    }

    // Support invisible Obsidian comments
    if let Some(rest) = trimmed.strip_prefix("%%")
        && let Some(inner_raw) = rest.strip_suffix("%%")
    {
        let inner = inner_raw.trim();
        if inner.eq_ignore_ascii_case("back") || inner.eq_ignore_ascii_case("answer") {
            return true;
        }
        if inner.len() >= 3 && inner.chars().filter(|&c| c != ' ').all(|c| c == '-') {
            return true;
        }
        if inner.len() >= 3 && inner.chars().filter(|&c| c != ' ').all(|c| c == '*') {
            return true;
        }
    }

    false
}

fn extract_anki_id(line: &str) -> (Option<String>, String) {
    if let Some(start_idx) = line.find("<!--anki:")
        && let Some(end_idx) = line[start_idx..].find("-->")
    {
        let actual_end_idx = start_idx + end_idx;
        let id_str = line[start_idx + "<!--anki:".len()..actual_end_idx].to_string();
        let mut stripped = String::new();
        stripped.push_str(&line[..start_idx]);
        stripped.push_str(&line[actual_end_idx + 3..]);
        return (Some(id_str), stripped);
    }
    // Known non-goal: Auto-repairing malformed comments (e.g. missing `-->`).
    // Such lines will generate a fresh ID and append a new comment.
    (None, line.to_string())
}

fn parse_params(param_str: &str, params: &mut CardParams) {
    for token in param_str.split_whitespace() {
        if let Some((key, value)) = token.split_once('=') {
            match key {
                "id" => params.id = Some(value.to_string()),
                "deck" if !value.trim().is_empty() => params.deck = Some(value.trim().to_string()),
                "reverse" => params.reverse = value == "true",
                _ => {}
            }
        }
    }
}

fn find_separator_index(line: &str, separator: &str) -> Option<usize> {
    let mut in_code = false;
    let mut in_math = false;
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i].1 == '`' {
            in_code = !in_code;
            i += 1;
            continue;
        }
        if chars[i].1 == '$' {
            in_math = !in_math;
            i += 1;
            continue;
        }

        if !in_code && !in_math && chars[i].1 == ':' {
            let mut colon_end = i;
            while colon_end < chars.len() && chars[colon_end].1 == ':' {
                colon_end += 1;
            }

            let mut backslash_count = 0;
            let mut j = i as isize - 1;
            while j >= 0 && chars[j as usize].1 == '\\' {
                backslash_count += 1;
                j -= 1;
            }

            if backslash_count % 2 == 1 {
                i = colon_end;
                continue;
            }

            if colon_end - i == separator.len() {
                let has_leading_space = i == 0 || chars[i - 1].1.is_whitespace();
                let has_trailing_space =
                    colon_end == chars.len() || chars[colon_end].1.is_whitespace();
                if has_leading_space && has_trailing_space {
                    return Some(chars[i].0);
                }
            }

            i = colon_end;
            continue;
        }
        i += 1;
    }
    None
}

fn find_invalid_lines(content: &str) -> HashSet<usize> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_MATH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);

    let parser = Parser::new_ext(content, options).into_offset_iter();
    let mut invalid = HashSet::new();
    let mut in_code_or_math = false;

    let mut add_range = |range: Range<usize>| {
        let before = &content[..range.start];
        let start_line_num = before.chars().filter(|&c| c == '\n').count();
        let text_in_range = &content[range.start..range.end];
        let line_count = text_in_range.lines().count().max(1);
        for ln in start_line_num..(start_line_num + line_count) {
            invalid.insert(ln);
        }
    };

    for (event, range) in parser {
        match event {
            Event::Start(
                Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(_))
                | Tag::MetadataBlock(_)
                | Tag::Table(_),
            ) => {
                in_code_or_math = true;
            }
            Event::End(TagEnd::CodeBlock | TagEnd::MetadataBlock(_) | TagEnd::Table) => {
                in_code_or_math = false;
            }
            Event::DisplayMath(_) => {
                add_range(range.clone());
            }
            _ => {}
        }
        if in_code_or_math {
            add_range(range);
        }
    }
    invalid
}

struct Scanner {
    lines: Vec<String>,
    invalid_line_indices: HashSet<usize>,
    cache: HashMap<String, String>,
    payload: Vec<AnkiNotePayload>,
    current_ids: Vec<String>,
    seen_ids: HashSet<String>,
    default_deck: String,
    force_sync: bool,
}

impl Scanner {
    fn new(content: &str, cache_json: &str, default_deck: &str, force_sync: bool) -> Self {
        Self {
            lines: content.lines().map(String::from).collect(),
            invalid_line_indices: HashSet::new(),
            cache: serde_json::from_str(cache_json).unwrap_or_default(),
            payload: Vec::new(),
            current_ids: Vec::new(),
            seen_ids: HashSet::new(),
            default_deck: default_deck.to_string(),
            force_sync,
        }
    }

    fn sync_if_dirty(
        &mut self,
        uuid: &str,
        front: &str,
        back: &str,
        deck: &str,
        is_reversed: bool,
    ) {
        let content_hash = hash_content(front, back, is_reversed);
        let should_sync = self.force_sync || self.cache.get(uuid) != Some(&content_hash);
        if should_sync {
            let mut fields = HashMap::new();
            fields.insert("Front".to_string(), markdown_to_html(front));
            fields.insert("Back".to_string(), markdown_to_html(back));
            if is_reversed {
                fields.insert("Add Reverse".to_string(), "y".to_string());
            } else {
                fields.insert("Add Reverse".to_string(), "".to_string());
            }

            self.payload.push(AnkiNotePayload {
                uuid: uuid.to_string(),
                deck_name: deck.to_string(),
                model_name: "Basic (optional reversed card)".to_string(),
                fields,
                tags: vec!["obsidian".to_string()],
            });
            self.cache.insert(uuid.to_string(), content_hash);
        }
    }

    fn process_block_notes(&mut self) {
        let mut i = 0;
        while i < self.lines.len() {
            if let Some(start_param_str) = parse_card_start(&self.lines[i]) {
                let start_line = i;
                let mut params = CardParams::default();
                parse_params(&start_param_str, &mut params);

                let mut end_line = None;
                let mut next_start = self.lines.len();
                for j in (i + 1)..self.lines.len() {
                    if let Some(end_param_str) = parse_card_end(&self.lines[j]) {
                        parse_params(&end_param_str, &mut params);
                        end_line = Some(j);
                        break;
                    }
                    if parse_card_start(&self.lines[j]).is_some() {
                        next_start = j;
                        break;
                    }
                }

                if let Some(end) = end_line {
                    let final_deck = params
                        .deck
                        .clone()
                        .unwrap_or_else(|| self.default_deck.clone());
                    self.invalid_line_indices.extend(start_line..=end);
                    if let Some(sep) = (start_line + 1..end).find(|&j| is_separator(&self.lines[j]))
                    {
                        let front = self.lines[start_line + 1..sep]
                            .join("\n")
                            .trim()
                            .to_string();
                        let back = self.lines[sep + 1..end].join("\n").trim().to_string();

                        if !front.is_empty() && !back.is_empty() {
                            let mut uuid = params.id.clone();
                            if uuid.is_some() && self.seen_ids.contains(uuid.as_ref().unwrap()) {
                                uuid = None; // Force regeneration if duplicate
                            }

                            let final_uuid = uuid.unwrap_or_else(|| {
                                let new_id = generate_id();
                                self.lines[end] = format!("%% card end id={} %%", new_id);
                                new_id
                            });

                            self.seen_ids.insert(final_uuid.clone());
                            self.current_ids.push(final_uuid.clone());
                            self.sync_if_dirty(
                                &final_uuid,
                                &front,
                                &back,
                                &final_deck,
                                params.reverse,
                            );
                        } else {
                            println!(
                                "block note skipped because front or back is empty. front: '{}', back: '{}'",
                                front, back
                            );
                        }
                    }
                    i = end + 1;
                    continue;
                } else {
                    println!("block note skipped because end_line is None");
                    self.invalid_line_indices.extend(start_line..next_start);
                    i = next_start;
                    continue;
                }
            }
            i += 1;
        }
    }

    fn process_inline_notes(&mut self) {
        for idx in 0..self.lines.len() {
            if self.invalid_line_indices.contains(&idx) {
                continue;
            }

            let (anki_id, line_without_id_raw) = extract_anki_id(&self.lines[idx]);
            let line_without_id = line_without_id_raw.trim();

            if line_without_id.starts_with('|') && line_without_id.ends_with('|') {
                continue;
            }

            let (sep_idx, is_reversed) =
                if let Some(idx) = find_separator_index(line_without_id, ":::") {
                    (idx, true)
                } else if let Some(idx) = find_separator_index(line_without_id, "::") {
                    (idx, false)
                } else {
                    continue;
                };

            let sep_len = if is_reversed { 3 } else { 2 };
            let front = line_without_id[..sep_idx].trim().to_string();
            let back = line_without_id[sep_idx + sep_len..].trim().to_string();

            if front.is_empty() || back.is_empty() {
                continue;
            }

            let mut uuid = anki_id.clone();
            if uuid.is_some() && self.seen_ids.contains(uuid.as_ref().unwrap()) {
                uuid = None; // Force regeneration if duplicate
            }

            let final_uuid = uuid.unwrap_or_else(|| {
                let new_id = generate_id();
                self.lines[idx] =
                    format!("{} <!--anki:{}-->", line_without_id_raw.trim_end(), new_id);
                new_id
            });

            self.seen_ids.insert(final_uuid.clone());
            self.current_ids.push(final_uuid.clone());
            self.sync_if_dirty(
                &final_uuid,
                &front,
                &back,
                &self.default_deck.clone(),
                is_reversed,
            );
        }
    }

    fn scan(mut self) -> ScanResult {
        self.process_block_notes();

        let content_after_blocks = self.lines.join("\n");
        self.invalid_line_indices
            .extend(find_invalid_lines(&content_after_blocks));

        self.process_inline_notes();

        ScanResult {
            modified_markdown: self.lines.join("\n"),
            anki_payload: self.payload,
            updated_cache: self.cache,
            current_file_ids: self.current_ids,
        }
    }
}

#[wasm_bindgen]
pub fn scan_file(
    content: &str,
    _source_file: &str,
    default_deck: &str,
    cache_json: &str,
    force_sync: bool,
) -> Result<JsValue, JsValue> {
    let scanner = Scanner::new(content, cache_json, default_deck, force_sync);
    let result = scanner.scan();

    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    serde::Serialize::serialize(&result, &serializer).map_err(|e| JsValue::from_str(&e.to_string()))
}

pub fn scan_for_fuzz(content: &str) {
    let scanner = Scanner::new(content, "{}", "Default Deck", false);
    let _ = scanner.scan();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_card_end() {
        assert_eq!(parse_card_end("%% card end %%").unwrap(), "");
        assert_eq!(parse_card_end("%% card end id=abc %%").unwrap(), "id=abc");
    }

    #[test]
    fn test_process_block_notes_debug() {
        let content = "%% card start %%\nFront\n---\nBack\n%% card end id=123 %%";
        let scanner = Scanner::new(content, "{}", "Default", false);
        let res = scanner.scan();
        assert_eq!(res.anki_payload.len(), 1);
    }

    #[test]
    fn test_markdown_to_html_single_paragraph() {
        assert_eq!(markdown_to_html("Paris"), "Paris");
        assert_eq!(markdown_to_html("**Bold**"), "<strong>Bold</strong>");
        assert_eq!(markdown_to_html("Hello\nWorld"), "Hello\nWorld");
    }

    #[test]
    fn test_markdown_to_html_multi_paragraph() {
        assert_eq!(
            markdown_to_html("Paris\n\nFrance"),
            "<p>Paris</p>\n<p>France</p>\n"
        );
    }

    #[test]
    fn test_markdown_to_html_edge_cases() {
        // Starts with <p> but has multiple paragraphs inside (though malformed markdown, just testing parser output)
        assert_eq!(
            markdown_to_html("Hello\n\n<ul><li>Item</li></ul>"),
            "<p>Hello</p>\n<ul><li>Item</li></ul>"
        );
        // Does not start with <p>
        assert_eq!(markdown_to_html("# Heading"), "<h1>Heading</h1>\n");
    }
}
