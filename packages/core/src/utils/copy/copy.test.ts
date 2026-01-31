import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  CopyService,
  detectCapabilities,
  resetCapabilitiesCache,
  resetCopyService,
} from "./index.ts";
import { StandardStrategy } from "./strategies/standard.ts";
import { CloneStrategy } from "./strategies/clone.ts";
import { RsyncStrategy } from "./strategies/rsync.ts";
import { validatePath } from "./validation.ts";
import { setupRealTestContext } from "../../context/testing.ts";

// Initialize test context with real runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

// Reset state before each test
function resetState(): void {
  resetCapabilitiesCache();
  resetCopyService();
}

describe("StandardStrategy", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is always available", async () => {
    const strategy = new StandardStrategy();
    expect(await strategy.isAvailable()).toBe(true);
    expect(strategy.name).toBe("standard");
  });

  it("copies file correctly", async () => {
    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "dest.txt");

    await writeFile(srcFile, "test content");

    const strategy = new StandardStrategy();
    await strategy.copyFile(srcFile, destFile);

    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("test content");
  });

  it("copies file and creates parent directories", async () => {
    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "nested", "deep", "dest.txt");

    await writeFile(srcFile, "test content");

    const strategy = new StandardStrategy();
    await strategy.copyFile(srcFile, destFile);

    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("test content");
  });

  it("copies directory correctly", async () => {
    const srcDir = join(tempDir, "source");
    const destDir = join(tempDir, "dest");

    // Create source directory with files
    await mkdir(srcDir);
    await writeFile(join(srcDir, "file1.txt"), "content1");
    await writeFile(join(srcDir, "file2.txt"), "content2");

    const strategy = new StandardStrategy();
    await strategy.copyDirectory(srcDir, destDir);

    // Verify files were copied
    const content1 = await readFile(join(destDir, "file1.txt"), "utf-8");
    const content2 = await readFile(join(destDir, "file2.txt"), "utf-8");
    expect(content1).toBe("content1");
    expect(content2).toBe("content2");
  });
});

describe("CloneStrategy", () => {
  it("name is clone", () => {
    const strategy = new CloneStrategy();
    expect(strategy.name).toBe("clone");
  });
});

describe("RsyncStrategy", () => {
  it("name is rsync", () => {
    const strategy = new RsyncStrategy();
    expect(strategy.name).toBe("rsync");
  });
});

describe("detectCapabilities", () => {
  it("caches result", async () => {
    resetState();

    const result1 = await detectCapabilities();
    const result2 = await detectCapabilities();

    // Same reference means it's cached
    expect(result1).toBe(result2);
  });
});

describe("CopyService", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetState();
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("selects a directory strategy", async () => {
    const service = new CopyService();
    try {
      const strategy = await service.getDirectoryStrategy();

      // Should select some strategy
      const isValidStrategy =
        strategy.name === "clonefile" ||
        strategy.name === "clone" ||
        strategy.name === "rsync" ||
        strategy.name === "standard";
      expect(isValidStrategy).toBe(true);
    } finally {
      service.close();
    }
  });

  it("caches selected directory strategy", async () => {
    const service = new CopyService();
    try {
      const strategy1 = await service.getDirectoryStrategy();
      const strategy2 = await service.getDirectoryStrategy();

      // Same strategy should be returned
      expect(strategy1.name).toBe(strategy2.name);
    } finally {
      service.close();
    }
  });

  it("copies file correctly", async () => {
    const service = new CopyService();

    try {
      const srcFile = join(tempDir, "source.txt");
      const destFile = join(tempDir, "dest.txt");

      await writeFile(srcFile, "test content");

      await service.copyFile(srcFile, destFile);

      const content = await readFile(destFile, "utf-8");
      expect(content).toBe("test content");
    } finally {
      service.close();
    }
  });

  it("copies directory correctly", async () => {
    const service = new CopyService();

    try {
      const srcDir = join(tempDir, "source");
      const destDir = join(tempDir, "dest");

      // Create source directory with files
      await mkdir(srcDir);
      await writeFile(join(srcDir, "file1.txt"), "content1");
      await mkdir(join(srcDir, "nested"));
      await writeFile(join(srcDir, "nested", "file2.txt"), "content2");

      await service.copyDirectory(srcDir, destDir);

      // Verify files were copied
      const content1 = await readFile(join(destDir, "file1.txt"), "utf-8");
      const content2 = await readFile(join(destDir, "nested", "file2.txt"), "utf-8");
      expect(content1).toBe("content1");
      expect(content2).toBe("content2");
    } finally {
      service.close();
    }
  });
});

describe("validatePath", () => {
  it("accepts valid paths", () => {
    // Should not throw for valid paths
    validatePath("/path/to/file.txt");
    validatePath("relative/path/file.txt");
    validatePath("path with spaces/file.txt");
    validatePath("日本語パス/ファイル.txt");
  });

  it("rejects paths with null bytes", () => {
    expect(() => validatePath("/path/to\0/file.txt")).toThrow("Invalid path: contains null byte");
  });

  it("rejects paths with newlines", () => {
    expect(() => validatePath("/path/to\n/file.txt")).toThrow(
      "Invalid path: contains newline characters",
    );
  });

  it("rejects empty paths", () => {
    expect(() => validatePath("")).toThrow("Invalid path: path is empty");
  });

  it("rejects paths with command substitution $(...)", () => {
    expect(() => validatePath("/path/$(whoami)/file.txt")).toThrow(
      "Invalid path: contains shell command substitution pattern",
    );
  });

  it("rejects paths with backticks", () => {
    expect(() => validatePath("/path/`whoami`/file.txt")).toThrow(
      "Invalid path: contains shell command substitution pattern",
    );
  });
});

describe("Platform-specific tests", () => {
  const isMacOS = process.platform === "darwin";
  let tempDir: string;

  beforeEach(async () => {
    resetState();
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.skipIf(!isMacOS)("CloneStrategy: is available on macOS with APFS", async () => {
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();
    // On macOS, clone should typically be available
    expect(typeof isAvailable).toBe("boolean");
  });

  it.skipIf(!isMacOS)("CloneStrategy: copies file on macOS", async () => {
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "dest.txt");

    await writeFile(srcFile, "test content for clone");
    await strategy.copyFile(srcFile, destFile);

    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("test content for clone");
  });

  it.skipIf(!isMacOS)("CloneStrategy: copies directory on macOS", async () => {
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const srcDir = join(tempDir, "source");
    const destDir = join(tempDir, "dest");

    await mkdir(srcDir);
    await writeFile(join(srcDir, "file.txt"), "content");

    await strategy.copyDirectory(srcDir, destDir);

    const content = await readFile(join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("content");
  });

  it("RsyncStrategy: checks rsync availability", async () => {
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();
    // Just verify it returns a boolean without error
    expect(typeof isAvailable).toBe("boolean");
  });

  it("RsyncStrategy: copies file when available", async () => {
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "dest.txt");

    await writeFile(srcFile, "test content for rsync");
    await strategy.copyFile(srcFile, destFile);

    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("test content for rsync");
  });

  it("RsyncStrategy: copies directory when available", async () => {
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const srcDir = join(tempDir, "source");
    const destDir = join(tempDir, "dest");

    await mkdir(srcDir);
    await mkdir(destDir);
    await writeFile(join(srcDir, "file.txt"), "rsync content");

    await strategy.copyDirectory(srcDir, destDir);

    const content = await readFile(join(destDir, "file.txt"), "utf-8");
    expect(content).toBe("rsync content");
  });
});
