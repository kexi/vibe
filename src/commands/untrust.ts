import { join } from "@std/path";
import { getRepoRoot } from "../utils/git.ts";
import { getSettingsPath, removeTrustedPath } from "../utils/trust.ts";

export async function untrustCommand(): Promise<void> {
  try {
    const repoRoot = await getRepoRoot();
    const vibeTomlPath = join(repoRoot, ".vibe.toml");

    await removeTrustedPath(vibeTomlPath);
    console.error(`Untrusted: ${vibeTomlPath}`);
    console.error(`Settings: ${getSettingsPath()}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}
