/**
 * Validates a file path for use in shell commands.
 * Throws an error if the path contains dangerous characters.
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
}
