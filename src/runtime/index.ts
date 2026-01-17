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
 */
function detectRuntime(): "deno" | "node" | "bun" {
  // Check for Deno
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).Deno !== "undefined") {
    return "deno";
  }

  // Check for Bun
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).Bun !== "undefined") {
    return "bun";
  }

  // Check for Node.js
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).process !== "undefined") {
    // deno-lint-ignore no-explicit-any
    const proc = (globalThis as any).process;
    const hasVersions = proc.versions && typeof proc.versions.node === "string";
    if (hasVersions) {
      return "node";
    }
  }

  // Default to Node.js for unknown environments
  return "node";
}

/**
 * Current runtime name
 */
export const RUNTIME_NAME = detectRuntime();

/**
 * Whether running on Deno
 */
export const IS_DENO = RUNTIME_NAME === "deno";

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
 * Auto-initialize Deno runtime at module load time
 *
 * Deno supports top-level await and can safely load modules synchronously,
 * so we initialize immediately to avoid requiring explicit initRuntime() calls.
 * This makes tests work without manual initRuntime() calls.
 */
if (IS_DENO) {
  const { denoRuntime } = await import("./deno/index.ts");
  runtimeInstance = denoRuntime;
}

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

  // Prevent concurrent initialization attempts
  if (initializationInProgress) {
    // Another call is setting up the promise, wait briefly and retry
    await new Promise((resolve) => setTimeout(resolve, 0));
    return getRuntime();
  }

  initializationInProgress = true;

  runtimeInitPromise = (async () => {
    try {
      if (IS_DENO) {
        const { denoRuntime } = await import("./deno/index.ts");
        runtimeInstance = denoRuntime;
      } else {
        // Node.js and Bun use the same implementation
        const { nodeRuntime } = await import("./node/index.ts");
        runtimeInstance = nodeRuntime;
      }
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
        `Runtime not initialized. Access to runtime.${
          String(prop)
        } requires calling await initRuntime() at application startup.`,
      );
    }
    // deno-lint-ignore no-explicit-any
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
