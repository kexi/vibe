import { join } from "@std/path";
import { getRepoInfoFromPath, getRepoRoot } from "../utils/git.ts";
import { addTrustedPath, getSettingsPath } from "../utils/trust.ts";
import { runtime } from "../runtime/index.ts";

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
      runtime.control.exit(1);
    }

    const trustedFiles: Array<
      { path: string; repoInfo: Awaited<ReturnType<typeof getRepoInfoFromPath>> }
    > = [];
    const errors: Array<{ file: string; error: string }> = [];

    // Trust .vibe.toml
    if (vibeTomlExists) {
      try {
        await addTrustedPath(vibeTomlPath);
        const repoInfo = await getRepoInfoFromPath(vibeTomlPath);
        trustedFiles.push({ path: vibeTomlPath, repoInfo });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ file: ".vibe.toml", error: errorMessage });
      }
    }

    // Trust .vibe.local.toml
    if (vibeLocalTomlExists) {
      try {
        await addTrustedPath(vibeLocalTomlPath);
        const repoInfo = await getRepoInfoFromPath(vibeLocalTomlPath);
        trustedFiles.push({ path: vibeLocalTomlPath, repoInfo });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ file: ".vibe.local.toml", error: errorMessage });
      }
    }

    // Report errors if any
    if (errors.length > 0) {
      console.error("Failed to trust the following files:");
      for (const { file, error } of errors) {
        console.error(`  ${file}: ${error}`);
      }
      runtime.control.exit(1);
    }

    // Display results
    console.error("Trusted files:");
    for (const { path, repoInfo } of trustedFiles) {
      console.error(`  ${path}`);
      if (repoInfo?.remoteUrl) {
        console.error(`    Repository: ${repoInfo.remoteUrl}`);
        console.error(`    Relative Path: ${repoInfo.relativePath}`);
      } else if (repoInfo?.repoRoot) {
        console.error(`    Repository: (local) ${repoInfo.repoRoot}`);
        console.error(`    Relative Path: ${repoInfo.relativePath}`);
      }
    }
    console.error(`\nSettings: ${getSettingsPath()}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}

async function checkFileExists(path: string): Promise<boolean> {
  try {
    await runtime.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
