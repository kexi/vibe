/**
 * Interactive prompt utilities
 */

import { type AppContext, getGlobalContext } from "../context/index.ts";

/**
 * Read a single line of input from the user
 * @returns The trimmed input line, or null if EOF is reached
 */
async function readLine(ctx: AppContext): Promise<string | null> {
  const buf = new Uint8Array(1024);
  const n = await ctx.runtime.io.stdin.read(buf);
  const isInputReceived = n !== null && n > 0;
  if (isInputReceived) {
    return new TextDecoder().decode(buf.subarray(0, n)).trim();
  }
  // Return null to indicate EOF or no data
  return null;
}

/**
 * Display a Y/n confirmation prompt
 * @param message Confirmation message
 * @param ctx Application context
 * @returns true if user selects Yes, false otherwise
 */
export async function confirm(
  message: string,
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  const { runtime } = ctx;

  // VIBE_FORCE_INTERACTIVE: When set to "1", forces the CLI to treat stdin as interactive.
  // This is necessary for E2E testing with node-pty, which creates a pseudo-terminal (PTY)
  // that stdin.isTerminal() may not recognize as a true TTY. Without this flag,
  // interactive prompts would fail in E2E tests even though they're running in a PTY.
  const forceInteractive = runtime.env.get("VIBE_FORCE_INTERACTIVE") === "1";
  const isInteractive = forceInteractive || runtime.io.stdin.isTerminal();

  // In non-interactive environments (CI, scripts), automatically return false
  if (!isInteractive) {
    console.error("Error: Cannot run in non-interactive mode with uncommitted changes.");
    return false;
  }

  while (true) {
    // Use writeSync to ensure immediate output in PTY environments (bypasses buffering)
    runtime.io.stderr.writeSync(new TextEncoder().encode(`${message}\n`));
    const input = await readLine(ctx);

    // Handle EOF (null) - treat as No/Cancel
    const isEof = input === null;
    if (isEof) {
      return false;
    }

    const isYes = input === "Y" || input === "y" || input === "";
    if (isYes) {
      return true;
    }

    const isNo = input === "N" || input === "n";
    if (isNo) {
      return false;
    }

    runtime.io.stderr.writeSync(new TextEncoder().encode("Invalid input. Please enter Y/y/n/N.\n"));
  }
}

/**
 * Display a numbered selection prompt
 * @param message Prompt message
 * @param choices Array of choices
 * @param ctx Application context
 * @returns Selected index (0-based)
 */
export async function select(
  message: string,
  choices: string[],
  ctx: AppContext = getGlobalContext(),
): Promise<number> {
  const { runtime } = ctx;

  // VIBE_FORCE_INTERACTIVE: When set to "1", forces the CLI to treat stdin as interactive.
  // This is necessary for E2E testing with node-pty, which creates a pseudo-terminal (PTY)
  // that stdin.isTerminal() may not recognize as a true TTY. Without this flag,
  // interactive prompts would fail in E2E tests even though they're running in a PTY.
  const forceInteractive = runtime.env.get("VIBE_FORCE_INTERACTIVE") === "1";
  const isInteractive = forceInteractive || runtime.io.stdin.isTerminal();

  // In non-interactive environments, throw an error (select() requires interaction)
  if (!isInteractive) {
    throw new Error("Cannot run select() in non-interactive mode");
  }

  while (true) {
    // Use writeSync to ensure immediate output in PTY environments (bypasses buffering)
    runtime.io.stderr.writeSync(new TextEncoder().encode(`${message}\n`));
    for (let i = 0; i < choices.length; i++) {
      runtime.io.stderr.writeSync(new TextEncoder().encode(`  ${i + 1}. ${choices[i]}\n`));
    }
    runtime.io.stderr.writeSync(new TextEncoder().encode("Please select (enter number):\n"));

    const input = await readLine(ctx);

    // Handle EOF (null) - return last choice (usually Cancel)
    const isEof = input === null;
    if (isEof) {
      return choices.length - 1;
    }

    const number = parseInt(input, 10);

    const isValidNumber = !isNaN(number) && number >= 1 && number <= choices.length;
    if (isValidNumber) {
      return number - 1;
    }

    runtime.io.stderr.writeSync(
      new TextEncoder().encode(
        `Invalid input. Please enter a number between 1 and ${choices.length}.\n`,
      ),
    );
  }
}
