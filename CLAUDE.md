# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Run ALL checks for ALL packages (REQUIRED before creating PR)
pnpm run check:all

# Run checks for core package only
pnpm run check:core

# Run checks for docs package only
pnpm run check:docs

# Run checks for video package only
pnpm run check:video

# Run in development mode
pnpm run dev <command>

# Run tests
pnpm run test

# Run a single test file
pnpm run test packages/core/src/path/to/test.ts

# Enable vibe shell function
source .vibedev
```

## Architecture

- **Runtime**: Bun-based CLI tool
- **Purpose**: Git worktree management (start, clean, trust, untrust, verify, config, upgrade)
- **CoW Optimization**: Copy-on-Write support for APFS, Btrfs, XFS filesystems

### Source Structure

```
packages/core/src/
├── commands/   # CLI command implementations
├── context/    # Context management
├── services/   # Business logic services
├── utils/      # Utility functions
├── runtime/    # Runtime abstraction layer
├── native/     # Native platform integrations
├── types/      # TypeScript type definitions
└── errors/     # Error handling
```
