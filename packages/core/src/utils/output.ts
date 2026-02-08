/**
 * Output options for controlling verbosity level.
 */
export interface OutputOptions {
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * Log a message to stderr unless quiet mode is enabled.
 */
export function log(message: string, options: OutputOptions): void {
  const shouldLog = !options.quiet;
  if (shouldLog) {
    console.error(message);
  }
}

/**
 * Log a verbose message to stderr when verbose mode is enabled.
 */
export function verboseLog(message: string, options: OutputOptions): void {
  const shouldLog = options.verbose && !options.quiet;
  if (shouldLog) {
    console.error(`[verbose] ${message}`);
  }
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Log a success message to stderr with green color.
 * Uses stderr because stdout is reserved for shell commands (eval pattern).
 */
export function successLog(message: string, options: OutputOptions): void {
  const shouldLog = !options.quiet;
  if (shouldLog) {
    console.error(`${GREEN}${message}${RESET}`);
  }
}

/**
 * Log an error message to stderr with red color.
 * Always outputs regardless of quiet mode, as errors should never be suppressed.
 */
export function errorLog(message: string, _options: OutputOptions): void {
  console.error(`${RED}${message}${RESET}`);
}

/**
 * Log a warning message to stderr with yellow color.
 * Always outputs regardless of quiet mode, as warnings should not be suppressed.
 */
export function warnLog(message: string): void {
  console.warn(`${YELLOW}${message}${RESET}`);
}

/**
 * Log a dry-run message to stderr with dim color.
 * Always outputs regardless of quiet mode.
 */
export function logDryRun(message: string): void {
  console.error(`${DIM}[dry-run] ${message}${RESET}`);
}
