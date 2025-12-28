import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { calculateFileHash } from "../utils/hash.ts";
import { loadUserSettings } from "../utils/trust.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

export async function verifyCommand(): Promise<void> {
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

    const settings = await loadUserSettings();

    console.error("=== Vibe Configuration Verification ===\n");

    // Verify .vibe.toml
    if (vibeTomlExists) {
      await displayFileStatus(vibeTomlPath, VIBE_TOML, settings);
    }

    // Verify .vibe.local.toml
    if (vibeLocalTomlExists) {
      if (vibeTomlExists) {
        console.error(); // Add blank line between files
      }
      await displayFileStatus(vibeLocalTomlPath, VIBE_LOCAL_TOML, settings);
    }

    // Display global settings
    console.error("\n=== Global Settings ===");
    console.error(`Skip Hash Check: ${settings.skipHashCheck ?? false}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}

async function displayFileStatus(
  filePath: string,
  fileName: string,
  settings: Awaited<ReturnType<typeof loadUserSettings>>,
): Promise<void> {
  console.error(`File: ${fileName}`);
  console.error(`Path: ${filePath}`);

  // Check if in deny list
  const isDenied = settings.permissions.deny.includes(filePath);
  if (isDenied) {
    console.error("Status: ❌ DENIED");
    return;
  }

  // Find entry in allow list
  const entry = settings.permissions.allow.find(
    (item) => item.path === filePath,
  );

  if (!entry) {
    console.error("Status: ⚠️  NOT TRUSTED");
    console.error(
      "Action: Run 'vibe trust' to add this file to trusted list",
    );
    return;
  }

  // Calculate current file hash
  let currentHash: string;
  try {
    currentHash = await calculateFileHash(filePath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Status: ❌ ERROR - Cannot read file: ${errorMessage}`);
    return;
  }

  // Check if current hash matches any stored hash
  const hashMatches = entry.hashes.includes(currentHash);
  const skipHashCheck = entry.skipHashCheck ?? settings.skipHashCheck ?? false;

  if (skipHashCheck) {
    console.error("Status: ⚠️  TRUSTED (hash check disabled)");
    console.error("Skip Hash Check: true (path-level or global)");
  } else if (hashMatches) {
    console.error("Status: ✅ TRUSTED");
    console.error("Current Hash: matches stored hash");
  } else {
    console.error("Status: ❌ HASH MISMATCH");
    console.error("Current Hash: does NOT match any stored hash");
    console.error(
      "Action: Run 'vibe trust' to update hash, or verify file integrity",
    );
  }

  // Display hash history
  console.error(`\nHash History (${entry.hashes.length} stored):`);
  entry.hashes.forEach((hash, index) => {
    const isCurrent = hash === currentHash;
    const marker = isCurrent ? "→" : " ";
    const status = isCurrent ? " (current)" : "";
    console.error(`${marker} ${index + 1}. ${hash.substring(0, 16)}...${status}`);
  });

  if (entry.skipHashCheck !== undefined) {
    console.error(`\nPath-level Skip Hash Check: ${entry.skipHashCheck}`);
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
