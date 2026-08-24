use dprint_plugin_markdown::configuration::ConfigurationBuilder;
use dprint_plugin_markdown::format_text;

#[derive(Debug)]
pub struct FormatError(pub String);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FormatError {}

pub fn format(input: &str) -> Result<String, FormatError> {
    let mut config = ConfigurationBuilder::new();
    config.list_indent_kind(dprint_plugin_markdown::configuration::ListIndentKind::PythonMarkdown);
    let config = config.build();
    let formatted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        format_text(input, &config, |_, _, _| Ok(None))
    }))
    .map_err(|_| FormatError("dprint panicked while formatting input".to_string()))?
    .map_err(|e| FormatError(e.to_string()))?
    .unwrap_or_else(|| input.to_string());

    Ok(formatted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_yaml_metadata() {
        let input = "---\ntitle: \"Project Alpha\"\nnext: \"[[Project Beta]]\"\ntags: [\"rust\",\"cli\",\"markdown\"]\naliases:\n  - Alpha\n  - ProjAlpha\nprevious: \"[[Project Zero]]\"\ncreated: 2026-01-04\n---\n\n# Heading\n";

        let output = format(input).unwrap();

        let frontmatter_end = input.find("\n---\n").unwrap() + "\n---\n".len();
        assert!(output.starts_with(&input[..frontmatter_end]));
    }

    #[test]
    fn leaves_fenced_yaml_alone() {
        let input = "```yaml\nz: 1\na: 2\n```\n";

        assert_eq!(format(input).unwrap(), input);
    }

    #[test]
    fn preserves_nul_characters() {
        let input = "text\0value\n";

        assert!(format(input).unwrap().contains('\0'));
    }

    #[test]
    fn uses_dprint_line_endings_and_bom_handling() {
        let input = "\u{feff}# Heading\r\n\r\ntext\r\n";

        assert_eq!(format(input).unwrap(), "# Heading\n\ntext\n");
    }

    #[test]
    fn reports_dprint_panics_as_format_errors() {
        let result = format("$\t}\n");

        assert!(result.is_err());
    }
}
