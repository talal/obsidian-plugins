{pkgs, ...}: {
  projectRootFile = "flake.nix";

  settings.global.excludes = [
    "**/tests/fixtures/**"
    "**/e2e/fixtures/**"
  ];

  programs = {
    alejandra.enable = true;
    deadnix.enable = true;
    oxfmt.enable = true;
    ruff-format.enable = true;
    rustfmt.enable = true;
    statix.enable = true;
  };

  programs.dprint = {
    enable = true;
    settings.plugins = pkgs.dprint-plugins.getPluginList (
      plugins:
        with plugins; [
          dprint-plugin-json
          dprint-plugin-markdown
          dprint-plugin-toml
        ]
    );
    includes = ["*.json" "*.md" "*.toml"];
    excludes = ["**/*-lock.json"];
  };

  settings.formatter = {
    # Priority: deadnix -> statix -> Alejandra
    deadnix.priority = 1;
    statix.priority = 2;
    alejandra.priority = 3;

    oxfmt.options = [
      "--config"
      (toString (pkgs.writeText "oxfmtrc.json" ''
        {
          "useTabs": true,
          "singleQuote": true
        }
      ''))
    ];
  };
}
