obsidian_vault_dir := home_directory() + "/Notes"

alias lint := check
alias fmt := check-fix

[private]
default:
    @just --list

# install formatter plugin and CLI
[group("install")]
install-formatter:
    npm run build -w formatter
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cp plugins/formatter/dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cargo build --profile cli -p formatter-cli
    mkdir -p ~/.local/bin
    cp target/cli/formatter-cli ~/.local/bin/obsdfmt

# install typst-math plugin
[group("install")]
install-typst-math:
    npm run build -w typst-math
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/
    cp plugins/typst-math/dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/

# run fuzzing across the repository
fuzz:
    cd crates/formatter-core/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0

# run test suites for all plugins and crates
test:
    cargo test --workspace
    npm run test

# run static analysis, formatting, type checks, and cargo clippy checks
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    npm run check

# fix formatting and lint issues across the repository
check-fix:
    cargo fmt --all
    cargo clippy --fix --workspace --allow-no-vcs
    npm run check:fix

# remove all build artifacts and generated outputs
clean:
    cargo clean
    rm -rf node_modules plugins/*/dist crates/*/pkg
