import { assertEquals } from "@std/assert";
import {
  expandCopyPatterns,
  expandDirectoryPatterns,
  expandGlobPattern,
  isGlobPattern,
} from "./glob.ts";
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

Deno.test("expandGlobPattern: prevents path traversal attacks", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create a file outside the temp directory to test path traversal
    const parentDir = join(tempDir, "..");
    const outsideFile = join(parentDir, "outside.txt");
    await Deno.writeTextFile(outsideFile, "sensitive data");

    // Try to access file outside repoRoot using path traversal
    const result = await expandGlobPattern("../*.txt", tempDir);

    // Should return empty array (files outside repoRoot are filtered)
    assertEquals(result, []);

    // Clean up
    await Deno.remove(outsideFile);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: handles absolute paths safely", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Absolute path patterns should not match or should be handled safely
    const result = await expandGlobPattern("/etc/passwd", tempDir);

    // Should return empty array
    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandGlobPattern: handles symlinks", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create a real file
    await Deno.writeTextFile(join(tempDir, "real.txt"), "content");

    // Create a symlink to it
    await Deno.symlink(
      join(tempDir, "real.txt"),
      join(tempDir, "link.txt"),
    );

    // Glob should include real files (symlinks may or may not be followed)
    const result = await expandGlobPattern("*.txt", tempDir);

    // Should at minimum include the real file
    // Note: expandGlob behavior with symlinks follows Deno's default behavior
    assertEquals(result.includes("real.txt"), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ===== Directory Pattern Tests =====

Deno.test("expandDirectoryPatterns: expands exact directory path", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, "node_modules"));

    const result = await expandDirectoryPatterns(["node_modules"], tempDir);

    assertEquals(result, ["node_modules"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: expands glob pattern for directories", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, ".cache"));
    await Deno.mkdir(join(tempDir, ".config"));
    await Deno.writeTextFile(join(tempDir, ".env"), ""); // File should not be included

    const result = await expandDirectoryPatterns([".*"], tempDir);

    assertEquals(result.sort(), [".cache", ".config"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: skips non-existent directories", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandDirectoryPatterns(["nonexistent"], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: prevents path traversal", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandDirectoryPatterns(["../"], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: rejects absolute paths", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandDirectoryPatterns(["/etc", "/tmp"], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: rejects null byte injection", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandDirectoryPatterns(["dir\0name"], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: deduplicates directories", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, "vendor"));

    const result = await expandDirectoryPatterns(["vendor", "vendor"], tempDir);

    assertEquals(result, ["vendor"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: handles nested directories with glob", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, "packages/pkg-a"), { recursive: true });
    await Deno.mkdir(join(tempDir, "packages/pkg-b"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "packages/file.txt"), ""); // File should not be included

    const result = await expandDirectoryPatterns(["packages/*"], tempDir);

    assertEquals(result.sort(), ["packages/pkg-a", "packages/pkg-b"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: handles empty array", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const result = await expandDirectoryPatterns([], tempDir);

    assertEquals(result, []);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: maintains order", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, "aaa"));
    await Deno.mkdir(join(tempDir, "bbb"));
    await Deno.mkdir(join(tempDir, "ccc"));

    const result = await expandDirectoryPatterns(["ccc", "aaa", "bbb"], tempDir);

    assertEquals(result, ["ccc", "aaa", "bbb"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("expandDirectoryPatterns: does not include files", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(tempDir, "dir1"));
    await Deno.writeTextFile(join(tempDir, "file1.txt"), "");

    const result = await expandDirectoryPatterns(["*"], tempDir);

    assertEquals(result, ["dir1"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
