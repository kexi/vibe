/**
 * Application Context
 *
 * This module provides dependency injection for the vibe CLI.
 * Instead of importing the global `runtime` singleton directly,
 * functions accept an AppContext parameter with a default value.
 */

import type { Runtime } from "../runtime/types.ts";
import type { VibeConfig } from "../types/config.ts";

/**
 * User settings stored in ~/.config/vibe/settings.toml
 */
export interface UserSettings {
  worktree_parent?: string;
  default_hooks?: boolean;
  default_copy?: boolean;
}

/**
 * Application context containing all dependencies
 */
export interface AppContext {
  /** Runtime abstraction for cross-platform operations */
  readonly runtime: Runtime;
  /** Vibe configuration from .vibe.toml (optional) */
  config?: VibeConfig;
  /** User settings from ~/.config/vibe/settings.toml (optional) */
  settings?: UserSettings;
}

// Global context instance
let globalContext: AppContext | null = null;

/**
 * Set the global application context
 *
 * Call this at application startup after initializing the runtime.
 */
export function setGlobalContext(ctx: AppContext): void {
  globalContext = ctx;
}

/**
 * Get the global application context
 *
 * @throws Error if context has not been initialized
 */
export function getGlobalContext(): AppContext {
  if (!globalContext) {
    throw new Error("AppContext not initialized. Call setGlobalContext() at application startup.");
  }
  return globalContext;
}

/**
 * Check if global context is initialized
 */
export function hasGlobalContext(): boolean {
  return globalContext !== null;
}

/**
 * Create an AppContext from a runtime instance
 */
export function createAppContext(runtime: Runtime): AppContext {
  return { runtime };
}

/**
 * Reset global context (for testing purposes)
 */
export function resetGlobalContext(): void {
  globalContext = null;
}
