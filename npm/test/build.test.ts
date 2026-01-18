/**
 * Build output verification tests
 *
 * Ensures that the bundled dist/main.js doesn't contain external @jsr imports
 * that would require JSR registry configuration.
 *
 * These tests are skipped if dist/main.js doesn't exist (e.g., in CI before build).
 * Run `pnpm run build` first to execute these tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("build output", () => {
  const distPath = join(import.meta.dirname, "../dist/main.js");
  const distExists = existsSync(distPath);

  it.skipIf(!distExists)(
    "dist/main.js should not contain external @jsr imports",
    () => {
      const dist = readFileSync(distPath, "utf-8");

      // Check for import statements from @jsr packages
      const hasJsrImport = /from ['"]@jsr\//.test(dist);
      expect(hasJsrImport).toBe(false);

      // Check for dynamic imports from @jsr packages
      const hasDynamicJsrImport = /import\(['"]@jsr\//.test(dist);
      expect(hasDynamicJsrImport).toBe(false);
    },
  );

  it.skipIf(!distExists)(
    "dist/main.js should have zod as external dependency",
    () => {
      const dist = readFileSync(distPath, "utf-8");

      // zod should remain as external dependency
      const hasZodImport = /from ['"]zod['"]/.test(dist);
      expect(hasZodImport).toBe(true);
    },
  );
});
