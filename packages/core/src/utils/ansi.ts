export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

let _colorEnabled: boolean | null = null;

function detectColorSupport(): boolean {
  try {
    const forceColor = process.env?.FORCE_COLOR !== undefined;
    if (forceColor) return true;

    const noColor = process.env?.NO_COLOR !== undefined;
    if (noColor) return false;

    return process.stderr?.isTTY ?? false;
  } catch {
    return false;
  }
}

export function isColorEnabled(): boolean {
  if (_colorEnabled === null) {
    _colorEnabled = detectColorSupport();
  }
  return _colorEnabled;
}

/** Reset cached color detection (for testing). */
export function resetColorDetection(): void {
  _colorEnabled = null;
}

/** Wrap message with ANSI color codes when color is enabled. */
export function colorize(color: string, message: string): string {
  const shouldColorize = isColorEnabled();
  if (!shouldColorize) return message;
  return `${color}${message}${RESET}`;
}
