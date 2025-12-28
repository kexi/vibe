import { getSettingsPath, loadUserSettings } from "../utils/trust.ts";

export async function configCommand(): Promise<void> {
  try {
    const settingsPath = getSettingsPath();
    const settings = await loadUserSettings();

    console.log(`Settings file: ${settingsPath}`);
    console.log("");
    console.log(JSON.stringify(settings, null, 2));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}
