import type { NativeClone } from "./types.ts";
import { LINUX_ERROR_CODES } from "./types.ts";

/**
 * FICLONE ioctl request number
 * From linux/fs.h: #define FICLONE _IOW(0x94, 9, int)
 * _IOW(type, nr, size) = (1 << 30) | (sizeof(int) << 16) | (type << 8) | nr
 * = 0x40049409
 */
const FICLONE = 0x40049409;

/**
 * File open flags
 */
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

/**
 * FFI symbol definitions for Linux
 */
const LINUX_SYMBOLS = {
  open: {
    parameters: ["buffer", "i32", "i32"],
    result: "i32",
  },
  close: {
    parameters: ["i32"],
    result: "i32",
  },
  ioctl: {
    parameters: ["i32", "u64", "i32"],
    result: "i32",
  },
  // __errno_location() returns a pointer to errno
  __errno_location: {
    parameters: [],
    result: "pointer",
  },
} as const;

type LinuxLibrary = Deno.DynamicLibrary<typeof LINUX_SYMBOLS>;

/**
 * Error messages for Linux FICLONE errors
 */
const ERROR_MESSAGES: Record<number, string> = {
  [LINUX_ERROR_CODES.EOPNOTSUPP]: "Operation not supported (filesystem does not support reflink)",
  [LINUX_ERROR_CODES.EXDEV]: "Cross-device clone not supported",
  [LINUX_ERROR_CODES.EISDIR]: "Is a directory (FICLONE does not support directories)",
  [LINUX_ERROR_CODES.EINVAL]: "Invalid argument",
  [LINUX_ERROR_CODES.EBADF]: "Bad file descriptor",
};

/**
 * Linux FICLONE FFI implementation
 *
 * Uses the FICLONE ioctl to create CoW clones on Btrfs/XFS.
 * Note: FICLONE only supports files, not directories.
 */
export class LinuxClone implements NativeClone {
  private libc: LinuxLibrary | null = null;
  readonly available: boolean;

  constructor() {
    this.available = this.tryLoadLibrary();
  }

  private tryLoadLibrary(): boolean {
    try {
      this.libc = Deno.dlopen("libc.so.6", LINUX_SYMBOLS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clone a file using FICLONE ioctl
   */
  async cloneFile(src: string, dest: string): Promise<void> {
    await this.clone(src, dest);
  }

  /**
   * Clone a directory - NOT SUPPORTED on Linux FICLONE
   * Throws an error, caller should fallback to other strategies
   */
  cloneDirectory(_src: string, _dest: string): Promise<void> {
    return Promise.reject(new Error("FICLONE does not support directory cloning"));
  }

  private clone(src: string, dest: string): Promise<void> {
    const hasLibrary = this.libc !== null;
    if (!hasLibrary) {
      return Promise.reject(new Error("LinuxClone: library not loaded"));
    }

    const srcBuffer = new TextEncoder().encode(src + "\0");
    const destBuffer = new TextEncoder().encode(dest + "\0");

    // Open source file for reading
    const srcFd = this.libc!.symbols.open(srcBuffer, O_RDONLY, 0);
    const srcOpenFailed = srcFd < 0;
    if (srcOpenFailed) {
      const errno = this.getErrno();
      return Promise.reject(this.createError(src, dest, errno, "open source"));
    }

    // Create and open destination file for writing
    const destFd = this.libc!.symbols.open(
      destBuffer,
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    const destOpenFailed = destFd < 0;
    if (destOpenFailed) {
      this.libc!.symbols.close(srcFd);
      const errno = this.getErrno();
      return Promise.reject(this.createError(src, dest, errno, "open dest"));
    }

    // Perform FICLONE ioctl
    const result = this.libc!.symbols.ioctl(destFd, BigInt(FICLONE), srcFd);

    // Close file descriptors
    this.libc!.symbols.close(srcFd);
    this.libc!.symbols.close(destFd);

    const isSuccess = result === 0;
    if (isSuccess) {
      return Promise.resolve();
    }

    const errno = this.getErrno();
    return Promise.reject(this.createError(src, dest, errno, "ioctl FICLONE"));
  }

  /**
   * Get the last errno value via __errno_location()
   */
  private getErrno(): number {
    const hasLibrary = this.libc !== null;
    if (!hasLibrary) {
      return -1;
    }

    try {
      const errnoPtr = this.libc!.symbols.__errno_location();
      const isNullPtr = errnoPtr === null;
      if (isNullPtr) {
        return -1;
      }
      const errnoView = new Deno.UnsafePointerView(errnoPtr);
      return errnoView.getInt32();
    } catch {
      return -1;
    }
  }

  private createError(src: string, dest: string, errno: number, operation: string): Error {
    const knownMessage = ERROR_MESSAGES[errno];
    const hasKnownMessage = knownMessage !== undefined;
    const message = hasKnownMessage
      ? `${operation} failed: ${knownMessage}`
      : `${operation} failed: errno ${errno}`;
    const error = new Error(message);
    (error as Error & { code: number }).code = errno;
    (error as Error & { src: string }).src = src;
    (error as Error & { dest: string }).dest = dest;
    return error;
  }

  supportsDirectoryClone(): boolean {
    return false;
  }

  close(): void {
    this.libc?.close();
    this.libc = null;
  }
}
