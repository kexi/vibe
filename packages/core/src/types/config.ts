import { z } from "zod";

// Zod schema for VibeConfig validation
export const VibeConfigSchema = z.object({
  copy: z.object({
    files: z.array(z.string()).optional(),
    files_prepend: z.array(z.string()).optional(),
    files_append: z.array(z.string()).optional(),
    dirs: z.array(z.string()).optional(),
    dirs_prepend: z.array(z.string()).optional(),
    dirs_append: z.array(z.string()).optional(),
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
