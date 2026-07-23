obsidian_vault_dir := home_directory() + "/Notes"
anki_addon_dir := home_directory() + "/.local/share/Anki2/addons21"

[private]
default:
    @just --list

# install all plugins and components
[group("install")]
install-all: install-anki-sync install-formatter install-typst-math

# install anki-sync plugin and addon
[group("install")]
install-anki-sync:
    #!/usr/bin/env bash
    set -euxo pipefail
    cd anki-sync/obsidian-plugin
    rm -rf dist/ && npm run build
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/anki-sync/
    cp dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/anki-sync/
    cd ../..
    mkdir -p {{ anki_addon_dir }}/obsidian-anki-sync
    API_KEY=""
    if [ -f {{ anki_addon_dir }}/obsidian-anki-sync/meta.json ]; then
        API_KEY=$(jq -r '.config.apiKey // empty' {{ anki_addon_dir }}/obsidian-anki-sync/meta.json)
    fi
    cp -r anki-sync/anki-addon/src/obsidian_anki_sync/* {{ anki_addon_dir }}/obsidian-anki-sync/
    if [ -n "$API_KEY" ]; then
        jq --arg key "$API_KEY" '.config.apiKey = $key' {{ anki_addon_dir }}/obsidian-anki-sync/meta.json > /tmp/anki_sync_meta_tmp.json
        mv /tmp/anki_sync_meta_tmp.json {{ anki_addon_dir }}/obsidian-anki-sync/meta.json
    fi
    rm -rf {{ anki_addon_dir }}/obsidian-anki-sync/__pycache__
# install formatter plugin and CLI
[group("install")]
install-formatter:
    #!/usr/bin/env bash
    set -euxo pipefail
    cd formatter
    rm -rf dist/ && npm run build
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cp dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/formatter/
    cargo build --release -p formatter-cli
    mkdir -p ~/.local/bin
    cp target/release/formatter-cli ~/.local/bin/obsdfmt

# install typst-math plugin
[group("install")]
install-typst-math:
    #!/usr/bin/env bash
    set -euxo pipefail
    cd typst-math
    rm -rf dist/ && npm run build
    mkdir -p {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/
    cp dist/* {{ obsidian_vault_dir }}/.obsidian/plugins/typst-math/

# run test suites for all plugins
[group("test")]
test-all:
    just test-anki-sync
    just test-formatter
    just test-typst-math

# test anki-sync plugin, addon, and WASM
[group("test")]
test-anki-sync:
    #!/usr/bin/env bash
    set -euxo pipefail
    cd anki-sync/obsidian-plugin
    npm run test
    cd ../anki-addon
    uv run pytest
    uv run pytest ../e2e/addon
    cd ../..
    cargo test --manifest-path anki-sync/Cargo.toml

# test formatter plugin, CLI, and WASM
[group("test")]
test-formatter:
    cd formatter &&  npm run test
    cargo test --manifest-path formatter/Cargo.toml

# test typst-math plugin and WASM
[group("test")]
test-typst-math:
    cd typst-math && npm run test
    cargo test --manifest-path typst-math/Cargo.toml

# run all static analysis, type checks, and cargo clippy checks
[group("test")]
check-all: format
    # JS/TS Type Checks & Lints
    cd anki-sync/obsidian-plugin && npx vp check --no-fmt
    cd formatter && npx vp check --no-fmt
    cd typst-math && npx vp check --no-fmt

    # Python Type Checks & Lints
    cd anki-sync/anki-addon &&  uv run ruff check && uv run ty check

    # Rust Compiler Checks (Clippy)
    cargo clippy --manifest-path anki-sync/Cargo.toml --all-targets -- -D warnings
    cargo clippy --manifest-path formatter/Cargo.toml --all-targets -- -D warnings
    cargo clippy --manifest-path typst-math/Cargo.toml --all-targets -- -D warnings

# format all files in the project
format:
    nix fmt
