/**
 * Build .deb packages for Ubuntu/Debian
 * Usage: bun run scripts/build-deb.ts <version> <arch> <binary-path>
 * Example: bun run scripts/build-deb.ts 0.1.5 amd64 vibe-linux-x64
 */

import { mkdir, copyFile, writeFile, chmod, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

interface DebConfig {
  version: string;
  arch: string; // amd64 or arm64
  binaryPath: string;
}

async function runCommand(cmd: string, args: string[]): Promise<{ success: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      resolve({ success: code === 0 });
    });
  });
}

async function createDebPackage(config: DebConfig): Promise<void> {
  const { version, arch, binaryPath } = config;
  const packageName = `vibe_${version}_${arch}`;
  const packageDir = packageName;

  try {
    // Create directory structure
    await mkdir(`${packageDir}/DEBIAN`, { recursive: true });
    await mkdir(`${packageDir}/usr/bin`, { recursive: true });

    // Copy binary
    await copyFile(binaryPath, `${packageDir}/usr/bin/vibe`);

    // Set executable permissions
    await chmod(`${packageDir}/usr/bin/vibe`, 0o755);

    // Create control file
    const controlContent = `Package: vibe
Version: ${version}
Architecture: ${arch}
Maintainer: kexi <https://github.com/kexi>
Description: Git worktree helper CLI
 A CLI tool for easy Git Worktree management.
 .
 vibe simplifies the creation and management of Git worktrees,
 making it easy to work on multiple branches simultaneously.
Homepage: https://github.com/kexi/vibe
Section: devel
Priority: optional
`;

    await writeFile(`${packageDir}/DEBIAN/control`, controlContent);

    // Build .deb package
    const { success } = await runCommand("dpkg-deb", ["--build", "--root-owner-group", packageDir]);

    if (!success) {
      throw new Error("Failed to build .deb package");
    }

    console.log(`Successfully created ${packageName}.deb`);
  } finally {
    // Clean up temporary directory
    try {
      await rm(packageDir, { recursive: true, force: true });
      console.log(`Cleaned up temporary directory: ${packageDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to clean up temporary directory: ${message}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hasRequiredArgs = args.length >= 3;
  if (!hasRequiredArgs) {
    console.error("Usage: bun run scripts/build-deb.ts <version> <arch> <binary-path>");
    console.error("Example: bun run scripts/build-deb.ts 0.1.5 amd64 vibe-linux-x64");
    process.exit(1);
  }

  const [version, arch, binaryPath] = args;

  // Validate arch
  const validArchs = ["amd64", "arm64"];
  const isValidArch = validArchs.includes(arch);
  if (!isValidArch) {
    console.error(`Invalid architecture: ${arch}. Must be 'amd64' or 'arm64'`);
    process.exit(1);
  }

  // Check if binary exists
  try {
    await stat(binaryPath);
  } catch {
    console.error(`Binary not found: ${binaryPath}`);
    process.exit(1);
  }

  await createDebPackage({ version, arch, binaryPath });
}

main();
