/**
 * Unified native operation errors
 *
 * These errors provide consistent error handling for
 * native Clone-on-Write operations via @kexi/vibe-native (N-API).
 */

/**
 * Base error class for native clone operations
 */
export class NativeCloneError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly errno?: number,
  ) {
    super(message);
    this.name = "NativeCloneError";
  }
}

/**
 * Error for unsupported filesystem operations
 * Thrown when the filesystem doesn't support Copy-on-Write
 */
export class UnsupportedFilesystemError extends NativeCloneError {
  constructor(operation: string, filesystem?: string) {
    const fsInfo = filesystem ? ` (filesystem: ${filesystem})` : "";
    super(`${operation} is not supported on this filesystem${fsInfo}`, "ENOTSUP", 45);
    this.name = "UnsupportedFilesystemError";
  }
}

/**
 * Error for cross-device operations
 * Thrown when trying to clone across different filesystems
 */
export class CrossDeviceError extends NativeCloneError {
  constructor(src: string, dest: string) {
    super(`Cannot clone across different filesystems: ${src} -> ${dest}`, "EXDEV", 18);
    this.name = "CrossDeviceError";
  }
}

/**
 * Error for permission denied
 */
export class PermissionDeniedError extends NativeCloneError {
  constructor(path: string) {
    super(`Permission denied: ${path}`, "EACCES", 13);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Error for file not found
 */
export class FileNotFoundError extends NativeCloneError {
  constructor(path: string) {
    super(`File not found: ${path}`, "ENOENT", 2);
    this.name = "FileNotFoundError";
  }
}

/**
 * Error for file already exists
 */
export class FileExistsError extends NativeCloneError {
  constructor(path: string) {
    super(`File already exists: ${path}`, "EEXIST", 17);
    this.name = "FileExistsError";
  }
}

/**
 * Error for native module not available
 */
export class NativeModuleNotAvailableError extends NativeCloneError {
  constructor(runtime: string, reason?: string) {
    const reasonInfo = reason ? `: ${reason}` : "";
    super(`Native clone module not available on ${runtime}${reasonInfo}`, "ENOSYS", 78);
    this.name = "NativeModuleNotAvailableError";
  }
}

/**
 * Error codes for macOS clonefile
 */
export const DARWIN_ERROR_CODES = {
  EXDEV: 18, // Cross-device link
  ENOTSUP: 45, // Operation not supported (non-APFS)
  EEXIST: 17, // File exists
  ENOENT: 2, // No such file or directory
  EACCES: 13, // Permission denied
} as const;

/**
 * Error codes for Linux FICLONE
 */
export const LINUX_ERROR_CODES = {
  EOPNOTSUPP: 95, // Operation not supported
  EXDEV: 18, // Cross-device link
  EISDIR: 21, // Is a directory
  EINVAL: 22, // Invalid argument
  EBADF: 9, // Bad file descriptor
} as const;

/**
 * Check if an error code indicates fallback to regular copy is needed
 */
export function shouldFallbackToRegularCopy(
  errorCode: number,
  platform: "darwin" | "linux",
): boolean {
  const isDarwin = platform === "darwin";
  if (isDarwin) {
    const fallbackCodes: number[] = [DARWIN_ERROR_CODES.EXDEV, DARWIN_ERROR_CODES.ENOTSUP];
    return fallbackCodes.includes(errorCode);
  }

  const fallbackCodes: number[] = [
    LINUX_ERROR_CODES.EOPNOTSUPP,
    LINUX_ERROR_CODES.EXDEV,
    LINUX_ERROR_CODES.EISDIR,
    LINUX_ERROR_CODES.EINVAL,
  ];
  return fallbackCodes.includes(errorCode);
}
