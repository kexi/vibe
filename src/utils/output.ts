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
