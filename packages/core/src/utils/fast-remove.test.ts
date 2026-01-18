import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  cleanupStaleTrash,
  fastRemoveDirectory,
  isFastRemoveSupported,
  resetTrashAdapterCache,
  SYSTEM_TRASH_DISPLAY_PATH,
} from "./fast-remove.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real Deno runtime for filesystem tests
await setupRealTestContext();

// Reset cache state before tests
resetTrashAdapterCache();

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
    // On Node.js with native module: trashedPath is "~/.Trash" (system trash)
    //   - macOS: Finder Trash
    //   - Linux: XDG Trash (~/.local/share/Trash)
    // On Deno without native module:
    //   - macOS: "~/.Trash" (osascript fallback)
    //   - Linux: /tmp or parent directory
    // Windows: %TEMP% or parent directory
    const isSystemTrash = result.trashedPath === SYSTEM_TRASH_DISPLAY_PATH;
    const isTempLocation = result.trashedPath?.startsWith("/tmp") ||
      result.trashedPath?.startsWith(tempDir);
    const isExpectedLocation = isSystemTrash || isTempLocation;
    assertEquals(isExpectedLocation, true);
    // If not system trash, it should be a .vibe-trash-* directory
    if (!isSystemTrash) {
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
    if (result.trashedPath && result.trashedPath !== SYSTEM_TRASH_DISPLAY_PATH) {
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
