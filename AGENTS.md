# AGENTS.md

## Branch Strategy

| Branch    | Purpose                                           |
| --------- | ------------------------------------------------- |
| `main`    | For releases. Stable versions only.               |
| `develop` | For development. Merge target for topic branches. |

### Workflow

1. Create a topic branch from `develop`
2. After completing work, merge into `develop`
3. When releasing, merge `develop` into `main`

```
main ────●─────────────────●────
         │                 ↑
develop ─┴──●──●──●──●─────┴────
             ↑  ↑
            feat/a feat/b
```

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

## Development Environment

- Toolchain: provided by `nix develop` (Rust via rustup, plus pnpm/node/bun for
  the docs/e2e packages and the TS release scripts)
- Run: `cargo run --manifest-path rust/Cargo.toml -p vibe -- <command>`
- Build (release): `pnpm run build:rust`
  (`cargo build --manifest-path rust/Cargo.toml -p vibe --release`)

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

- Lint check (TS scripts): `pnpm run lint`
- Format check (TS scripts): `pnpm run fmt:check`
- Rust checks (fmt + clippy + tests): `pnpm run check:rust`
- npm shim / release-script tests: `pnpm run test:npm`
- E2E tests: `pnpm run test:e2e`
- Run all checks: `pnpm run check:all`
  (fmt:check, lint, check:rust, test:npm, test:e2e, check:docs)
- All checks must pass before committing

## Documentation

- Source code comments and documentation: English
- `*.ja.md` files: Japanese

## PR Guidelines

- Title format: `<type>: <description>`
  - type: feat, fix, docs, refactor, test, chore
- PR title and description must be written in English
- Must pass `pnpm run lint` and `pnpm run fmt:check`
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
