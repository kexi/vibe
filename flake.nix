{
  description = "vibe - Git worktree helper CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      version = "VERSION_PLACEHOLDER";

      # Platform-specific binary names and SHA-256 hashes
      platforms = {
        x86_64-linux = {
          artifact = "vibe-linux-x64";
          hash = "sha256-SHA256_LINUX_X64";
        };
        aarch64-linux = {
          artifact = "vibe-linux-arm64";
          hash = "sha256-SHA256_LINUX_ARM64";
        };
        x86_64-darwin = {
          artifact = "vibe-darwin-x64";
          hash = "sha256-SHA256_DARWIN_X64";
        };
        aarch64-darwin = {
          artifact = "vibe-darwin-arm64";
          hash = "sha256-SHA256_DARWIN_ARM64";
        };
      };
    in
    flake-utils.lib.eachSystem (builtins.attrNames platforms) (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platformInfo = platforms.${system};
        isLinux = pkgs.lib.hasSuffix "-linux" system;
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "vibe";
          inherit version;

          src = pkgs.fetchurl {
            url = "https://github.com/kexi/vibe/releases/download/v${version}/${platformInfo.artifact}";
            hash = platformInfo.hash;
          };

          dontUnpack = true;

          nativeBuildInputs = pkgs.lib.optionals isLinux [
            pkgs.autoPatchelfHook
          ];

          buildInputs = pkgs.lib.optionals isLinux [
            pkgs.stdenv.cc.cc.lib
          ];

          installPhase = ''
            install -Dm755 $src $out/bin/vibe
          '';

          meta = with pkgs.lib; {
            description = "Git worktree helper CLI";
            homepage = "https://github.com/kexi/vibe";
            license = licenses.mit;
            platforms = builtins.attrNames platforms;
            mainProgram = "vibe";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
            nodePackages.pnpm
            rustc
            cargo
            git
          ];
        };
      }
    ) // {
      overlays.default = final: prev: {
        vibe = self.packages.${final.system}.default;
      };
    };
}
