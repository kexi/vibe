import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { addTrustedPath, getSettingsPath } from "../utils/trust.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function trustCommand(): Promise<void> {
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

    if (vibeTomlExists) {
      await addTrustedPath(vibeTomlPath);
      console.error(`Trusted: ${vibeTomlPath}`);
    }

    if (vibeLocalTomlExists) {
      await addTrustedPath(vibeLocalTomlPath);
      console.error(`Trusted: ${vibeLocalTomlPath}`);
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
