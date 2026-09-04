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
        "formatter-cli-{label}-{}-{timestamp}.md",
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
        .expect("run formatter-cli");

    let formatted = fs::read_to_string(&path).expect("read formatted fixture");
    let _ = fs::remove_file(&path);

    assert!(
        output.status.success(),
        "formatter-cli failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(formatted, "# Heading\n\n- item\n");
}

#[test]
fn a_panicking_file_does_not_abort_the_batch() {
    let bad = temporary_path("panic");
    let good = temporary_path("batch");
    fs::write(&bad, "$\t}\n").expect("write panicking fixture");
    fs::write(&good, "# Heading\n\n-   item\n").expect("write fixture");

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(&bad)
        .arg(&good)
        .output()
        .expect("run formatter-cli");

    let bad_after = fs::read_to_string(&bad);
    let good_after = fs::read_to_string(&good);
    let _ = fs::remove_file(&bad);
    let _ = fs::remove_file(&good);

    assert!(
        !output.status.success(),
        "batch should report the failed file"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Error formatting"),
        "stderr should name the failing file: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The panicking file stays untouched and later files are still formatted.
    assert_eq!(bad_after.expect("read bad file"), "$\t}\n");
    assert_eq!(good_after.expect("read good file"), "# Heading\n\n- item\n");
}

#[test]
fn missing_paths_fail_and_report_on_stderr() {
    let path = temporary_path("missing");

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(path)
        .output()
        .expect("run formatter-cli");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Error reading"));
}

#[test]
fn help_describes_the_path_only_interface() {
    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg("--help")
        .output()
        .expect("run formatter-cli");
    let help = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success());
    assert!(help.starts_with("Usage: "));
    assert!(help.contains("[PATHS]..."));
    assert!(!help.contains("check"));
}

#[test]
fn formats_directory_recursively() {
    let dir = temporary_path("dir");
    let sub_dir = dir.join("nested");
    fs::create_dir_all(&sub_dir).expect("create dir");

    let file1 = dir.join("file1.md");
    let file2 = sub_dir.join("file2.md");
    let non_md = dir.join("file.txt");

    fs::write(&file1, "# Title 1\n\n-   item\n").expect("write file1");
    fs::write(&file2, "# Title 2\n\n-   item\n").expect("write file2");
    fs::write(&non_md, "non-markdown unchanged\n").expect("write non-md");

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(&dir)
        .output()
        .expect("run formatter-cli");

    let file1_after = fs::read_to_string(&file1).expect("read file1");
    let file2_after = fs::read_to_string(&file2).expect("read file2");
    let non_md_after = fs::read_to_string(&non_md).expect("read non-md");

    let _ = fs::remove_dir_all(&dir);

    assert!(output.status.success());
    assert_eq!(file1_after, "# Title 1\n\n- item\n");
    assert_eq!(file2_after, "# Title 2\n\n- item\n");
    assert_eq!(non_md_after, "non-markdown unchanged\n");
}

#[test]
fn already_formatted_files_are_not_modified() {
    let path = temporary_path("idempotent");
    let initial_content = "# Heading\n\n- item\n";
    fs::write(&path, initial_content).expect("write fixture");

    let meta_before = fs::metadata(&path).expect("metadata before");
    let mtime_before = meta_before.modified().expect("mtime before");

    // Sleep briefly so mtime would change if written
    std::thread::sleep(std::time::Duration::from_millis(20));

    let output = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg(&path)
        .output()
        .expect("run formatter-cli");

    let meta_after = fs::metadata(&path).expect("metadata after");
    let mtime_after = meta_after.modified().expect("mtime after");
    let _ = fs::remove_file(&path);

    assert!(output.status.success());
    assert_eq!(mtime_before, mtime_after);
}

#[test]
fn formats_stdin_with_no_arguments() {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn formatter-cli");

    child
        .stdin
        .as_mut()
        .expect("stdin handle")
        .write_all(b"# Title\n\n-   item\n")
        .expect("write stdin");

    let output = child.wait_with_output().expect("wait on child");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "# Title\n\n- item\n"
    );
}

#[test]
fn formats_stdin_with_dash_argument() {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(env!("CARGO_BIN_EXE_formatter-cli"))
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn formatter-cli");

    child
        .stdin
        .as_mut()
        .expect("stdin handle")
        .write_all(b"# Title\n\n-   item\n")
        .expect("write stdin");

    let output = child.wait_with_output().expect("wait on child");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "# Title\n\n- item\n"
    );
}
