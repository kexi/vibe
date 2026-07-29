# vibe — unified task entrypoint.
#
# Thin facade over the existing runners (pnpm / cargo). Each recipe delegates to
# the matching `package.json` script so command strings live in exactly one place
# (package.json stays the source of truth); this file only provides a single,
# memorable front door instead of three scattered ones (pnpm / cargo / bun).
#
# Why not name recipes `check:rust` to match the pnpm scripts? `:` is just's
# module-path separator, so recipe names use `-` (e.g. `check-rust`). The pnpm
# script names themselves are unchanged.
# Why not inline `--manifest-path rust/Cargo.toml` here? It already lives in the
# pnpm scripts; the only cargo call we make directly is `run`, which has no pnpm
# script to defer to.

# Default: list available recipes.
default:
    @just --list

# --- Aggregate check ---

# All checks required before opening a PR (fmt:check + lint + check:rust + check:licenses + test:npm + test:e2e + check:docs).
check:
    pnpm run check:all

# --- Build / run ---

# Build the shipped Rust binary (release).
build:
    pnpm run build:rust

# Run the Rust binary directly during development, e.g. `just run -- start`.
run *args:
    cargo run --manifest-path rust/Cargo.toml -p vibe -- {{args}}

# --- Individual checks ---

# Rust (shipped binary) — fmt + clippy + workspace tests.
check-rust:
    pnpm run check:rust

# Third-party license notices — THIRD-PARTY-LICENSES.md freshness + the ring link guard.
check-licenses:
    pnpm run check:licenses

# Docs package checks only (lint + format + check).
check-docs:
    pnpm run check:docs

# --- Format / lint (TS/JS via oxfmt/oxlint) ---

fmt:
    pnpm run fmt

fmt-check:
    pnpm run fmt:check

lint:
    pnpm run lint

lint-fix:
    pnpm run lint:fix

# --- Tests ---

# npm launcher-shim tests.
test-npm:
    pnpm run test:npm

# E2E tests — build and drive the Rust debug binary.
test-e2e:
    pnpm run test:e2e

# --- Version bump / manifest validation ---

# Version-bump / validate manifests via kt3k/bmp (no args = validate; -p/-m/-j to bump).
bmp *args:
    pnpm run bmp -- {{args}}

# --- Setup / chores ---

install:
    pnpm install

clean:
    pnpm run clean

# --- Docs dev server (per-package) ---

docs-dev:
    pnpm -C packages/docs dev
