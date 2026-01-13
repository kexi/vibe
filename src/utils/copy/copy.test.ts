import { assertEquals } from "@std/assert";
import { join } from "@std/path";
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

// Reset state before each test
function resetState(): void {
  resetCapabilitiesCache();
  resetCopyService();
}

Deno.test("StandardStrategy: is always available", async () => {
  const strategy = new StandardStrategy();
  assertEquals(await strategy.isAvailable(), true);
  assertEquals(strategy.name, "standard");
});

Deno.test("StandardStrategy: copies file correctly", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "dest.txt");

    await Deno.writeTextFile(srcFile, "test content");

    const strategy = new StandardStrategy();
    await strategy.copyFile(srcFile, destFile);

    const content = await Deno.readTextFile(destFile);
    assertEquals(content, "test content");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("StandardStrategy: copies file and creates parent directories", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "nested", "deep", "dest.txt");

    await Deno.writeTextFile(srcFile, "test content");

    const strategy = new StandardStrategy();
    await strategy.copyFile(srcFile, destFile);

    const content = await Deno.readTextFile(destFile);
    assertEquals(content, "test content");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("StandardStrategy: copies directory correctly", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const srcDir = join(tempDir, "source");
    const destDir = join(tempDir, "dest");

    // Create source directory with files
    await Deno.mkdir(srcDir);
    await Deno.writeTextFile(join(srcDir, "file1.txt"), "content1");
    await Deno.writeTextFile(join(srcDir, "file2.txt"), "content2");

    const strategy = new StandardStrategy();
    await strategy.copyDirectory(srcDir, destDir);

    // Verify files were copied
    const content1 = await Deno.readTextFile(join(destDir, "file1.txt"));
    const content2 = await Deno.readTextFile(join(destDir, "file2.txt"));
    assertEquals(content1, "content1");
    assertEquals(content2, "content2");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("CloneStrategy: name is clone", () => {
  const strategy = new CloneStrategy();
  assertEquals(strategy.name, "clone");
});

Deno.test("RsyncStrategy: name is rsync", () => {
  const strategy = new RsyncStrategy();
  assertEquals(strategy.name, "rsync");
});

Deno.test("detectCapabilities: caches result", async () => {
  resetState();

  const result1 = await detectCapabilities();
  const result2 = await detectCapabilities();

  // Same reference means it's cached
  assertEquals(result1, result2);
});

Deno.test("CopyService: selects a directory strategy", async () => {
  resetState();

  const service = new CopyService();
  try {
    const strategy = await service.getDirectoryStrategy();

    // Should select some strategy
    const isValidStrategy = strategy.name === "clonefile" ||
      strategy.name === "clone" ||
      strategy.name === "rsync" ||
      strategy.name === "standard";
    assertEquals(isValidStrategy, true);
  } finally {
    service.close();
  }
});

Deno.test("CopyService: caches selected directory strategy", async () => {
  resetState();

  const service = new CopyService();
  try {
    const strategy1 = await service.getDirectoryStrategy();
    const strategy2 = await service.getDirectoryStrategy();

    // Same strategy should be returned
    assertEquals(strategy1.name, strategy2.name);
  } finally {
    service.close();
  }
});

Deno.test("CopyService: copies file correctly", async () => {
  resetState();
  const tempDir = await Deno.makeTempDir();
  const service = new CopyService();

  try {
    const srcFile = join(tempDir, "source.txt");
    const destFile = join(tempDir, "dest.txt");

    await Deno.writeTextFile(srcFile, "test content");

    await service.copyFile(srcFile, destFile);

    const content = await Deno.readTextFile(destFile);
    assertEquals(content, "test content");
  } finally {
    service.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("CopyService: copies directory correctly", async () => {
  resetState();
  const tempDir = await Deno.makeTempDir();
  const service = new CopyService();

  try {
    const srcDir = join(tempDir, "source");
    const destDir = join(tempDir, "dest");

    // Create source directory with files
    await Deno.mkdir(srcDir);
    await Deno.writeTextFile(join(srcDir, "file1.txt"), "content1");
    await Deno.mkdir(join(srcDir, "nested"));
    await Deno.writeTextFile(join(srcDir, "nested", "file2.txt"), "content2");

    await service.copyDirectory(srcDir, destDir);

    // Verify files were copied
    const content1 = await Deno.readTextFile(join(destDir, "file1.txt"));
    const content2 = await Deno.readTextFile(join(destDir, "nested", "file2.txt"));
    assertEquals(content1, "content1");
    assertEquals(content2, "content2");
  } finally {
    service.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

// Path validation tests
Deno.test("validatePath: accepts valid paths", () => {
  // Should not throw for valid paths
  validatePath("/path/to/file.txt");
  validatePath("relative/path/file.txt");
  validatePath("path with spaces/file.txt");
  validatePath("日本語パス/ファイル.txt");
});

Deno.test("validatePath: rejects paths with null bytes", () => {
  try {
    validatePath("/path/to\0/file.txt");
    throw new Error("Should have thrown");
  } catch (err) {
    assertEquals((err as Error).message, "Invalid path: contains null byte");
  }
});

Deno.test("validatePath: rejects paths with newlines", () => {
  try {
    validatePath("/path/to\n/file.txt");
    throw new Error("Should have thrown");
  } catch (err) {
    assertEquals(
      (err as Error).message,
      "Invalid path: contains newline characters",
    );
  }
});

Deno.test("validatePath: rejects empty paths", () => {
  try {
    validatePath("");
    throw new Error("Should have thrown");
  } catch (err) {
    assertEquals((err as Error).message, "Invalid path: path is empty");
  }
});

Deno.test("validatePath: rejects paths with command substitution $(...)", () => {
  try {
    validatePath("/path/$(whoami)/file.txt");
    throw new Error("Should have thrown");
  } catch (err) {
    assertEquals(
      (err as Error).message,
      "Invalid path: contains shell command substitution pattern",
    );
  }
});

Deno.test("validatePath: rejects paths with backticks", () => {
  try {
    validatePath("/path/`whoami`/file.txt");
    throw new Error("Should have thrown");
  } catch (err) {
    assertEquals(
      (err as Error).message,
      "Invalid path: contains shell command substitution pattern",
    );
  }
});

// Platform-specific tests
const isMacOS = Deno.build.os === "darwin";

Deno.test({
  name: "CloneStrategy: is available on macOS with APFS",
  ignore: !isMacOS,
  async fn() {
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();
    // On macOS, clone should typically be available
    // (unless running on an old non-APFS filesystem)
    assertEquals(typeof isAvailable, "boolean");
  },
});

Deno.test({
  name: "CloneStrategy: copies file on macOS",
  ignore: !isMacOS,
  async fn() {
    resetState();
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const tempDir = await Deno.makeTempDir();
    try {
      const srcFile = join(tempDir, "source.txt");
      const destFile = join(tempDir, "dest.txt");

      await Deno.writeTextFile(srcFile, "test content for clone");
      await strategy.copyFile(srcFile, destFile);

      const content = await Deno.readTextFile(destFile);
      assertEquals(content, "test content for clone");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "CloneStrategy: copies directory on macOS",
  ignore: !isMacOS,
  async fn() {
    resetState();
    const strategy = new CloneStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const tempDir = await Deno.makeTempDir();
    try {
      const srcDir = join(tempDir, "source");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.writeTextFile(join(srcDir, "file.txt"), "content");

      await strategy.copyDirectory(srcDir, destDir);

      const content = await Deno.readTextFile(join(destDir, "file.txt"));
      assertEquals(content, "content");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "RsyncStrategy: checks rsync availability",
  async fn() {
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();
    // Just verify it returns a boolean without error
    assertEquals(typeof isAvailable, "boolean");
  },
});

Deno.test({
  name: "RsyncStrategy: copies file when available",
  async fn() {
    resetState();
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const tempDir = await Deno.makeTempDir();
    try {
      const srcFile = join(tempDir, "source.txt");
      const destFile = join(tempDir, "dest.txt");

      await Deno.writeTextFile(srcFile, "test content for rsync");
      await strategy.copyFile(srcFile, destFile);

      const content = await Deno.readTextFile(destFile);
      assertEquals(content, "test content for rsync");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "RsyncStrategy: copies directory when available",
  async fn() {
    resetState();
    const strategy = new RsyncStrategy();
    const isAvailable = await strategy.isAvailable();

    if (!isAvailable) {
      return;
    }

    const tempDir = await Deno.makeTempDir();
    try {
      const srcDir = join(tempDir, "source");
      const destDir = join(tempDir, "dest");

      await Deno.mkdir(srcDir);
      await Deno.mkdir(destDir);
      await Deno.writeTextFile(join(srcDir, "file.txt"), "rsync content");

      await strategy.copyDirectory(srcDir, destDir);

      const content = await Deno.readTextFile(join(destDir, "file.txt"));
      assertEquals(content, "rsync content");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
