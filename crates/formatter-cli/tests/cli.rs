use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_path(label: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "obsdfmt-{label}-{}-{timestamp}.md",
        std::process::id()
    ))
}

#[test]
fn formats_paths_without_a_subcommand() {
    let path = temporary_path("format");
    fs::write(&path, "# Heading\n\n-   item\n").expect("write fixture");

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(&path)
        .output()
        .expect("run obsdfmt");

    let formatted = fs::read_to_string(&path).expect("read formatted fixture");
    let _ = fs::remove_file(&path);

    assert!(
        output.status.success(),
        "obsdfmt failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(formatted, "# Heading\n\n- item\n");
}

#[test]
fn missing_paths_fail_and_report_on_stderr() {
    let path = temporary_path("missing");

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(path)
        .output()
        .expect("run obsdfmt");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Error reading"));
}

#[test]
fn help_describes_the_path_only_interface() {
    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg("--help")
        .output()
        .expect("run obsdfmt");
    let help = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success());
    assert!(help.starts_with("Usage: "));
    assert!(help.contains("[PATHS]..."));
    assert!(!help.contains("check"));
}
