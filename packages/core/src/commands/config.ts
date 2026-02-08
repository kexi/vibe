import { getSettingsPath, loadUserSettings } from "../utils/trust.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { errorLog, log, type OutputOptions } from "../utils/output.ts";

export async function configCommand(ctx: AppContext = getGlobalContext()): Promise<void> {
  const { runtime } = ctx;
  const outputOpts: OutputOptions = {};

  try {
    const settingsPath = getSettingsPath(ctx);
    const settings = await loadUserSettings(ctx);

    log(`Settings file: ${settingsPath}`, outputOpts);
    log("", outputOpts);
    log(JSON.stringify(settings, null, 2), outputOpts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errorLog(`Error: ${errorMessage}`, outputOpts);
    runtime.control.exit(1);
  }
}
