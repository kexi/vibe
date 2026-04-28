import { dirname, join } from "node:path";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { FileSystemError } from "../errors/index.ts";
import { getNativeTrashAdapter, type NativeTrashAdapter } from "../native/index.ts";
import type { FileInfo } from "../runtime/types.ts";
import { type OutputOptions, verboseLog } from "./output.ts";

/**
 * Display path for system Trash returned to callers.
 * - macOS: ~/.Trash (Finder managed)
 * - Linux: ~/.local/share/Trash (XDG specification)
 */
export const SYSTEM_TRASH_DISPLAY_PATH = "~/.Trash";

/**
 * Pattern to detect characters that could cause issues in shell/AppleScript.
 *
 * Includes:
 * - C0 control characters (\x00-\x1f) and DEL (\x7f)
 * - U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), which are
 *   AppleScript line terminators and would let an attacker break out of
 *   the quoted string in `tell application "Finder" to delete POSIX file "..."`.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f\u2028\u2029]/;

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

/**
 * Length of UUID suffix used in trash directory names for uniqueness.
 *
 * 16 hex chars (64 bits of entropy) make pre-planting attacks via name
 * enumeration computationally infeasible.
 */
const TRASH_UUID_LENGTH = 16;

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
  return `.vibe-trash-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, TRASH_UUID_LENGTH)}`;
}

/**
 * Result of validating a removal target.
 */
type ValidationResult =
  | { valid: true; info: FileInfo }
  | { valid: false; reason: "not-found" | "symlink" | "not-directory" };

/**
 * Validate that `targetPath` is a removable directory (not a symlink, not a file).
 *
 * Uses `lstat` (not `stat`) so we never follow symlinks while checking — a
 * symlinked path must be rejected, not silently dereferenced.
 */
async function validateRemovalTarget(
  targetPath: string,
  ctx: AppContext,
): Promise<ValidationResult> {
  let info: FileInfo;
  try {
    info = await ctx.runtime.fs.lstat(targetPath);
  } catch (error) {
    const isMissing = ctx.runtime.errors.isNotFound(error);
    if (isMissing) {
      return { valid: false, reason: "not-found" };
    }
    throw error;
  }

  const isSymlinkTarget = info.isSymlink === true;
  if (isSymlinkTarget) {
    return { valid: false, reason: "symlink" };
  }

  const isNotDirectory = !info.isDirectory;
  if (isNotDirectory) {
    return { valid: false, reason: "not-directory" };
  }

  return { valid: true, info };
}

/**
 * Verify that the immediate parent directory is a real directory and not
 * itself a symlink. The relevant attack is "attacker swaps the worktree's
 * parent with a symlink redirecting subsequent operations" — a single `lstat`
 * on the parent string detects this directly.
 *
 * We deliberately do NOT compare `realPath(parentDir) === parentDir` here:
 * legitimate setups (macOS `/tmp` → `/private/tmp`, `/var/folders/...`,
 * Windows 8.3 short-name expansion, APFS case-insensitive casing) routinely
 * produce a different `realPath` for completely benign paths and would
 * cause false-positives. Deeper-ancestor swaps require attacker write
 * access higher up the tree, which is outside the practical threat model
 * for #417 (and the post-rename verification still catches any
 * race-window exploits).
 */
async function isParentSafe(parentDir: string, ctx: AppContext): Promise<boolean> {
  try {
    const info = await ctx.runtime.fs.lstat(parentDir);
    const isSafe = !info.isSymlink && info.isDirectory;
    return isSafe;
  } catch {
    return false;
  }
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
 * Returns true if successful, false otherwise.
 *
 * SECURITY: Callers MUST validate `targetPath` with `validateRemovalTarget`
 * immediately before calling this function. Both code paths below
 * (native trash adapter and AppleScript fallback) trust the caller to have
 * verified that the path is a real directory and not a symlink.
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
 *
 * SECURITY: Finder's `delete POSIX file` may follow the leaf symlink (deleting
 * the link target instead of the link). To defend against TOCTOU symlink
 * swaps, we `lstat` the leaf (must be a real directory) and the immediate
 * parent (must not be a symlink) before invoking Finder.
 */
async function moveToMacOSTrashViaAppleScript(
  targetPath: string,
  ctx: AppContext,
): Promise<boolean> {
  try {
    // Reject paths with control characters or AppleScript line separators
    // to prevent injection attacks
    const hasControlChars = CONTROL_CHARS_PATTERN.test(targetPath);
    if (hasControlChars) {
      return false;
    }

    // Defense against TOCTOU symlink swap right before invoking Finder.
    // Finder's `delete POSIX file` may follow the leaf symlink; we must ensure
    // the leaf is a real directory and the immediate parent is not a symlink.
    let leafInfo: FileInfo;
    try {
      leafInfo = await ctx.runtime.fs.lstat(targetPath);
    } catch {
      return false;
    }
    const isLeafSafe = !leafInfo.isSymlink && leafInfo.isDirectory;
    if (!isLeafSafe) {
      return false;
    }
    const parentSafe = await isParentSafe(dirname(targetPath), ctx);
    if (!parentSafe) {
      return false;
    }

    // Escape backslashes and double quotes in the path for AppleScript
    const escapedPath = targetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = ctx.runtime.process.spawn({
      cmd: "osascript",
      args: ["-e", `tell application "Finder" to delete POSIX file "${escapedPath}"`],
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
    return runtime.env.get("TEMP") || runtime.env.get("TMP") || "C:\\Windows\\Temp";
  }
  return "/tmp";
}

/**
 * Map a `validateRemovalTarget` failure reason to a `FileSystemError` operation
 * suitable for inclusion in the result. The `"not-found"` case is handled by
 * the caller (idempotent success) and is excluded from the reason type here.
 */
const OPERATION_BY_REASON: Record<"symlink" | "not-directory", string> = {
  symlink: "remove (refusing symlink)",
  "not-directory": "remove (not a directory)",
};

function operationForInvalid(reason: "symlink" | "not-directory"): string {
  return OPERATION_BY_REASON[reason];
}

/**
 * Re-validate the target before each external sink. Returns:
 * - `null` if the caller should continue (target is valid)
 * - A terminal `FastRemoveResult` otherwise (success for not-found, failure
 *   for symlink/non-directory)
 */
async function checkBeforeSink(
  targetPath: string,
  ctx: AppContext,
): Promise<FastRemoveResult | null> {
  const result = await validateRemovalTarget(targetPath, ctx);
  if (result.valid) {
    return null;
  }
  if (result.reason === "not-found") {
    return { success: true, trashedPath: undefined };
  }
  return {
    success: false,
    error: new FileSystemError(operationForInvalid(result.reason), targetPath),
  };
}

/**
 * Re-validate the immediate parent directory before each external sink that
 * may resolve through it (rename, native trash, AppleScript). Returns `null`
 * if safe; a terminal failure result otherwise.
 */
async function checkParentBeforeSink(
  targetPath: string,
  ctx: AppContext,
): Promise<FastRemoveResult | null> {
  const safe = await isParentSafe(dirname(targetPath), ctx);
  if (safe) {
    return null;
  }
  return {
    success: false,
    error: new FileSystemError("remove (parent is symlink)", targetPath),
  };
}

/**
 * Fast remove a directory by moving it to trash or temp location.
 *
 * Strategy (in order of preference):
 * 1. Native trash (via @kexi/vibe-native on Node.js)
 *    - macOS: Finder Trash
 *    - Linux: XDG Trash (~/.local/share/Trash)
 * 2. AppleScript fallback (Deno on macOS)
 * 3. /tmp + background delete (Linux without desktop, SSH sessions)
 * 4. Parent directory fallback (cross-device scenarios)
 *
 * SECURITY (issue #417): Defends against TOCTOU symlink-swap attacks where an
 * attacker with write access to the worktree's parent directory could replace
 * the worktree path with a symlink to a sensitive location between checks and
 * rename/trash invocations.
 *
 * Defense-in-depth measures:
 * - Symlinks are refused outright (returns `{success: false}`); a symlinked
 *   target must never reach `rename`, the native trash adapter, or `osascript`.
 * - Non-directories (regular files, sockets, etc.) are refused.
 * - A fresh `lstat` check is performed immediately before each external sink
 *   (system trash, temp-dir rename, parent-dir rename) to shrink the TOCTOU
 *   window to its theoretical minimum.
 * - Before each rename or native-trash invocation, the immediate parent
 *   directory is `lstat`ed to ensure it is a real directory (not a symlink).
 *   This catches the case where an attacker swaps the worktree's parent with
 *   a symlink redirecting subsequent operations. (Deeper-ancestor swaps
 *   require attacker write access higher up the tree, beyond the practical
 *   threat model.)
 * - After each rename, the destination is re-`lstat`ed; if a symlink is now
 *   present (TOCTOU detected during the rename), we attempt to roll back and
 *   skip the background deletion entirely.
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
    // Pre-flight validation: lstat (no symlink follow), reject symlinks and non-dirs
    const initialResult = await checkBeforeSink(targetPath, ctx);
    if (initialResult !== null) {
      return initialResult;
    }

    // Try system trash first (native module on Node.js, osascript on macOS Deno).
    // Re-validate immediately before invocation (defense-in-depth against TOCTOU)
    // and ensure the immediate parent is not a symlink.
    const trashRecheckResult = await checkBeforeSink(targetPath, ctx);
    if (trashRecheckResult !== null) {
      return trashRecheckResult;
    }
    const trashParentResult = await checkParentBeforeSink(targetPath, ctx);
    if (trashParentResult !== null) {
      return trashParentResult;
    }
    const movedToTrash = await moveToSystemTrash(targetPath, ctx, outputOpts);
    if (movedToTrash) {
      return { success: true, trashedPath: SYSTEM_TRASH_DISPLAY_PATH };
    }
    // Fall through to /tmp fallback if trash fails (SSH session, no desktop, etc.)

    // Fallback: rename to temp directory + background delete
    const trashName = generateTrashName();
    const tempDir = getTempDir(ctx);
    const tempTrashPath = join(tempDir, trashName);
    const parentDir = dirname(targetPath);

    // Step 1: Try to rename to temp directory first
    // This is preferred because /tmp is cleaned on reboot
    let usedTempPath = false;
    try {
      // Re-validate target and parent immediately before rename
      const tempRecheckResult = await checkBeforeSink(targetPath, ctx);
      if (tempRecheckResult !== null) {
        return tempRecheckResult;
      }
      const tempParentResult = await checkParentBeforeSink(targetPath, ctx);
      if (tempParentResult !== null) {
        return tempParentResult;
      }

      await ctx.runtime.fs.rename(targetPath, tempTrashPath);
      usedTempPath = true;

      // Post-rename verification: did we actually move a real directory, or
      // did a TOCTOU swap convert the destination into a symlink? Treat any
      // validation throw as a TOCTOU detection so we don't orphan the temp dir.
      let postValid = false;
      try {
        const postRename = await validateRemovalTarget(tempTrashPath, ctx);
        postValid = postRename.valid;
      } catch {
        postValid = false;
      }
      if (!postValid) {
        return await handleToctouRollback(targetPath, tempTrashPath, ctx);
      }

      spawnBackgroundDelete(tempTrashPath, ctx);
      return { success: true, trashedPath: tempTrashPath };
    } catch (tempError) {
      // If the rename itself succeeded but a later step threw, we already
      // returned above. Here `tempError` is from rename or the recheck.
      if (usedTempPath) {
        throw tempError;
      }

      // Cross-device link error (EXDEV) - fall back to parent directory.
      // This occurs when targetPath and /tmp are on different filesystems
      // (e.g., Docker volumes, network mounts, separate partitions).
      // Check error message since Deno doesn't have a specific CrossDeviceLink error type.
      const errorMessage = String(tempError);
      const isCrossDeviceError =
        errorMessage.includes("cross-device") || errorMessage.includes("EXDEV");
      if (!isCrossDeviceError) {
        throw tempError;
      }
    }

    // Step 2: Fallback to parent directory (same filesystem)
    const fallbackTrashPath = join(parentDir, trashName);

    // Re-validate target and parent immediately before rename
    const fallbackRecheckResult = await checkBeforeSink(targetPath, ctx);
    if (fallbackRecheckResult !== null) {
      return fallbackRecheckResult;
    }
    const fallbackParentResult = await checkParentBeforeSink(targetPath, ctx);
    if (fallbackParentResult !== null) {
      return fallbackParentResult;
    }

    await ctx.runtime.fs.rename(targetPath, fallbackTrashPath);

    // Post-rename verification: same TOCTOU defense as the temp-dir path —
    // wrap in try/catch so a thrown lstat error doesn't orphan the renamed dir.
    let postFallbackValid = false;
    try {
      const postFallback = await validateRemovalTarget(fallbackTrashPath, ctx);
      postFallbackValid = postFallback.valid;
    } catch {
      postFallbackValid = false;
    }
    if (!postFallbackValid) {
      return await handleToctouRollback(targetPath, fallbackTrashPath, ctx);
    }

    // Spawn detached background process for deletion
    spawnBackgroundDelete(fallbackTrashPath, ctx);

    return { success: true, trashedPath: fallbackTrashPath };
  } catch (error) {
    // NotFound is success (another process already removed it)
    if (ctx.runtime.errors.isNotFound(error)) {
      return { success: true, trashedPath: undefined };
    }
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Handle a TOCTOU detection after a rename: attempt to roll back so the
 * caller's filesystem is left in a recoverable state. NEVER spawn the
 * background delete in this case — the destination is now a symlink to
 * an attacker-chosen path.
 */
async function handleToctouRollback(
  originalPath: string,
  destPath: string,
  ctx: AppContext,
): Promise<FastRemoveResult> {
  try {
    await ctx.runtime.fs.rename(destPath, originalPath);
    return {
      success: false,
      error: new FileSystemError("remove (TOCTOU detected)", originalPath),
    };
  } catch (rollbackError) {
    const cause = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    return {
      success: false,
      error: new FileSystemError(
        `remove (TOCTOU detected, rollback failed; manual recovery required at ${destPath})`,
        originalPath,
        cause,
      ),
    };
  }
}

/**
 * Clean up stale .vibe-trash-* directories from a single directory
 *
 * SECURITY: Symlinks named `.vibe-trash-*` are skipped and never passed to
 * `spawnBackgroundDelete`. Otherwise an attacker could plant a symlink to a
 * sensitive directory under the parent and trick `rm -rf` into recursing
 * through the link.
 */
async function cleanupTrashInDir(dir: string, ctx: AppContext): Promise<void> {
  const { runtime } = ctx;
  try {
    for await (const entry of runtime.fs.readDir(dir)) {
      const isVibeTrash =
        entry.isDirectory && !entry.isSymlink && entry.name.startsWith(".vibe-trash-");
      if (!isVibeTrash) {
        continue;
      }

      const trashPath = join(dir, entry.name);

      // Re-check via lstat: readDir's flags can race with the filesystem; a
      // symlink swapped in after enumeration must still be skipped.
      let info: FileInfo;
      try {
        info = await runtime.fs.lstat(trashPath);
      } catch {
        continue;
      }
      const isSafeTarget = info.isDirectory && !info.isSymlink;
      if (!isSafeTarget) {
        continue;
      }

      // Spawn detached background process for cleanup
      spawnBackgroundDelete(trashPath, ctx);
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
  await Promise.all([cleanupTrashInDir(parentDir, ctx), cleanupTrashInDir(tempDir, ctx)]);
}
