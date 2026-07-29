#!/usr/bin/env bun

/**
 * Assert that a built .deb carries the binary and the required documentation.
 *
 * A .deb that installs /usr/bin/vibe but drops usr/share/doc/vibe/copyright
 * ships a Debian package with no statement of terms, and one without
 * THIRD-PARTY-LICENSES.md drops the notices for the Rust crates the binary
 * statically links. Neither failure is visible from a smoke test of the
 * installed binary, so this checks the package contents directly.
 *
 * Inspection only: `dpkg-deb --contents` / `--fsys-tarfile` read the archive
 * without installing it, so no sudo (and no mutation of the runner) is needed.
 *
 * Usage:
 *   bun run scripts/verify-deb.ts vibe_1.2.3_amd64.deb
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { resolve, relative, isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);

const BINARY_PATH = "usr/bin/vibe";
const COPYRIGHT_PATH = "usr/share/doc/vibe/copyright";
const NOTICES_PATH = "usr/share/doc/vibe/THIRD-PARTY-LICENSES.md";

/** Substrings each documentation file must contain to count as the real thing. */
const COPYRIGHT_MARKERS = [
  "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/",
  "License: MIT",
  "Permission is hereby granted, free of charge",
];
const NOTICES_MARKERS = ["TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"];

/** One entry of `dpkg-deb --contents`: the member path and its mode string. */
export interface DebEntry {
  path: string;
  mode: string;
}

/**
 * Parse `dpkg-deb --contents` output. Lines look like
 *   -rwxr-xr-x root/root  5242880 2025-01-01 00:00 ./usr/bin/vibe
 * The leading `./` is stripped so callers compare against plain archive paths.
 *
 * Why not take the last whitespace-separated field as the name: paths may
 * contain spaces, which would truncate the member to its last word and report a
 * required file as missing. Only the first five fields (mode, owner, size, date,
 * time) are fixed-width-ish; everything after them is the name, so the name is
 * rejoined rather than indexed.
 */
export function parseDebContents(stdout: string): DebEntry[] {
  const entries: DebEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const hasEnoughFields = fields.length >= 6;
    if (!hasEnoughFields) {
      continue;
    }
    const mode = fields[0];
    // A symlink/hardlink line reads `<name> -> <target>`; the member is
    // everything before the arrow. Otherwise the name runs to end of line.
    const arrowIndex = fields.indexOf("->", 5);
    const nameFields = arrowIndex === -1 ? fields.slice(5) : fields.slice(5, arrowIndex);
    const rawPath = nameFields.join(" ");
    if (rawPath === "") {
      continue;
    }
    entries.push({ path: rawPath.replace(/^\.\//, ""), mode });
  }
  return entries;
}

/** True when a `dpkg-deb --contents` mode string denotes a regular file. */
export function isRegularFile(mode: string): boolean {
  return mode.startsWith("-");
}

/** True when a `dpkg-deb --contents` mode string carries any execute bit. */
export function isExecutable(mode: string): boolean {
  return mode.slice(1).includes("x");
}

/**
 * Check the archive listing for the required members. Pure so it can be
 * unit-tested without dpkg. Returns the list of problems (empty = OK).
 *
 * Each required member must be a REGULAR file: `dpkg-deb --contents` lists
 * directories and symlinks in the same table, so a bare presence check would
 * accept a directory named usr/bin/vibe, or a copyright symlink pointing
 * somewhere that is not shipped in the package at all.
 */
export function findContentProblems(entries: DebEntry[]): string[] {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const problems: string[] = [];

  for (const required of [BINARY_PATH, COPYRIGHT_PATH, NOTICES_PATH]) {
    const entry = byPath.get(required);
    if (!entry) {
      problems.push(`missing required file: ${required}`);
      continue;
    }
    if (!isRegularFile(entry.mode)) {
      problems.push(`${required} is not a regular file (mode ${entry.mode})`);
    }
  }

  const binary = byPath.get(BINARY_PATH);
  const isNonExecutableFile = binary && isRegularFile(binary.mode) && !isExecutable(binary.mode);
  if (isNonExecutableFile) {
    problems.push(`${BINARY_PATH} is not executable (mode ${binary.mode})`);
  }

  return problems;
}

/** Check a documentation file's text for the markers that identify it. */
export function findMarkerProblems(path: string, content: string, markers: string[]): string[] {
  return markers
    .filter((marker) => !content.includes(marker))
    .map((marker) => `${path} does not contain: ${marker}`);
}

/**
 * Resolve the .deb argument and require it to stay under the working directory.
 * The path reaches this script from CI job inputs, and reading an arbitrary
 * absolute path would let a crafted value point the verifier at a file outside
 * the workspace that it then reports on.
 */
export function resolveDebPath(arg: string, cwd: string): string {
  const abs = resolve(cwd, arg);
  const rel = relative(cwd, abs);
  const escapes = rel === "" || rel.startsWith("..") || isAbsolute(rel);
  if (escapes) {
    throw new Error(`.deb path must be inside the working directory: ${arg}`);
  }
  return abs;
}

/**
 * Read one member's text out of the .deb without unpacking it to disk.
 *
 * Why not `sh -c 'dpkg-deb --fsys-tarfile ... | tar -xO ...'`: that would put a
 * caller-supplied path through a shell. The two processes are spawned with argv
 * arrays instead and wired together in-process.
 */
async function readMember(debPath: string, member: string): Promise<string> {
  const dpkg = spawn("dpkg-deb", ["--fsys-tarfile", debPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tar = spawn("tar", ["-xO", `./${member}`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  dpkg.stdout.pipe(tar.stdin);

  const chunks: Buffer[] = [];
  tar.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

  const [dpkgCode, tarCode] = await Promise.all([
    once(dpkg, "close").then(([code]) => code as number | null),
    once(tar, "close").then(([code]) => code as number | null),
  ]);

  // The producer's status is checked too: dpkg-deb failing on a corrupt archive
  // still closes the pipe, which tar reports as a clean end-of-input, so
  // ignoring it would turn an unreadable package into an empty extraction.
  if (dpkgCode !== 0) {
    throw new Error(`dpkg-deb could not read the package (exit ${dpkgCode})`);
  }
  if (tarCode !== 0) {
    throw new Error(`could not extract ${member} from the package (tar exit ${tarCode})`);
  }

  const content = Buffer.concat(chunks).toString("utf-8");
  // tar exits 0 when asked for a member that does not match anything, so an
  // empty result is the only signal distinguishing "absent" from "empty file".
  if (content === "") {
    throw new Error(`extracted ${member} from the package but it was empty`);
  }
  return content;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: bun run scripts/verify-deb.ts <path-to-.deb>");
    process.exit(1);
  }
  const debPath = resolveDebPath(arg, process.cwd());

  const { stdout } = await execFileAsync("dpkg-deb", ["--contents", debPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = parseDebContents(stdout);

  const problems = findContentProblems(entries);
  if (problems.length === 0) {
    const copyright = await readMember(debPath, COPYRIGHT_PATH);
    problems.push(...findMarkerProblems(COPYRIGHT_PATH, copyright, COPYRIGHT_MARKERS));
    const notices = await readMember(debPath, NOTICES_PATH);
    problems.push(...findMarkerProblems(NOTICES_PATH, notices, NOTICES_MARKERS));
  }

  if (problems.length > 0) {
    console.error(`✗ ${arg}: package contents are incomplete:`);
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  console.log(`✓ ${arg}: ships ${BINARY_PATH}, ${COPYRIGHT_PATH}, ${NOTICES_PATH}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`verify-deb: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
