/**
 * Node.js errors implementation
 */

import type { RuntimeErrors } from "../types.ts";

/**
 * Custom error class for NotFound errors
 */
export class NotFoundError extends Error {
  code = "ENOENT";
  override name = "NotFound";

  constructor(message?: string) {
    super(message ?? "No such file or directory");
  }
}

/**
 * Custom error class for AlreadyExists errors
 */
export class AlreadyExistsError extends Error {
  code = "EEXIST";
  override name = "AlreadyExists";

  constructor(message?: string) {
    super(message ?? "File or directory already exists");
  }
}

/**
 * Custom error class for PermissionDenied errors
 */
export class PermissionDeniedError extends Error {
  code = "EACCES";
  override name = "PermissionDenied";

  constructor(message?: string) {
    super(message ?? "Permission denied");
  }
}

/**
 * Check if an error is a Node.js system error with a specific code
 */
function isNodeError(error: unknown, code: string): boolean {
  const isErrorWithCode = error instanceof Error && "code" in error;
  if (isErrorWithCode) {
    return (error as Error & { code: string }).code === code;
  }
  return false;
}

export const nodeErrors: RuntimeErrors = {
  NotFound: NotFoundError,
  AlreadyExists: AlreadyExistsError,
  PermissionDenied: PermissionDeniedError,

  isNotFound(error: unknown): boolean {
    if (error instanceof NotFoundError) {
      return true;
    }
    return isNodeError(error, "ENOENT");
  },

  isAlreadyExists(error: unknown): boolean {
    if (error instanceof AlreadyExistsError) {
      return true;
    }
    return isNodeError(error, "EEXIST");
  },

  isPermissionDenied(error: unknown): boolean {
    if (error instanceof PermissionDeniedError) {
      return true;
    }
    return isNodeError(error, "EACCES") || isNodeError(error, "EPERM");
  },
};
