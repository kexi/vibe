/**
 * Build output verification tests
 *
 * Ensures that the bundled dist/main.js doesn't contain external @jsr imports
 * that would require JSR registry configuration.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("build output", () => {
  const distPath = join(import.meta.dirname, "../dist/main.js");

  it("dist/main.js should exist", () => {
    const exists = existsSync(distPath);
    expect(exists).toBe(true);
  });

  it("dist/main.js should not contain external @jsr imports", () => {
    const dist = readFileSync(distPath, "utf-8");

    // Check for import statements from @jsr packages
    const hasJsrImport = /from ['"]@jsr\//.test(dist);
    expect(hasJsrImport).toBe(false);

    // Check for dynamic imports from @jsr packages
    const hasDynamicJsrImport = /import\(['"]@jsr\//.test(dist);
    expect(hasDynamicJsrImport).toBe(false);
  });

  it("dist/main.js should have zod as external dependency", () => {
    const dist = readFileSync(distPath, "utf-8");

    // zod should remain as external dependency
    const hasZodImport = /from ['"]zod['"]/.test(dist);
    expect(hasZodImport).toBe(true);
  });
});
