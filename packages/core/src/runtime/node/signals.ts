/**
 * Node.js signal handling implementation
 */

import type { RuntimeSignals, Signal } from "../types.ts";

export const nodeSignals: RuntimeSignals = {
  addListener(signal: Signal, handler: () => void): void {
    try {
      process.on(signal, handler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  },

  removeListener(signal: Signal, handler: () => void): void {
    try {
      process.off(signal, handler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  },
};
