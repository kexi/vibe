import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cleanupStaleTrash, fastRemoveDirectory, isFastRemoveSupported } from "./fast-remove.ts";

/** macOS Trash display path constant for test assertions (matches MACOS_TRASH_DISPLAY_PATH in fast-remove.ts) */
const MACOS_TRASH_DISPLAY_PATH = "~/.Trash";

/**
 * Wait for a path to be deleted using polling instead of fixed timeout
 * More reliable than fixed setTimeout for async deletion operations
 */
async function waitForDeletion(path: string, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await Deno.stat(path);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return true;
    }
  }
  return false;
}

Deno.test("isFastRemoveSupported returns true", () => {
  assertEquals(isFastRemoveSupported(), true);
});

Deno.test({
  name: "fastRemoveDirectory moves directory and starts background deletion",
  // Allow spawned background processes to continue after test
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const targetDir = join(tempDir, "test-worktree");
    await Deno.mkdir(targetDir);
    await Deno.writeTextFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    assertEquals(result.success, true);
    assertEquals(result.trashedPath !== undefined, true);
    // On macOS: trashedPath is "~/.Trash" (Finder-managed)
    // On Linux/Windows: trashedPath is in /tmp or parent directory
    const isMacOS = Deno.build.os === "darwin";
    if (isMacOS) {
      assertEquals(result.trashedPath, MACOS_TRASH_DISPLAY_PATH);
    } else {
      const isInExpectedLocation = result.trashedPath?.startsWith("/tmp") ||
        result.trashedPath?.startsWith(tempDir);
      assertEquals(isInExpectedLocation, true);
      assertEquals(result.trashedPath?.includes(".vibe-trash-"), true);
    }

    // Original path should no longer exist
    let exists = true;
    try {
      await Deno.stat(targetDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    // Wait for background deletion to complete before cleanup (polling-based)
    if (result.trashedPath && result.trashedPath !== MACOS_TRASH_DISPLAY_PATH) {
      await waitForDeletion(result.trashedPath);
    }

    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted by background process
    }
  },
});

Deno.test("fastRemoveDirectory returns failure for non-existent directory", async () => {
  const result = await fastRemoveDirectory("/non/existent/path");

  assertEquals(result.success, false);
  assertEquals(result.error !== undefined, true);
});

Deno.test({
  name: "cleanupStaleTrash removes .vibe-trash-* directories",
  // Allow spawned background processes to continue after test
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const trashDir1 = join(tempDir, ".vibe-trash-12345-abcdef");
    const trashDir2 = join(tempDir, ".vibe-trash-67890-ghijkl");
    const normalDir = join(tempDir, "normal-dir");

    await Deno.mkdir(trashDir1);
    await Deno.mkdir(trashDir2);
    await Deno.mkdir(normalDir);

    // Create a file in one trash dir to ensure recursive deletion
    await Deno.writeTextFile(join(trashDir1, "file.txt"), "content");

    await cleanupStaleTrash(tempDir);

    // Wait for background processes to complete (polling-based)
    const [trash1Deleted, trash2Deleted] = await Promise.all([
      waitForDeletion(trashDir1),
      waitForDeletion(trashDir2),
    ]);

    assertEquals(trash1Deleted, true);
    assertEquals(trash2Deleted, true);

    // Normal dir should still exist
    let normalExists = true;
    try {
      await Deno.stat(normalDir);
    } catch {
      normalExists = false;
    }
    assertEquals(normalExists, true);

    // Cleanup
    await Deno.remove(tempDir, { recursive: true });
  },
});

Deno.test("cleanupStaleTrash handles non-existent directory gracefully", async () => {
  // Should not throw
  await cleanupStaleTrash("/non/existent/path");
});

Deno.test({
  name: "fastRemoveDirectory handles path with spaces",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const targetDir = join(tempDir, "test dir with spaces");
    await Deno.mkdir(targetDir);
    await Deno.writeTextFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    assertEquals(result.success, true);

    // Original path should no longer exist
    let exists = true;
    try {
      await Deno.stat(targetDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  },
});

Deno.test({
  name: "fastRemoveDirectory handles path with Japanese characters",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const targetDir = join(tempDir, "テスト日本語ディレクトリ");
    await Deno.mkdir(targetDir);
    await Deno.writeTextFile(join(targetDir, "ファイル.txt"), "テスト内容");

    const result = await fastRemoveDirectory(targetDir);

    assertEquals(result.success, true);

    // Original path should no longer exist
    let exists = true;
    try {
      await Deno.stat(targetDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  },
});

Deno.test({
  name: "fastRemoveDirectory handles path with quotes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const targetDir = join(tempDir, "test'dir\"with'quotes");
    await Deno.mkdir(targetDir);
    await Deno.writeTextFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    assertEquals(result.success, true);

    // Original path should no longer exist
    let exists = true;
    try {
      await Deno.stat(targetDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  },
});
