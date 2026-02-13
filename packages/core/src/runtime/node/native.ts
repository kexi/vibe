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
 * Load the .node file directly for the current platform/architecture.
 *
 * This bypasses the NAPI-RS generated index.js which uses existsSync()
 * to check for .node files — a check that fails inside Bun's compiled
 * binary virtual filesystem ($bunfs).
 *
 * IMPORTANT: Each require() call MUST use a string literal so that
 * Bun's bundler can statically discover and embed the .node files
 * during `bun build --compile`.
 */
function loadNativeForPlatform(): VibeNativeModule | null {
  const { platform, arch } = process;

  try {
    if (platform === "darwin" && arch === "arm64") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("../../../../native/vibe-native.darwin-arm64.node") as VibeNativeModule;
    }
    if (platform === "darwin" && arch === "x64") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("../../../../native/vibe-native.darwin-x64.node") as VibeNativeModule;
    }
    if (platform === "linux" && arch === "x64") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("../../../../native/vibe-native.linux-x64-gnu.node") as VibeNativeModule;
    }
    if (platform === "linux" && arch === "arm64") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("../../../../native/vibe-native.linux-arm64-gnu.node") as VibeNativeModule;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (process.env.VIBE_DEBUG) {
      console.warn(`[vibe-native] Direct .node load failed: ${errorMessage}`);
    }
  }

  return null;
}

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

  // Try 1: NAPI-RS index.js (development mode, npm distribution)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require("@kexi/vibe-native") as VibeNativeModule;
    return nativeModule;
  } catch {
    // index.js existsSync fails inside Bun's $bunfs — fall through to direct load
  }

  // Try 2: Direct .node file require (for Bun compiled binaries)
  nativeModule = loadNativeForPlatform();
  if (nativeModule !== null) {
    if (process.env.VIBE_DEBUG) {
      console.warn("[vibe-native] Loaded via direct .node require");
    }
    return nativeModule;
  }

  lastLoadError = "Failed to load @kexi/vibe-native via both package and direct .node paths";
  if (process.env.VIBE_DEBUG) {
    console.warn(`[vibe-native] ${lastLoadError}`);
  }
  return null;
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
