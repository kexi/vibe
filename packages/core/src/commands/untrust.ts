import { join } from "node:path";
import { getRepoRoot } from "../utils/git.ts";
import { getSettingsPath, removeTrustedPath } from "../utils/trust.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { errorLog, log, type OutputOptions, successLog } from "../utils/output.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function untrustCommand(ctx: AppContext = getGlobalContext()): Promise<void> {
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

    const untrustedFiles: string[] = [];

    // Remove trust for .vibe.toml
    if (vibeTomlExists) {
      await removeTrustedPath(vibeTomlPath, ctx);
      untrustedFiles.push(vibeTomlPath);
    }

    // Remove trust for .vibe.local.toml
    if (vibeLocalTomlExists) {
      await removeTrustedPath(vibeLocalTomlPath, ctx);
      untrustedFiles.push(vibeLocalTomlPath);
    }

    // Display results
    for (const file of untrustedFiles) {
      successLog(`Untrusted: ${file}`, outputOpts);
    }
    log(`Settings: ${getSettingsPath(ctx)}`, outputOpts);
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
