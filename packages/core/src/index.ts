/**
 * @kexi/vibe-core
 *
 * Core components for Vibe - Runtime abstraction, types, errors, and context
 */

// ===== Runtime =====
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

export type {
  Arch,
  ChildProcess,
  DirEntry,
  FileInfo,
  MkdirOptions,
  OS,
  RemoveOptions,
  RunOptions,
  RunResult,
  Runtime,
  RuntimeBuild,
  RuntimeControl,
  RuntimeEnv,
  RuntimeErrors,
  RuntimeFFI,
  RuntimeFS,
  RuntimeIO,
  RuntimeProcess,
  RuntimeSignals,
  Signal,
  SpawnOptions,
  StderrStream,
  StdinStream,
} from "./runtime/types.ts";

// ===== Types =====
export { parseVibeConfig, VibeConfigSchema } from "./types/config.ts";
export type { VibeConfig } from "./types/config.ts";

// ===== Errors =====
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

// ===== Context =====
export {
  createAppContext,
  getGlobalContext,
  hasGlobalContext,
  resetGlobalContext,
  setGlobalContext,
} from "./context/index.ts";
export type { AppContext, UserSettings } from "./context/index.ts";
