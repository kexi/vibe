/**
 * Node.js native clone implementation using @kexi/vibe-native
 *
 * This module provides Copy-on-Write cloning functionality for Node.js
 * by wrapping the @kexi/vibe-native N-API module.
 */

import type { NativeClone } from "../../utils/copy/ffi/types.ts";

// Lazy load the native module
let nativeModule: typeof import("@kexi/vibe-native") | null = null;
let loadAttempted = false;

/**
 * Try to load the @kexi/vibe-native module
 */
function tryLoadNative(): typeof import("@kexi/vibe-native") | null {
  if (loadAttempted) {
    return nativeModule;
  }
  loadAttempted = true;

  try {
    // Dynamic import to handle optional dependency
    // @ts-ignore - @kexi/vibe-native is an optional dependency
    nativeModule = require("@kexi/vibe-native");
    return nativeModule;
  } catch {
    return null;
  }
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

  constructor() {
    const native = tryLoadNative();
    this.available = native !== null && native.isAvailable();
  }

  async cloneFile(src: string, dest: string): Promise<void> {
    const native = tryLoadNative();
    const isAvailable = native !== null && native.isAvailable();
    if (!isAvailable) {
      throw new Error("Native clone not available");
    }
    return native!.cloneFile(src, dest);
  }

  async cloneDirectory(src: string, dest: string): Promise<void> {
    const native = tryLoadNative();
    const isAvailable = native !== null && native.isAvailable();
    if (!isAvailable) {
      throw new Error("Native clone not available");
    }
    return native!.cloneDirectory(src, dest);
  }

  supportsDirectoryClone(): boolean {
    const native = tryLoadNative();
    const isAvailable = native !== null;
    if (!isAvailable) {
      return false;
    }
    return native.supportsDirectory();
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
