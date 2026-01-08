/**
 * Native clone operation interface for FFI-based implementations
 */
export interface NativeClone {
  /** Whether FFI is available and initialized */
  readonly available: boolean;

  /**
   * Clone a file using native system call
   * @param src Source file path
   * @param dest Destination file path
   */
  cloneFile(src: string, dest: string): Promise<void>;

  /**
   * Clone a directory using native system call
   * @param src Source directory path
   * @param dest Destination directory path
   */
  cloneDirectory(src: string, dest: string): Promise<void>;

  /**
   * Whether this implementation supports directory cloning
   * - macOS clonefile: true
   * - Linux FICLONE: false
   */
  supportsDirectoryClone(): boolean;

  /**
   * Release FFI resources
   */
  close(): void;
}

/**
 * Result of an FFI operation
 */
export interface FFIResult {
  success: boolean;
  errorCode?: number;
  errorMessage?: string;
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
 * Check if an error code indicates fallback is needed
 */
export function shouldFallback(errorCode: number, os: "darwin" | "linux"): boolean {
  const isDarwin = os === "darwin";
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
