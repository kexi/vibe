/**
 * Tests for scripts/check-justfile-comments.ts — the gate that keeps
 * `just --list` from listing a recipe with nothing next to it.
 *
 * What these guarantee:
 *   - a recipe with a comment directly above it passes, and one without fails,
 *     which is the whole contract `just --list` depends on;
 *   - recipe BODIES cannot be mistaken for recipe headers, so a shell line that
 *     happens to end in `:` neither raises a false failure nor masks a real one;
 *   - `name := value` assignments are not treated as recipes, since they never
 *     appear in the listing and requiring comments on them would be noise;
 *   - a `[attribute]` between the comment and the recipe still counts as
 *     documented, because just attaches both to the same recipe;
 *   - the repository's own justfile passes, so the check and the file it guards
 *     cannot drift apart silently.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findUndocumentedRecipes } from "../../../scripts/check-justfile-comments.ts";

describe("findUndocumentedRecipes", () => {
  it("accepts a recipe whose comment sits directly above it", () => {
    const source = ["# Build the binary.", "build:", "    cargo build", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });

  it("reports a recipe with no comment above it, with its line number", () => {
    const source = ["# Build the binary.", "build:", "    cargo build", "", "test:", "    cargo test", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([{ name: "test", line: 5 }]);
  });

  it("reports the first recipe when the file opens with one", () => {
    expect(findUndocumentedRecipes("build:\n    cargo build\n")).toEqual([{ name: "build", line: 1 }]);
  });

  it("does not mistake an indented body line ending in ':' for a recipe", () => {
    // Without the column-0 anchor, `echo done:` would parse as a recipe header
    // and be reported — a false failure on a perfectly documented file.
    const source = ["# Build the binary.", "build:", "    echo done:", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });

  it("ignores `name := value` assignments", () => {
    // Assignments never appear in `just --list`, so demanding a comment on one
    // would fail a file that lists perfectly.
    const source = ["export RUST_LOG := \"info\"", "", "# Build the binary.", "build:", "    cargo build", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });

  it("treats a recipe as documented when an attribute separates it from its comment", () => {
    const source = ["# Internal helper.", "[private]", "helper:", "    true", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });

  it("still reports an attributed recipe that has no comment at all", () => {
    const source = ["[private]", "helper:", "    true", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([{ name: "helper", line: 2 }]);
  });

  it("accepts a recipe that takes parameters", () => {
    const source = ["# Run the binary.", "run *args:", "    cargo run -- {{args}}", ""].join("\n");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });

  it("passes on this repository's own justfile", () => {
    const source = readFileSync(new URL("../../../justfile", import.meta.url), "utf8");
    expect(findUndocumentedRecipes(source)).toEqual([]);
  });
});
