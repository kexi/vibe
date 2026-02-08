/**
 * Escape a value for use inside single-quoted shell strings.
 *
 * Replaces single quotes with the POSIX-compliant sequence '\''
 * which ends the current single-quoted string, adds an escaped
 * literal quote, and reopens a new single-quoted string.
 */
export function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Format a shell cd command with proper escaping.
 *
 * The output is intended to be eval'd by the shell wrapper function,
 * so paths must be properly escaped to prevent shell injection.
 */
export function formatCdCommand(path: string): string {
  return `cd '${shellEscape(path)}'`;
}
