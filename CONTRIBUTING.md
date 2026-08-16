# Contributing

Thank you for your interest in contributing to vibe!

## Development Setup

The development toolchain is provided by a Nix flake dev shell. Enter it with:

```bash
nix develop
```

Or, with [direnv](https://direnv.net/), allow the included `.envrc` once and the
shell loads automatically on `cd`:

```bash
direnv allow
```

## Running vibe in Development

vibe is a Rust binary. Run it directly with cargo:

```bash
cargo run --manifest-path rust/Cargo.toml -p vibe -- start feat/my-feature
cargo run --manifest-path rust/Cargo.toml -p vibe -- clean
```

Build a release binary (the artifact that ships) with:

```bash
pnpm run build:rust   # -> rust/target/release/vibe
```

Note: `vibe start` outputs shell commands for directory navigation, so wrap it
in `eval "$(vibe start ...)"` when you want it to change the current directory.

## Available Tasks

All tasks are defined in `package.json` to ensure consistency between local development and CI:

```bash
# Run all checks (same as CI runs)
pnpm run check:all

# Individual checks
pnpm run fmt:check     # Check TS-script formatting (oxfmt)
pnpm run lint          # Run linter (oxlint) on the TS scripts
pnpm run check:rust    # Rust: cargo fmt --check + clippy -D warnings + workspace tests
pnpm run test:npm      # npm launcher-shim + release-script tests
pnpm run test:e2e      # Build and run E2E tests against the Rust debug binary
pnpm run check:docs    # Docs package checks

# Auto-fix formatting
pnpm run fmt           # TS scripts (oxfmt)
pnpm run fmt:rust      # Rust (cargo fmt)
```

## Running CI Checks Locally

Before pushing, run the same checks that CI will run:

```bash
pnpm run check:all
```

This runs:

1. Format check (`pnpm run fmt:check`)
2. Linter (`pnpm run lint`)
3. Rust checks (`pnpm run check:rust`)
4. npm shim / release-script tests (`pnpm run test:npm`)
5. E2E tests (`pnpm run test:e2e`)
6. Docs checks (`pnpm run check:docs`)

## Release Process

### Branching Model

This project follows the git-flow branching model:

- `develop` - Active development branch. All feature branches merge here.
- `main` - Stable release branch. Only receives merges from develop during releases.

See [AGENTS.md](./AGENTS.md) for detailed branching workflow.

### Releasing a New Version

1. **Prepare the release on develop:**

   ```bash
   # Ensure you're on develop and up to date
   git checkout develop
   git pull origin develop

   # Update version in package.json
   # Update CHANGELOG if you maintain one

   # Commit version bump
   git add package.json
   git commit -m "chore: Bump version to vX.X.X"
   git push origin develop
   ```

2. **Sync main with develop:**

   Since main branch has protection rules, you must create a pull request:

   ```bash
   # Create a sync branch from develop
   git checkout -b chore/release-vX.X.X
   git push origin chore/release-vX.X.X

   # Create PR targeting main
   gh pr create --base main --title "chore: Release vX.X.X" \
     --body "Sync main with develop for vX.X.X release"
   ```

   After the PR is merged:

3. **Run the Release workflow:**

   Do **not** create the tag or the GitHub release by hand. The Release
   workflow builds the binaries first and only then creates and publishes the
   GitHub Release with every asset attached — the tag is created at publish
   time, pointing at the exact commit that was built. This is the order
   Immutable Releases requires (a published release's tag and assets are
   frozen, so nothing can be added afterwards).

   ```bash
   gh workflow run release.yml --ref main

   # Optionally pass hand-written release notes (empty = auto-generated):
   #   gh workflow run release.yml --ref main -F notes=@notes.md
   # Rehearse without publishing (builds, verifies a draft, deletes it):
   #   gh workflow run release.yml --ref main -f dry_run=true

   # Watch it finish, then confirm the release is published. Wait (max ~3 min)
   # for the fresh (not yet completed) run so a stale earlier run is never
   # watched.
   tries=0
   until RUN_ID=$(gh run list --workflow=release.yml --limit 1 \
     --json databaseId,status --jq '.[0] | select(.status != "completed") | .databaseId') \
     && [ -n "$RUN_ID" ]; do
     tries=$((tries + 1))
     [ "$tries" -lt 60 ] || { echo "error: no new release.yml run appeared" >&2; exit 1; }
     sleep 3
   done
   gh run watch "$RUN_ID" --exit-status
   gh release view vX.X.X
   ```

   The workflow reads the version from `package.json` on main. npm publishing
   (`publish-npm.yml`) follows automatically once the Release workflow
   succeeds; a re-run of either workflow is safe (idempotency guards skip
   what is already published). To heal a post-publish mirror failure (e.g.
   update-homebrew), re-run the **original** run — either "Re-run failed jobs"
   or "Re-run all jobs" now resumes against the published release instead of
   skipping the pipeline green. Do not dispatch a fresh run to recover: the
   workflow refuses one whose commit differs from the one the release targets.
   Re-run promptly, as update-homebrew skips with a warning once a newer
   release has superseded this one.

4. **Update Nix binary hashes, if needed:**

   The default Nix package builds from source. The prebuilt binary fast path
   (`#binary`) needs `flake.nix` hashes that match the final GitHub Release
   assets, so update those hashes only after the release workflow uploads the
   assets.

   ```fish
   set -l version X.X.X
   mkdir -p artifacts
   gh release download "v$version" --pattern 'vibe-*' --dir artifacts

   for file in darwin-arm64 darwin-x64 linux-arm64 linux-x64
     set -l sri (nix hash file --type sha256 --sri "artifacts/vibe-$file")
     printf "%s %s\n" "$file" "$sri"
   end
   ```

   Copy the SRI hashes into the matching `platforms.*.hash` entries in
   `flake.nix`, then verify and open a PR against `develop`:

   ```fish
   nix build .#binary; and ./result/bin/vibe --help
   git checkout -b chore/update-nix-binary-hashes-vX.X.X
   git add flake.nix
   git commit -m "chore: update Nix binary hashes for X.X.X"
   git push -u origin chore/update-nix-binary-hashes-vX.X.X
   gh pr create --base develop --title "chore: update Nix binary hashes for X.X.X" --body "Updates flake.nix binary hashes for vX.X.X release assets."
   ```

   Do not update `flake.lock` as part of the release. Update `nixpkgs` in a
   separate maintenance PR when needed.

### Automated Release Tasks

When the Release workflow is dispatched, GitHub Actions automatically:

1. Builds binaries for each platform (plus `.deb` packages)
2. Creates and publishes the GitHub Release with all assets attached
   (the tag is created at publish time)
3. Updates the homebrew-tap formula
4. Publishes the npm packages (`publish-npm.yml`, via `workflow_run`)

### Required Secrets

The release workflow requires the `HOMEBREW_TAP_TOKEN` secret.

#### Creating a Fine-grained Personal Access Token

1. Go to https://github.com/settings/personal-access-tokens/new

2. Configure the following:
   - **Token name:** `homebrew-tap-updater`
   - **Expiration:** 90 days (or your preference)
   - **Repository access:** `Only select repositories` → `kexi/homebrew-tap`
   - **Permissions:**
     - **Contents:** Read and write

3. Click `Generate token` and copy the token

#### Setting the Secret

```bash
gh secret set HOMEBREW_TAP_TOKEN
# Paste the token when prompted
```

### Creating a Release

```bash
gh workflow run release.yml --ref main
```

Never `git tag` or `gh release create` by hand — the workflow creates the tag
when it publishes the release (see "Releasing a New Version" above).

## CLI Guidelines

This project follows [GNU Coding Standards](https://www.gnu.org/prep/standards/) for command-line interface design:

- Support `--help` and `--version` options
- Use long options with `--` prefix (e.g., `--verbose`)
- Use short options with `-` prefix (e.g., `-v`)

## License

vibe is released under the MIT License (see [LICENSE](LICENSE)). By submitting a
contribution, you agree that it is licensed under the same terms as the project
itself — inbound license equals outbound license. No separate CLA is required.

Releases up to and including v2.x were published under Apache-2.0; MIT applies
from v3.0.0 onward (see [#553](https://github.com/kexi/vibe/issues/553)).

## Security Guidelines

When contributing to vibe, please keep these security considerations in mind:

### Input Validation

- Always validate user inputs, especially file paths and branch names
- Use `validate_path()` from `rust/crates/vibe-core/src/copy/types.rs` for path validation
- Check for null bytes, newlines, and shell command substitution patterns

### External Command Execution

- Use `std::process::Command` with argument arrays, not shell strings, to prevent injection
- Never pass untrusted input directly to shell commands
- The `run_hooks()` function in `rust/crates/vibe-core/src/hooks.rs` executes user-defined commands - this is intentional, but the trust mechanism must be respected

### Trust Mechanism

- The trust system (`rust/crates/vibe-core/src/settings_io.rs`) uses SHA-256 hashes to verify configuration file integrity
- Trust is repository-based (identified by remote URL or repo root)
- Always require explicit user consent before executing hook commands from untrusted sources

### File Operations

- Use atomic file operations (temp file + rename) for settings to prevent corruption
- Validate paths before copy operations to prevent directory traversal
- The `TOCTOU` (time-of-check to time-of-use) race condition is addressed in `verify_trust_and_read()` (`rust/crates/vibe-core/src/settings_io.rs`) - this function reads the file content and verifies its hash atomically, preventing attackers from modifying the file between the check and use

### Reporting Security Issues

If you discover a security vulnerability, please report it by creating a private security advisory on GitHub rather than opening a public issue.
