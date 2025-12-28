import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { addTrustedPath } from "../utils/trust.ts";

export async function trustCommand(): Promise<void> {
  try {
    const repoRoot = await getRepoRoot();
    const vibeTomlPath = join(repoRoot, ".vibe.toml");

    const fileExists = await checkFileExists(vibeTomlPath);
    if (!fileExists) {
      console.error(`Error: .vibe.toml file not found in ${repoRoot}`);
      Deno.exit(1);
    }

    await addTrustedPath(vibeTomlPath);
    console.error(`Trusted: ${vibeTomlPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
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
