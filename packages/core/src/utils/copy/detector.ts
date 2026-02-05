import type { CopyCapabilities } from "./types.ts";
import { type AppContext, getGlobalContext } from "../../context/index.ts";

/**
 * Cached capabilities (detected once per process)
 */
let cachedCapabilities: CopyCapabilities | null = null;

/**
 * Detect system capabilities for copy operations.
 * Results are cached for the lifetime of the process.
 */
export async function detectCapabilities(
  ctx: AppContext = getGlobalContext(),
): Promise<CopyCapabilities> {
  if (cachedCapabilities !== null) {
    return cachedCapabilities;
  }

  const [cloneSupported, rsyncAvailable, robocopyAvailable] = await Promise.all([
    detectCloneSupport(ctx),
    detectRsyncAvailable(ctx),
    detectRobocopyAvailable(ctx),
  ]);

  cachedCapabilities = { cloneSupported, rsyncAvailable, robocopyAvailable };
  return cachedCapabilities;
}

/**
 * Reset cached capabilities (for testing purposes)
 */
export function resetCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/**
 * Detect if the filesystem supports Copy-on-Write (clone) operations.
 * - macOS: APFS supports `cp -c`
 * - Linux: Btrfs/XFS support `cp --reflink=auto`
 */
async function detectCloneSupport(ctx: AppContext): Promise<boolean> {
  const os = ctx.runtime.build.os;

  if (os === "darwin") {
    return await testMacOSClone(ctx);
  }

  if (os === "linux") {
    return await testLinuxReflink(ctx);
  }

  return false;
}

/**
 * Test if macOS `cp -c` (clone) works.
 */
async function testMacOSClone(ctx: AppContext): Promise<boolean> {
  const { runtime } = ctx;
  const tempDir = await runtime.fs.makeTempDir();
  const srcFile = `${tempDir}/test_src`;
  const destFile = `${tempDir}/test_dest`;

  try {
    // Create a test file
    await runtime.fs.writeTextFile(srcFile, "test");

    // Try to clone it
    const result = await runtime.process.run({
      cmd: "cp",
      args: ["-c", srcFile, destFile],
      stderr: "null",
      stdout: "null",
    });

    return result.success;
  } catch {
    return false;
  } finally {
    // Cleanup
    await runtime.fs.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Test if Linux `cp --reflink=auto` works.
 */
async function testLinuxReflink(ctx: AppContext): Promise<boolean> {
  const { runtime } = ctx;
  const tempDir = await runtime.fs.makeTempDir();
  const srcFile = `${tempDir}/test_src`;
  const destFile = `${tempDir}/test_dest`;

  try {
    // Create a test file
    await runtime.fs.writeTextFile(srcFile, "test");

    // Try to reflink copy it
    const result = await runtime.process.run({
      cmd: "cp",
      args: ["--reflink=auto", srcFile, destFile],
      stderr: "null",
      stdout: "null",
    });

    return result.success;
  } catch {
    return false;
  } finally {
    // Cleanup
    await runtime.fs.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Detect if rsync command is available.
 */
async function detectRsyncAvailable(ctx: AppContext): Promise<boolean> {
  try {
    const result = await ctx.runtime.process.run({
      cmd: "rsync",
      args: ["--version"],
      stderr: "null",
      stdout: "null",
    });

    return result.success;
  } catch {
    return false;
  }
}

/**
 * Detect if robocopy command is available (Windows only).
 * robocopy /? returns exit code 16, but the process execution itself succeeds.
 */
async function detectRobocopyAvailable(ctx: AppContext): Promise<boolean> {
  const os = ctx.runtime.build.os;
  if (os !== "windows") {
    return false;
  }

  try {
    await ctx.runtime.process.run({
      cmd: "robocopy",
      args: ["/?"],
      stderr: "null",
      stdout: "null",
    });
    // robocopy /? returns exit code 16, but if we get here the command exists
    return true;
  } catch {
    return false;
  }
}
