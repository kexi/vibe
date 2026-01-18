/**
 * @module @kexi/vibe-core
 *
 * Core components for Vibe CLI - Runtime abstraction, types, errors, and context.
 *
 * This package provides cross-platform runtime abstraction for Deno and Node.js,
 * along with shared types, error classes, and context management.
 */

// Runtime exports
export {
  getRuntime,
  getRuntimeSync,
  initRuntime,
  IS_BUN,
  IS_DENO,
  IS_NODE,
  runtime,
  RUNTIME_NAME,
} from "./runtime/index.ts";
export type * from "./runtime/types.ts";

// Context exports
export {
  createAppContext,
  getGlobalContext,
  hasGlobalContext,
  resetGlobalContext,
  setGlobalContext,
} from "./context/index.ts";
export type { AppContext, UserSettings } from "./context/index.ts";

// Error exports
export {
  ArgumentError,
  ConfigurationError,
  ErrorSeverity,
  FileSystemError,
  GitOperationError,
  HookExecutionError,
  NetworkError,
  TrustError,
  UserCancelledError,
  VibeError,
  WorktreeError,
} from "./errors/index.ts";

// Type exports
export { parseVibeConfig, VibeConfigSchema } from "./types/config.ts";
export type { VibeConfig } from "./types/config.ts";
