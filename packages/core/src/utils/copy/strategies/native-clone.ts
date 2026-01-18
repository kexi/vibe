import { dirname } from "@std/path";
import type { CopyStrategy } from "../types.ts";
import type { NativeClone } from "../ffi/types.ts";
import { getNativeClone } from "../ffi/detector.ts";
import { validatePath } from "../validation.ts";
import { runtime } from "../../../runtime/index.ts";

/**
 * Native clone strategy using FFI-based system calls.
 * - macOS: Uses clonefile() for both files and directories
 * - Linux: Uses FICLONE ioctl for files only (directories not supported)
 */
export class NativeCloneStrategy implements CopyStrategy {
  readonly name = "clonefile" as const;
  private nativeClone: NativeClone | null = null;
  private initialized = false;

  async isAvailable(): Promise<boolean> {
    await this.ensureInitialized();
    return this.nativeClone !== null;
  }

  private async ensureInitialized(): Promise<void> {
    const alreadyInitialized = this.initialized;
    if (alreadyInitialized) {
      return;
    }
    this.nativeClone = await getNativeClone();
    this.initialized = true;
  }

  async copyFile(src: string, dest: string): Promise<void> {
    validatePath(src);
    validatePath(dest);

    await this.ensureInitialized();
    const hasNativeClone = this.nativeClone !== null;
    if (!hasNativeClone) {
      throw new Error("Native clone is not available");
    }

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    await this.nativeClone!.cloneFile(src, dest);
  }

  async copyDirectory(src: string, dest: string): Promise<void> {
    validatePath(src);
    validatePath(dest);

    await this.ensureInitialized();
    const hasNativeClone = this.nativeClone !== null;
    if (!hasNativeClone) {
      throw new Error("Native clone is not available");
    }

    // Check if directory cloning is supported
    const supportsDirectory = this.nativeClone!.supportsDirectoryClone();
    if (!supportsDirectory) {
      throw new Error("Native directory cloning not supported on this platform");
    }

    // Ensure parent directory exists
    const destDir = dirname(dest);
    await runtime.fs.mkdir(destDir, { recursive: true }).catch(() => {});

    await this.nativeClone!.cloneDirectory(src, dest);
  }

  /**
   * Check if this strategy supports directory cloning on the current platform
   */
  supportsDirectoryClone(): boolean {
    const hasNativeClone = this.nativeClone !== null;
    if (!hasNativeClone) {
      return false;
    }
    return this.nativeClone!.supportsDirectoryClone();
  }

  /**
   * Release FFI resources
   */
  close(): void {
    this.nativeClone?.close();
    this.nativeClone = null;
    this.initialized = false;
  }
}
