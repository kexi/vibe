{
  description = "vibe - Git worktree helper CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Single source of truth: read the release version from package.json at
      # eval time instead of hardcoding it here. A literal duplicate drifts out
      # of sync — the release tag pointed at a commit whose flake.nix still said
      # the previous version, so a source build / `#binary` from that tag built
      # the wrong version. Deriving it means flake.nix is correct at every
      # commit and tag with no release-time bump. (pnpm/native pins below are
      # tool versions, deliberately independent of the release version.)
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

      # Platform-specific metadata.
      # - artifact/hash: prebuilt release binary (packages.binary). The artifact
      #   is now the Rust binary, but the names (vibe-linux-x64, ...) and the
      #   fetchurl+install path are unchanged, so the update-nix hash mechanism
      #   in release.yml still applies.
      platforms = {
        x86_64-linux = {
          artifact = "vibe-linux-x64";
          hash = "sha256-UBS9+p13knX1kzMYRphrkj3rTV/uLdP/Wgn5WifQFZw=";
        };
        aarch64-linux = {
          artifact = "vibe-linux-arm64";
          hash = "sha256-nDABUwRqEQZ/g0JAdL6WWXuR/M+Q01uKt7UIGFZJI0M=";
        };
        x86_64-darwin = {
          artifact = "vibe-darwin-x64";
          hash = "sha256-fGAdMJIQBR3L+Z7ClRgMlDoHEyN+omRfaAdnpyHgTIU=";
        };
        aarch64-darwin = {
          artifact = "vibe-darwin-arm64";
          hash = "sha256-mqlfWzIXnYZ0k+zdOKV9bMpK2rjxu4Y5LiIS4DwQUfk=";
        };
      };
    in
    flake-utils.lib.eachSystem (builtins.attrNames platforms) (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platformInfo = platforms.${system};
        isLinux = pkgs.lib.hasSuffix "-linux" system;

        # ---- Source build (compile the Rust binary from source) ----

        # The shipped vibe is a native Rust binary. The source build compiles the
        # `vibe` crate (which statically links its own `vibe-native` crate) with
        # rustPlatform.buildRustPackage, replacing the former pnpm + bun-compile +
        # N-API-embed pipeline. The commit comes from the flake's own revision
        # (git is unavailable in the pure sandbox), preserving the
        # `<version>+<commit>` provenance the build.rs would otherwise read from
        # git.
        commitRev = self.shortRev or self.dirtyShortRev or "";

        vibe-source = pkgs.rustPlatform.buildRustPackage {
          pname = "vibe";
          inherit version;
          src = ./rust;
          cargoLock.lockFile = ./rust/Cargo.lock;

          cargoBuildFlags = [ "-p" "vibe" ];

          # build.rs reads these (cargo:rustc-env) so the binary's --version is
          # accurate and reproducible without calling git / a wall clock.
          VIBE_BUILD_COMMIT = commitRev;
          VIBE_BUILD_DISTRIBUTION = "nix";
          VIBE_BUILD_ENV = "nix";

          # The Rust workspace tests run in the dedicated CI `rust` job (which
          # builds the macOS native code too); skip them here to keep the Nix
          # build focused on producing the binary.
          doCheck = false;

          # aws-lc-rs (via rustls) links libgcc_s at runtime on Linux;
          # buildRustPackage applies autoPatchelfHook there, and this provides the
          # shared object it needs.
          buildInputs = pkgs.lib.optionals isLinux [
            pkgs.stdenv.cc.cc.lib
          ];

          meta = with pkgs.lib; {
            description = "Git worktree helper CLI";
            homepage = "https://github.com/kexi/vibe";
            license = licenses.asl20;
            platforms = builtins.attrNames platforms;
            mainProgram = "vibe";
          };
        };
      in
      {
        # Default to the source build: it is reproducible and avoids the
        # per-release SHA-256 churn the prebuilt binary needs. `fromSource` is
        # kept as an explicit alias for clarity and CI.
        packages.default = vibe-source;
        packages.fromSource = vibe-source;

        # Prebuilt release binary (fast path; skips compiling). Requires the
        # per-platform hashes above to be bumped on every release, so it is no
        # longer the default.
        packages.binary = pkgs.stdenv.mkDerivation {
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
            description = "Git worktree helper CLI (prebuilt release binary)";
            homepage = "https://github.com/kexi/vibe";
            license = licenses.asl20;
            platforms = builtins.attrNames platforms;
            mainProgram = "vibe";
          };
        };

        # mkShellNoCC (not mkShell) so the shell does not put a Nix C toolchain
        # (gcc/clang + binutils) on PATH. node-gyp (node-pty) and rustup link
        # against the system toolchain; a Nix `ld` here shadows it and fails to
        # find the system crti.o.
        devShells.default = pkgs.mkShellNoCC {
          # Toolchain that replaces the former .mise.toml. Versions are pinned
          # by flake.lock; node/pnpm follow the lockfile's major (pnpm_10), while
          # Rust is managed by rustup (see rust-toolchain.toml) because the native
          # module's cross-target builds need `rustup target add`.
          packages = with pkgs; [
            bun
            nodejs_24
            pnpm_10
            ruby_3_4
            rustup
            pinact
            lefthook
            git
            gitleaks
          ];

          # Formerly .mise.toml [env]; avoids sharp pulling in a global libvips.
          # lefthook install registers the git hooks defined in lefthook.yml;
          # done here (not via an npm "prepare" script) so hook setup is owned by
          # the Nix dev shell and does not depend on the JS package lifecycle.
          shellHook = ''
            export SHARP_IGNORE_GLOBAL_LIBVIPS=1
            lefthook install >/dev/null 2>&1 || true
          '';
        };
      }
    ) // {
      overlays.default = final: prev: {
        vibe = self.packages.${final.system}.default;
      };
    };
}
