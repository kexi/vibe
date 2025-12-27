import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { addTrustedPath } from "../utils/trust.ts";

export async function trustCommand(): Promise<void> {
  try {
    const repoRoot = await getRepoRoot();
    const vibeFilePath = join(repoRoot, ".vibe");

    const fileExists = await checkFileExists(vibeFilePath);
    if (!fileExists) {
      console.error(`echo 'Error: .vibe file not found in ${repoRoot}'`);
      Deno.exit(1);
    }

    await addTrustedPath(vibeFilePath);
    console.error(`echo 'Trusted: ${vibeFilePath}'`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`echo 'Error: ${errorMessage.replace(/'/g, "'\\''")}'`);
    Deno.exit(1);
  }
}

async function checkFileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
