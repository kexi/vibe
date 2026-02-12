/**
 * Unified native clone adapter
 *
 * Provides a consistent interface for native Copy-on-Write cloning
 * across different runtimes (Deno, Node.js, Bun) and platforms (macOS, Linux).
 *
 * Deno, Node.js, and Bun use @kexi/vibe-native N-API module.
 * Deno 2.x supports N-API modules via npm: specifier.
 * Bun is fully compatible with Node.js N-API, so it uses the same path.
 */

import { IS_BUN, IS_DENO, IS_NODE, runtime } from "../runtime/index.ts";

/**
 * Native trash operation interface
 */
export interface NativeTrashAdapter {
  /** Whether the native trash module is available */
  readonly available: boolean;

  /** The runtime type (deno or node). Bun reports as "node" since it shares the same N-API implementation. */
  readonly runtimeType: "deno" | "node";

  /**
   * Move a file or directory to the system trash
   * - macOS: Uses Finder Trash
   * - Linux: Uses XDG Trash (~/.local/share/Trash)
   * - Windows: Uses Recycle Bin
   * @param path Path to the file or directory to move to trash
   */
  moveToTrash(path: string): Promise<void>;
}

/**
 * Native clone operation interface
 */
export interface NativeCloneAdapter {
  /** Whether the native module is available and initialized */
  readonly available: boolean;

  /** The runtime type (deno or node). Bun reports as "node" since it shares the same N-API implementation. */
  readonly runtimeType: "deno" | "node";

  /** The platform type */
  readonly platformType: "darwin" | "linux" | "unsupported";

  /**
   * Clone a file using native system call (Copy-on-Write)
   * @param src Source file path
   * @param dest Destination file path
   */
  cloneFile(src: string, dest: string): Promise<void>;

  /**
   * Clone a directory using native system call (Copy-on-Write)
   * @param src Source directory path
   * @param dest Destination directory path
   */
  cloneDirectory(src: string, dest: string): Promise<void>;

  /**
   * Whether this implementation supports directory cloning
   * - macOS clonefile: true
   * - Linux FICLONE: false (files only)
   */
  supportsDirectoryClone(): boolean;

  /**
   * Release native resources
   */
  close(): void;
}

/**
 * Get the native clone adapter for the current runtime and platform
 *
 * Returns null if:
 * - The runtime doesn't support native cloning
 * - The platform doesn't support Copy-on-Write
 * - Native module (@kexi/vibe-native) is not installed or unavailable
 */
export function getNativeCloneAdapter(): Promise<NativeCloneAdapter | null> {
  // Node.js and Bun use the same N-API path
  if (IS_NODE || IS_BUN) {
    return getNodeAdapter();
  }

  if (IS_DENO) {
    return getDenoAdapter();
  }

  return Promise.resolve(null);
}

/**
 * Get the native trash adapter for the current runtime
 *
 * Returns null if:
 * - The runtime doesn't support native trash
 * - Native module is not installed (Node.js @kexi/vibe-native)
 *
 * Note: Deno doesn't support FFI-based trash operations currently.
 * It falls back to platform-specific methods (osascript on macOS, /tmp on Linux).
 */
export function getNativeTrashAdapter(): Promise<NativeTrashAdapter | null> {
  // Node.js and Bun use the same N-API path
  if (IS_NODE || IS_BUN) {
    return getNodeTrashAdapter();
  }

  // Deno: No native trash support via FFI
  // Fall back to platform-specific methods in fast-remove.ts
  return Promise.resolve(null);
}

/**
 * Get the Node.js trash adapter
 */
async function getNodeTrashAdapter(): Promise<NativeTrashAdapter | null> {
  try {
    const { createNodeNativeTrash } = await import("../runtime/node/native.ts");
    const trash = createNodeNativeTrash();
    const isAvailable = trash.available;
    if (!isAvailable) {
      return null;
    }

    return {
      available: trash.available,
      runtimeType: "node" as const,
      moveToTrash: (path: string) => trash.moveToTrash(path),
    };
  } catch (error) {
    const isDebug = runtime.env.get("VIBE_DEBUG") === "1";
    if (isDebug) {
      console.warn("[vibe] Failed to load native trash module (Node.js):", error);
    }
    return null;
  }
}

/**
 * Check if native cloning is available for the current runtime/platform
 */
export function isNativeCloneAvailable(): boolean {
  // For Deno, Node.js, and Bun, actual availability is checked when adapter is created
  if (IS_DENO || IS_NODE || IS_BUN) {
    return true;
  }

  return false;
}

/**
 * Get the Deno adapter using N-API (@kexi/vibe-native)
 *
 * Deno 2.x supports N-API native modules via npm: specifier,
 * allowing us to share the same binary with Node.js.
 */
async function getDenoAdapter(): Promise<NativeCloneAdapter | null> {
  try {
    // Import @kexi/vibe-native via npm specifier (Deno 2.x N-API support)
    const native = await import("@kexi/vibe-native");

    const isAvailable = native.isAvailable();
    if (!isAvailable) {
      return null;
    }

    const platform = native.getPlatform();
    const platformType =
      platform === "darwin" || platform === "linux" ? platform : ("unsupported" as const);

    return {
      available: true,
      runtimeType: "deno" as const,
      platformType,
      cloneFile: (src: string, dest: string) => native.cloneAsync(src, dest),
      cloneDirectory: (src: string, dest: string) => native.cloneAsync(src, dest),
      supportsDirectoryClone: () => native.supportsDirectory(),
      close: () => {}, // N-API uses GC, no manual cleanup needed
    };
  } catch (error) {
    const isDebug = runtime.env.get("VIBE_DEBUG") === "1";
    if (isDebug) {
      console.warn("[vibe] Failed to load native clone module (Deno):", error);
    }
    return null;
  }
}

/**
 * Get the Node.js N-API adapter
 */
async function getNodeAdapter(): Promise<NativeCloneAdapter | null> {
  try {
    const { createNodeNativeClone } = await import("../runtime/node/native.ts");
    const clone = createNodeNativeClone();
    const isAvailable = clone.available;
    if (!isAvailable) {
      return null;
    }

    // Determine platform from Node.js
    const os = runtime.build.os;
    const platformType = os === "darwin" || os === "linux" ? os : ("unsupported" as const);

    return wrapNativeClone(clone, "node", platformType);
  } catch (error) {
    const isDebug = runtime.env.get("VIBE_DEBUG") === "1";
    if (isDebug) {
      console.warn("[vibe] Failed to load native clone module (Node.js):", error);
    }
    return null;
  }
}

/**
 * Internal NativeClone interface for wrapping native module implementations
 */
interface InternalNativeClone {
  readonly available: boolean;
  cloneFile(src: string, dest: string): Promise<void>;
  cloneDirectory(src: string, dest: string): Promise<void>;
  supportsDirectoryClone(): boolean;
  close(): void;
}

/**
 * Wrap an internal NativeClone implementation with adapter metadata
 */
function wrapNativeClone(
  clone: InternalNativeClone,
  runtimeType: "deno" | "node",
  platformType: "darwin" | "linux" | "unsupported",
): NativeCloneAdapter {
  return {
    available: clone.available,
    runtimeType,
    platformType,
    cloneFile: (src: string, dest: string) => clone.cloneFile(src, dest),
    cloneDirectory: (src: string, dest: string) => clone.cloneDirectory(src, dest),
    supportsDirectoryClone: () => clone.supportsDirectoryClone(),
    close: () => clone.close(),
  };
}

// Re-export error types for consumers
export * from "./errors.ts";
