import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cleanupStaleTrash, fastRemoveDirectory, isFastRemoveSupported } from "./fast-remove.ts";

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
    assertEquals(result.trashedPath?.startsWith(tempDir), true);
    assertEquals(result.trashedPath?.includes(".vibe-trash-"), true);

    // Original path should no longer exist
    let exists = true;
    try {
      await Deno.stat(targetDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    // Wait for background deletion to complete before cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));

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

    // Wait a bit for background processes to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check trash directories are removed
    let trash1Exists = true;
    let trash2Exists = true;
    let normalExists = true;

    try {
      await Deno.stat(trashDir1);
    } catch {
      trash1Exists = false;
    }

    try {
      await Deno.stat(trashDir2);
    } catch {
      trash2Exists = false;
    }

    try {
      await Deno.stat(normalDir);
    } catch {
      normalExists = false;
    }

    assertEquals(trash1Exists, false);
    assertEquals(trash2Exists, false);
    assertEquals(normalExists, true); // Normal dir should still exist

    // Cleanup
    await Deno.remove(tempDir, { recursive: true });
  },
});

Deno.test("cleanupStaleTrash handles non-existent directory gracefully", async () => {
  // Should not throw
  await cleanupStaleTrash("/non/existent/path");
});
