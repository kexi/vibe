import { join } from "@std/path";
import { z } from "zod";

// 設定ファイルのパス
const CONFIG_DIR = join(Deno.env.get("HOME") ?? "", ".config", "vibe");
const USER_SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// 現在のスキーマバージョン
const CURRENT_SCHEMA_VERSION = 1;

// ===== スキーマ定義 =====

// v1スキーマ
const SettingsSchemaV1 = z.object({
  version: z.literal(1),
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
});

// レガシースキーマ（version フィールドなし）
const LegacySettingsSchema = z.object({
  permissions: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
});

// 現在使用するスキーマ
const CurrentSettingsSchema = SettingsSchemaV1;
export type VibeSettings = z.infer<typeof CurrentSettingsSchema>;

// ===== マイグレーション =====

type MigrationFn = (data: unknown) => unknown;

const migrations: Record<number, MigrationFn> = {
  // レガシー（バージョンなし）から v1 へのマイグレーション
  0: (data: unknown) => {
    const legacy = LegacySettingsSchema.safeParse(data);
    if (legacy.success) {
      return {
        version: 1,
        permissions: legacy.data.permissions,
      };
    }
    // パースに失敗した場合はそのまま返す
    return data;
  },
};

function getSchemaVersion(data: unknown): number {
  const hasVersion = typeof data === "object" && data !== null && "version" in data;
  if (hasVersion) {
    const version = (data as { version: unknown }).version;
    const isValidVersion = typeof version === "number";
    if (isValidVersion) {
      return version;
    }
  }
  return 0; // レガシー（バージョンなし）
}

function migrateSettings(data: unknown): unknown {
  let currentData = data;
  let version = getSchemaVersion(currentData);

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations[version];
    const hasMigration = migration !== undefined;
    if (!hasMigration) {
      throw new Error(`Migration from version ${version} is not defined`);
    }
    currentData = migration(currentData);
    version = getSchemaVersion(currentData);
  }

  return currentData;
}

// ===== デフォルト設定 =====

function createDefaultSettings(): VibeSettings {
  return {
    version: CURRENT_SCHEMA_VERSION,
    permissions: {
      allow: [],
      deny: [],
    },
  };
}

// ===== ファイル操作 =====

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

export async function loadUserSettings(): Promise<VibeSettings> {
  try {
    const content = await Deno.readTextFile(USER_SETTINGS_FILE);
    const rawData = JSON.parse(content);

    // マイグレーションを実行
    const migratedData = migrateSettings(rawData);

    // スキーマバリデーション
    const result = CurrentSettingsSchema.safeParse(migratedData);
    if (result.success) {
      // マイグレーションが行われた場合、ファイルを更新
      const needsMigration = getSchemaVersion(rawData) !== CURRENT_SCHEMA_VERSION;
      if (needsMigration) {
        await saveUserSettings(result.data);
      }
      return result.data;
    }

    // バリデーション失敗時はデフォルト設定を返す
    console.error("Settings validation failed, using defaults:", result.error.message);
    return createDefaultSettings();
  } catch {
    return createDefaultSettings();
  }
}

export async function saveUserSettings(settings: VibeSettings): Promise<void> {
  await ensureConfigDir();
  const content = JSON.stringify(settings, null, 2) + "\n";
  await Deno.writeTextFile(USER_SETTINGS_FILE, content);
}

// ===== 公開API =====

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

export async function removeTrustedPath(path: string): Promise<void> {
  const settings = await loadUserSettings();

  const allowIndex = settings.permissions.allow.indexOf(path);
  const isInAllowList = allowIndex !== -1;
  if (isInAllowList) {
    settings.permissions.allow.splice(allowIndex, 1);
  }

  await saveUserSettings(settings);
}

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

export function getSettingsPath(): string {
  return USER_SETTINGS_FILE;
}

// テスト用にエクスポート
export const _internal = {
  CURRENT_SCHEMA_VERSION,
  migrateSettings,
  getSchemaVersion,
  createDefaultSettings,
};
