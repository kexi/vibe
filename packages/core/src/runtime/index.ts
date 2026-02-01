/**
 * Runtime detection and initialization
 *
 * This module provides runtime detection and exports the appropriate
 * runtime implementation based on the current execution environment.
 */

import type { Runtime } from "./types.ts";

// Re-export types
export type * from "./types.ts";

/**
 * Detect the current runtime environment
 * @throws Error if running in an unsupported environment (not Node.js or Bun)
 */
function detectRuntime(): "node" | "bun" {
  // Check for Bun
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).Bun !== "undefined") {
    return "bun";
  }

  // Verify Node.js is available
  if (typeof process !== "undefined" && process.versions?.node) {
    return "node";
  }

  // Unsupported runtime
  throw new Error("Unsupported runtime: vibe requires Node.js 18+ or Bun 1.2+");
}

/**
 * Current runtime name
 */
export const RUNTIME_NAME = detectRuntime();

/**
 * Whether running on Deno
 * @deprecated Deno support was removed in v0.18.0. This constant is kept for backward compatibility.
 */
export const IS_DENO = false;

/**
 * Whether running on Node.js
 */
export const IS_NODE = RUNTIME_NAME === "node";

/**
 * Whether running on Bun
 */
export const IS_BUN = RUNTIME_NAME === "bun";

// Runtime instance cache
let runtimeInstance: Runtime | null = null;
let runtimeInitPromise: Promise<Runtime> | null = null;
let initializationInProgress = false;

/**
 * Get the runtime implementation for the current environment
 *
 * This function lazily loads the appropriate runtime implementation
 * based on the detected runtime environment.
 *
 * Thread-safe: Uses a flag to prevent concurrent initialization and
 * clears the promise after completion to allow retry on failure.
 */
export async function getRuntime(): Promise<Runtime> {
  // Fast path: already initialized
  if (runtimeInstance) {
    return runtimeInstance;
  }

  // Wait for in-progress initialization
  if (runtimeInitPromise) {
    return runtimeInitPromise;
  }

  // Prevent concurrent initialization attempts with bounded retry
  const MAX_INIT_WAIT_RETRIES = 100;
  let retryCount = 0;
  while (initializationInProgress && retryCount < MAX_INIT_WAIT_RETRIES) {
    // Another call is setting up the promise, wait briefly and check again
    await new Promise((resolve) => setTimeout(resolve, 1));
    retryCount++;
    // Check if initialization completed while waiting
    if (runtimeInstance) {
      return runtimeInstance;
    }
    if (runtimeInitPromise) {
      return runtimeInitPromise;
    }
  }

  // If still in progress after max retries, throw error
  if (initializationInProgress) {
    throw new Error("Runtime initialization timed out");
  }

  initializationInProgress = true;

  runtimeInitPromise = (async () => {
    try {
      // Node.js and Bun use the same implementation
      const { nodeRuntime } = await import("./node/index.ts");
      runtimeInstance = nodeRuntime;
      return runtimeInstance;
    } finally {
      // Always clear initialization state in finally block
      // This ensures retry is possible on failure and cleans up after success
      runtimeInitPromise = null;
      initializationInProgress = false;
    }
  })();

  return runtimeInitPromise;
}

/**
 * Get the runtime implementation synchronously (must be initialized first)
 *
 * @throws Error if runtime has not been initialized via getRuntime()
 */
export function getRuntimeSync(): Runtime {
  if (!runtimeInstance) {
    throw new Error(
      "Runtime not initialized. Call await getRuntime() first, or use initRuntime() at startup.",
    );
  }
  return runtimeInstance;
}

/**
 * Initialize the runtime (call at application startup)
 */
export async function initRuntime(): Promise<Runtime> {
  return await getRuntime();
}

/**
 * Runtime proxy for lazy access
 *
 * This allows using `runtime.xxx` pattern without explicit async initialization.
 * The proxy will throw an error if accessed before initialization.
 */
const runtimeProxy = new Proxy({} as Runtime, {
  get(_target, prop) {
    if (!runtimeInstance) {
      throw new Error(
        `Runtime not initialized. Access to runtime.${String(
          prop,
        )} requires calling await initRuntime() at application startup.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (runtimeInstance as any)[prop];
  },
});

/**
 * Runtime instance for cross-platform code
 *
 * IMPORTANT: You must call `await initRuntime()` before using this export.
 * This export is a proxy that will throw if accessed before initialization.
 */
export const runtime: Runtime = runtimeProxy;
