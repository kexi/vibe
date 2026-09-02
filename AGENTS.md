# AGENTS.md

## Branch Strategy

GitHub Flow: `main` is the only long-lived branch.

| Branch | Purpose                                                 |
| ------ | ------------------------------------------------------- |
| `main` | The single long-lived branch. Every PR targets it.      |
| topic  | Short-lived, branched from `main`, deleted when merged. |

### Workflow

1. Create a topic branch from `main`
2. Open a PR into `main`; merge it once CI is green
3. To release, bump the version on a `release/vX.Y.Z` branch, merge that PR,
   then dispatch the Release workflow on `main` — it creates the tag

```
main ──●──●──●──●──●──●────
       ↑  ↑     ↑     ↑
    feat/a  fix/b  release/v4.1.0
                         │
                      tag v4.1.0
```

There is no `develop` branch and no release branch that outlives its PR. A
release is a tag on `main`, never a separate line of history.

### Why the heavy CI runs after the merge

A PR gets the light gate (lint, macOS tests, docs, pinact, gitleaks). The full
matrix — Linux, Windows, cross-built binaries, `.deb`, e2e, the npm install
matrix — runs on the push to `main`, i.e. right after the merge. Add the
`ci-full` label to a PR to pull the Windows leg forward when a change touches
Windows-specific behavior.

Nothing ships from `main` directly: the Release workflow rebuilds every artifact
from the tag it creates, so a red post-merge run blocks a release rather than
reaching users.

## Supported Platforms

### OS

| OS      | Architectures | Notes                                  |
| ------- | ------------- | -------------------------------------- |
| macOS   | x64, ARM64    | Homebrew available                     |
| Linux   | x64, ARM64    | .deb package available (Ubuntu/Debian) |
| Windows | x64           | Native npm package available           |

WSL2 is also supported via Linux binaries.

### Filesystem (Copy-on-Write Optimization)

| Filesystem | Platform | CoW Support               |
| ---------- | -------- | ------------------------- |
| APFS       | macOS    | Yes                       |
| Btrfs      | Linux    | Yes                       |
| XFS        | Linux    | Yes                       |
| Others     | All      | Fallback to standard copy |

### Shell

- Zsh
- Bash
- Fish
- Nushell
- PowerShell

## Architecture

- **Implementation**: Rust binary (`rust/crates/vibe`); the worktree-management
  logic lives in `rust/crates/vibe-core`, with the CoW clone code in
  `rust/crates/vibe-native` (statically linked). The dead TypeScript
  implementation was removed in Phase 6.
- **Distribution**: npm ships a thin launcher shim (`packages/npm/bin/vibe.cjs`)
  whose `optionalDependencies` are the four per-platform binary packages
  (`packages/vibe-{linux,darwin}-{x64,arm64}`); the shim execs the binary for the
  host platform. Homebrew (`Formula/`) and a `.deb` are also published.
- **Purpose**: Git worktree management (start, clean, trust, untrust, verify, config, upgrade)
- **CoW Optimization**: Copy-on-Write support for APFS, Btrfs, XFS filesystems
- **Package Manager**: pnpm (monorepo). The surviving TS release scripts under
  `scripts/` are run by `bun` (kept in the Nix dev shell as the script runner).

## Development Environment

`just` is the entrypoint for every task. Run it with no arguments to list the
recipes with their descriptions. Do not invoke `pnpm run` or `cargo` directly:
the recipes give one name per task, and they wrap the `package.json` scripts
that CI invokes, so local and CI runs cannot drift.

- Toolchain: provided by `nix develop` (Rust via rustup, plus pnpm/node/bun for
  the docs/e2e packages and the TS release scripts)
- Run: `just run -- <command>`
- Build (release): `just build`

## CLI Guidelines

- Follow [GNU Coding Standards](https://www.gnu.org/prep/standards/) for command-line interface design
  - Support `--help` and `--version` options
  - Use long options with `--` prefix (e.g., `--verbose`)
  - Use short options with `-` prefix (e.g., `-v`)

## Coding Guidelines

### SOLID Principles

Code should follow SOLID principles:

- **S**ingle Responsibility Principle: A class or function should have only one
  reason to change
- **O**pen/Closed Principle: Open for extension, closed for modification
- **L**iskov Substitution Principle: Subtypes must be substitutable for their
  base types
- **I**nterface Segregation Principle: Clients should not be forced to depend on
  methods they do not use
- **D**ependency Inversion Principle: High-level modules should not depend on
  low-level modules; both should depend on abstractions

## Testing

Run tasks through `just`; `just` with no arguments lists every recipe.

- Lint check (TS scripts): `just lint`
- Format check (TS scripts): `just fmt-check`
- Justfile hygiene (format + a comment on every recipe): `just check-just`
- Rust checks (fmt + clippy + tests): `just check-rust`
- npm shim / release-script tests: `just test-npm`
- E2E tests: `just test-e2e`
- Run all checks: `just check`
- All checks must pass before committing

## Documentation

- Source code comments and documentation: English
- `*.ja.md` files: Japanese

## PR Guidelines

- Title format: `<type>: <description>`
  - type: feat, fix, docs, refactor, test, chore
- PR title and description must be written in English
- Must pass `just lint` and `just fmt-check`
- Add or update tests for changed code

## Release

- After merging to `main`, dispatch the Release workflow; do NOT create a tag
  or a GitHub Release by hand (the workflow builds the binaries first, then
  creates and publishes the release with all assets — the Immutable
  Releases-safe order)
- Steps:
  1. `gh workflow run release.yml --ref main`
  2. Watch the run: resolve the fresh run id first, then
     `gh run watch <run-id> --exit-status` (see CONTRIBUTING.md "Releasing a
     New Version" step 3 for the polling snippet; version comes from
     `package.json` on main)
  3. npm publish (`publish-npm.yml`) follows automatically via `workflow_run`
