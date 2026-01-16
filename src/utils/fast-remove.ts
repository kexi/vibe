import { dirname, join } from "@std/path";

export interface FastRemoveResult {
  success: boolean;
  trashedPath?: string;
  error?: Error;
}

/**
 * Check if fast remove is supported on the current OS
 * Fast remove uses rename + async delete, which works on all platforms
 * (same-volume rename is O(1) on macOS, Linux, and Windows)
 * If rename fails for any reason, the caller should fall back to traditional deletion
 */
export function isFastRemoveSupported(): boolean {
  return true;
}

/**
 * Generate a unique trash directory name
 */
function generateTrashName(): string {
  return `.vibe-trash-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Spawn a detached background process to delete a directory
 * This process runs independently and won't block the parent from exiting
 *
 * Note: Uses direct command execution with unref() to avoid shell injection
 * while ensuring the process is truly detached from the parent.
 */
function spawnBackgroundDelete(trashPath: string): void {
  const isWindows = Deno.build.os === "windows";

  if (isWindows) {
    // Windows: use cmd /c with start /b for detached process
    // Path is passed as separate argument to avoid shell interpretation
    const child = new Deno.Command("cmd", {
      args: ["/c", "start", "/b", "cmd", "/c", "rd", "/s", "/q", trashPath],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    // Unref to allow parent to exit without waiting
    child.unref();
  } else {
    // macOS/Linux: use rm directly
    // Path is passed as argument, avoiding shell injection
    const child = new Deno.Command("rm", {
      args: ["-rf", trashPath],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    // Unref to allow parent to exit without waiting for child
    child.unref();
  }
}

/**
 * Fast remove a directory by moving it to a trash location
 * and deleting it asynchronously in the background
 *
 * @param targetPath The directory to remove
 * @returns Result indicating success/failure and the trash path if successful
 */
export async function fastRemoveDirectory(
  targetPath: string,
): Promise<FastRemoveResult> {
  const parentDir = dirname(targetPath);
  const trashName = generateTrashName();
  const trashPath = join(parentDir, trashName);

  try {
    // Step 1: Rename (O(1) operation on same filesystem)
    await Deno.rename(targetPath, trashPath);

    // Step 2: Spawn detached background process for deletion
    // Parent process can exit immediately without waiting
    spawnBackgroundDelete(trashPath);

    return { success: true, trashedPath: trashPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Clean up any stale .vibe-trash-* directories from previous runs
 * This is called asynchronously and doesn't block the user
 *
 * @param parentDir The directory to search for stale trash directories
 */
export async function cleanupStaleTrash(parentDir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(parentDir)) {
      const isVibeTrash = entry.isDirectory &&
        entry.name.startsWith(".vibe-trash-");
      if (isVibeTrash) {
        const trashPath = join(parentDir, entry.name);
        // Spawn detached background process for cleanup
        spawnBackgroundDelete(trashPath);
      }
    }
  } catch {
    // Ignore errors - directory might not exist or be inaccessible
  }
}
