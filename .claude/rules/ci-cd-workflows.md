---
globs: "**/.github/workflows/*.yml"
---

# CI/CD Workflow Rules

## Tool Setup Requirements

The development toolchain is defined once in the Nix flake (`flake.nix`,
`devShells.default`). When creating or modifying GitHub Actions workflows,
**use the `./.github/actions/setup-toolchain` composite action** to provision
tools instead of adding individual setup actions.

### Decision Process

Before adding a setup action, check:

1. Does the job just need the standard project toolchain (bun, node, pnpm, ruby,
   rust/rustup, pinact, git)? → use `./.github/actions/setup-toolchain`.
2. Does the job need a tool the dev shell does not provide? → add it to
   `flake.nix` `devShells.default` (so it is available locally and in CI), then
   use the composite action.
3. Is it a one-off, distribution-specific tool (e.g. `denoland/setup-deno` for
   JSR smoke tests, or `actions/setup-node` purely for npm registry auth)? → use
   the individual action as a fallback, on top of `setup-toolchain` if needed.

### How `setup-toolchain` works

- **Linux/macOS**: installs Nix (`DeterminateSystems/nix-installer-action` +
  `magic-nix-cache-action`), enters the flake dev shell, and exposes its tools
  on `PATH` for all subsequent `run:` steps. No `nix develop --command` prefix
  is needed — steps look the same as on any runner.
- **Windows**: Nix does not run on Windows, so it falls back to
  `oven-sh/setup-bun` + `actions/setup-node` + `pnpm/action-setup`, pinned to the
  same versions. Rust is not provided (the native module is not built on Windows).

### Example

```yaml
# Good - using the shared composite action
steps:
  - uses: actions/checkout@<sha> # v...
  - uses: ./.github/actions/setup-toolchain
  - run: pnpm install --frozen-lockfile --ignore-scripts

# Bad - re-adding individual setup actions per workflow
steps:
  - uses: actions/checkout@<sha> # v...
  - uses: actions/setup-node@<sha> # v...
    with:
      node-version: 24
  - uses: oven-sh/setup-bun@<sha> # v...
  - uses: pnpm/action-setup@<sha> # v...
  - run: pnpm install
```

### Exceptions (not provided by the dev shell)

- `actions/checkout` - Git checkout, not a tool
- `actions/cache` - Caching mechanism
- `actions/upload-artifact` / `actions/download-artifact` - Artifact handling
- `docker/build-push-action` - Docker-specific operations
- `denoland/setup-deno` - Deno is intentionally not in the dev shell (dev uses
  Bun); it is only needed for JSR distribution testing
- `actions/setup-node` with `registry-url` - used in publish jobs for npm
  registry auth / OIDC, layered on top of `setup-toolchain`
- `gitleaks/gitleaks-action` - secret scanning; the official action bundles its
  own gitleaks binary and maintained scan / PR-comment logic. The Nix dev shell
  still provides gitleaks for the local pre-commit hook (lefthook)
- Platform-specific SDK setup (e.g., Xcode, Android SDK)

### Benefits

1. **Single source of truth**: tool versions come from `flake.nix` / `flake.lock`
2. **Consistency**: the exact same dev shell is used locally (`nix develop`) and in CI
3. **Simpler workflows**: one composite action instead of several setup actions
4. **Reproducibility**: `flake.lock` pins the entire toolchain to a nixpkgs commit
5. **Faster CI**: `magic-nix-cache-action` caches the Nix store across runs

### Adding New Tools

When you need a new tool in CI:

1. Find it in nixpkgs (e.g. `nix search nixpkgs <tool>`)
2. Add it to `devShells.default` in `flake.nix`
3. Run `nix flake check` and confirm it resolves in `nix develop`
4. If a Windows job needs it too, add a pinned fallback in
   `.github/actions/setup-toolchain` (Windows branch)

### SHA Pinning

Any third-party action added to a workflow **or** to the `setup-toolchain`
composite must be pinned to a full commit SHA — see
`.claude/rules/github-actions-sha-pinning.md`.

### Reference

See `flake.nix` for the dev shell toolchain, `rust-toolchain.toml` for the Rust
pin, and `.github/actions/setup-toolchain/action.yml` for the CI setup.
