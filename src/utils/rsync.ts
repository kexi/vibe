export interface RsyncResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Check if rsync command is available
 */
export async function isRsyncAvailable(): Promise<boolean> {
  try {
    const command = new Deno.Command("rsync", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Run rsync command to sync a directory
 */
export async function runRsync(
  src: string,
  dest: string,
): Promise<RsyncResult> {
  const args: string[] = [
    "-a", // archive mode (preserves permissions, symlinks, etc.)
  ];

  // Ensure src ends with / to copy directory contents
  const srcPath = src.endsWith("/") ? src : `${src}/`;
  args.push(srcPath);
  args.push(dest);

  const command = new Deno.Command("rsync", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const result = await command.output();
  const decoder = new TextDecoder();

  return {
    success: result.success,
    exitCode: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}
