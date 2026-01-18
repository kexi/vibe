/**
 * Unified error handling for Vibe CLI
 *
 * Error severity levels:
 * - Fatal: Unrecoverable errors that should stop execution
 * - Warning: Non-critical errors that can be logged and continued
 * - Info: Informational messages (not truly errors)
 *
 * Exit codes:
 * - 0: Success
 * - 1: General error
 * - 2: Argument error
 * - 130: User cancelled (Ctrl+C)
 */

export enum ErrorSeverity {
  Fatal = "fatal",
  Warning = "warning",
  Info = "info",
}

/**
 * Base class for all Vibe errors
 */
export abstract class VibeError extends Error {
  abstract readonly severity: ErrorSeverity;
  abstract readonly exitCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * User cancelled the operation (e.g., Ctrl+C or declined confirmation)
 */
export class UserCancelledError extends VibeError {
  readonly severity = ErrorSeverity.Info;
  readonly exitCode = 130;

  constructor(message = "Operation cancelled") {
    super(message);
  }
}

/**
 * Git operation failed
 */
export class GitOperationError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly command: string;

  constructor(command: string, message: string) {
    super(`git ${command}: ${message}`);
    this.command = command;
  }
}

/**
 * Configuration file error (parsing, validation, etc.)
 */
export class ConfigurationError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly configPath?: string;

  constructor(message: string, configPath?: string) {
    super(configPath ? `${configPath}: ${message}` : message);
    this.configPath = configPath;
  }
}

/**
 * File system operation error
 */
export class FileSystemError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly path: string;

  constructor(operation: string, path: string, cause?: Error) {
    const message = cause
      ? `Failed to ${operation} "${path}": ${cause.message}`
      : `Failed to ${operation} "${path}"`;
    super(message);
    this.path = path;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Worktree operation error
 */
export class WorktreeError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly worktreePath?: string;

  constructor(message: string, worktreePath?: string) {
    super(message);
    this.worktreePath = worktreePath;
  }
}

/**
 * Hook execution error (non-fatal, warns and continues)
 */
export class HookExecutionError extends VibeError {
  readonly severity = ErrorSeverity.Warning;
  readonly exitCode = 0; // Hooks failing shouldn't stop the command
  readonly hookCommand: string;

  constructor(hookCommand: string, message: string) {
    super(`Hook "${hookCommand}" failed: ${message}`);
    this.hookCommand = hookCommand;
  }
}

/**
 * Command argument error
 */
export class ArgumentError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 2;
  readonly argument?: string;

  constructor(message: string, argument?: string) {
    super(message);
    this.argument = argument;
  }
}

/**
 * Network operation error
 */
export class NetworkError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly url?: string;

  constructor(message: string, url?: string) {
    super(url ? `${message} (${url})` : message);
    this.url = url;
  }
}

/**
 * Trust/security verification error
 */
export class TrustError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 1;
  readonly filePath: string;

  constructor(message: string, filePath: string) {
    super(`${filePath}: ${message}`);
    this.filePath = filePath;
  }
}
