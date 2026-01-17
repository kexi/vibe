import { parse } from "@std/toml";
import { join } from "@std/path";
import { parseVibeConfig, type VibeConfig } from "../types/config.ts";
import { verifyTrustAndRead } from "./settings.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

const VIBE_TOML = ".vibe.toml";
const VIBE_LOCAL_TOML = ".vibe.local.toml";

async function fileExists(
  path: string,
  ctx: AppContext = getGlobalContext(),
): Promise<boolean> {
  try {
    await ctx.runtime.fs.stat(path);
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

  // Merge copy.files field
  const mergedFiles = mergeArrayField(
    baseConfig.copy?.files,
    localConfig.copy?.files,
    localConfig.copy?.files_prepend,
    localConfig.copy?.files_append,
  );

  // Merge copy.dirs field
  const mergedDirs = mergeArrayField(
    baseConfig.copy?.dirs,
    localConfig.copy?.dirs,
    localConfig.copy?.dirs_prepend,
    localConfig.copy?.dirs_append,
  );

  const hasCopyConfig = mergedFiles !== undefined || mergedDirs !== undefined;
  if (hasCopyConfig) {
    mergedConfig.copy = {};
    if (mergedFiles !== undefined) {
      mergedConfig.copy.files = mergedFiles;
    }
    if (mergedDirs !== undefined) {
      mergedConfig.copy.dirs = mergedDirs;
    }
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

  // Merge worktree section (local takes precedence)
  const hasWorktreeConfig = baseConfig.worktree !== undefined || localConfig.worktree !== undefined;
  if (hasWorktreeConfig) {
    mergedConfig.worktree = {
      path_script: localConfig.worktree?.path_script ??
        baseConfig.worktree?.path_script,
    };
  }

  return mergedConfig;
}

export async function loadVibeConfig(
  repoRoot: string,
  ctx: AppContext = getGlobalContext(),
): Promise<VibeConfig | undefined> {
  const vibeTomlPath = join(repoRoot, VIBE_TOML);
  const vibeLocalTomlPath = join(repoRoot, VIBE_LOCAL_TOML);

  const vibeTomlExists = await fileExists(vibeTomlPath, ctx);
  const vibeLocalTomlExists = await fileExists(vibeLocalTomlPath, ctx);

  let config: VibeConfig | undefined;

  // Load .vibe.toml
  if (vibeTomlExists) {
    const result = await verifyTrustAndRead(vibeTomlPath, ctx);
    if (result.trusted && result.content) {
      const rawConfig = parse(result.content);
      config = parseVibeConfig(rawConfig, vibeTomlPath);
    } else {
      console.error(
        "Error: .vibe.toml file is not trusted or has been modified.\n" +
          "Please run: vibe trust",
      );
      ctx.runtime.control.exit(1);
    }
  }

  // Load and merge .vibe.local.toml
  if (vibeLocalTomlExists) {
    const localResult = await verifyTrustAndRead(vibeLocalTomlPath, ctx);
    if (localResult.trusted && localResult.content) {
      const rawLocalConfig = parse(localResult.content);
      const localConfig = parseVibeConfig(rawLocalConfig, vibeLocalTomlPath);

      if (config !== undefined) {
        config = mergeConfigs(config, localConfig);
      } else {
        config = localConfig;
      }
    } else {
      console.error(
        "Error: .vibe.local.toml file is not trusted or has been modified.\n" +
          "Please run: vibe trust",
      );
      ctx.runtime.control.exit(1);
    }
  }

  return config;
}
