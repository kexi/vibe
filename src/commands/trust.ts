import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { addTrustedPath, getSettingsPath } from "../utils/trust.ts";

export async function trustCommand(): Promise<void> {
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

    const trustedFiles: string[] = [];

    // Trust .vibe.toml
    if (vibeTomlExists) {
      try {
        await Deno.readFile(vibeTomlPath);
        await addTrustedPath(vibeTomlPath);
        trustedFiles.push(vibeTomlPath);
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        console.error(`Error: Cannot read .vibe.toml file: ${errorMessage}`);
        Deno.exit(1);
      }
    }

    // Trust .vibe.local.toml
    if (vibeLocalTomlExists) {
      try {
        await Deno.readFile(vibeLocalTomlPath);
        await addTrustedPath(vibeLocalTomlPath);
        trustedFiles.push(vibeLocalTomlPath);
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        console.error(
          `Error: Cannot read .vibe.local.toml file: ${errorMessage}`,
        );
        Deno.exit(1);
      }
    }

    // Display results
    for (const file of trustedFiles) {
      console.error(`Trusted: ${file}`);
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
