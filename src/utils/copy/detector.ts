import type { CopyCapabilities } from "./types.ts";

/**
 * Cached capabilities (detected once per process)
 */
let cachedCapabilities: CopyCapabilities | null = null;

/**
 * Detect system capabilities for copy operations.
 * Results are cached for the lifetime of the process.
 */
export async function detectCapabilities(): Promise<CopyCapabilities> {
  if (cachedCapabilities !== null) {
    return cachedCapabilities;
  }

  const [cloneSupported, rsyncAvailable] = await Promise.all([
    detectCloneSupport(),
    detectRsyncAvailable(),
  ]);

  cachedCapabilities = { cloneSupported, rsyncAvailable };
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
async function detectCloneSupport(): Promise<boolean> {
  const os = Deno.build.os;

  if (os === "darwin") {
    return await testMacOSClone();
  }

  if (os === "linux") {
    return await testLinuxReflink();
  }

  return false;
}

/**
 * Test if macOS `cp -c` (clone) works.
 */
async function testMacOSClone(): Promise<boolean> {
  const tempDir = await Deno.makeTempDir();
  const srcFile = `${tempDir}/test_src`;
  const destFile = `${tempDir}/test_dest`;

  try {
    // Create a test file
    await Deno.writeTextFile(srcFile, "test");

    // Try to clone it
    const cmd = new Deno.Command("cp", {
      args: ["-c", srcFile, destFile],
      stderr: "null",
      stdout: "null",
    });
    const result = await cmd.output();

    return result.success;
  } catch {
    return false;
  } finally {
    // Cleanup
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Test if Linux `cp --reflink=auto` works.
 */
async function testLinuxReflink(): Promise<boolean> {
  const tempDir = await Deno.makeTempDir();
  const srcFile = `${tempDir}/test_src`;
  const destFile = `${tempDir}/test_dest`;

  try {
    // Create a test file
    await Deno.writeTextFile(srcFile, "test");

    // Try to reflink copy it
    const cmd = new Deno.Command("cp", {
      args: ["--reflink=auto", srcFile, destFile],
      stderr: "null",
      stdout: "null",
    });
    const result = await cmd.output();

    return result.success;
  } catch {
    return false;
  } finally {
    // Cleanup
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Detect if rsync command is available.
 */
async function detectRsyncAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("rsync", {
      args: ["--version"],
      stderr: "null",
      stdout: "null",
    });
    const result = await cmd.output();

    return result.success;
  } catch {
    return false;
  }
}
