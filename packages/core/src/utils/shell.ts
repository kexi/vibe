/**
 * Escape a string for safe use inside single quotes in shell commands.
 *
 * The technique closes the current single-quoted string, appends an escaped
 * single quote (\'), then reopens the single-quoted string:
 *   it's  ->  it'\''s
 */
export function escapeForShellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Build a shell `cd` command with the path safely single-quoted.
 *
 * This is used to emit commands that will be eval'd by the `.vibedev`
 * shell wrapper, so the path MUST be escaped to prevent injection.
 */
export function cdCommand(path: string): string {
  return `cd '${escapeForShellSingleQuote(path)}'`;
}
