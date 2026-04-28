/**
 * Validation helpers for `path_script` execution.
 *
 * The script receives user-controlled values (branch name, repo name, etc.) as
 * environment variables. A naively written script (missing double-quotes, use
 * of `eval`, etc.) can let those values inject shell syntax. We apply defense
 * in depth: hard-reject control characters, warn on shell metacharacters, and
 * verify the script's stdout for control characters as well.
 */

/** Matches ASCII control characters (0x00–0x1f) and DEL (0x7f). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Shell metacharacters that can break out of an unquoted or single-quoted
 * context. The single quote (`'`) is included on security-expert recommendation
 * because `'$VAR'` patterns are common and a value containing `'` can close the
 * quote.
 */
const SHELL_METACHARS = ["$", "`", ";", "|", "&", "<", ">", "\\", '"', "'"] as const;

const SHELL_METACHAR_SET = new Set<string>(SHELL_METACHARS);

export interface ControlCharFinding {
  /** Field name as exposed to the script (e.g. "VIBE_BRANCH_NAME"). */
  fieldName: string;
  /** Hex representation of the first offending byte, e.g. "0x0a". */
  hex: string;
}

/**
 * Throw if `value` contains any control character. The error message reports
 * the first offending character in hex so users can identify it without the
 * terminal eating it.
 */
export function assertNoControlChars(fieldName: string, value: string): void {
  const match = value.match(CONTROL_CHAR_REGEX);
  const isClean = match === null;
  if (isClean) {
    return;
  }

  const codePoint = match[0].charCodeAt(0);
  const hex = `0x${codePoint.toString(16).padStart(2, "0")}`;
  throw new Error(
    `Refused to execute path_script: ${fieldName} contains a control character (${hex}).\n` +
      `This is rejected to prevent injection. Please rename the branch:\n` +
      `  git branch -m <new-name>`,
  );
}

/** Return the unique shell metacharacters present in `value`, preserving order. */
export function findShellMetachars(value: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const ch of value) {
    const isMeta = SHELL_METACHAR_SET.has(ch);
    if (!isMeta) {
      continue;
    }
    const isDup = seen.has(ch);
    if (isDup) {
      continue;
    }
    seen.add(ch);
    found.push(ch);
  }
  return found;
}

/**
 * Stable dedup key for `(field, metachars)` so the same warning is emitted at
 * most once per process even if `resolveWorktreePath` is called many times.
 */
export function buildWarningKey(fieldName: string, metachars: readonly string[]): string {
  return `${fieldName}:${[...metachars].sort().join("")}`;
}

/**
 * Build the user-facing warning message. Includes an actionable hint with the
 * recommended `path_script` snippet.
 */
export function buildShellMetacharWarning(fieldName: string, metachars: readonly string[]): string {
  const list = metachars.join(", ");
  return (
    `[vibe] Warning: ${fieldName} contains shell metacharacters: ${list}\n` +
    `Ensure your path_script always double-quotes environment variables:\n` +
    `  echo "\${HOME}/worktrees/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"\n` +
    `Never use 'eval' with these variables.`
  );
}

/** Throw if the script's stdout contains a control character. */
export function assertOutputHasNoControlChars(rawOutput: string): void {
  const match = rawOutput.match(CONTROL_CHAR_REGEX);
  const isClean = match === null;
  if (isClean) {
    return;
  }

  const codePoint = match[0].charCodeAt(0);
  // A single trailing newline is the normal terminator from `echo`; allow it
  // and reject everything else (embedded newlines, multiple newlines, CR, etc.).
  const isOnlyTrailingNewline =
    codePoint === 0x0a && rawOutput.indexOf("\n") === rawOutput.length - 1;
  if (isOnlyTrailingNewline) {
    return;
  }

  const hex = `0x${codePoint.toString(16).padStart(2, "0")}`;
  throw new Error(
    `Worktree path script output contains a control character (${hex}). ` +
      `Ensure the script outputs a single line containing only the absolute path.`,
  );
}
