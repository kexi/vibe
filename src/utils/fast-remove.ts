import { dirname, join } from "@std/path";
import { runtime } from "../runtime/index.ts";

/**
 * Display path for macOS Trash returned to callers.
 * This is a user-friendly representation (~/.Trash), not the actual
 * filesystem path. Finder manages the actual trash location internally.
 */
const MACOS_TRASH_DISPLAY_PATH = "~/.Trash";

/** Pattern to detect control characters that could cause issues in shell/AppleScript */
// deno-lint-ignore no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

/** Length of UUID suffix used in trash directory names for uniqueness */
const TRASH_UUID_LENGTH = 8;

export interface FastRemoveResult {
  success: boolean;
  trashedPath?: string;
  error?: Error;
}

/**
 * Check if fast remove is supported on the current OS
 *
 * This function exists for API stability and future extensibility.
 * Currently returns true for all platforms, but may be extended to
 * check for specific OS capabilities or configurations.
 */
export function isFastRemoveSupported(): boolean {
  return true;
}

/**
 * Generate a unique trash directory name
 */
function generateTrashName(): string {
  return `.vibe-trash-${Date.now()}-${crypto.randomUUID().slice(0, TRASH_UUID_LENGTH)}`;
}

/**
 * Move a directory to macOS Trash using Finder (via osascript)
 * Returns true if successful, false otherwise
 */
async function moveToMacOSTrash(targetPath: string): Promise<boolean> {
  try {
    // Reject paths with control characters to prevent injection attacks
    const hasControlChars = CONTROL_CHARS_PATTERN.test(targetPath);
    if (hasControlChars) {
      return false;
    }

    // Escape backslashes and double quotes in the path for AppleScript
    const escapedPath = targetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const command = new Deno.Command("osascript", {
      args: [
        "-e",
        `tell application "Finder" to delete POSIX file "${escapedPath}"`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const { success } = await command.output();
    return success;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached background process to delete a directory
 * This process runs independently and won't block the parent from exiting
 *
 * Note: Uses nohup on Linux to ensure the process continues after
 * the parent exits. Path is passed as an argument ($1) to avoid shell injection.
 */
function spawnBackgroundDelete(trashPath: string): void {
  const isWindows = runtime.build.os === "windows";

  if (isWindows) {
    // Windows: use cmd /c with start /b for detached process
    // Path is passed as separate argument to avoid shell interpretation
    const child = runtime.process.spawn({
      cmd: "cmd",
      args: ["/c", "start", "/b", "cmd", "/c", "rd", "/s", "/q", trashPath],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true,
    });
    // Unref to allow parent to exit without waiting
    child.unref();
  } else {
    // Linux: use nohup to ensure deletion continues after parent exits
    // $1 is used to pass the path safely, avoiding shell injection
    const child = runtime.process.spawn({
      cmd: "sh",
      args: ["-c", 'nohup rm -rf "$1" >/dev/null 2>&1 &', "_", trashPath],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true,
    });
    // Unref to allow parent to exit without waiting for child
    child.unref();
  }
}

/**
 * Get the system temp directory path
 * Uses /tmp on Linux, %TEMP% on Windows
 */
function getTempDir(): string {
  const isWindows = Deno.build.os === "windows";
  if (isWindows) {
    return Deno.env.get("TEMP") || Deno.env.get("TMP") || "C:\\Windows\\Temp";
  }
  return "/tmp";
}

/**
 * Fast remove a directory by moving it to trash or temp location
 *
 * On macOS: Uses Finder to move to system Trash (reliable, OS-managed)
 * On Linux: Uses /tmp with nohup rm -rf (cleaned on reboot)
 * On Windows: Uses temp directory with background deletion
 *
 * Note: If targetPath is a symlink, the symlink itself is removed/moved,
 * not the target it points to. This is the expected behavior for cleaning
 * up worktrees which should not affect the original repository.
 *
 * @param targetPath The directory to remove
 * @returns Result indicating success/failure and the trash path if successful
 */
export async function fastRemoveDirectory(
  targetPath: string,
): Promise<FastRemoveResult> {
  const isMacOS = Deno.build.os === "darwin";

  try {
    // macOS: Use Finder to move to Trash (most reliable)
    if (isMacOS) {
      const movedToTrash = await moveToMacOSTrash(targetPath);
      if (movedToTrash) {
        // Finder handles the actual deletion
        return { success: true, trashedPath: MACOS_TRASH_DISPLAY_PATH };
      }
      // Fall through to fallback if Finder fails (e.g., SSH session)
    }

    // Fallback: rename to temp directory + background delete
    const trashName = generateTrashName();
    const tempDir = getTempDir();
    const tempTrashPath = join(tempDir, trashName);

    // Step 1: Try to rename to temp directory first
    // This is preferred because /tmp is cleaned on reboot
    try {
      await Deno.rename(targetPath, tempTrashPath);
      spawnBackgroundDelete(tempTrashPath);
      return { success: true, trashedPath: tempTrashPath };
    } catch (tempError) {
      // Cross-device link error (EXDEV) - fall back to parent directory
      // This occurs when targetPath and /tmp are on different filesystems
      // (e.g., Docker volumes, network mounts, separate partitions)
      // Check error message since Deno doesn't have a specific CrossDeviceLink error type
      const errorMessage = String(tempError);
      const isCrossDeviceError = errorMessage.includes("cross-device") ||
        errorMessage.includes("EXDEV");
      if (!isCrossDeviceError) {
        throw tempError;
      }
    }

    // Step 2: Fallback to parent directory (same filesystem)
    const parentDir = dirname(targetPath);
    const fallbackTrashPath = join(parentDir, trashName);
    await Deno.rename(targetPath, fallbackTrashPath);

    // Spawn detached background process for deletion
    spawnBackgroundDelete(fallbackTrashPath);

    return { success: true, trashedPath: fallbackTrashPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Clean up stale .vibe-trash-* directories from a single directory
 */
async function cleanupTrashInDir(dir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const isVibeTrash = entry.isDirectory &&
        entry.name.startsWith(".vibe-trash-");
      if (isVibeTrash) {
        const trashPath = join(dir, entry.name);
        // Spawn detached background process for cleanup
        spawnBackgroundDelete(trashPath);
      }
    }
  } catch {
    // Ignore errors - directory might not exist or be inaccessible
  }
}

/**
 * Clean up any stale .vibe-trash-* directories from previous runs
 * Checks both the parent directory and the system temp directory
 * This is called asynchronously and doesn't block the user
 *
 * @param parentDir The directory to search for stale trash directories
 */
export async function cleanupStaleTrash(parentDir: string): Promise<void> {
  // Clean up in both parent directory and temp directory
  const tempDir = getTempDir();
  await Promise.all([
    cleanupTrashInDir(parentDir),
    cleanupTrashInDir(tempDir),
  ]);
}
