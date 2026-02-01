import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandCopyPatterns,
  expandDirectoryPatterns,
  expandGlobPattern,
  isGlobPattern,
} from "./glob.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real Deno runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

describe("isGlobPattern", () => {
  it("detects glob patterns", () => {
    // Should detect glob patterns
    expect(isGlobPattern("*.env")).toBe(true);
    expect(isGlobPattern("**/*.json")).toBe(true);
    expect(isGlobPattern("config/*.txt")).toBe(true);
    expect(isGlobPattern("file?.txt")).toBe(true);
    expect(isGlobPattern("file[123].txt")).toBe(true);
    expect(isGlobPattern("file{a,b}.txt")).toBe(true);

    // Should not detect exact paths
    expect(isGlobPattern(".env")).toBe(false);
    expect(isGlobPattern("config/file.txt")).toBe(false);
    expect(isGlobPattern("dir/subdir/file.json")).toBe(false);
  });
});

describe("expandGlobPattern", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("expands simple wildcard", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create test files
    await writeFile(join(tempDir, ".env"), "");
    await writeFile(join(tempDir, ".env.local"), "");
    await writeFile(join(tempDir, "config.json"), "");

    // Test simple wildcard
    const result = await expandGlobPattern("*.env*", tempDir);

    // Should match .env and .env.local (sorted)
    expect(result.sort()).toEqual([".env", ".env.local"]);
  });

  it("expands recursive wildcard", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create nested directory structure
    await mkdir(join(tempDir, "config"), { recursive: true });
    await mkdir(join(tempDir, "src/lib"), { recursive: true });

    // Create test files
    await writeFile(join(tempDir, "package.json"), "");
    await writeFile(join(tempDir, "config/settings.json"), "");
    await writeFile(join(tempDir, "src/lib/data.json"), "");
    await writeFile(join(tempDir, "readme.txt"), "");

    // Test recursive wildcard
    const result = await expandGlobPattern("**/*.json", tempDir);

    // Should match all JSON files recursively
    expect(result.sort()).toEqual(["config/settings.json", "package.json", "src/lib/data.json"]);
  });

  it("expands directory wildcard", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create directory structure
    await mkdir(join(tempDir, "config"), { recursive: true });

    // Create test files
    await writeFile(join(tempDir, "config/dev.txt"), "");
    await writeFile(join(tempDir, "config/prod.txt"), "");
    await writeFile(join(tempDir, "config/settings.json"), "");
    await writeFile(join(tempDir, "readme.txt"), "");

    // Test directory wildcard
    const result = await expandGlobPattern("config/*.txt", tempDir);

    // Should match only .txt files in config/
    expect(result.sort()).toEqual(["config/dev.txt", "config/prod.txt"]);
  });

  it("returns empty array for no matches", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create a file that won't match
    await writeFile(join(tempDir, "file.txt"), "");

    // Pattern that matches nothing
    const result = await expandGlobPattern("*.json", tempDir);

    expect(result).toEqual([]);
  });

  it("only includes files, not directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create directories and files
    await mkdir(join(tempDir, "dir1"));
    await mkdir(join(tempDir, "dir2"));
    await writeFile(join(tempDir, "file1.txt"), "");
    await writeFile(join(tempDir, "file2.txt"), "");

    // Pattern that could match both files and directories
    const result = await expandGlobPattern("*", tempDir);

    // Should only include files
    expect(result.sort()).toEqual(["file1.txt", "file2.txt"]);
  });

  it("prevents path traversal attacks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create a file outside the temp directory to test path traversal
    const parentDir = join(tempDir, "..");
    const outsideFile = join(parentDir, "outside.txt");
    await writeFile(outsideFile, "sensitive data");

    try {
      // Try to access file outside repoRoot using path traversal
      const result = await expandGlobPattern("../*.txt", tempDir);

      // Should return empty array (files outside repoRoot are filtered)
      expect(result).toEqual([]);
    } finally {
      // Clean up
      await rm(outsideFile);
    }
  });

  it("handles absolute paths safely", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Absolute path patterns should not match or should be handled safely
    const result = await expandGlobPattern("/etc/passwd", tempDir);

    // Should return empty array
    expect(result).toEqual([]);
  });

  it("handles symlinks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create a real file
    await writeFile(join(tempDir, "real.txt"), "content");

    // Create a symlink to it
    await symlink(join(tempDir, "real.txt"), join(tempDir, "link.txt"));

    // Glob should include real files (symlinks may or may not be followed)
    const result = await expandGlobPattern("*.txt", tempDir);

    // Should at minimum include the real file
    // Note: expandGlob behavior with symlinks follows Deno's default behavior
    expect(result.includes("real.txt")).toBe(true);
  });
});

describe("expandCopyPatterns", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("handles mix of exact paths and patterns", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create test files
    await writeFile(join(tempDir, ".env"), "");
    await writeFile(join(tempDir, ".env.local"), "");
    await writeFile(join(tempDir, "config.json"), "");

    // Mix of exact path and pattern
    const result = await expandCopyPatterns([".env", "*.json"], tempDir);

    expect(result.sort()).toEqual([".env", "config.json"]);
  });

  it("deduplicates files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create test file
    await writeFile(join(tempDir, ".env"), "");
    await writeFile(join(tempDir, ".env.local"), "");

    // Pattern and exact path that overlap
    const result = await expandCopyPatterns([".env*", ".env"], tempDir);

    // .env should appear only once
    expect(result).toEqual([".env", ".env.local"]);
  });

  it("maintains order", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create test files
    await writeFile(join(tempDir, "a.txt"), "");
    await writeFile(join(tempDir, "b.txt"), "");
    await writeFile(join(tempDir, "c.txt"), "");

    // Order should be preserved
    const result = await expandCopyPatterns(["c.txt", "a.txt", "b.txt"], tempDir);

    expect(result).toEqual(["c.txt", "a.txt", "b.txt"]);
  });

  it("handles empty array", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandCopyPatterns([], tempDir);

    expect(result).toEqual([]);
  });

  it("handles pattern with no matches", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    // Create a file
    await writeFile(join(tempDir, "file.txt"), "");

    // Pattern that matches nothing
    const result = await expandCopyPatterns(["*.json", "*.env"], tempDir);

    expect(result).toEqual([]);
  });
});

describe("expandDirectoryPatterns", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("expands exact directory path", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, "node_modules"));

    const result = await expandDirectoryPatterns(["node_modules"], tempDir);

    expect(result).toEqual(["node_modules"]);
  });

  it("expands glob pattern for directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, ".cache"));
    await mkdir(join(tempDir, ".config"));
    await writeFile(join(tempDir, ".env"), ""); // File should not be included

    const result = await expandDirectoryPatterns([".*"], tempDir);

    expect(result.sort()).toEqual([".cache", ".config"]);
  });

  it("skips non-existent directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandDirectoryPatterns(["nonexistent"], tempDir);

    expect(result).toEqual([]);
  });

  it("prevents path traversal", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandDirectoryPatterns(["../"], tempDir);

    expect(result).toEqual([]);
  });

  it("rejects absolute paths", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandDirectoryPatterns(["/etc", "/tmp"], tempDir);

    expect(result).toEqual([]);
  });

  it("rejects null byte injection", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandDirectoryPatterns(["dir\0name"], tempDir);

    expect(result).toEqual([]);
  });

  it("deduplicates directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, "vendor"));

    const result = await expandDirectoryPatterns(["vendor", "vendor"], tempDir);

    expect(result).toEqual(["vendor"]);
  });

  it("handles nested directories with glob", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, "packages/pkg-a"), { recursive: true });
    await mkdir(join(tempDir, "packages/pkg-b"), { recursive: true });
    await writeFile(join(tempDir, "packages/file.txt"), ""); // File should not be included

    const result = await expandDirectoryPatterns(["packages/*"], tempDir);

    expect(result.sort()).toEqual(["packages/pkg-a", "packages/pkg-b"]);
  });

  it("handles empty array", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    const result = await expandDirectoryPatterns([], tempDir);

    expect(result).toEqual([]);
  });

  it("maintains order", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, "aaa"));
    await mkdir(join(tempDir, "bbb"));
    await mkdir(join(tempDir, "ccc"));

    const result = await expandDirectoryPatterns(["ccc", "aaa", "bbb"], tempDir);

    expect(result).toEqual(["ccc", "aaa", "bbb"]);
  });

  it("does not include files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));

    await mkdir(join(tempDir, "dir1"));
    await writeFile(join(tempDir, "file1.txt"), "");

    const result = await expandDirectoryPatterns(["*"], tempDir);

    expect(result).toEqual(["dir1"]);
  });
});
