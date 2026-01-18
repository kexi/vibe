import { dirname, join } from "@std/path";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { getNativeTrashAdapter, type NativeTrashAdapter } from "../native/index.ts";
import { type OutputOptions, verboseLog } from "./output.ts";

/**
 * Display path for system Trash returned to callers.
 * - macOS: ~/.Trash (Finder managed)
 * - Linux: ~/.local/share/Trash (XDG specification)
 */
export const SYSTEM_TRASH_DISPLAY_PATH = "~/.Trash";

/** Pattern to detect control characters that could cause issues in shell/AppleScript */
// deno-lint-ignore no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

/** Cached native trash adapter instance */
let cachedNativeTrashAdapter: NativeTrashAdapter | null | undefined;

/**
 * Reset the trash adapter cache.
 * Useful for testing to ensure each test gets a fresh adapter state.
 */
export function resetTrashAdapterCache(): void {
  cachedNativeTrashAdapter = undefined;
}

/**
 * Get or create the native trash adapter
 */
async function getTrashAdapter(): Promise<NativeTrashAdapter | null> {
  if (cachedNativeTrashAdapter === undefined) {
    cachedNativeTrashAdapter = await getNativeTrashAdapter();
  }
  return cachedNativeTrashAdapter;
}

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
 * Currently returns true for all platforms because:
 * - macOS: Native Trash (Node.js) or AppleScript fallback (Deno)
 * - Linux: Native XDG Trash (Node.js) or /tmp fallback
 * - Windows: %TEMP% fallback
 *
 * This function exists for API stability. Future versions may
 * return false for platforms with limited support (e.g., sandboxed environments).
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
 * Move a directory to system Trash using native module or platform-specific fallback
 *
 * On Node.js: Uses @kexi/vibe-native (trash crate)
 *   - macOS: Finder Trash
 *   - Linux: XDG Trash (~/.local/share/Trash)
 *
 * On Deno (fallback): Uses osascript on macOS
 *
 * Returns true if successful, false otherwise
 */
async function moveToSystemTrash(
  targetPath: string,
  ctx: AppContext,
  outputOpts: OutputOptions = {},
): Promise<boolean> {
  // First, try native trash adapter (available on Node.js)
  const trashAdapter = await getTrashAdapter();
  if (trashAdapter?.available) {
    try {
      await trashAdapter.moveToTrash(targetPath);
      return true;
    } catch (error) {
      // Log error in verbose mode for debugging, then fall through to platform-specific fallback
      verboseLog(`Native trash failed: ${error}`, outputOpts);
    }
  }

  // Deno fallback: Use osascript on macOS
  const isMacOS = ctx.runtime.build.os === "darwin";
  if (isMacOS) {
    return moveToMacOSTrashViaAppleScript(targetPath, ctx);
  }

  // Linux/other: No Deno native trash support, let caller use /tmp fallback
  return false;
}

/**
 * Move a directory to macOS Trash using Finder (via osascript)
 * This is used as a fallback when native module is not available (Deno runtime)
 */
async function moveToMacOSTrashViaAppleScript(
  targetPath: string,
  ctx: AppContext,
): Promise<boolean> {
  try {
    // Reject paths with control characters to prevent injection attacks
    const hasControlChars = CONTROL_CHARS_PATTERN.test(targetPath);
    if (hasControlChars) {
      return false;
    }

    // Escape backslashes and double quotes in the path for AppleScript
    const escapedPath = targetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = ctx.runtime.process.spawn({
      cmd: "osascript",
      args: [
        "-e",
        `tell application "Finder" to delete POSIX file "${escapedPath}"`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const { success } = await child.wait();
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
function spawnBackgroundDelete(trashPath: string, ctx: AppContext): void {
  const { runtime } = ctx;
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
function getTempDir(ctx: AppContext): string {
  const { runtime } = ctx;
  const isWindows = runtime.build.os === "windows";
  if (isWindows) {
    return runtime.env.get("TEMP") || runtime.env.get("TMP") ||
      "C:\\Windows\\Temp";
  }
  return "/tmp";
}

/**
 * Fast remove a directory by moving it to trash or temp location
 *
 * Strategy (in order of preference):
 * 1. Native trash (via @kexi/vibe-native on Node.js)
 *    - macOS: Finder Trash
 *    - Linux: XDG Trash (~/.local/share/Trash)
 * 2. AppleScript fallback (Deno on macOS)
 * 3. /tmp + background delete (Linux without desktop, SSH sessions)
 * 4. Parent directory fallback (cross-device scenarios)
 *
 * Note: If targetPath is a symlink, the symlink itself is removed/moved,
 * not the target it points to. This is the expected behavior for cleaning
 * up worktrees which should not affect the original repository.
 *
 * @param targetPath The directory to remove
 * @param ctx Application context
 * @param outputOpts Output options for verbose logging
 * @returns Result indicating success/failure and the trash path if successful
 */
export async function fastRemoveDirectory(
  targetPath: string,
  ctx: AppContext = getGlobalContext(),
  outputOpts: OutputOptions = {},
): Promise<FastRemoveResult> {
  try {
    // Try system trash first (native module on Node.js, osascript on macOS Deno)
    const movedToTrash = await moveToSystemTrash(targetPath, ctx, outputOpts);
    if (movedToTrash) {
      return { success: true, trashedPath: SYSTEM_TRASH_DISPLAY_PATH };
    }
    // Fall through to /tmp fallback if trash fails (SSH session, no desktop, etc.)

    // Fallback: rename to temp directory + background delete
    const trashName = generateTrashName();
    const tempDir = getTempDir(ctx);
    const tempTrashPath = join(tempDir, trashName);

    // Step 1: Try to rename to temp directory first
    // This is preferred because /tmp is cleaned on reboot
    try {
      await ctx.runtime.fs.rename(targetPath, tempTrashPath);
      spawnBackgroundDelete(tempTrashPath, ctx);
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
    await ctx.runtime.fs.rename(targetPath, fallbackTrashPath);

    // Spawn detached background process for deletion
    spawnBackgroundDelete(fallbackTrashPath, ctx);

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
async function cleanupTrashInDir(dir: string, ctx: AppContext): Promise<void> {
  const { runtime } = ctx;
  try {
    for await (const entry of runtime.fs.readDir(dir)) {
      const isVibeTrash = entry.isDirectory &&
        entry.name.startsWith(".vibe-trash-");
      if (isVibeTrash) {
        const trashPath = join(dir, entry.name);
        // Spawn detached background process for cleanup
        spawnBackgroundDelete(trashPath, ctx);
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
 * @param ctx Application context
 */
export async function cleanupStaleTrash(
  parentDir: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  // Clean up in both parent directory and temp directory
  const tempDir = getTempDir(ctx);
  await Promise.all([
    cleanupTrashInDir(parentDir, ctx),
    cleanupTrashInDir(tempDir, ctx),
  ]);
}
