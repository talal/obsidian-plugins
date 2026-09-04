use clap::Parser;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[arg(value_name = "PATHS")]
    paths: Vec<PathBuf>,
}

fn format_stdin() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{Read, Write};

    let mut content = String::new();
    std::io::stdin().read_to_string(&mut content)?;
    let formatted = formatter_core::format(&content)?;
    std::io::stdout().write_all(formatted.as_bytes())?;

    Ok(())
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) {
    if path.to_string_lossy() == "-" {
        files.push(path.to_path_buf());
        return;
    }

    if path.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            let mut sub_paths: Vec<_> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
            sub_paths.sort();
            for sub_path in sub_paths {
                if sub_path
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with('.'))
                {
                    continue;
                }
                if sub_path.is_dir() {
                    collect_files(&sub_path, files);
                } else if sub_path.extension().is_some_and(|ext| ext == "md") {
                    files.push(sub_path);
                }
            }
        }
    } else {
        files.push(path.to_path_buf());
    }
}

fn main() {
    let cli = Cli::parse();
    let mut failed = false;

    if cli.paths.is_empty() {
        if let Err(e) = format_stdin() {
            eprintln!("Error formatting stdin: {e}");
            failed = true;
        }
    } else {
        let mut target_files = Vec::new();
        for path in &cli.paths {
            collect_files(path, &mut target_files);
        }

        for path in target_files {
            if path.to_string_lossy() == "-" {
                if let Err(e) = format_stdin() {
                    eprintln!("Error formatting stdin: {e}");
                    failed = true;
                }
                continue;
            }

            match fs::read_to_string(&path) {
                Ok(content) => match formatter_core::format(&content) {
                    Ok(formatted) => {
                        if formatted != content
                            && let Err(e) = fs::write(&path, formatted)
                        {
                            eprintln!("Error writing {}: {}", path.display(), e);
                            failed = true;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error formatting {}: {}", path.display(), e);
                        failed = true;
                    }
                },
                Err(e) => {
                    eprintln!("Error reading {}: {}", path.display(), e);
                    failed = true;
                }
            }
        }
    }

    if failed {
        std::process::exit(1);
    }
}
