import { z } from "zod";

/**
 * Zod schema for VibeConfig validation.
 *
 * Defines the structure and constraints for .vibe.toml and .vibe.local.toml files.
 */
export const VibeConfigSchema = z.object({
  copy: z.object({
    /** Files to copy from origin to worktree (supports glob patterns) */
    files: z.array(z.string()).optional(),
    /** Files to prepend to the base config's files array */
    files_prepend: z.array(z.string()).optional(),
    /** Files to append to the base config's files array */
    files_append: z.array(z.string()).optional(),
    /** Directories to copy from origin to worktree (supports glob patterns) */
    dirs: z.array(z.string()).optional(),
    /** Directories to prepend to the base config's dirs array */
    dirs_prepend: z.array(z.string()).optional(),
    /** Directories to append to the base config's dirs array */
    dirs_append: z.array(z.string()).optional(),
    /**
     * Number of parallel directory copy operations.
     * Higher values may improve performance on fast storage (NVMe, SSDs).
     * Can be overridden by VIBE_COPY_CONCURRENCY environment variable.
     * @minimum 1
     * @maximum 32
     * @default 4
     */
    concurrency: z.number().int().min(1).max(32).optional(),
  }).strict().optional(),
  hooks: z.object({
    pre_start: z.array(z.string()).optional(),
    pre_start_prepend: z.array(z.string()).optional(),
    pre_start_append: z.array(z.string()).optional(),
    post_start: z.array(z.string()).optional(),
    post_start_prepend: z.array(z.string()).optional(),
    post_start_append: z.array(z.string()).optional(),
    pre_clean: z.array(z.string()).optional(),
    pre_clean_prepend: z.array(z.string()).optional(),
    pre_clean_append: z.array(z.string()).optional(),
    post_clean: z.array(z.string()).optional(),
    post_clean_prepend: z.array(z.string()).optional(),
    post_clean_append: z.array(z.string()).optional(),
  }).strict().optional(),
  worktree: z.object({
    path_script: z.string().optional(),
  }).strict().optional(),
  clean: z.object({
    delete_branch: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type VibeConfig = z.infer<typeof VibeConfigSchema>;

/**
 * Validate and parse a VibeConfig from unknown data
 * @param data Unknown data to validate
 * @param filePath Path to the config file (for error messages)
 * @returns Validated VibeConfig
 * @throws Error if validation fails
 */
export function parseVibeConfig(data: unknown, filePath: string): VibeConfig {
  const result = VibeConfigSchema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration in ${filePath}:\n${errors}`,
    );
  }
  return result.data;
}
