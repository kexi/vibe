/**
 * Node.js native clone implementation using @kexi/vibe-native
 *
 * This module provides Copy-on-Write cloning functionality for Node.js
 * by wrapping the @kexi/vibe-native N-API module.
 */

import type { NativeClone } from "../../utils/copy/native/types.ts";

/** Type for the @kexi/vibe-native module */
interface VibeNativeModule {
  cloneSync(src: string, dest: string): void;
  cloneAsync(src: string, dest: string): Promise<void>;
  clone(src: string, dest: string): void;
  isAvailable(): boolean;
  supportsDirectory(): boolean;
  getPlatform(): "darwin" | "linux" | "unknown";
  moveToTrash(path: string): void;
  moveToTrashAsync(path: string): Promise<void>;
}

// Lazy load the native module
let nativeModule: VibeNativeModule | null = null;
let loadAttempted = false;

/** Last error message from native module loading attempt */
let lastLoadError: string | null = null;

/**
 * Try to load the @kexi/vibe-native module
 */
function tryLoadNative(): VibeNativeModule | null {
  if (loadAttempted) {
    return nativeModule;
  }
  loadAttempted = true;

  // Check for Windows - native module is not supported
  const isWindows = process.platform === "win32";
  if (isWindows) {
    lastLoadError = "Native clone module is not supported on Windows. Using standard copy instead.";
    if (process.env.VIBE_DEBUG) {
      console.warn(`[vibe-native] ${lastLoadError}`);
    }
    return null;
  }

  try {
    // Dynamic import to handle optional dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require("@kexi/vibe-native") as VibeNativeModule;
    return nativeModule;
  } catch (error) {
    // Log the error for debugging purposes
    const errorMessage = error instanceof Error ? error.message : String(error);
    lastLoadError = `Failed to load @kexi/vibe-native: ${errorMessage}`;
    if (process.env.VIBE_DEBUG) {
      console.warn(`[vibe-native] ${lastLoadError}`);
    }
    return null;
  }
}

/**
 * Get the last error message from native module loading attempt
 */
export function getLastLoadError(): string | null {
  return lastLoadError;
}

/**
 * Node.js native clone implementation
 *
 * Uses @kexi/vibe-native for Copy-on-Write cloning:
 * - macOS: clonefile() on APFS
 * - Linux: FICLONE ioctl on Btrfs/XFS
 */
export class NodeNativeClone implements NativeClone {
  readonly available: boolean;
  private readonly native: VibeNativeModule | null;

  constructor() {
    this.native = tryLoadNative();
    this.available = this.native !== null && this.native.isAvailable();
  }

  async cloneFile(src: string, dest: string): Promise<void> {
    if (!this.available || this.native === null) {
      throw new Error("Native clone not available");
    }
    return this.native.cloneAsync(src, dest);
  }

  async cloneDirectory(src: string, dest: string): Promise<void> {
    if (!this.available || this.native === null) {
      throw new Error("Native clone not available");
    }
    // cloneAsync supports directories on macOS (clonefile)
    return this.native.cloneAsync(src, dest);
  }

  supportsDirectoryClone(): boolean {
    if (this.native === null) {
      return false;
    }
    return this.native.supportsDirectory();
  }

  close(): void {
    // No-op for Node.js - native module handles its own cleanup
  }
}

/**
 * Get an instance of NodeNativeClone
 */
export function createNodeNativeClone(): NativeClone {
  return new NodeNativeClone();
}

/**
 * Native trash interface
 */
export interface NativeTrash {
  readonly available: boolean;
  moveToTrash(path: string): Promise<void>;
}

/**
 * Node.js native trash implementation using @kexi/vibe-native
 *
 * Uses the trash crate for cross-platform trash support:
 * - macOS: Uses Finder Trash
 * - Linux: Uses XDG Trash (~/.local/share/Trash)
 */
export class NodeNativeTrash implements NativeTrash {
  readonly available: boolean;
  private readonly native: VibeNativeModule | null;

  constructor() {
    this.native = tryLoadNative();
    // Trash is available if the native module is loaded
    // (trash crate works on all platforms where the module compiles)
    this.available = this.native !== null;
  }

  async moveToTrash(path: string): Promise<void> {
    if (!this.available || this.native === null) {
      throw new Error("Native trash not available");
    }
    return this.native.moveToTrashAsync(path);
  }
}

/**
 * Get an instance of NodeNativeTrash
 */
export function createNodeNativeTrash(): NativeTrash {
  return new NodeNativeTrash();
}
