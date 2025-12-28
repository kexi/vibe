/**
 * Display a y/n confirmation prompt to the user
 * @param message The prompt message to display
 * @returns true to continue, false to cancel
 */
export async function confirmPrompt(message: string): Promise<boolean> {
  // In non-interactive environments (CI, scripts), automatically return false
  const isInteractive = Deno.stdin.isTerminal?.() ?? false;
  if (!isInteractive) {
    console.error(
      "Error: Cannot run in non-interactive mode with uncommitted changes.",
    );
    return false;
  }

  console.log(`${message} (y/n): `);

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);

  const hasInput = n !== null;
  if (!hasInput) {
    return false;
  }

  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim()
    .toLowerCase();
  const isYes = answer === "y" || answer === "yes";

  return isYes;
}
