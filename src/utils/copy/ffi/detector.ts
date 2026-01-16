import type { NativeClone } from "./types.ts";
import { IS_DENO, IS_NODE, runtime } from "../../../runtime/index.ts";

/**
 * Check if FFI is available (requires --allow-ffi permission in Deno)
 */
export function isFFIAvailable(): boolean {
  // Deno: Check FFI permission
  if (IS_DENO) {
    try {
      const ffi = runtime.ffi;
      return ffi?.available ?? false;
    } catch {
      return false;
    }
  }

  // Node.js: Check if @vibe/native is available
  // Note: Actual availability check is done in getNativeClone() which uses dynamic import
  if (IS_NODE) {
    // Return true here to indicate FFI mechanism is available on Node.js
    // The actual native module availability is checked when getNativeClone() is called
    return true;
  }

  return false;
}

/**
 * Get the appropriate NativeClone implementation for the current OS
 * Returns null if native clone is not available or the OS is not supported
 */
export async function getNativeClone(): Promise<NativeClone | null> {
  // Node.js: Use @vibe/native module
  if (IS_NODE) {
    try {
      const { createNodeNativeClone } = await import("../../../runtime/node/native.ts");
      const clone = createNodeNativeClone();
      const isAvailable = clone.available;
      if (isAvailable) {
        return clone;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Deno: Use FFI
  const ffiAvailable = isFFIAvailable();
  if (!ffiAvailable) {
    return null;
  }

  const os = runtime.build.os;

  const isMacOS = os === "darwin";
  if (isMacOS) {
    const { DarwinClone } = await import("./darwin.ts");
    const clone = new DarwinClone();
    const isAvailable = clone.available;
    if (isAvailable) {
      return clone;
    }
    clone.close();
    return null;
  }

  const isLinux = os === "linux";
  if (isLinux) {
    const { LinuxClone } = await import("./linux.ts");
    const clone = new LinuxClone();
    const isAvailable = clone.available;
    if (isAvailable) {
      return clone;
    }
    clone.close();
    return null;
  }

  return null;
}
