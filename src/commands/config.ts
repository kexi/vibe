import { getSettingsPath, loadUserSettings } from "../utils/trust.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

export async function configCommand(
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;

  try {
    const settingsPath = getSettingsPath(ctx);
    const settings = await loadUserSettings(ctx);

    console.error(`Settings file: ${settingsPath}`);
    console.error("");
    console.error(JSON.stringify(settings, null, 2));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
