/**
 * Interactive prompt utilities
 */

/**
 * Read a single line of input from the user
 */
async function readLine(): Promise<string> {
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  const isInputReceived = n !== null;
  if (isInputReceived) {
    return new TextDecoder().decode(buf.subarray(0, n)).trim();
  }
  return "";
}

/**
 * Display a Y/n confirmation prompt
 * @param message Confirmation message
 * @returns true if user selects Yes, false otherwise
 */
export async function confirm(message: string): Promise<boolean> {
  // In non-interactive environments (CI, scripts), automatically return false
  const isInteractive = Deno.stdin.isTerminal?.() ?? false;
  if (!isInteractive) {
    console.error(
      "Error: Cannot run in non-interactive mode with uncommitted changes.",
    );
    return false;
  }

  while (true) {
    console.error(`${message}`);
    const input = await readLine();

    const isYes = input === "Y" || input === "y" || input === "";
    if (isYes) {
      return true;
    }

    const isNo = input === "N" || input === "n";
    if (isNo) {
      return false;
    }

    console.error("Invalid input. Please enter Y/y/n/N.");
  }
}

/**
 * Display a numbered selection prompt
 * @param message Prompt message
 * @param choices Array of choices
 * @returns Selected index (0-based)
 */
export async function select(
  message: string,
  choices: string[],
): Promise<number> {
  while (true) {
    console.error(`${message}`);
    for (let i = 0; i < choices.length; i++) {
      console.error(`  ${i + 1}. ${choices[i]}`);
    }
    console.error("Please select (enter number):");

    const input = await readLine();
    const number = parseInt(input, 10);

    const isValidNumber = !isNaN(number) && number >= 1 && number <= choices.length;
    if (isValidNumber) {
      return number - 1;
    }

    console.error(`Invalid input. Please enter a number between 1 and ${choices.length}.`);
  }
}
