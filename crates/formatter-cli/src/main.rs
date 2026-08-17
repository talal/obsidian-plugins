use clap::{Parser, Subcommand};
use std::fs;
use std::path::PathBuf;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Format { paths: Vec<PathBuf> },
    Check { paths: Vec<PathBuf> },
}

fn format_stdin() {
    use std::io::{Read, Write};
    let mut content = String::new();
    std::io::stdin().read_to_string(&mut content).unwrap();
    if let Ok(formatted) = formatter_core::format(&content) {
        std::io::stdout().write_all(formatted.as_bytes()).unwrap();
    } else {
        std::io::stdout().write_all(content.as_bytes()).unwrap();
    }
}

fn main() {
    let cli = Cli::parse();

    match &cli.command {
        Commands::Format { paths } => {
            if paths.is_empty() {
                format_stdin();
            } else {
                for path in paths {
                    if path.to_string_lossy() == "-" {
                        format_stdin();
                    } else {
                        match fs::read_to_string(path) {
                            Ok(content) => match formatter_core::format(&content) {
                                Ok(formatted) => {
                                    if let Err(e) = fs::write(path, formatted) {
                                        eprintln!("Error writing {}: {}", path.display(), e);
                                    }
                                }
                                Err(e) => eprintln!("Error formatting {}: {}", path.display(), e),
                            },
                            Err(e) => eprintln!("Error reading {}: {}", path.display(), e),
                        }
                    }
                }
            }
        }
        Commands::Check { paths } => {
            let mut all_match = true;
            for path in paths {
                match fs::read_to_string(path) {
                    Ok(content) => match formatter_core::would_change(&content) {
                        Ok(changed) => {
                            if changed {
                                eprintln!("Would change: {}", path.display());
                                all_match = false;
                            }
                        }
                        Err(e) => {
                            eprintln!("Error formatting {}: {}", path.display(), e);
                            all_match = false;
                        }
                    },
                    Err(e) => {
                        eprintln!("Error reading {}: {}", path.display(), e);
                        all_match = false;
                    }
                }
            }
            if !all_match {
                std::process::exit(1);
            }
        }
    }
}
