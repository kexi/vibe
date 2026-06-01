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
      # - artifact/hash: prebuilt release binary (packages.default)
      # - napiNode: filename the runtime's literal require() expects for the
      #   N-API native module (see packages/core/src/runtime/node/native.ts)
      platforms = {
        x86_64-linux = {
          artifact = "vibe-linux-x64";
          hash = "sha256-IK3Mus3OPVnxqojBI2dLFOyKwganV6tfGs5duGCoqWg=";
          napiNode = "vibe-native.linux-x64-gnu.node";
        };
        aarch64-linux = {
          artifact = "vibe-linux-arm64";
          hash = "sha256-6i98Hh5jnThHIXFPUoc2/XXEqzwBc6ZuEWP1JAAu3hg=";
          napiNode = "vibe-native.linux-arm64-gnu.node";
        };
        x86_64-darwin = {
          artifact = "vibe-darwin-x64";
          hash = "sha256-ly10wj0u/jh7J5Tyo2RlAEAMHV7n3FUGfaSyaa8U1kw=";
          napiNode = "vibe-native.darwin-x64.node";
        };
        aarch64-darwin = {
          artifact = "vibe-darwin-arm64";
          hash = "sha256-A95UEErpNXknVXSl8+ZBvXDNHL7WuW+ogsirMLGN2BY=";
          napiNode = "vibe-native.darwin-arm64.node";
        };
      };
    in
    flake-utils.lib.eachSystem (builtins.attrNames platforms) (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        platformInfo = platforms.${system};
        isLinux = pkgs.lib.hasSuffix "-linux" system;

        # ---- Source build (nixpkgs-style: compile everything from source) ----

        # Pin pnpm to the repo's own version (package.json `packageManager`).
        # nixpkgs' pnpm_10 (10.33.4) writes the newer v11 store (a binary
        # `index.db`), which nixpkgs fetchPnpmDeps only round-trips correctly at
        # fetcherVersion >= 4 (unavailable here, max 3); the result is a mangled
        # index and ERR_PNPM_NO_OFFLINE_TARBALL at build time. 10.26.2 writes the
        # v10 store that fetcherVersion 3 handles, and matches the lockfile.
        pnpmPinned = pkgs.pnpm_10.override {
          version = "10.26.2";
          hash = "sha256-Y7UKS6Fc3iAAbdul2eIf1iPiPwlMn2O7FfaGsOSWrtY=";
        };

        # N-API native module (Copy-on-Write clone helpers). napi-rs emits a
        # cdylib that the runtime loads as `<napiNode>`; we build the crate with
        # plain cargo (napi-build sets the link flags) and rename the resulting
        # shared object to the name the runtime's literal require() expects.
        vibe-native = pkgs.rustPlatform.buildRustPackage {
          pname = "vibe-native";
          version = "0.12.0"; # packages/native/Cargo.toml
          src = ./packages/native;
          cargoLock.lockFile = ./packages/native/Cargo.lock;

          # No Rust tests are meant to run without a Node host.
          doCheck = false;

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            lib=$(find . \( -name 'libvibe_native.so' -o -name 'libvibe_native.dylib' \) -type f | head -n1)
            if [ -z "$lib" ]; then
              echo "vibe-native: built shared object not found" >&2
              exit 1
            fi
            cp "$lib" "$out/${platformInfo.napiNode}"
            runHook postInstall
          '';
        };

        # Deterministic stand-in for scripts/build.ts version generation, which
        # shells out to git (unavailable in the sandbox) and stamps a wall-clock
        # build time (non-reproducible). The commit comes from the flake's own
        # revision instead of git, preserving the `<version>+<commit>` provenance
        # that scripts/build.ts produces.
        commitRev = self.shortRev or self.dirtyShortRev or "unknown";
        versionFile = pkgs.writeText "version.ts" ''
          // This file is provided by the Nix build (see flake.nix).
          export interface BuildInfo {
            version: string;
            repository: string;
            platform: string;
            arch: string;
            target: string;
            distribution: string;
            buildTime: string;
            buildEnv: string;
          }

          export const BUILD_INFO: BuildInfo = {
            version: "${version}+${commitRev}",
            repository: "git+https://github.com/kexi/vibe.git",
            platform: "${if isLinux then "linux" else "darwin"}",
            arch: "${if pkgs.lib.hasPrefix "x86_64" system then "x64" else "arm64"}",
            target: "${system}",
            distribution: "nix",
            buildTime: "",
            buildEnv: "nix",
          };

          // Backwards compatibility
          export const VERSION = BUILD_INFO.version;
          export const REPOSITORY_URL = BUILD_INFO.repository;
        '';

        # pnpm-workspace.yaml carries supply-chain policies (trustPolicy,
        # minimumReleaseAge) that re-verify packages against the npm registry at
        # install time. They depend on wall-clock time and live registry trust
        # state, so inside the pure build sandbox they are non-deterministic and
        # fail the fixed-output pnpm fetch (the host pnpm cache that masks this
        # locally is not visible). Integrity for the Nix build is instead pinned
        # by the fetch output hash + the frozen lockfile, so strip just those two
        # registry-time policies from a build-only copy of the source, shared by
        # both the fetch and the compile so they stay consistent.
        nixSrc = pkgs.runCommandLocal "vibe-src" { } ''
          cp -r ${self} $out
          chmod -R +w $out
          ${pkgs.yq-go}/bin/yq -i \
            'del(.trustPolicy) | del(.minimumReleaseAge) | del(.minimumReleaseAgeExclude)' \
            $out/pnpm-workspace.yaml
        '';

        vibe-source = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "vibe";
          inherit version;
          src = nixSrc;

          # The CLI binary only needs the root project (main.ts) and
          # @kexi/vibe-core; the other workspaces (docs/video/e2e) pull in heavy,
          # platform-specific trees (astro, remotion, pagefind) that bloat and
          # destabilise the fetch without contributing to the binary. Restrict
          # both the fetch and the offline install to just these two projects.
          pnpmWorkspaces = [
            "vibe-monorepo"
            "@kexi/vibe-core"
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs)
              pname
              version
              src
              pnpmWorkspaces
              ;
            pnpm = pnpmPinned;
            fetcherVersion = 3;
            hash = "sha256-RPW842JniDhnnpPiU+n+LP3LovZHnsamVN/RmDmxyyQ=";
          };

          nativeBuildInputs = [
            pkgs.bun
            pkgs.nodejs_24
            pnpmPinned
            pkgs.pnpmConfigHook
          ]
          # `bun build --compile` copies the (Nix-patched) bun runtime as the
          # base executable, but the result and the embedded N-API module still
          # need their ELF interpreter/rpath rewritten to Nix store paths, or
          # they fail to start on NixOS (no FHS /lib64/ld-linux). Mirror what
          # packages.binary does for the downloaded binary.
          ++ pkgs.lib.optionals isLinux [ pkgs.autoPatchelfHook ];

          buildInputs = pkgs.lib.optionals isLinux [
            pkgs.stdenv.cc.cc.lib
          ];

          preBuild = ''
            # Drop the prebuilt N-API module where the literal require() in
            # packages/core/src/runtime/node/native.ts looks for it, so that
            # `bun build --compile` statically embeds it into the binary.
            cp ${vibe-native}/${platformInfo.napiNode} packages/native/${platformInfo.napiNode}

            # Deterministic version.ts instead of the git/timestamp generator.
            cp ${versionFile} packages/core/src/version.ts
          '';

          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            export SHARP_IGNORE_GLOBAL_LIBVIPS=1
            bun build --compile --minify --outfile vibe main.ts
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 vibe $out/bin/vibe
            runHook postInstall
          '';

          # The output is a self-contained Bun executable; stripping corrupts it.
          dontStrip = true;

          meta = with pkgs.lib; {
            description = "Git worktree helper CLI";
            homepage = "https://github.com/kexi/vibe";
            license = licenses.asl20;
            platforms = builtins.attrNames platforms;
            mainProgram = "vibe";
          };
        });
      in
      {
        # Default to the source build: it is reproducible and avoids the
        # per-release SHA-256 churn the prebuilt binary needs. `fromSource` is
        # kept as an explicit alias for clarity and CI.
        packages.default = vibe-source;
        packages.fromSource = vibe-source;
        packages.vibe-native = vibe-native;

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
