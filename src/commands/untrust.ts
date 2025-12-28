import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { getSettingsPath, removeTrustedPath } from "../utils/trust.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function untrustCommand(): Promise<void> {
  try {
    const repoRoot = await getRepoRoot();
    const vibeTomlPath = join(repoRoot, VIBE_TOML);
    const vibeLocalTomlPath = join(repoRoot, VIBE_LOCAL_TOML);

    const vibeTomlExists = await checkFileExists(vibeTomlPath);
    const vibeLocalTomlExists = await checkFileExists(vibeLocalTomlPath);

    const hasAnyFile = vibeTomlExists || vibeLocalTomlExists;
    if (!hasAnyFile) {
      console.error(
        `Error: Neither .vibe.toml nor .vibe.local.toml found in ${repoRoot}`,
      );
      Deno.exit(1);
    }

    const untrustedFiles: string[] = [];

    // Remove trust for .vibe.toml
    if (vibeTomlExists) {
      await removeTrustedPath(vibeTomlPath);
      untrustedFiles.push(vibeTomlPath);
    }

    // Remove trust for .vibe.local.toml
    if (vibeLocalTomlExists) {
      await removeTrustedPath(vibeLocalTomlPath);
      untrustedFiles.push(vibeLocalTomlPath);
    }

    // Display results
    for (const file of untrustedFiles) {
      console.error(`Untrusted: ${file}`);
    }
    console.error(`Settings: ${getSettingsPath()}`);
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
