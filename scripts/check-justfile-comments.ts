#!/usr/bin/env bun

/**
 * Assert that every recipe in the justfile carries a description comment.
 *
 * `just --list` renders the comment on the line directly above a recipe as that
 * recipe's description, and that listing is the entrypoint contributors are
 * told to run. A recipe with no comment above it therefore appears in the list
 * as a bare name with nothing explaining it — which is exactly the recipe a
 * newcomer skips, and exactly the one that rots because nobody can tell what it
 * was for.
 *
 * Why parse the file rather than read `just --list`: an undocumented recipe is
 * still listed, just without text, so the listing cannot distinguish "no
 * description" from "description happens to be empty". The file can.
 *
 * Usage:
 *   bun run scripts/check-justfile-comments.ts [path]
 */

import { readFileSync } from "node:fs";

const DEFAULT_JUSTFILE = "justfile";

/**
 * A recipe header: a name at column 0, optional parameters, then `:`.
 *
 * Anchored at column 0 because recipe BODIES are indented, and a body line can
 * otherwise look like a header (`echo foo:` would match unanchored). Assignments
 * (`name := value`) are excluded by requiring the `:` not to be followed by `=`.
 */
const RECIPE_HEADER = /^([a-zA-Z_][a-zA-Z0-9_-]*)(\s+[^:]*)?:(?!=)/;

/** Lines that may sit between a comment and its recipe without breaking the pair. */
function isAttribute(line: string): boolean {
  // just attributes look like `[group('x')]` / `[private]` and attach to the
  // recipe below them, so a comment above an attribute still documents it.
  return line.trimStart().startsWith("[");
}

export interface UndocumentedRecipe {
  name: string;
  line: number;
}

/**
 * Recipes with no `#` comment on the line above (skipping attributes).
 *
 * A section banner such as `# --- Tests ---` counts as a comment for whatever
 * recipe follows it directly. That is deliberate: requiring a *distinct*
 * comment would mean rejecting a file that reads perfectly well, and the point
 * of the check is that `just --list` shows something, not that the something is
 * unique.
 */
export function findUndocumentedRecipes(source: string): UndocumentedRecipe[] {
  const lines = source.split("\n");
  const undocumented: UndocumentedRecipe[] = [];

  for (const [index, line] of lines.entries()) {
    const match = RECIPE_HEADER.exec(line);
    if (!match) continue;

    // Walk back over attributes to find the line that should carry the comment.
    let above = index - 1;
    while (above >= 0 && isAttribute(lines[above] ?? "")) above -= 1;

    const isDocumented = (lines[above] ?? "").trimStart().startsWith("#");
    if (!isDocumented) {
      undocumented.push({ name: match[1] ?? line, line: index + 1 });
    }
  }

  return undocumented;
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_JUSTFILE;
  const source = readFileSync(path, "utf8");
  const undocumented = findUndocumentedRecipes(source);

  if (undocumented.length === 0) {
    console.log(`✓ every recipe in ${path} has a description comment.`);
    return;
  }

  console.error(`${path}: ${undocumented.length} recipe(s) without a description comment:\n`);
  for (const { name, line } of undocumented) {
    console.error(`  ${path}:${line}  ${name}`);
  }
  console.error(
    `\nAdd a one-line \`# ...\` comment directly above each recipe. ` +
      `\`just --list\` renders it as the recipe's description.`,
  );
  process.exit(1);
}

if (import.meta.main) {
  main();
}
