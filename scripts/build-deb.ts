#!/usr/bin/env bun

/**
 * Build .deb packages for Ubuntu/Debian
 * Usage: bun run scripts/build-deb.ts <version> <arch> <binary-path>
 * Example: bun run scripts/build-deb.ts 0.1.5 amd64 vibe-linux-x64
 *
 * Besides /usr/bin/vibe the package installs the documentation Debian expects a
 * binary package to carry: a machine-readable DEP-5 copyright file derived from
 * the repo's own LICENSE, and THIRD-PARTY-LICENSES.md for the Rust crates the
 * binary statically links.
 */

import { mkdir, copyFile, writeFile, chmod, rm, stat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const DOC_DIR = "usr/share/doc/vibe";
const THIRD_PARTY_LICENSE_FILE = "THIRD-PARTY-LICENSES.md";
const PROJECT_LICENSE_FILE = "LICENSE";

interface DebConfig {
  version: string;
  arch: string; // amd64 or arm64
  binaryPath: string;
}

export interface BuildOptions {
  /** Repo root that LICENSE and THIRD-PARTY-LICENSES.md resolve under. */
  root?: string;
}

async function runCommand(cmd: string, args: string[]): Promise<{ success: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: "inherit",
    });

    // Why handle "error" and not only "close": a spawn failure (dpkg-deb absent
    // from PATH) emits "error" and never "close", so without this the promise
    // never settles and the build hangs instead of reporting a missing tool.
    proc.on("error", (err: Error) => {
      console.error(`${cmd}: ${err.message}`);
      resolve({ success: false });
    });

    proc.on("close", (code) => {
      resolve({ success: code === 0 });
    });
  });
}

/**
 * Reformat a license body as a DEP-5 formatted-text field value: blank lines
 * become ` .` and every other line is indented by one space, so the whole block
 * is a single continued field.
 *
 * Throws on a non-blank line that already starts with `.`: DEP-5 reads ` .` as
 * an escaped empty line, so such a line would silently come back out of the
 * file as a blank one, corrupting the reproduced license text.
 */
export function formatDep5Text(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => {
      const isBlank = line.trim() === "";
      if (isBlank) {
        return " .";
      }
      if (line.startsWith(".")) {
        throw new Error(
          "license text has a line starting with '.', which DEP-5 continuation syntax cannot represent",
        );
      }
      return ` ${line}`;
    })
    .join("\n");
}

/**
 * Pull the upstream copyright holder line out of the license text.
 * Throws rather than defaulting: a wrong or invented holder in a legal document
 * is worse than a failed build.
 */
export function extractCopyrightLine(licenseText: string): string {
  const match = licenseText.match(/^\s*(Copyright \(c\).*)$/m);
  if (!match) {
    throw new Error(`no "Copyright (c)" line found in ${PROJECT_LICENSE_FILE}`);
  }
  return match[1].trim();
}

export interface CopyrightOptions {
  /** The project's own LICENSE text (MIT), used verbatim for the License stanza. */
  licenseText: string;
}

/**
 * Render `usr/share/doc/vibe/copyright` in machine-readable DEP-5 1.0 format.
 * The MIT body is derived from the repo LICENSE rather than hardcoded, so the
 * .deb can never state terms that differ from the ones actually shipped.
 */
export function renderDebianCopyright({ licenseText }: CopyrightOptions): string {
  const copyright = extractCopyrightLine(licenseText);
  const body = formatDep5Text(licenseText);

  return `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: vibe
Upstream-Contact: kexi <https://github.com/kexi>
Source: https://github.com/kexi/vibe

Files: *
Copyright: ${copyright}
License: MIT
Comment: The vibe binary statically links third-party Rust crates.
 Their license notices are installed alongside this file as
 /usr/share/doc/vibe/${THIRD_PARTY_LICENSE_FILE}.

License: MIT
${body}
`;
}

async function readRequired(path: string, what: string): Promise<string> {
  const exists = await stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) {
    throw new Error(`${what} not found: ${path}`);
  }
  return readFile(path, "utf-8");
}

/**
 * Populate `<packageDir>/usr/share/doc/vibe/` with the DEP-5 copyright file and
 * THIRD-PARTY-LICENSES.md, with modes set explicitly (0755 dir, 0644 files) so
 * the caller's umask cannot produce an unreadable installed document.
 *
 * Both sources are required. Why not warn on a missing THIRD-PARTY-LICENSES.md
 * the way stage-platform-package.ts does: there the file is a build product a
 * developer may not have generated yet, and the tarball verifier is the release
 * gate. Here it is a committed file, so its absence means a broken checkout —
 * and unlike an npm tarball, a .deb that installs no notices is a distribution
 * that silently drops the crates' terms.
 *
 * The files are installed uncompressed: `dpkg-deb` does not gzip them, and
 * `copyright` must stay plain text for the archive tooling that reads it.
 */
export async function stageDocFiles(packageDir: string, options: BuildOptions = {}): Promise<void> {
  const root = options.root ?? ".";

  const licenseText = await readRequired(join(root, PROJECT_LICENSE_FILE), PROJECT_LICENSE_FILE);
  const notices = await readRequired(
    join(root, THIRD_PARTY_LICENSE_FILE),
    THIRD_PARTY_LICENSE_FILE,
  );

  const docDir = join(packageDir, DOC_DIR);
  await mkdir(docDir, { recursive: true });
  await chmod(docDir, 0o755);

  const copyrightPath = join(docDir, "copyright");
  await writeFile(copyrightPath, renderDebianCopyright({ licenseText }), "utf-8");
  await chmod(copyrightPath, 0o644);

  const noticesPath = join(docDir, THIRD_PARTY_LICENSE_FILE);
  await writeFile(noticesPath, notices, "utf-8");
  await chmod(noticesPath, 0o644);
}

export async function createDebPackage(
  config: DebConfig,
  options: BuildOptions = {},
): Promise<void> {
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

    await stageDocFiles(packageDir, options);

    // Create control file. Why no License: field: the Debian binary package
    // control format has none — the terms live in usr/share/doc/vibe/copyright,
    // and an unknown field would make the package fail lintian/policy checks.
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

// Only run the CLI when executed directly (bun sets import.meta.main); under
// vitest import.meta.main is undefined, so importing for tests is side-effect free.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`build-deb: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
