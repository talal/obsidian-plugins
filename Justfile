obsidian_vault_dir := home_directory() + "/Notes"

alias lint := check
alias fmt := check-fix

[private]
default:
    @just --list

# install all plugins and components
[group("install")]
install-all: install-formatter install-typst-math

# install formatter plugin and CLI
[group("install")]
install-formatter:
    npm run build -w formatter
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cp plugins/formatter/dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cargo build --release -p formatter-cli
    mkdir -p ~/.local/bin
    cp target/release/formatter-cli ~/.local/bin/obsdfmt

# install typst-math plugin
[group("install")]
install-typst-math:
    npm run build -w typst-math
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/
    cp plugins/typst-math/dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/

# run test suites for all plugins and crates
[group("test")]
test-all:
    cargo test --workspace
    npm run test

# run test suite for formatter
[group("test")]
test-formatter:
    cargo test -p formatter-core -p formatter-cli -p formatter-wasm
    npm run test -w formatter

# test typst-math plugin and Wasm
[group("test")]
test-typst-math:
    cargo test -p typst-math-wasm
    npm run test -w typst-math

# run static analysis, formatting, type checks, and cargo clippy checks
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm run check

# auto-fix format and lint issues across all files
check-fix:
    cargo fmt --all
    cargo clippy --fix --workspace --allow-no-vcs
    npm run check:fix

# remove all build artifacts and generated outputs
clean:
    cargo clean
    rm -rf node_modules plugins/*/dist crates/*/pkg
