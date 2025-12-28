import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { getSettingsPath, removeTrustedPath } from "../utils/trust.ts";

export async function untrustCommand(): Promise<void> {
  try {
    const repoRoot = await getRepoRoot();
    const vibeTomlPath = join(repoRoot, ".vibe.toml");
    const vibeLocalTomlPath = join(repoRoot, ".vibe.local.toml");

    const vibeTomlExists = await checkFileExists(vibeTomlPath);
    const vibeLocalTomlExists = await checkFileExists(vibeLocalTomlPath);

    const noFilesFound = !vibeTomlExists && !vibeLocalTomlExists;
    if (noFilesFound) {
      console.error(
        `Error: .vibe.toml or .vibe.local.toml file not found in ${repoRoot}`,
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
