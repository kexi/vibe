/**
 * @kexi/vibe-native - Native clone operations
 *
 * Provides Copy-on-Write cloning using:
 * - macOS: clonefile() on APFS
 * - Linux: FICLONE ioctl on Btrfs/XFS
 */

/**
 * Check if native clone operations are available
 */
export function isAvailable(): boolean;

/**
 * Check if directory cloning is supported
 * - macOS clonefile: true (supports directories)
 * - Linux FICLONE: false (files only)
 */
export function supportsDirectory(): boolean;

/**
 * Get the current platform
 * @returns "darwin", "linux", or "unknown"
 */
export function getPlatform(): "darwin" | "linux" | "unknown";

/**
 * Clone a file using native Copy-on-Write
 * @param src - Source file path
 * @param dest - Destination file path
 */
export function cloneFile(src: string, dest: string): Promise<void>;

/**
 * Clone a directory using native Copy-on-Write
 * Note: Only supported on macOS (clonefile). Linux FICLONE does not support directories.
 * @param src - Source directory path
 * @param dest - Destination directory path
 */
export function cloneDirectory(src: string, dest: string): Promise<void>;

/**
 * Get the load error if native module failed to load
 */
export function getLoadError(): Error | null;
