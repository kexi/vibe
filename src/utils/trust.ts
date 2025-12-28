// Re-export from settings.ts for backwards compatibility
export {
  addTrustedPath,
  getSettingsPath,
  isTrusted,
  loadUserSettings,
  removeTrustedPath,
  saveUserSettings,
} from "./settings.ts";
export type { VibeSettings } from "./settings.ts";
