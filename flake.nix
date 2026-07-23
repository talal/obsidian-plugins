{
  description = "Development shell for Obsidian plugins and Anki addons";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    rust-overlay,
    treefmt-nix,
    ...
  }: let
    overlays = [(import rust-overlay)];
    pkgs = import nixpkgs {
      system = "x86_64-linux";
      inherit overlays;
    };
    rustToolchain = pkgs.rust-bin.nightly.latest.default.override {
      extensions = ["rust-src" "rust-analyzer" "llvm-tools-preview"];
      targets = ["wasm32-unknown-unknown"];
    };
    treefmtEval = treefmt-nix.lib.evalModule pkgs ./treefmt.nix;
  in {
    formatter.x86_64-linux = treefmtEval.config.build.wrapper;

    devShells.x86_64-linux.default = pkgs.mkShell {
      packages = with pkgs; [
        # Formatting
        treefmtEval.config.build.wrapper

        # Type-/JavaScript
        nodejs_26
        typescript-language-server

        # Rust + WASM
        rustToolchain
        lld
        wasm-pack
        cargo-fuzz

        # Python
        uv
        sqlite # for working with Anki databases
      ];
    };
  };
}
