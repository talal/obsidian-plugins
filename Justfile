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

# install flashcards plugin
[group("install")]
install-flashcards:
    npm run build -w flashcards
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/flashcards/
    cp plugins/flashcards/dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/flashcards/

# run fuzzing across the repository
fuzz:
    cd crates/flashcards-wasm/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run parse seeds/parse --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    cd crates/flashcards-wasm/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run protected_syntax --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    cd crates/flashcards-wasm/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run fsrs_schedule --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    cd crates/flashcards-wasm/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run fsrs_optimize --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    cd crates/formatter-core/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run format --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    cd crates/typst-math-wasm/fuzz && ASAN_OPTIONS="detect_leaks=0" cargo fuzz run compile_math --release -- -max_total_time=${FUZZ_TIME:-120} -detect_leaks=0
    npm run fuzz -w typst-math
    cargo test -p typst-math-wasm --release -- --ignored

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
