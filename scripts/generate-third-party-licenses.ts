#!/usr/bin/env bun

/**
 * Generate THIRD-PARTY-LICENSES.md for the shipped Rust binary.
 *
 * The Rust `vibe` binary statically links its crate dependencies, so the
 * distributed artifact must carry their license notices. We deliberately avoid a
 * dedicated tool (cargo-about / cargo-bundle-licenses) to keep the dependency
 * set minimal; instead the crate set + SPDX expressions are read from
 * `cargo metadata` (already available) and rendered to a checked-in Markdown
 * file that the per-platform npm packages ship via their `files` list.
 *
 * Usage:
 *   bun run scripts/generate-third-party-licenses.ts          # write the file
 *   bun run scripts/generate-third-party-licenses.ts --check  # fail if stale
 *
 * Run this whenever rust/Cargo.lock changes (a dependency add/remove/bump).
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OUTPUT = "THIRD-PARTY-LICENSES.md";
const OWN_CRATES = new Set(["vibe", "vibe-core", "vibe-native", "vibe-test-support"]);

interface CargoPackage {
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
}

interface CargoMetadata {
  packages: CargoPackage[];
}

async function loadDependencies(): Promise<CargoPackage[]> {
  const { stdout } = await execFileAsync("cargo", ["metadata", "--format-version", "1"], {
    cwd: "rust",
    maxBuffer: 64 * 1024 * 1024,
  });
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const deps = metadata.packages.filter((pkg) => !OWN_CRATES.has(pkg.name));
  deps.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return deps;
}

function render(deps: CargoPackage[]): string {
  const lines: string[] = [];
  lines.push("# Third-Party Licenses");
  lines.push("");
  lines.push("The `vibe` binary is written in Rust and statically links the crates listed");
  lines.push("below. Each is distributed under a permissive license (MIT, Apache-2.0, ISC,");
  lines.push("BSD-3-Clause, Zlib, Unlicense, CC0-1.0, Unicode-3.0, CDLA-Permissive-2.0, or a");
  lines.push("dual/multi-license `OR` of these). Where a crate is multi-licensed, vibe's");
  lines.push("distribution elects the permissive option.");
  lines.push("");
  lines.push("This list is generated from `cargo metadata` over `rust/Cargo.lock` by");
  lines.push("`scripts/generate-third-party-licenses.ts`. It is the full dependency graph,");
  lines.push("including platform-gated crates (e.g. Windows/wasm) that are not linked into");
  lines.push("every shipped binary; listing them all is intentionally conservative.");
  lines.push("");
  lines.push("| Crate | Version | License (SPDX) |");
  lines.push("| ----- | ------- | -------------- |");
  for (const dep of deps) {
    const license = dep.license ?? (dep.license_file ? `see ${dep.license_file}` : "UNKNOWN");
    lines.push(`| ${dep.name} | ${dep.version} | ${license} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const checkOnly = process.argv.slice(2).includes("--check");
  const deps = await loadDependencies();
  const content = render(deps);

  if (checkOnly) {
    const existing = await readFile(OUTPUT, "utf-8").catch(() => "");
    if (existing !== content) {
      console.error(`${OUTPUT} is stale. Run: bun run scripts/generate-third-party-licenses.ts`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date (${deps.length} crates).`);
    return;
  }

  await writeFile(OUTPUT, content, "utf-8");
  console.log(`Wrote ${OUTPUT} (${deps.length} crates).`);
}

main().catch((err: unknown) => {
  console.error(
    `generate-third-party-licenses: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
