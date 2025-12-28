import { assertEquals } from "@std/assert";
import { expandCopyPatterns, expandGlobPattern, isGlobPattern } from "./glob.ts";
import { join } from "@std/path";

Deno.test("isGlobPattern: detects glob patterns", () => {
  // Should detect glob patterns
  assertEquals(isGlobPattern("*.env"), true);
  assertEquals(isGlobPattern("**/*.json"), true);
  assertEquals(isGlobPattern("config/*.txt"), true);
  assertEquals(isGlobPattern("file?.txt"), true);
  assertEquals(isGlobPattern("file[123].txt"), true);
  assertEquals(isGlobPattern("file{a,b}.txt"), true);

  // Should not detect exact paths
  assertEquals(isGlobPattern(".env"), false);
  assertEquals(isGlobPattern("config/file.txt"), false);
  assertEquals(isGlobPattern("dir/subdir/file.json"), false);
});

Deno.test("expandGlobPattern: expands simple wildcard", async () => {
  // Create a temporary directory structure
  const tempDir = await Deno.makeTempDir();

  try {
    // Create test files
    await Deno.writeTextFile(join(tempDir, ".env"), "");
    await Deno.writeTextFile(join(tempDir, ".env.local"), "");
    await Deno.writeTextFile(join(tempDir, "config.json"), "");

    // Test simple wildcard
    const result = await expandGlobPattern("*.env*", tempDir);

    // Should match .env and .env.local (sorted)
    assertEquals(result.sort(), [".env", ".env.local"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: expands recursive wildcard", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create nested directory structure
    await Deno.mkdir(join(tempDir, "config"), { recursive: true });
    await Deno.mkdir(join(tempDir, "src/lib"), { recursive: true });

    // Create test files
    await Deno.writeTextFile(join(tempDir, "package.json"), "");
    await Deno.writeTextFile(join(tempDir, "config/settings.json"), "");
    await Deno.writeTextFile(join(tempDir, "src/lib/data.json"), "");
    await Deno.writeTextFile(join(tempDir, "readme.txt"), "");

    // Test recursive wildcard
    const result = await expandGlobPattern("**/*.json", tempDir);

    // Should match all JSON files recursively
    assertEquals(result.sort(), [
      "config/settings.json",
      "package.json",
      "src/lib/data.json",
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: expands directory wildcard", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create directory structure
    await Deno.mkdir(join(tempDir, "config"), { recursive: true });

    // Create test files
    await Deno.writeTextFile(join(tempDir, "config/dev.txt"), "");
    await Deno.writeTextFile(join(tempDir, "config/prod.txt"), "");
    await Deno.writeTextFile(join(tempDir, "config/settings.json"), "");
    await Deno.writeTextFile(join(tempDir, "readme.txt"), "");

    // Test directory wildcard
    const result = await expandGlobPattern("config/*.txt", tempDir);

    // Should match only .txt files in config/
    assertEquals(result.sort(), ["config/dev.txt", "config/prod.txt"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: returns empty array for no matches", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create a file that won't match
    await Deno.writeTextFile(join(tempDir, "file.txt"), "");

    // Pattern that matches nothing
    const result = await expandGlobPattern("*.json", tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: only includes files, not directories", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create directories and files
    await Deno.mkdir(join(tempDir, "dir1"));
    await Deno.mkdir(join(tempDir, "dir2"));
    await Deno.writeTextFile(join(tempDir, "file1.txt"), "");
    await Deno.writeTextFile(join(tempDir, "file2.txt"), "");

    // Pattern that could match both files and directories
    const result = await expandGlobPattern("*", tempDir);

    // Should only include files
    assertEquals(result.sort(), ["file1.txt", "file2.txt"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandCopyPatterns: handles mix of exact paths and patterns", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create test files
    await Deno.writeTextFile(join(tempDir, ".env"), "");
    await Deno.writeTextFile(join(tempDir, ".env.local"), "");
    await Deno.writeTextFile(join(tempDir, "config.json"), "");

    // Mix of exact path and pattern
    const result = await expandCopyPatterns(
      [".env", "*.json"],
      tempDir,
    );

    assertEquals(result.sort(), [".env", "config.json"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandCopyPatterns: deduplicates files", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create test file
    await Deno.writeTextFile(join(tempDir, ".env"), "");
    await Deno.writeTextFile(join(tempDir, ".env.local"), "");

    // Pattern and exact path that overlap
    const result = await expandCopyPatterns(
      [".env*", ".env"],
      tempDir,
    );

    // .env should appear only once
    assertEquals(result, [".env", ".env.local"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandCopyPatterns: maintains order", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create test files
    await Deno.writeTextFile(join(tempDir, "a.txt"), "");
    await Deno.writeTextFile(join(tempDir, "b.txt"), "");
    await Deno.writeTextFile(join(tempDir, "c.txt"), "");

    // Order should be preserved
    const result = await expandCopyPatterns(
      ["c.txt", "a.txt", "b.txt"],
      tempDir,
    );

    assertEquals(result, ["c.txt", "a.txt", "b.txt"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandCopyPatterns: handles empty array", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandCopyPatterns([], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandCopyPatterns: handles pattern with no matches", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create a file
    await Deno.writeTextFile(join(tempDir, "file.txt"), "");

    // Pattern that matches nothing
    const result = await expandCopyPatterns(
      ["*.json", "*.env"],
      tempDir,
    );

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
