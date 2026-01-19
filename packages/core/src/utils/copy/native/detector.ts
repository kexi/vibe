import type { NativeClone } from "./types.ts";
import { IS_DENO, IS_NODE, runtime } from "../../../runtime/index.ts";

/**
 * Check if native clone module is potentially available
 *
 * Returns true if the runtime could support native cloning.
 * Actual availability is checked when getNativeClone() is called.
 */
export function isNativeCloneAvailable(): boolean {
  // Both Deno and Node.js use N-API (@kexi/vibe-native)
  // Actual availability is checked when getNativeClone() is called
  return IS_DENO || IS_NODE;
}

/**
 * Get the appropriate NativeClone implementation for the current OS
 * Returns null if native clone is not available or the OS is not supported
 *
 * Both Deno and Node.js now use @kexi/vibe-native (N-API module).
 */
export async function getNativeClone(): Promise<NativeClone | null> {
  // Node.js: Use @kexi/vibe-native module via require
  if (IS_NODE) {
    try {
      const { createNodeNativeClone } = await import("../../../runtime/node/native.ts");
      const clone = createNodeNativeClone();
      const isAvailable = clone.available;
      if (isAvailable) {
        return clone;
      }
      return null;
    } catch (error) {
      const isDebug = runtime.env.get("VIBE_DEBUG") === "1";
      if (isDebug) {
        console.warn("[vibe] Failed to load native clone module (Node.js):", error);
      }
      return null;
    }
  }

  // Deno: Use @kexi/vibe-native module via npm: specifier (Deno 2.x N-API support)
  if (IS_DENO) {
    try {
      const native = await import("@kexi/vibe-native");

      const isAvailable = native.isAvailable();
      if (!isAvailable) {
        return null;
      }

      // Create a NativeClone-compatible wrapper
      return {
        available: true,
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

  return null;
}
