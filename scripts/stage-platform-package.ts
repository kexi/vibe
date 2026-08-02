#!/usr/bin/env bun

/**
 * Stage a Rust release binary into its per-platform npm package.
 *
 * The shipped vibe is a native Rust binary. @kexi/vibe (the npm shim) declares
 * five per-platform `optionalDependencies`; this script copies the built binary
 * for one <platform>-<arch> into that platform package's `bin/vibe` so it can be
 * published (the bin/ dirs are gitignored and staged at build/release time).
 *
 * The on-disk name is `bin/vibe` on Unix and `bin/vibe.exe` on Windows. Why the
 * .exe on Windows: Node's spawn launches a PE by its extension (an extensionless
 * PE does not run via CreateProcess from a npm .bin shim), and require.resolve
 * never tries a `.exe` suffix, so the shim must ask for the explicit name. This
 * mirrors esbuild (esbuild.exe on win32, bin/esbuild elsewhere). On Windows the
 * caller passes `--binary <...>/vibe.exe`; the copy below keeps the .exe name.
 *
 * Usage:
 *   bun run scripts/stage-platform-package.ts --platform <p> --arch <a> [--binary <path>]
 *
 * Options:
 *   --platform   linux | darwin | win32    (Node process.platform values)
 *   --arch       x64 | arm64               (Node process.arch values)
 *   --binary     path to the built `vibe` binary (or `vibe.exe` on Windows).
 *                Defaults to the host build at rust/target/release/vibe.
 *
 * On success it prints the staged destination path.
 */

import { copyFile, mkdir, chmod, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;
const SUPPORTED_ARCHES = ["x64", "arm64"] as const;

type Platform = (typeof SUPPORTED_PLATFORMS)[number];
type Arch = (typeof SUPPORTED_ARCHES)[number];

export interface Args {
  platform: Platform;
  arch: Arch;
  binary: string;
}

export function parseArgs(argv: string[]): Args {
  let platform: string | undefined;
  let arch: string | undefined;
  let binary: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") {
      platform = argv[++i];
    } else if (arg === "--arch") {
      arch = argv[++i];
    } else if (arg === "--binary") {
      binary = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const isValidPlatform = SUPPORTED_PLATFORMS.includes(platform as Platform);
  if (!isValidPlatform) {
    throw new Error(
      `--platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")} (got: ${platform ?? "<none>"})`,
    );
  }
  const isValidArch = SUPPORTED_ARCHES.includes(arch as Arch);
  if (!isValidArch) {
    throw new Error(
      `--arch must be one of: ${SUPPORTED_ARCHES.join(", ")} (got: ${arch ?? "<none>"})`,
    );
  }

  return {
    platform: platform as Platform,
    arch: arch as Arch,
    // Default to the host release build path.
    binary: binary ?? join("rust", "target", "release", "vibe"),
  };
}

function packageDir(root: string, platform: Platform, arch: Arch): string {
  return join(root, "packages", `vibe-${platform}-${arch}`);
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/stage-platform-package.ts --platform <p> --arch <a> [--binary <path>]

Options:
  --platform   linux | darwin | win32
  --arch       x64 | arm64
  --binary     path to the built vibe binary (default: rust/target/release/vibe)
  --help       show this help
`);
}

export interface StageOptions {
  /** Repo root the `packages/` tree, LICENSE and THIRD-PARTY-LICENSES.md resolve under. */
  root?: string;
  /** Sink for the not-found-notice warning; defaults to console.error. */
  warn?: (msg: string) => void;
}

/**
 * Copy the built binary into `packages/vibe-<platform>-<arch>/bin/vibe`
 * (`bin/vibe.exe` on win32, 0o755) and stage LICENSE + THIRD-PARTY-LICENSES.md
 * beside it. Returns the staged binary path. Throws if the source binary or the
 * root LICENSE does not exist. The root is injected so tests run against a temp
 * dir instead of the real repo.
 *
 * Why LICENSE throws but THIRD-PARTY-LICENSES.md only warns: LICENSE is a
 * committed file, so its absence never means "not generated yet" — it means the
 * checkout is broken, and continuing would stage a package that ships no terms
 * at all. THIRD-PARTY-LICENSES.md is a build product that a caller may legitimately
 * not have generated yet, and verify-platform-tarball.ts is the gate that stops it
 * from reaching a release. That gate is skipped on the Windows CI leg, which is
 * the other reason LICENSE cannot rely on it.
 */
export async function stagePlatformPackage(
  args: Args,
  options: StageOptions = {},
): Promise<string> {
  const root = options.root ?? ".";
  const warn = options.warn ?? ((msg: string) => console.error(msg));

  const sourceExists = await stat(args.binary).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!sourceExists) {
    throw new Error(`binary not found: ${args.binary}`);
  }

  const pkgDir = packageDir(root, args.platform, args.arch);
  // Windows binaries keep the .exe extension so Node's spawn can launch the PE
  // and the shim's require.resolve(".../bin/vibe.exe") finds it (esbuild does
  // the same: esbuild.exe on win32). Unix stays extensionless.
  const binName = args.platform === "win32" ? "vibe.exe" : "vibe";
  const dest = join(pkgDir, "bin", binName);

  await mkdir(dirname(dest), { recursive: true });
  await copyFile(args.binary, dest);
  await chmod(dest, 0o755);

  // The platform package's `files` list includes THIRD-PARTY-LICENSES.md (the
  // statically-linked Rust crates' notices), so stage it alongside the binary.
  const stagedNotices = await copyIfPresent(root, pkgDir, "THIRD-PARTY-LICENSES.md");
  if (!stagedNotices) {
    warn(
      "stage-platform-package: warning: THIRD-PARTY-LICENSES.md not found; " +
        "run scripts/generate-third-party-licenses.ts first",
    );
  }

  // vibe's own LICENSE. Not listed in `files`: npm includes a top-level LICENSE
  // in the tarball irrespective of `files`, and the canonical copy lives at the
  // repo root — checking a duplicate into each package dir would be N copies to
  // keep in sync.
  const stagedLicense = await copyIfPresent(root, pkgDir, "LICENSE");
  if (!stagedLicense) {
    throw new Error(`LICENSE not found at ${resolve(root, "LICENSE")}`);
  }

  return dest;
}

/**
 * Copy `<root>/<name>` into the package dir. Returns false (without copying)
 * when the source is absent, leaving the caller to decide whether that is fatal.
 */
async function copyIfPresent(root: string, pkgDir: string, name: string): Promise<boolean> {
  const source = join(root, name);
  const exists = await stat(source).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) {
    return false;
  }
  await copyFile(source, join(pkgDir, name));
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dest = await stagePlatformPackage(args);
  console.log(dest);
}

// Only run the CLI when executed directly (bun sets import.meta.main); under
// vitest import.meta.main is undefined, so importing for tests is side-effect free.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`stage-platform-package: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
