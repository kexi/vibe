import { parse } from "@std/toml";
import { join } from "@std/path";
import type { VibeConfig } from "../types/config.ts";
import { isTrusted } from "./trust.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function mergeArrayField(
  base: string[] | undefined,
  override: string[] | undefined,
  prepend: string[] | undefined,
  append: string[] | undefined,
): string[] | undefined {
  // Complete override if specified
  if (override !== undefined) {
    return override;
  }

  // If no base array exists
  if (base === undefined) {
    // Return prepend/append only if specified
    if (prepend !== undefined || append !== undefined) {
      return [
        ...(prepend ?? []),
        ...(append ?? []),
      ];
    }
    return undefined;
  }

  // Apply prepend/append to base array
  return [
    ...(prepend ?? []),
    ...base,
    ...(append ?? []),
  ];
}

export function mergeConfigs(
  baseConfig: VibeConfig,
  localConfig: VibeConfig,
): VibeConfig {
  const mergedConfig: VibeConfig = {};

  // Merge shell field
  mergedConfig.shell = localConfig.shell ?? baseConfig.shell;

  // Merge copy field
  const mergedFiles = mergeArrayField(
    baseConfig.copy?.files,
    localConfig.copy?.files,
    localConfig.copy?.files_prepend,
    localConfig.copy?.files_append,
  );
  if (mergedFiles !== undefined) {
    mergedConfig.copy = { files: mergedFiles };
  }

  // Merge hooks field
  const hooks: VibeConfig["hooks"] = {};

  const mergedPreStart = mergeArrayField(
    baseConfig.hooks?.pre_start,
    localConfig.hooks?.pre_start,
    localConfig.hooks?.pre_start_prepend,
    localConfig.hooks?.pre_start_append,
  );
  if (mergedPreStart !== undefined) {
    hooks.pre_start = mergedPreStart;
  }

  const mergedPostStart = mergeArrayField(
    baseConfig.hooks?.post_start,
    localConfig.hooks?.post_start,
    localConfig.hooks?.post_start_prepend,
    localConfig.hooks?.post_start_append,
  );
  if (mergedPostStart !== undefined) {
    hooks.post_start = mergedPostStart;
  }

  const mergedPreClean = mergeArrayField(
    baseConfig.hooks?.pre_clean,
    localConfig.hooks?.pre_clean,
    localConfig.hooks?.pre_clean_prepend,
    localConfig.hooks?.pre_clean_append,
  );
  if (mergedPreClean !== undefined) {
    hooks.pre_clean = mergedPreClean;
  }

  const mergedPostClean = mergeArrayField(
    baseConfig.hooks?.post_clean,
    localConfig.hooks?.post_clean,
    localConfig.hooks?.post_clean_prepend,
    localConfig.hooks?.post_clean_append,
  );
  if (mergedPostClean !== undefined) {
    hooks.post_clean = mergedPostClean;
  }

  if (Object.keys(hooks).length > 0) {
    mergedConfig.hooks = hooks;
  }

  return mergedConfig;
}

export async function loadVibeConfig(
  repoRoot: string,
): Promise<VibeConfig | undefined> {
  const vibeTomlPath = join(repoRoot, VIBE_TOML);
  const vibeLocalTomlPath = join(repoRoot, VIBE_LOCAL_TOML);

  const vibeTomlExists = await fileExists(vibeTomlPath);
  const vibeLocalTomlExists = await fileExists(vibeLocalTomlPath);

  let config: VibeConfig | undefined;

  // .vibe.tomlの読み込み
  if (vibeTomlExists) {
    const trusted = await isTrusted(vibeTomlPath);
    if (trusted) {
      config = parse(await Deno.readTextFile(vibeTomlPath)) as VibeConfig;
    } else {
      console.error(".vibe.toml file found but not trusted. Run: vibe trust");
    }
  }

  // .vibe.local.tomlの読み込みとマージ
  if (vibeLocalTomlExists) {
    const localTrusted = await isTrusted(vibeLocalTomlPath);
    if (localTrusted) {
      const localConfig = parse(
        await Deno.readTextFile(vibeLocalTomlPath),
      ) as VibeConfig;

      if (config !== undefined) {
        config = mergeConfigs(config, localConfig);
      } else {
        config = localConfig;
      }
    } else {
      console.error(
        ".vibe.local.toml file found but not trusted. Run: vibe trust",
      );
    }
  }

  return config;
}
