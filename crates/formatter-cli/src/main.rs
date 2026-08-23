use clap::Parser;
use std::fs;
use std::path::PathBuf;

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

fn main() {
    let cli = Cli::parse();
    let mut failed = false;

    if cli.paths.is_empty() {
        if let Err(e) = format_stdin() {
            eprintln!("Error formatting stdin: {e}");
            failed = true;
        }
    } else {
        for path in cli.paths {
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
                        if let Err(e) = fs::write(&path, formatted) {
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
