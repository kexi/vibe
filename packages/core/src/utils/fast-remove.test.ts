import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, stat, lstat, symlink, readFile } from "node:fs/promises";
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

const isWindows = process.platform === "win32";
const itUnix = isWindows ? it.skip : it;

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

  // ===== Security: TOCTOU symlink-attack regression tests for issue #417 =====

  itUnix("fastRemoveDirectory rejects symlink to directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    // "Sensitive" directory that must survive untouched.
    const sensitiveDir = join(tempDir, "sensitive");
    await mkdir(sensitiveDir);
    const sensitiveFile = join(sensitiveDir, "secret.txt");
    await writeFile(sensitiveFile, "do-not-delete");

    // Symlink masquerading as a worktree.
    const linkPath = join(tempDir, "worktree-link");
    await symlink(sensitiveDir, linkPath);

    const result = await fastRemoveDirectory(linkPath);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("symlink");

    // Sensitive directory and file must still be intact.
    const sensitiveContent = await readFile(sensitiveFile, "utf8");
    expect(sensitiveContent).toBe("do-not-delete");

    // The symlink itself should still exist (we refused, didn't remove it).
    const linkInfo = await lstat(linkPath);
    expect(linkInfo.isSymbolicLink()).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  itUnix("fastRemoveDirectory rejects symlink to file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const targetFile = join(tempDir, "target.txt");
    await writeFile(targetFile, "file-content");

    const linkPath = join(tempDir, "link-to-file");
    await symlink(targetFile, linkPath);

    const result = await fastRemoveDirectory(linkPath);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("symlink");

    // Original file must remain.
    const fileContent = await readFile(targetFile, "utf8");
    expect(fileContent).toBe("file-content");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("fastRemoveDirectory rejects regular file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const filePath = join(tempDir, "just-a-file.txt");
    await writeFile(filePath, "content");

    const result = await fastRemoveDirectory(filePath);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("not a directory");

    // File must still exist.
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("content");

    await rm(tempDir, { recursive: true, force: true });
  });

  itUnix("fastRemoveDirectory rejects broken symlink (not treated as not-found)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const nonexistentTarget = join(tempDir, "does-not-exist");
    const brokenLink = join(tempDir, "broken-link");
    await symlink(nonexistentTarget, brokenLink);

    const result = await fastRemoveDirectory(brokenLink);

    // A broken symlink must NOT silently report success; it must be refused
    // as a symlink (lstat sees the link, even though stat would not).
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("symlink");

    // The link itself should still exist.
    const linkInfo = await lstat(brokenLink);
    expect(linkInfo.isSymbolicLink()).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  itUnix("fastRemoveDirectory rejects when parent directory is a symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    // Real parent and a real worktree directory inside it.
    const realParent = join(tempDir, "real-parent");
    await mkdir(realParent);
    const realWorktree = join(realParent, "worktree");
    await mkdir(realWorktree);
    await writeFile(join(realWorktree, "marker.txt"), "preserve-me");

    // Symlinked alias for the parent directory.
    const linkedParent = join(tempDir, "linked-parent");
    await symlink(realParent, linkedParent);
    const targetViaLink = join(linkedParent, "worktree");

    const result = await fastRemoveDirectory(targetViaLink);

    expect(result.success).toBe(false);
    // Error should mention parent symlink (we reject before reaching rename).
    expect(result.error?.message).toContain("parent");

    // Real worktree and its content must still exist.
    const markerContent = await readFile(join(realWorktree, "marker.txt"), "utf8");
    expect(markerContent).toBe("preserve-me");

    await rm(tempDir, { recursive: true, force: true });
  });

  itUnix(
    "fastRemoveDirectory succeeds when a deeper ancestor (not the immediate parent) is a symlink",
    async () => {
      // The check is intentionally scoped to the immediate parent. Deeper-
      // ancestor swaps require attacker write access higher up the tree and
      // are out of #417's threat model. This test pins that behavior so we
      // don't accidentally re-introduce a false-positive on legitimate paths
      // whose grandparent (or above) is a symlink (e.g. macOS `/var` →
      // `/private/var`).
      const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
      const realGrandparent = join(tempDir, "real-grandparent");
      await mkdir(realGrandparent);
      const parent = join(realGrandparent, "parent");
      await mkdir(parent);
      const worktree = join(parent, "worktree");
      await mkdir(worktree);
      await writeFile(join(worktree, "marker.txt"), "ok");

      // Symlinked alias for the *grandparent*; the immediate parent of the
      // worktree (under the symlinked path) is still a real directory.
      const linkedGrandparent = join(tempDir, "linked-grandparent");
      await symlink(realGrandparent, linkedGrandparent);
      const targetViaSymlinkedGrandparent = join(linkedGrandparent, "parent", "worktree");

      const result = await fastRemoveDirectory(targetViaSymlinkedGrandparent);

      expect(result.success).toBe(true);

      // The original (real) worktree path should no longer exist.
      let exists = true;
      try {
        await stat(worktree);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);

      await rm(tempDir, { recursive: true, force: true });
    },
  );

  itUnix("cleanupStaleTrash skips symlink named .vibe-trash-*", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    // Sensitive directory that must survive.
    const sensitiveDir = join(tempDir, "sensitive");
    await mkdir(sensitiveDir);
    const sensitiveFile = join(sensitiveDir, "important.txt");
    await writeFile(sensitiveFile, "keep-me");

    // Plant a symlink under a .vibe-trash-* name pointing at the sensitive dir.
    const malicious = join(tempDir, ".vibe-trash-99999-aaaaaaaaaaaaaaaa");
    await symlink(sensitiveDir, malicious);

    await cleanupStaleTrash(tempDir);

    // Wait briefly: if the cleanup were to (incorrectly) spawn a delete, it
    // would happen here. We then verify the sensitive content is still intact.
    await new Promise((r) => setTimeout(r, 250));

    const sensitiveContent = await readFile(sensitiveFile, "utf8");
    expect(sensitiveContent).toBe("keep-me");

    // The symlink may or may not still exist (it's not load-bearing for the
    // security property), but the *target* must be untouched.
    await rm(tempDir, { recursive: true, force: true });
  });
});
