# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

`just` is the unified entrypoint (a thin facade over the pnpm scripts; run
`just` with no args to list recipes). The equivalent `pnpm run` command is shown
alongside each — both work.

```bash
# Run ALL checks (REQUIRED before creating PR):
# fmt:check + lint (oxfmt/oxlint on scripts) + check:rust + test:npm + test:e2e + check:docs + check:video
just check                   # = pnpm run check:all

# Rust (the shipped binary) — fmt + clippy + workspace tests
just check-rust              # = pnpm run check:rust

# Build the shipped Rust binary (release)
just build                   # = pnpm run build:rust (cargo build --manifest-path rust/Cargo.toml -p vibe --release)

# Run the Rust binary directly during development
just run -- <command>        # = cargo run --manifest-path rust/Cargo.toml -p vibe -- <command>

# npm launcher-shim tests (shim resolution + the surviving release scripts)
just test-npm                # = pnpm run test:npm

# E2E tests (build and drive the Rust debug binary through node-pty)
just test-e2e                # = pnpm run test:e2e

# Checks for docs / video packages only
just check-docs              # = pnpm run check:docs
just check-video             # = pnpm run check:video
```

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
