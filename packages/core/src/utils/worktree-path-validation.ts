import { isAbsolute, resolve } from "node:path";
import { validatePath } from "./copy/validation.ts";

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const SEGMENT_SEPARATOR = /[/\\]/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:[^/\\]/;
const WINDOWS_LONG_OR_UNC_PREFIX = /^\\\\/;

function escapeForErrorMessage(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

/**
 * Validates a path used as a git worktree location and returns its canonical form.
 *
 * Rejects relative paths, control characters, leading `-`, `..` segments, and
 * Windows drive-relative / long-path / UNC prefixes. On success returns `path.resolve(p)`.
 *
 * Note: this is syntactic validation only; symlinks in parent directories are NOT
 * resolved. A pre-existing symlink at any parent component can still escape the
 * intended area at the time `git worktree add/remove` runs (TOCTOU). An optional
 * allowlist of permitted roots (`worktree.allowedRoots`) is tracked as a future
 * enhancement.
 */
export function validateWorktreePath(p: string): string {
  const isEmpty = p.trim() === "";
  if (isEmpty) {
    throw new Error(`Invalid worktree path: path is empty`);
  }

  validatePath(p);

  const safePath = escapeForErrorMessage(p);

  const hasControlChar = CONTROL_CHAR_PATTERN.test(p);
  if (hasControlChar) {
    throw new Error(`Invalid worktree path: contains control characters: ${safePath}`);
  }

  const startsWithDash = p.startsWith("-");
  if (startsWithDash) {
    throw new Error(
      `Invalid worktree path: must not start with '-' (argument-injection risk): ${safePath}`,
    );
  }

  const isLongOrUnc = WINDOWS_LONG_OR_UNC_PREFIX.test(p);
  if (isLongOrUnc) {
    throw new Error(
      `Invalid worktree path: Windows long-path or UNC prefix is not allowed: ${safePath}`,
    );
  }

  const isDriveRelative = WINDOWS_DRIVE_RELATIVE.test(p);
  if (isDriveRelative) {
    throw new Error(
      `Invalid worktree path: Windows drive-relative form is not allowed: ${safePath}`,
    );
  }

  const isNotAbsolute = !isAbsolute(p);
  if (isNotAbsolute) {
    throw new Error(`Invalid worktree path: must be absolute: ${safePath}`);
  }

  const segments = p.split(SEGMENT_SEPARATOR);
  const hasParentSegment = segments.some((segment) => segment === "..");
  if (hasParentSegment) {
    throw new Error(`Invalid worktree path: must not contain '..' segments: ${safePath}`);
  }

  return resolve(p);
}
