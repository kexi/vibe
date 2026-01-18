/**
 * Validates a file path for use in copy operations.
 * Throws an error if the path contains dangerous characters.
 *
 * Note: While Deno.Command uses argument arrays (not shell strings),
 * which prevents most shell injection attacks, we still validate paths
 * for defense-in-depth against potential future vulnerabilities.
 */
export function validatePath(path: string): void {
  // Check for null bytes (potential injection)
  const hasNullByte = path.includes("\0");
  if (hasNullByte) {
    throw new Error(`Invalid path: contains null byte`);
  }

  // Check for newlines (could break shell commands)
  const hasNewline = path.includes("\n") || path.includes("\r");
  if (hasNewline) {
    throw new Error(`Invalid path: contains newline characters`);
  }

  // Check for empty path
  const isEmpty = path.trim() === "";
  if (isEmpty) {
    throw new Error(`Invalid path: path is empty`);
  }

  // Check for shell command substitution patterns (defense-in-depth)
  // These patterns are highly suspicious and unlikely to be legitimate paths
  const hasCommandSubstitution = path.includes("$(") || path.includes("`");
  if (hasCommandSubstitution) {
    throw new Error(`Invalid path: contains shell command substitution pattern`);
  }
}
