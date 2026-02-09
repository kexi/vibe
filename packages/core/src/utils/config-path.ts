import { isAbsolute, join } from "node:path";
import { type AppContext, getGlobalContext } from "../context/index.ts";

/**
 * Get the vibe configuration directory path (~/.config/vibe).
 * Validates HOME environment variable to prevent path traversal attacks.
 */
export function getConfigDir(ctx: AppContext = getGlobalContext()): string {
  const home = ctx.runtime.env.get("HOME") ?? "";

  // Validate HOME to prevent path traversal attacks
  const isValidHome = home.length > 0 && isAbsolute(home) && !home.includes("..");
  if (!isValidHome) {
    throw new Error(
      "Invalid HOME environment variable. " +
        "HOME must be an absolute path without '..' components.",
    );
  }

  return join(home, ".config", "vibe");
}

/**
 * Ensure the vibe configuration directory exists.
 */
export async function ensureConfigDir(ctx: AppContext = getGlobalContext()): Promise<void> {
  try {
    await ctx.runtime.fs.mkdir(getConfigDir(ctx), { recursive: true });
  } catch (error) {
    const isAlreadyExists = ctx.runtime.errors.isAlreadyExists(error);
    if (!isAlreadyExists) {
      throw error;
    }
  }
}
