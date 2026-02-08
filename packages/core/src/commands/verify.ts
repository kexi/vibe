import { join } from "node:path";
import { getRepoInfoFromPath, getRepoRoot } from "../utils/git.ts";
import { calculateFileHash } from "../utils/hash.ts";
import { loadUserSettings } from "../utils/trust.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { errorLog, log, type OutputOptions, successLog, warnLog } from "../utils/output.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function verifyCommand(ctx: AppContext = getGlobalContext()): Promise<void> {
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

    const settings = await loadUserSettings(ctx);

    log("=== Vibe Configuration Verification ===\n", outputOpts);

    // Verify .vibe.toml
    if (vibeTomlExists) {
      await displayFileStatus(vibeTomlPath, VIBE_TOML, settings, outputOpts, ctx);
    }

    // Verify .vibe.local.toml
    if (vibeLocalTomlExists) {
      if (vibeTomlExists) {
        log("", outputOpts); // Add blank line between files
      }
      await displayFileStatus(vibeLocalTomlPath, VIBE_LOCAL_TOML, settings, outputOpts, ctx);
    }

    // Display global settings
    log("\n=== Global Settings ===", outputOpts);
    log(`Skip Hash Check: ${settings.skipHashCheck ?? false}`, outputOpts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${errorMessage}`, outputOpts);
    runtime.control.exit(1);
  }
}

async function displayFileStatus(
  filePath: string,
  fileName: string,
  settings: Awaited<ReturnType<typeof loadUserSettings>>,
  outputOpts: OutputOptions,
  ctx: AppContext,
): Promise<void> {
  log(`File: ${fileName}`, outputOpts);
  log(`Path: ${filePath}`, outputOpts);

  // Get repository information
  const repoInfo = await getRepoInfoFromPath(filePath, ctx);
  if (!repoInfo) {
    errorLog("Status: ❌ NOT IN GIT REPOSITORY", outputOpts);
    log("Action: File must be in a git repository to be trusted", outputOpts);
    return;
  }

  // Display repository info
  if (repoInfo.remoteUrl) {
    log(`Repository: ${repoInfo.remoteUrl}`, outputOpts);
  } else {
    log(`Repository: (local) ${repoInfo.repoRoot}`, outputOpts);
  }
  log(`Relative Path: ${repoInfo.relativePath}`, outputOpts);

  // Find entry in allow list using repository-based matching
  const entry = settings.permissions.allow.find((item) => {
    return (
      item.relativePath === repoInfo.relativePath &&
      ((item.repoId.remoteUrl &&
        repoInfo.remoteUrl &&
        item.repoId.remoteUrl === repoInfo.remoteUrl) ||
        (item.repoId.repoRoot && repoInfo.repoRoot && item.repoId.repoRoot === repoInfo.repoRoot))
    );
  });

  if (!entry) {
    warnLog("Status: ⚠️  NOT TRUSTED");
    log("Action: Run 'vibe trust' to add this file to trusted list", outputOpts);
    return;
  }

  // Calculate current file hash
  let currentHash: string;
  try {
    currentHash = await calculateFileHash(filePath, ctx);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Status: ❌ ERROR - Cannot read file: ${errorMessage}`, outputOpts);
    return;
  }

  // Check if current hash matches any stored hash
  const hashMatches = entry.hashes.includes(currentHash);
  const skipHashCheck = entry.skipHashCheck ?? settings.skipHashCheck ?? false;

  if (skipHashCheck) {
    warnLog("Status: ⚠️  TRUSTED (hash check disabled)");
    log("Skip Hash Check: true (path-level or global)", outputOpts);
  } else if (hashMatches) {
    successLog("Status: ✅ TRUSTED", outputOpts);
    log("Current Hash: matches stored hash", outputOpts);
  } else {
    errorLog("Status: ❌ HASH MISMATCH", outputOpts);
    log("Current Hash: does NOT match any stored hash", outputOpts);
    log("Action: Run 'vibe trust' to update hash, or verify file integrity", outputOpts);
  }

  // Display hash history
  log(`\nHash History (${entry.hashes.length} stored):`, outputOpts);
  entry.hashes.forEach((hash, index) => {
    const isCurrent = hash === currentHash;
    const marker = isCurrent ? "→" : " ";
    const status = isCurrent ? " (current)" : "";
    log(`${marker} ${index + 1}. ${hash.substring(0, 16)}...${status}`, outputOpts);
  });

  if (entry.skipHashCheck !== undefined) {
    log(`\nPath-level Skip Hash Check: ${entry.skipHashCheck}`, outputOpts);
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
