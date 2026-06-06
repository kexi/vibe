#!/usr/bin/env bun

/**
 * Stage a Rust release binary into its per-platform npm package.
 *
 * The shipped vibe is a native Rust binary. @kexi/vibe (the npm shim) declares
 * five per-platform `optionalDependencies`; this script copies the built binary
 * for one <platform>-<arch> into that platform package's `bin/vibe` so it can be
 * published (the bin/ dirs are gitignored and staged at build/release time).
 *
 * The on-disk name is `bin/vibe` (no extension) on EVERY platform, Windows
 * included. Why not `bin/vibe.exe` on Windows: the shim resolves the binary via
 * `require.resolve(".../bin/vibe")`, which never tries a `.exe` suffix — keeping
 * one name across platforms means the shim's resolution and the tarball verifier
 * stay branch-free. On Windows the caller passes `--binary <...>/vibe.exe`; the
 * copy below renames it to `bin/vibe`, and Node's `spawnSync` launches the PE by
 * its header, not its extension.
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
import { dirname, join } from "node:path";

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
  /** Repo root the `packages/` tree and THIRD-PARTY-LICENSES.md resolve under. */
  root?: string;
  /** Sink for the not-found-license warning; defaults to console.error. */
  warn?: (msg: string) => void;
}

/**
 * Copy the built binary into `packages/vibe-<platform>-<arch>/bin/vibe` (0o755)
 * and stage THIRD-PARTY-LICENSES.md beside it. Returns the staged binary path.
 * Throws if the source binary does not exist. The root is injected so tests run
 * against a temp dir instead of the real repo.
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
  const dest = join(pkgDir, "bin", "vibe");

  await mkdir(dirname(dest), { recursive: true });
  await copyFile(args.binary, dest);
  await chmod(dest, 0o755);

  // The platform package's `files` list includes THIRD-PARTY-LICENSES.md (the
  // statically-linked Rust crates' notices), so stage it alongside the binary.
  const licenseSource = join(root, "THIRD-PARTY-LICENSES.md");
  const licenseExists = await stat(licenseSource).then(
    (s) => s.isFile(),
    () => false,
  );
  if (licenseExists) {
    await copyFile(licenseSource, join(pkgDir, "THIRD-PARTY-LICENSES.md"));
  } else {
    warn(
      `stage-platform-package: warning: THIRD-PARTY-LICENSES.md not found; ` +
        "run scripts/generate-third-party-licenses.ts first",
    );
  }

  return dest;
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
