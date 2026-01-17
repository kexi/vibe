/**
 * Deno FFI implementation
 */

import type { RuntimeFFI } from "../types.ts";

export const denoFFI: RuntimeFFI = {
  available: true,

  dlopen<T extends Record<string, Deno.ForeignFunction>>(
    path: string,
    symbols: T,
  ): Deno.DynamicLibrary<T> {
    return Deno.dlopen(path, symbols);
  },
};
