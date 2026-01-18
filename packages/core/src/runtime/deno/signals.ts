/**
 * Deno signal handling implementation
 */

import type { RuntimeSignals, Signal } from "../types.ts";

export const denoSignals: RuntimeSignals = {
  addListener(signal: Signal, handler: () => void): void {
    try {
      Deno.addSignalListener(signal, handler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  },

  removeListener(signal: Signal, handler: () => void): void {
    try {
      Deno.removeSignalListener(signal, handler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  },
};
