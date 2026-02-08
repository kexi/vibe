/**
 * Unified error handler for Vibe CLI
 *
 * This module provides consistent error handling across all commands.
 */

import { type AppContext, getGlobalContext } from "../context/index.ts";
import { ErrorSeverity, HookExecutionError, UserCancelledError, VibeError } from "./index.ts";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Options for error handling
 */
export interface ErrorHandlerOptions {
  /** Whether to print verbose error details */
  verbose?: boolean;
  /** Whether to suppress output */
  quiet?: boolean;
}

/**
 * Handle an error and return appropriate exit code
 *
 * @param error The error to handle
 * @param options Handler options
 * @param ctx Application context
 * @returns Exit code (0 for success, non-zero for errors)
 */
export function handleError(
  error: unknown,
  options: ErrorHandlerOptions = {},
  _ctx: AppContext = getGlobalContext(),
): number {
  const { verbose = false, quiet = false } = options;

  // Handle VibeError instances
  if (error instanceof VibeError) {
    return handleVibeError(error, { verbose, quiet });
  }

  // Handle DOMException timeout errors
  if (error instanceof DOMException && error.name === "TimeoutError") {
    if (!quiet) {
      console.error(`${RED}Error: Request timed out.${RESET}`);
      console.error("Please check your network connection and try again.");
    }
    return 1;
  }

  // Handle generic errors
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (!quiet) {
    console.error(`${RED}Error: ${errorMessage}${RESET}`);
  }

  if (verbose && error instanceof Error && error.stack) {
    console.error(`${DIM}\nStack trace:`);
    console.error(`${error.stack}${RESET}`);
  }

  return 1;
}

/**
 * Handle a VibeError with appropriate output
 */
function handleVibeError(error: VibeError, options: { verbose: boolean; quiet: boolean }): number {
  const { verbose, quiet } = options;

  // UserCancelledError - silent exit
  if (error instanceof UserCancelledError) {
    if (!quiet && error.message !== "Operation cancelled") {
      console.error(error.message);
    }
    return error.exitCode;
  }

  // HookExecutionError - warning, continue
  if (error instanceof HookExecutionError) {
    if (!quiet) {
      console.error(`${YELLOW}Warning: ${error.message}${RESET}`);
    }
    return error.exitCode;
  }

  // All other VibeErrors
  if (!quiet) {
    const isWarning = error.severity === ErrorSeverity.Warning;
    const prefix = isWarning ? "Warning" : "Error";
    const color = isWarning ? YELLOW : RED;
    console.error(`${color}${prefix}: ${error.message}${RESET}`);
  }

  if (verbose && error.stack) {
    console.error(`${DIM}\nStack trace:`);
    console.error(`${error.stack}${RESET}`);
  }

  return error.exitCode;
}

/**
 * Wrap a command function with error handling
 *
 * This is a higher-order function that wraps any async command function
 * with consistent error handling and process exit.
 *
 * @param fn The command function to wrap
 * @param options Handler options
 * @param ctx Application context
 */
export function withErrorHandler<T extends (...args: Parameters<T>) => Promise<void>>(
  fn: T,
  options: ErrorHandlerOptions = {},
  ctx: AppContext = getGlobalContext(),
): (...args: Parameters<T>) => Promise<void> {
  return async (...args: Parameters<T>): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      const exitCode = handleError(error, options, ctx);
      const shouldExit = exitCode !== 0;
      if (shouldExit) {
        ctx.runtime.control.exit(exitCode);
      }
    }
  };
}

/**
 * Assert a condition and throw ArgumentError if false
 */
export function assertArgument(
  condition: boolean,
  message: string,
  argument?: string,
): asserts condition {
  if (!condition) {
    // Dynamically import to avoid circular dependency
    throw new Error(`Argument error${argument ? ` (${argument})` : ""}: ${message}`);
  }
}
