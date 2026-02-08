import { join } from "node:path";
import { getRepoInfoFromPath, getRepoRoot } from "../utils/git.ts";
import { addTrustedPath, getSettingsPath } from "../utils/trust.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { errorLog, log, type OutputOptions, successLog } from "../utils/output.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function trustCommand(ctx: AppContext = getGlobalContext()): Promise<void> {
  const { runtime } = ctx;
  const outputOpts: OutputOptions = {};

  try {
    const repoRoot = await getRepoRoot(ctx);
    const vibeTomlPath = join(repoRoot, VIBE_TOML);
    const vibeLocalTomlPath = join(repoRoot, VIBE_LOCAL_TOML);

    const vibeTomlExists = await checkFileExists(vibeTomlPath, ctx);
    const vibeLocalTomlExists = await checkFileExists(vibeLocalTomlPath, ctx);

    const hasAnyFile = vibeTomlExists || vibeLocalTomlExists;
    if (!hasAnyFile) {
      errorLog(`Error: Neither .vibe.toml nor .vibe.local.toml found in ${repoRoot}`, outputOpts);
      runtime.control.exit(1);
    }

    const trustedFiles: Array<{
      path: string;
      repoInfo: Awaited<ReturnType<typeof getRepoInfoFromPath>>;
    }> = [];
    const errors: Array<{ file: string; error: string }> = [];

    // Trust .vibe.toml
    if (vibeTomlExists) {
      try {
        await addTrustedPath(vibeTomlPath, ctx);
        const repoInfo = await getRepoInfoFromPath(vibeTomlPath, ctx);
        trustedFiles.push({ path: vibeTomlPath, repoInfo });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ file: ".vibe.toml", error: errorMessage });
      }
    }

    // Trust .vibe.local.toml
    if (vibeLocalTomlExists) {
      try {
        await addTrustedPath(vibeLocalTomlPath, ctx);
        const repoInfo = await getRepoInfoFromPath(vibeLocalTomlPath, ctx);
        trustedFiles.push({ path: vibeLocalTomlPath, repoInfo });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ file: ".vibe.local.toml", error: errorMessage });
      }
    }

    // Report errors if any
    if (errors.length > 0) {
      errorLog("Failed to trust the following files:", outputOpts);
      for (const { file, error } of errors) {
        errorLog(`  ${file}: ${error}`, outputOpts);
      }
      runtime.control.exit(1);
    }

    // Display results
    successLog("Trusted files:", outputOpts);
    for (const { path, repoInfo } of trustedFiles) {
      log(`  ${path}`, outputOpts);
      if (repoInfo?.remoteUrl) {
        log(`    Repository: ${repoInfo.remoteUrl}`, outputOpts);
        log(`    Relative Path: ${repoInfo.relativePath}`, outputOpts);
      } else if (repoInfo?.repoRoot) {
        log(`    Repository: (local) ${repoInfo.repoRoot}`, outputOpts);
        log(`    Relative Path: ${repoInfo.relativePath}`, outputOpts);
      }
    }
    log(`\nSettings: ${getSettingsPath(ctx)}`, outputOpts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${errorMessage}`, outputOpts);
    runtime.control.exit(1);
  }
}

async function checkFileExists(path: string, ctx: AppContext): Promise<boolean> {
  try {
    await ctx.runtime.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
