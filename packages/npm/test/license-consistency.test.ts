/**
 * License coherence guards for the MIT relicense (#553).
 *
 * vibe declares its license in eight independent places — the root and every
 * package manifest, the Rust workspace, three Homebrew formulae, the Nix
 * derivation meta, and the LICENSE text itself. Nothing derives one from
 * another, so a partial relicense (or a new package copy-pasted from a
 * pre-v3 manifest) would publish contradictory terms without any build failing.
 *
 * What these guarantee:
 *   - every non-private package under packages/ declares "MIT", and none omits
 *     the license field — enumerated by SCANNING packages/ on disk, not from a
 *     hardcoded list, so a future sixth platform package cannot silently ship
 *     without a license;
 *   - the root package.json and the Rust workspace declare MIT;
 *   - all three Homebrew formula templates declare `license "MIT"` (they are
 *     published to the tap, a separate statement of vibe's terms);
 *   - flake.nix's meta says licenses.mit and no longer licenses.asl20;
 *   - LICENSE is the MIT text, with no Apache wording left behind.
 *
 * Reads the REAL repo files (resolved from the repo root, three levels up from
 * this test dir): these assert the committed configuration, not a fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Repo root: packages/npm/test -> ../../..
const REPO_ROOT = join(__dirname, "..", "..", "..");

const EXPECTED_LICENSE = "MIT";

interface PackageManifest {
  name?: string;
  private?: boolean;
  license?: string;
}

function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function readRepoJson<T>(rel: string): T {
  return JSON.parse(readRepoFile(rel)) as T;
}

/**
 * Every packages/<dir>/package.json on disk, discovered by directory scan.
 * A hardcoded list would not fail when a new package dir is added, which is
 * precisely the drift this file exists to catch.
 */
function discoverPackageManifests(): { dir: string; rel: string; pkg: PackageManifest }[] {
  const packagesDir = join(REPO_ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: e.name, rel: `packages/${e.name}/package.json` }))
    .filter((e) => existsSync(join(REPO_ROOT, e.rel)))
    .map((e) => ({ ...e, pkg: readRepoJson<PackageManifest>(e.rel) }));
}

/**
 * `private: true` is npm's own publish blocker, so anything without it is
 * publishable by default and must state its terms. Why not key off
 * publishConfig.access: that is opt-IN, so a new package that simply forgot to
 * declare a license would also lack publishConfig and be skipped entirely —
 * the drift would hide in the very gap this file exists to close.
 */
function isPublishable(pkg: PackageManifest): boolean {
  return pkg.private !== true;
}

const manifests = discoverPackageManifests();

describe("package manifest licenses", () => {
  it("finds the shim and all five platform packages by disk scan", () => {
    const publishable = manifests.filter((m) => isPublishable(m.pkg)).map((m) => m.dir);
    // Sanity-check the discovery itself: if the scan silently found nothing,
    // every per-package assertion below would vacuously pass.
    expect(publishable).toContain("npm");
    expect(publishable.filter((d) => d.startsWith("vibe-")).length).toBe(5);
  });

  it.each(manifests.filter((m) => isPublishable(m.pkg)).map((m) => [m.rel, m.pkg] as const))(
    "%s declares MIT",
    (_rel, pkg) => {
      expect(pkg.license).toBe(EXPECTED_LICENSE);
    },
  );

  it("has no non-private packages/* manifest missing or contradicting the license field", () => {
    // Asserted over the scanned set rather than per-package so a NEW publishable
    // package that omits `license` entirely fails here — an absent field would
    // otherwise never be compared against anything.
    const wrong = manifests
      .filter((m) => isPublishable(m.pkg) && m.pkg.license !== EXPECTED_LICENSE)
      .map((m) => `${m.rel}: ${m.pkg.license ?? "<no license field>"}`);
    expect(wrong).toEqual([]);
  });

  it("has no packages/* manifest declaring a non-MIT license", () => {
    // Covers private manifests too: a license field, if present at all, must
    // not contradict the project's terms.
    const wrong = manifests
      .filter((m) => m.pkg.license !== undefined && m.pkg.license !== EXPECTED_LICENSE)
      .map((m) => `${m.rel}: ${m.pkg.license}`);
    expect(wrong).toEqual([]);
  });

  it("declares MIT in the root package.json", () => {
    expect(readRepoJson<PackageManifest>("package.json").license).toBe(EXPECTED_LICENSE);
  });
});

describe("Rust workspace license", () => {
  it("declares MIT in [workspace.package] (every crate inherits it)", () => {
    // Anchored to the license line only. Why not also assert the file mentions
    // no "Apache": a comment explaining, say, aws-lc-sys's Apache-2.0 conjunct
    // would trip it — a false positive about prose, not about the declaration.
    expect(readRepoFile("rust/Cargo.toml")).toMatch(/^license = "MIT"$/m);
  });
});

describe("Homebrew formula licenses", () => {
  const formulae = ["Formula/vibe.rb", "Formula/vibe-beta.rb", "Formula/vibe-versioned.rb"];

  it.each(formulae)("%s declares an MIT license stanza", (rel) => {
    expect(readRepoFile(rel)).toContain('license "MIT"');
  });

  it("enumerates every formula in the repo (no unchecked template)", () => {
    const onDisk = readdirSync(join(REPO_ROOT, "Formula"))
      .filter((f) => f.endsWith(".rb"))
      .map((f) => `Formula/${f}`)
      .sort();
    expect(onDisk).toEqual([...formulae].sort());
  });
});

describe("Nix derivation meta", () => {
  it("uses licenses.mit and no longer licenses.asl20", () => {
    const flake = readRepoFile("flake.nix");
    expect(flake).toContain("licenses.mit");
    expect(flake).not.toContain("asl20");
  });
});

describe("LICENSE text", () => {
  const license = readRepoFile("LICENSE");

  it("is the MIT license", () => {
    expect(license).toContain("MIT License");
    expect(license).toContain("Permission is hereby granted, free of charge");
  });

  it("retains no Apache-2.0 wording", () => {
    expect(license).not.toContain("Apache");
  });

  it("carries the project copyright line", () => {
    expect(license).toContain("Copyright (c) 2025 Kei Nakayama (kexi) and the vibe contributors");
  });
});
