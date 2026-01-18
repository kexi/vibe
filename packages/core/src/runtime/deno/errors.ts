/**
 * Deno errors implementation
 */

import type { RuntimeErrors } from "../types.ts";

export const denoErrors: RuntimeErrors = {
  NotFound: Deno.errors.NotFound,
  AlreadyExists: Deno.errors.AlreadyExists,
  PermissionDenied: Deno.errors.PermissionDenied,

  isNotFound(error: unknown): boolean {
    return error instanceof Deno.errors.NotFound;
  },

  isAlreadyExists(error: unknown): boolean {
    return error instanceof Deno.errors.AlreadyExists;
  },

  isPermissionDenied(error: unknown): boolean {
    return error instanceof Deno.errors.PermissionDenied;
  },
};
