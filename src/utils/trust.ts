// Re-export from settings.ts for backwards compatibility
export {
  addTrustedPath,
  getSettingsPath,
  // Note: isTrusted() is deprecated (@internal, @deprecated in settings.ts)
  // but kept for backwards compatibility. Use verifyTrustAndRead() instead
  // to prevent TOCTOU vulnerabilities.
  isTrusted,
  loadUserSettings,
  removeTrustedPath,
  saveUserSettings,
} from "./settings.ts";
export type { VibeSettings } from "./settings.ts";
