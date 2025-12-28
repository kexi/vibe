import { join } from "@std/path";

// 設定ファイルのパス
const CONFIG_DIR = join(Deno.env.get("HOME") ?? "", ".config", "vibe");
const USER_SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// 設定のスキーマ
export interface VibeSettings {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

// デフォルト設定
function createDefaultSettings(): VibeSettings {
  return {
    permissions: {
      allow: [],
      deny: [],
    },
  };
}

// 設定ディレクトリを作成
async function ensureConfigDir(): Promise<void> {
  try {
    await Deno.mkdir(CONFIG_DIR, { recursive: true });
  } catch (error) {
    const isAlreadyExists = error instanceof Deno.errors.AlreadyExists;
    if (!isAlreadyExists) {
      throw error;
    }
  }
}

// ユーザー設定を読み込み
export async function loadUserSettings(): Promise<VibeSettings> {
  try {
    const content = await Deno.readTextFile(USER_SETTINGS_FILE);
    const parsed = JSON.parse(content) as Partial<VibeSettings>;
    return mergeWithDefaults(parsed);
  } catch {
    return createDefaultSettings();
  }
}

// デフォルト値とマージ
function mergeWithDefaults(partial: Partial<VibeSettings>): VibeSettings {
  const defaults = createDefaultSettings();
  return {
    permissions: {
      allow: partial.permissions?.allow ?? defaults.permissions.allow,
      deny: partial.permissions?.deny ?? defaults.permissions.deny,
    },
  };
}

// ユーザー設定を保存
export async function saveUserSettings(settings: VibeSettings): Promise<void> {
  await ensureConfigDir();
  const content = JSON.stringify(settings, null, 2) + "\n";
  await Deno.writeTextFile(USER_SETTINGS_FILE, content);
}

// 信頼済みパスを追加
export async function addTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  // denyリストから削除（もしあれば）
  const denyIndex = settings.permissions.deny.indexOf(path);
  const isInDenyList = denyIndex !== -1;
  if (isInDenyList) {
    settings.permissions.deny.splice(denyIndex, 1);
  }

  // allowリストに追加（重複チェック）
  const isAlreadyAllowed = settings.permissions.allow.includes(path);
  if (!isAlreadyAllowed) {
    settings.permissions.allow.push(path);
  }

  await saveUserSettings(settings);
}

// 信頼済みパスを削除
export async function removeTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  const allowIndex = settings.permissions.allow.indexOf(path);
  const isInAllowList = allowIndex !== -1;
  if (isInAllowList) {
    settings.permissions.allow.splice(allowIndex, 1);
  }

  await saveUserSettings(settings);
}

// パスが信頼されているか確認
export async function isTrusted(vibeFilePath: string): Promise<boolean> {
  const settings = await loadUserSettings();

  // denyリストにあれば拒否
  const isDenied = settings.permissions.deny.includes(vibeFilePath);
  if (isDenied) {
    return false;
  }

  // allowリストにあれば許可
  const isAllowed = settings.permissions.allow.includes(vibeFilePath);
  return isAllowed;
}

// 設定ファイルのパスを取得
export function getSettingsPath(): string {
  return USER_SETTINGS_FILE;
}
