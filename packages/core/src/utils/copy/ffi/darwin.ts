import type { NativeClone } from "./types.ts";
import { DARWIN_ERROR_CODES } from "./types.ts";

/**
 * FFI symbol definitions for macOS
 */
const DARWIN_SYMBOLS = {
  clonefile: {
    parameters: ["buffer", "buffer", "u32"],
    result: "i32",
  },
  // __error() returns a pointer to errno
  __error: {
    parameters: [],
    result: "pointer",
  },
} as const;

type DarwinLibrary = Deno.DynamicLibrary<typeof DARWIN_SYMBOLS>;

/**
 * Error messages for macOS clonefile errors
 */
const ERROR_MESSAGES: Record<number, string> = {
  [DARWIN_ERROR_CODES.EXDEV]: "Cross-device clone not supported",
  [DARWIN_ERROR_CODES.ENOTSUP]: "Clone not supported (non-APFS filesystem)",
  [DARWIN_ERROR_CODES.EEXIST]: "Destination already exists",
  [DARWIN_ERROR_CODES.ENOENT]: "Source file not found",
  [DARWIN_ERROR_CODES.EACCES]: "Permission denied",
};

/**
 * macOS clonefile FFI implementation
 *
 * Uses the clonefile() system call to create CoW clones on APFS.
 * Supports both files and directories.
 */
export class DarwinClone implements NativeClone {
  private dylib: DarwinLibrary | null = null;
  readonly available: boolean;

  constructor() {
    this.available = this.tryLoadLibrary();
  }

  private tryLoadLibrary(): boolean {
    try {
      this.dylib = Deno.dlopen("libSystem.B.dylib", DARWIN_SYMBOLS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clone a file using clonefile()
   */
  async cloneFile(src: string, dest: string): Promise<void> {
    await this.clone(src, dest);
  }

  /**
   * Clone a directory using clonefile()
   * macOS clonefile supports directory cloning natively
   */
  async cloneDirectory(src: string, dest: string): Promise<void> {
    await this.clone(src, dest);
  }

  private clone(_src: string, _dest: string): Promise<void> {
    const hasLibrary = this.dylib !== null;
    if (!hasLibrary) {
      return Promise.reject(new Error("DarwinClone: library not loaded"));
    }

    const srcBuffer = new TextEncoder().encode(_src + "\0");
    const destBuffer = new TextEncoder().encode(_dest + "\0");

    // clonefile(src, dest, flags)
    // flags = 0 means default behavior
    const result = this.dylib!.symbols.clonefile(srcBuffer, destBuffer, 0);

    const isSuccess = result === 0;
    if (isSuccess) {
      return Promise.resolve();
    }

    // Get errno via __error()
    const errno = this.getErrno();
    return Promise.reject(this.createError(_src, _dest, errno));
  }

  /**
   * Get the last errno value via __error()
   */
  private getErrno(): number {
    const hasLibrary = this.dylib !== null;
    if (!hasLibrary) {
      return -1;
    }

    try {
      const errnoPtr = this.dylib!.symbols.__error();
      const isNullPtr = errnoPtr === null;
      if (isNullPtr) {
        return -1;
      }
      // Read the i32 value from the pointer
      const errnoView = new Deno.UnsafePointerView(errnoPtr);
      return errnoView.getInt32();
    } catch {
      return -1;
    }
  }

  private createError(src: string, dest: string, errno: number): Error {
    const knownMessage = ERROR_MESSAGES[errno];
    const hasKnownMessage = knownMessage !== undefined;
    const message = hasKnownMessage
      ? `clonefile failed: ${knownMessage}`
      : `clonefile failed: errno ${errno}`;
    const error = new Error(message);
    (error as Error & { code: number }).code = errno;
    (error as Error & { src: string }).src = src;
    (error as Error & { dest: string }).dest = dest;
    return error;
  }

  supportsDirectoryClone(): boolean {
    return true;
  }

  close(): void {
    this.dylib?.close();
    this.dylib = null;
  }
}
