# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Run ALL checks (REQUIRED before creating PR):
# fmt:check + lint (oxfmt/oxlint on scripts) + check:rust + test:npm + check:docs + check:video
# NOTE: check:all does NOT run test:e2e (it needs a built binary); CI's e2e-test
# job gates that. Run `pnpm run test:e2e` manually when touching command behavior.
pnpm run check:all

# Rust (the shipped binary) — fmt + clippy + workspace tests
pnpm run check:rust

# Build the shipped Rust binary (release)
pnpm run build:rust          # cargo build --manifest-path rust/Cargo.toml -p vibe --release

# Run the Rust binary directly during development
cargo run --manifest-path rust/Cargo.toml -p vibe -- <command>

# npm launcher-shim tests (shim resolution + the surviving release scripts)
pnpm run test:npm

# E2E tests (drive the built binary through node-pty)
pnpm run test:e2e

# Checks for docs / video packages only
pnpm run check:docs
pnpm run check:video
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
