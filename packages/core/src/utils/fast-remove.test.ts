import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupStaleTrash,
  fastRemoveDirectory,
  isFastRemoveSupported,
  resetTrashAdapterCache,
  SYSTEM_TRASH_DISPLAY_PATH,
} from "./fast-remove.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real Deno runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

// Reset cache state before tests
beforeEach(() => {
  resetTrashAdapterCache();
});

/**
 * Wait for a path to be deleted using polling instead of fixed timeout
 * More reliable than fixed setTimeout for async deletion operations
 */
async function waitForDeletion(path: string, timeout = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await stat(path);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return true;
    }
  }
  return false;
}

describe("fast-remove", () => {
  it("isFastRemoveSupported returns true", () => {
    expect(isFastRemoveSupported()).toBe(true);
  });

  it("fastRemoveDirectory moves directory and starts background deletion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const targetDir = join(tempDir, "test-worktree");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    expect(result.success).toBe(true);
    expect(result.trashedPath !== undefined).toBe(true);
    // On Node.js with native module: trashedPath is "~/.Trash" (system trash)
    //   - macOS: Finder Trash
    //   - Linux: XDG Trash (~/.local/share/Trash)
    // On Deno without native module:
    //   - macOS: "~/.Trash" (osascript fallback)
    //   - Linux: /tmp or parent directory
    // Windows: %TEMP% or parent directory
    const isSystemTrash = result.trashedPath === SYSTEM_TRASH_DISPLAY_PATH;
    const isTempLocation =
      result.trashedPath?.startsWith("/tmp") || result.trashedPath?.startsWith(tempDir);
    const isExpectedLocation = isSystemTrash || isTempLocation;
    expect(isExpectedLocation).toBe(true);
    // If not system trash, it should be a .vibe-trash-* directory
    if (!isSystemTrash) {
      expect(result.trashedPath?.includes(".vibe-trash-")).toBe(true);
    }

    // Original path should no longer exist
    let exists = true;
    try {
      await stat(targetDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Wait for background deletion to complete before cleanup (polling-based)
    if (result.trashedPath && result.trashedPath !== SYSTEM_TRASH_DISPLAY_PATH) {
      await waitForDeletion(result.trashedPath);
    }

    // Cleanup
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted by background process
    }
  });

  it("fastRemoveDirectory returns success for non-existent directory (idempotent)", async () => {
    // Idempotent design: removing a non-existent directory is considered a success
    // since the desired end state (directory does not exist) is already achieved
    const result = await fastRemoveDirectory("/non/existent/path");

    expect(result.success).toBe(true);
    expect(result.trashedPath).toBe(undefined);
  });

  it("cleanupStaleTrash removes .vibe-trash-* directories", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const trashDir1 = join(tempDir, ".vibe-trash-12345-abcdef");
    const trashDir2 = join(tempDir, ".vibe-trash-67890-ghijkl");
    const normalDir = join(tempDir, "normal-dir");

    await mkdir(trashDir1);
    await mkdir(trashDir2);
    await mkdir(normalDir);

    // Create a file in one trash dir to ensure recursive deletion
    await writeFile(join(trashDir1, "file.txt"), "content");

    await cleanupStaleTrash(tempDir);

    // Wait for background processes to complete (polling-based)
    const [trash1Deleted, trash2Deleted] = await Promise.all([
      waitForDeletion(trashDir1),
      waitForDeletion(trashDir2),
    ]);

    expect(trash1Deleted).toBe(true);
    expect(trash2Deleted).toBe(true);

    // Normal dir should still exist
    let normalExists = true;
    try {
      await stat(normalDir);
    } catch {
      normalExists = false;
    }
    expect(normalExists).toBe(true);

    // Cleanup
    await rm(tempDir, { recursive: true });
  });

  it("cleanupStaleTrash handles non-existent directory gracefully", async () => {
    // Should not throw
    await cleanupStaleTrash("/non/existent/path");
  });

  it("fastRemoveDirectory handles path with spaces", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const targetDir = join(tempDir, "test dir with spaces");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    expect(result.success).toBe(true);

    // Original path should no longer exist
    let exists = true;
    try {
      await stat(targetDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Cleanup
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  });

  it("fastRemoveDirectory handles path with Japanese characters", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const targetDir = join(tempDir, "テスト日本語ディレクトリ");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "ファイル.txt"), "テスト内容");

    const result = await fastRemoveDirectory(targetDir);

    expect(result.success).toBe(true);

    // Original path should no longer exist
    let exists = true;
    try {
      await stat(targetDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Cleanup
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  });

  it("fastRemoveDirectory handles path with quotes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const targetDir = join(tempDir, "test'dir\"with'quotes");
    await mkdir(targetDir);
    await writeFile(join(targetDir, "file.txt"), "test content");

    const result = await fastRemoveDirectory(targetDir);

    expect(result.success).toBe(true);

    // Original path should no longer exist
    let exists = true;
    try {
      await stat(targetDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Cleanup
    try {
      await rm(tempDir, { recursive: true });
    } catch {
      // Directory may already be deleted
    }
  });
});
