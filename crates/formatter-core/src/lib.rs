use dprint_plugin_markdown::configuration::ConfigurationBuilder;
use dprint_plugin_markdown::format_text;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug)]
pub struct FormatError(pub String);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FormatError {}

fn split_frontmatter(input: &str) -> (Option<&str>, &str) {
    if let Some(after_first_sep) = input.strip_prefix("---\n")
        && let Some(end_idx) = after_first_sep.find("\n---")
    {
        let fm = &after_first_sep[..end_idx];
        let after_second_sep = &after_first_sep[end_idx + 4..];
        let content_start = if after_second_sep.starts_with('\n') {
            1
        } else if after_second_sep.starts_with("\r\n") {
            2
        } else {
            0
        };
        return (Some(fm), &after_second_sep[content_start..]);
    }
    (None, input)
}

pub fn format(input: &str) -> Result<String, FormatError> {
    let input_no_bom = input.replace(['\u{feff}', '\0'], "");
    let normalized_input = input_no_bom.replace("\r\n", "\n").replace('\r', "\n");
    let (fm, rest) = split_frontmatter(&normalized_input);
    let mut out = String::new();

    if let Some(fm) = fm {
        static RE_WIKILINK: OnceLock<Regex> = OnceLock::new();
        let re_wikilink = RE_WIKILINK
            .get_or_init(|| Regex::new(r"(?m)(:\s*|^\s*-\s*)\[\[([^\]]+)\]\]\s*$").unwrap());
        let safe_fm = re_wikilink.replace_all(fm, "$1\"[[$2]]\"");

        if let Ok(mut val) =
            serde_yaml::from_str::<std::collections::BTreeMap<String, serde_yaml::Value>>(&safe_fm)
        {
            let mut sorted_map = serde_yaml::Mapping::new();

            if let Some(created) = val.remove("created") {
                sorted_map.insert(serde_yaml::Value::String("created".to_string()), created);
            }

            if let Some(aliases) = val.remove("aliases") {
                sorted_map.insert(serde_yaml::Value::String("aliases".to_string()), aliases);
            }

            if let Some(start) = val.remove("start") {
                sorted_map.insert(serde_yaml::Value::String("start".to_string()), start);
            }

            if let Some(end) = val.remove("end") {
                sorted_map.insert(serde_yaml::Value::String("end".to_string()), end);
            }

            let previous = val.remove("previous");
            let next = val.remove("next");
            let tags = val.remove("tags");

            for (k, v) in val {
                sorted_map.insert(serde_yaml::Value::String(k), v);
            }

            if let Some(previous) = previous {
                sorted_map.insert(serde_yaml::Value::String("previous".to_string()), previous);
            }

            if let Some(next) = next {
                sorted_map.insert(serde_yaml::Value::String("next".to_string()), next);
            }

            if let Some(tags) = tags {
                let is_empty = match &tags {
                    serde_yaml::Value::Null => true,
                    serde_yaml::Value::Sequence(seq) => seq.is_empty(),
                    serde_yaml::Value::String(s) => s.trim().is_empty(),
                    _ => false,
                };
                if is_empty {
                    sorted_map.insert(
                        serde_yaml::Value::String("tags".to_string()),
                        serde_yaml::Value::Null,
                    );
                } else {
                    sorted_map.insert(serde_yaml::Value::String("tags".to_string()), tags);
                }
            }

            let yaml_out =
                serde_yaml::to_string(&sorted_map).map_err(|e| FormatError(e.to_string()))?;
            out.push_str("---\n");

            static RE_NULL: OnceLock<Regex> = OnceLock::new();
            let re_null =
                RE_NULL.get_or_init(|| Regex::new(r"(?m)^([A-Za-z0-9_-]+):\s*null$").unwrap());

            let formatted_yaml = yaml_out.trim().replace("\n- ", "\n  - ");
            let formatted_yaml = re_null.replace_all(&formatted_yaml, "$1:").into_owned();

            out.push_str(&formatted_yaml);
            out.push_str("\n---\n\n");
        } else {
            out.push_str("---\n");
            out.push_str(fm);
            out.push_str("\n---\n\n");
        }
    }

    let mut fixed_rest = String::with_capacity(rest.len());
    let mut fence: Option<(char, usize)> = None;
    let mut lines = rest.split('\n').peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        let fence_char = trimmed.chars().next().unwrap_or(' ');
        let fence_len = trimmed.chars().take_while(|&c| c == fence_char).count();

        if (fence_char == '`' || fence_char == '~') && fence_len >= 3 {
            match &fence {
                None => fence = Some((fence_char, fence_len)),
                Some((fc, fw))
                    if *fc == fence_char
                        && fence_len >= *fw
                        && trimmed[fence_len..].trim().is_empty() =>
                {
                    fence = None;
                }
                _ => {} // ignore mismatched or too-short fences
            }
            fixed_rest.push_str(&line.replace('\t', "    "));
        } else {
            let in_code_block = fence.is_some();
            if in_code_block {
                fixed_rest.push_str(&line.replace('\t', "    "));
            } else {
                let cleaned: String = line
                    .replace('\t', "    ")
                    .chars()
                    .map(|c| {
                        // preserve non-breaking space (used in Obsidian)
                        if c.is_whitespace() && c != ' ' && c != '\r' && c != '\u{a0}' {
                            ' '
                        } else {
                            c
                        }
                    })
                    .collect();

                let final_line = if cleaned.starts_with("  - ")
                    || cleaned.starts_with("  * ")
                    || cleaned.starts_with("  + ")
                {
                    format!("  {}", cleaned)
                } else {
                    cleaned
                };
                fixed_rest.push_str(&final_line);
            }
        }
        if lines.peek().is_some() {
            fixed_rest.push('\n');
        }
    }

    let global_config = dprint_core::configuration::GlobalConfiguration {
        indent_width: Some(4),
        line_width: Some(100),
        ..Default::default()
    };

    let mut config = ConfigurationBuilder::new();
    config.global_config(global_config);
    config.list_indent_kind(dprint_plugin_markdown::configuration::ListIndentKind::PythonMarkdown);
    let config = config.build();

    let formatted = format_text(&fixed_rest, &config, |_, _, _| Ok(None))
        .map_err(|e| FormatError(e.to_string()))?
        .unwrap_or(fixed_rest.clone());

    out.push_str(&formatted);

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exotic_input_no_panic() {
        let input = "~~~/SS\t\0)u";
        let _ = format(input);
    }
}
