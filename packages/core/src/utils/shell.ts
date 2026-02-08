/**
 * Escape a path for safe use inside single-quoted shell strings.
 *
 * Replaces each single quote with the sequence `'\''` which:
 * 1. Ends the current single-quoted string
 * 2. Adds an escaped single quote
 * 3. Starts a new single-quoted string
 *
 * @example
 * escapeShellPath("/path/with'quote") // "/path/with'\\''quote"
 */
export function escapeShellPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}
