# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Run all checks (fmt:check, lint, check, test)
deno task ci

# Run in development mode
deno task dev <command>

# Run tests
deno task test

# Run a single test file
deno test --allow-read --allow-env --allow-write --allow-run --allow-ffi src/path/to/test.ts

# Enable vibe shell function
source .vibedev
```

## Architecture

- **Runtime**: Deno v2.x-based CLI tool
- **Purpose**: Git worktree management (start, clean, trust, untrust, verify, config, upgrade)
- **Multi-runtime**: Supports both Deno and Node.js
- **CoW Optimization**: Copy-on-Write support for APFS, Btrfs, XFS filesystems

### Source Structure

```
src/
├── commands/   # CLI command implementations
├── context/    # Context management
├── services/   # Business logic services
├── utils/      # Utility functions
├── runtime/    # Runtime abstraction layer
├── native/     # Native platform integrations
├── types/      # TypeScript type definitions
└── errors/     # Error handling
```

## Branch Strategy

- `main`: Release versions only
- `develop`: Main development branch
- Topic branches should be created from `develop`

## PR/Commit Guidelines

- **Title format**: `<type>: <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- Write in English
- Follow GNU Coding Standards

## Security

- SHA-256 based configuration trust mechanism
- Use `Deno.Command` (avoid shell string execution)
- Path validation with `validatePath()`
