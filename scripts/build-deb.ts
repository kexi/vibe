/**
 * Build .deb packages for Ubuntu/Debian
 * Usage: deno run --allow-read --allow-write --allow-run scripts/build-deb.ts <version> <arch> <binary-path>
 * Example: deno run --allow-read --allow-write --allow-run scripts/build-deb.ts 0.1.5 amd64 vibe-linux-x64
 */

interface DebConfig {
  version: string;
  arch: string; // amd64 or arm64
  binaryPath: string;
}

async function createDebPackage(config: DebConfig): Promise<void> {
  const { version, arch, binaryPath } = config;
  const packageName = `vibe_${version}_${arch}`;
  const packageDir = packageName;

  // Create directory structure
  await Deno.mkdir(`${packageDir}/DEBIAN`, { recursive: true });
  await Deno.mkdir(`${packageDir}/usr/bin`, { recursive: true });

  // Copy binary
  await Deno.copyFile(binaryPath, `${packageDir}/usr/bin/vibe`);

  // Set executable permissions
  await Deno.chmod(`${packageDir}/usr/bin/vibe`, 0o755);

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

  await Deno.writeTextFile(`${packageDir}/DEBIAN/control`, controlContent);

  // Build .deb package
  const buildCommand = new Deno.Command("dpkg-deb", {
    args: ["--build", "--root-owner-group", packageDir],
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success } = await buildCommand.output();
  if (!success) {
    throw new Error("Failed to build .deb package");
  }

  console.log(`Successfully created ${packageName}.deb`);

  // Clean up temporary directory
  await Deno.remove(packageDir, { recursive: true });
  console.log(`Cleaned up temporary directory: ${packageDir}`);
}

async function main(): Promise<void> {
  const hasRequiredArgs = Deno.args.length >= 3;
  if (!hasRequiredArgs) {
    console.error("Usage: deno run --allow-read --allow-write --allow-run scripts/build-deb.ts <version> <arch> <binary-path>");
    console.error("Example: deno run --allow-read --allow-write --allow-run scripts/build-deb.ts 0.1.5 amd64 vibe-linux-x64");
    Deno.exit(1);
  }

  const [version, arch, binaryPath] = Deno.args;

  // Validate arch
  const validArchs = ["amd64", "arm64"];
  if (!validArchs.includes(arch)) {
    console.error(`Invalid architecture: ${arch}. Must be 'amd64' or 'arm64'`);
    Deno.exit(1);
  }

  // Check if binary exists
  try {
    await Deno.stat(binaryPath);
  } catch {
    console.error(`Binary not found: ${binaryPath}`);
    Deno.exit(1);
  }

  await createDebPackage({ version, arch, binaryPath });
}

main();
