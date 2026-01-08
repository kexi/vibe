import type { NativeClone } from "./types.ts";

/**
 * Check if FFI is available (requires --allow-ffi permission)
 */
export function isFFIAvailable(): boolean {
  try {
    const hasDlopen = typeof Deno.dlopen === "function";
    return hasDlopen;
  } catch {
    return false;
  }
}

/**
 * Get the appropriate NativeClone implementation for the current OS
 * Returns null if FFI is not available or the OS is not supported
 */
export async function getNativeClone(): Promise<NativeClone | null> {
  const ffiAvailable = isFFIAvailable();
  if (!ffiAvailable) {
    return null;
  }

  const os = Deno.build.os;

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
