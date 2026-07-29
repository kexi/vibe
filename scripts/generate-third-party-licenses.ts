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
 * Crates whose SPDX expression is a top-level `AND` conjunction impose
 * obligations that cannot be side-stepped by electing one arm of an `OR`
 * (Apache-2.0's §4 notice requirement, most notably). For those the appendix
 * reproduces the crate's own LICENSE/NOTICE files verbatim.
 *
 * Usage:
 *   bun run scripts/generate-third-party-licenses.ts          # write the file
 *   bun run scripts/generate-third-party-licenses.ts --check  # fail if stale
 *
 * Run this whenever rust/Cargo.lock changes (a dependency add/remove/bump).
 */

import { readFile, readdir, writeFile, lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);

const OUTPUT = "THIRD-PARTY-LICENSES.md";
const OWN_CRATES = new Set(["vibe", "vibe-core", "vibe-native", "vibe-test-support"]);

/** Names a crate may use for a shipped license/notice file, at its root only. */
const NOTICE_FILE_PATTERN = /^(LICENSE|LICENCE|NOTICE|COPYING)([-._].*)?$/i;

/** Per-file ceiling for a reproduced notice. */
const MAX_NOTICE_BYTES = 1024 * 1024;

interface CargoPackage {
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  manifest_path: string;
}

interface CargoMetadata {
  packages: CargoPackage[];
}

/** A crate's reproduced notice file: its basename and normalized UTF-8 text. */
export interface NoticeFile {
  name: string;
  text: string;
}

/** One appendix entry: a crate with a non-electable obligation, plus its notices. */
export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  files: NoticeFile[];
}

// --- SPDX ------------------------------------------------------------------

/**
 * Normalize the deprecated `/` shorthand (`MIT/Apache-2.0`) into ` OR `.
 * crates.io still carries these in older manifests, and the parser below only
 * understands the modern operators.
 */
export function normalizeSpdx(expr: string): string {
  return expr.replace(/\//g, " OR ").replace(/\s+/g, " ").trim();
}

/** A parsed SPDX expression: a license atom or a binary conjunction/disjunction. */
export type SpdxNode =
  | { kind: "license"; id: string }
  | { kind: "and"; operands: SpdxNode[] }
  | { kind: "or"; operands: SpdxNode[] };

function tokenizeSpdx(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i++;
      continue;
    }
    let j = i;
    while (j < expr.length && expr[j] !== " " && expr[j] !== "(" && expr[j] !== ")") {
      j++;
    }
    tokens.push(expr.slice(i, j));
    i = j;
  }
  return tokens;
}

/**
 * Minimal recursive-descent SPDX parser. Precedence is WITH > AND > OR, per the
 * SPDX license-expression grammar; `<id> WITH <exception>` is folded into a
 * single atom because the exception never changes which obligations apply.
 */
export function parseSpdx(expr: string): SpdxNode {
  const tokens = tokenizeSpdx(normalizeSpdx(expr));
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const isOperator = (token: string | undefined, name: string): boolean =>
    token !== undefined && token.toUpperCase() === name;

  function parseAtom(): SpdxNode {
    const token = peek();
    if (token === undefined) {
      throw new Error(`unexpected end of SPDX expression: ${expr}`);
    }
    if (token === "(") {
      pos++;
      const inner = parseOr();
      if (peek() !== ")") {
        throw new Error(`unbalanced parenthesis in SPDX expression: ${expr}`);
      }
      pos++;
      return inner;
    }
    if (token === ")") {
      throw new Error(`unexpected ')' in SPDX expression: ${expr}`);
    }
    pos++;
    let id = token;
    if (isOperator(peek(), "WITH")) {
      pos++;
      const exception = peek();
      if (exception === undefined) {
        throw new Error(`WITH without an exception in SPDX expression: ${expr}`);
      }
      pos++;
      id = `${id} WITH ${exception}`;
    }
    return { kind: "license", id };
  }

  function parseAnd(): SpdxNode {
    const operands = [parseAtom()];
    while (isOperator(peek(), "AND")) {
      pos++;
      operands.push(parseAtom());
    }
    return operands.length === 1 ? operands[0] : { kind: "and", operands };
  }

  function parseOr(): SpdxNode {
    const operands = [parseAnd()];
    while (isOperator(peek(), "OR")) {
      pos++;
      operands.push(parseAnd());
    }
    return operands.length === 1 ? operands[0] : { kind: "or", operands };
  }

  const node = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`trailing tokens in SPDX expression: ${expr}`);
  }
  return node;
}

/**
 * True when the expression's top-level operator is `AND`: every conjunct binds,
 * so no choice of `OR` arm can shed the obligation.
 *
 * Why not solve for the cheapest satisfying assignment (e.g. an `AND` whose
 * conjuncts are all `OR`s that share one electable license)? That analysis has
 * no subject in the current graph — no dependency is an electable-AND — so it
 * would be untested machinery guarding a case that does not exist. The
 * conservative answer only ever over-reproduces notices, which is safe.
 */
export function hasNonElectableObligation(expr: string): boolean {
  return parseSpdx(expr).kind === "and";
}

// --- Notice files ----------------------------------------------------------

/**
 * List the license/notice files a crate ships at its root, sorted by name.
 *
 * Symlinks are excluded outright rather than resolved: a crate tarball that
 * pointed LICENSE at /etc/shadow would otherwise have its target inlined into a
 * committed, published document. The realpath containment check is the second
 * layer, covering a root that is itself reached through a link.
 */
export async function discoverNoticeFiles(crateDir: string): Promise<string[]> {
  const entries = await readdir(crateDir).catch(() => [] as string[]);
  const candidates = entries.filter((name) => NOTICE_FILE_PATTERN.test(name)).sort();

  const crateReal = await realpath(crateDir);
  const found: string[] = [];
  for (const name of candidates) {
    const abs = join(crateDir, name);
    const stats = await lstat(abs).catch(() => null);
    const isPlainFile = stats !== null && stats.isFile() && !stats.isSymbolicLink();
    if (!isPlainFile) {
      continue;
    }
    const real = await realpath(abs).catch(() => null);
    if (real === null) {
      continue;
    }
    const rel = relative(crateReal, real);
    const escapesCrate = rel.startsWith("..") || isAbsolute(rel);
    if (escapesCrate) {
      continue;
    }
    found.push(name);
  }
  return found;
}

/**
 * Read a notice file and normalize it for embedding: strip a leading BOM,
 * convert CRLF to LF, and end with exactly one newline.
 *
 * Rejects (rather than repairs) anything unfit for a Markdown code block —
 * oversized, non-UTF-8, or carrying control characters. Silent truncation or
 * sanitization would publish a license text that is not the one the crate
 * shipped, which is the exact failure this appendix exists to prevent.
 *
 * Error messages name the crate and file only: echoing the offending bytes
 * would push attacker-controlled content into CI logs.
 */
export function normalizeNoticeText(raw: Buffer, label: string): string {
  if (raw.byteLength > MAX_NOTICE_BYTES) {
    throw new Error(
      `${label}: notice file is ${raw.byteLength} bytes, over the ${MAX_NOTICE_BYTES}-byte limit`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${label}: notice file is not valid UTF-8`);
  }

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, "\n");

  // Everything in C0 except tab and newline, plus DEL and any lone CR left over.
  // Why not rewrite this without control characters (no-control-regex): matching
  // them IS the check — a notice carrying NUL or an ANSI escape must be rejected,
  // and the rule's usual concern (an accidental literal in a text pattern) does
  // not apply to a range written deliberately as escapes.
  // oxlint-disable-next-line no-control-regex
  const hasForbiddenControl = /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text);
  if (hasForbiddenControl) {
    throw new Error(`${label}: notice file contains disallowed control characters`);
  }

  return `${text.replace(/\n+$/, "")}\n`;
}

async function readNoticeFile(crateDir: string, name: string, label: string): Promise<NoticeFile> {
  const raw = await readFile(join(crateDir, name));
  return { name, text: normalizeNoticeText(raw, `${label}/${name}`) };
}

// --- Rendering -------------------------------------------------------------

/**
 * The fence for a code block must be longer than the longest backtick run in
 * its content, anywhere on a line — not just at line start. aws-lc-sys's LICENSE
 * already contains a ``` run, so a fixed three-backtick fence breaks the
 * document against today's dependency graph, not some hypothetical future one.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Render the appendix reproducing each obligated crate's shipped notices. */
export function renderNoticeAppendix(entries: NoticeEntry[]): string {
  const lines: string[] = [];
  lines.push("## Appendix: License texts and notices for non-electable obligations");
  lines.push("");
  lines.push("Most crates above are offered under an `OR` choice, and vibe's distribution");
  lines.push("elects the permissive arm. The crates in this appendix are different: their");
  lines.push("SPDX expression is a top-level `AND` conjunction, so every conjunct binds and");
  lines.push("no election can shed it. Their obligations therefore travel with the shipped");
  lines.push("binary, and the license and notice files each crate distributes are reproduced");
  lines.push("below verbatim, exactly as published on crates.io.");
  lines.push("");
  lines.push("Like the table above, this appendix is drawn from the conservative full");
  lines.push("dependency graph, so it may reproduce notices for crates that are not linked");
  lines.push("into any shipped binary. Reproducing a notice is not a representation that the");
  lines.push("crate is present in a given build.");
  lines.push("");

  for (const entry of entries) {
    lines.push(`### ${entry.name} ${entry.version} — ${entry.license}`);
    lines.push("");
    for (const file of entry.files) {
      const fence = fenceFor(file.text);
      lines.push(`#### ${file.name}`);
      lines.push("");
      lines.push(fence);
      lines.push(file.text.replace(/\n$/, ""));
      lines.push(fence);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Render the whole document: preamble, crate table, and the notice appendix. */
export function render(deps: CargoPackage[], entries: NoticeEntry[]): string {
  const lines: string[] = [];
  lines.push("# Third-Party Licenses");
  lines.push("");
  lines.push("The `vibe` binary is written in Rust and statically links the crates listed");
  lines.push("below. Each is distributed under a permissive license (MIT, Apache-2.0, ISC,");
  lines.push("BSD-3-Clause, Zlib, Unlicense, CC0-1.0, Unicode-3.0, CDLA-Permissive-2.0, or a");
  lines.push("dual/multi-license `OR` of these). Where a crate is multi-licensed with `OR`,");
  lines.push("vibe's distribution elects the permissive option.");
  lines.push("");
  lines.push("Some crates are licensed under a top-level `AND` conjunction instead. Those");
  lines.push("obligations cannot be elected away, so the license and notice files those");
  lines.push("crates ship are reproduced in full in the appendix at the end of this file.");
  lines.push("");
  lines.push("This list is generated from `cargo metadata` over `rust/Cargo.lock` by");
  lines.push("`scripts/generate-third-party-licenses.ts`. It is the full dependency graph,");
  lines.push("including platform-gated crates (e.g. Windows/wasm) that are not linked into");
  lines.push("every shipped binary; listing them all is intentionally conservative.");
  lines.push("");
  lines.push("| Crate | Version | License (SPDX) |");
  lines.push("| ----- | ------- | -------------- |");
  for (const dep of deps) {
    lines.push(`| ${dep.name} | ${dep.version} | ${licenseOf(dep)} |`);
  }
  lines.push("");
  lines.push(renderNoticeAppendix(entries));
  return lines.join("\n");
}

function licenseOf(pkg: CargoPackage): string {
  return pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : "UNKNOWN");
}

// --- Driver ----------------------------------------------------------------

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

/**
 * Collect the appendix entries for every dependency whose SPDX expression
 * carries a non-electable obligation, in the same name→version order as the
 * table so the rendered document is byte-stable across runs and platforms.
 */
async function collectNoticeEntries(deps: CargoPackage[]): Promise<NoticeEntry[]> {
  const entries: NoticeEntry[] = [];
  for (const dep of deps) {
    const license = dep.license;
    if (license === null || !hasNonElectableObligation(license)) {
      continue;
    }

    const label = `${dep.name} ${dep.version}`;
    const crateDir = dirname(dep.manifest_path);
    const names = await discoverNoticeFiles(crateDir);
    if (names.length === 0) {
      throw new Error(
        `${label} has a non-electable obligation (${license}) but ships no ` +
          `LICENSE/NOTICE/COPYING file at its crate root; its terms cannot be reproduced`,
      );
    }

    const files: NoticeFile[] = [];
    for (const name of names) {
      files.push(await readNoticeFile(crateDir, name, label));
    }
    entries.push({ name: dep.name, version: dep.version, license, files });
  }
  return entries;
}

/**
 * Locate the first differing line between the committed and regenerated
 * documents. The file runs past a thousand lines of reproduced license text, so
 * a bare "is stale" leaves the reader diffing by hand to find what moved.
 */
export function describeFirstDifference(existing: string, generated: string): string {
  const a = existing.split("\n");
  const b = generated.split("\n");
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) {
      return `first difference at line ${i + 1}`;
    }
  }
  if (a.length !== b.length) {
    const verb = b.length > a.length ? "adds" : "removes";
    return `identical through line ${shared}; regeneration ${verb} ${Math.abs(b.length - a.length)} line(s)`;
  }
  return "content differs";
}

async function main(): Promise<void> {
  const checkOnly = process.argv.slice(2).includes("--check");
  const deps = await loadDependencies();
  const entries = await collectNoticeEntries(deps);

  // Why not tolerate an empty appendix: today's graph has four obligated
  // crates, so zero means the SPDX parser regressed and stopped recognizing
  // `AND` — a failure whose whole symptom is that the appendix silently
  // vanishes while the run still exits 0.
  if (entries.length === 0) {
    throw new Error(
      "no crate with a non-electable obligation was found; the SPDX analysis has regressed " +
        "(the dependency graph is expected to contain top-level AND expressions)",
    );
  }

  const content = render(deps, entries);

  if (checkOnly) {
    const raw = await readFile(OUTPUT, "utf-8").catch(() => "");
    // Compare against LF-normalized text. .gitattributes pins this file to LF,
    // but a Windows checkout that predates it (or ignores it) would otherwise
    // report a stale file whose only difference is the line ending.
    const existing = raw.replace(/\r\n/g, "\n");
    if (existing !== content) {
      const where = describeFirstDifference(existing, content);
      console.error(
        `${OUTPUT} is stale (${where}). Run: bun run scripts/generate-third-party-licenses.ts`,
      );
      process.exit(1);
    }
    console.log(
      `${OUTPUT} is up to date (${deps.length} crates, ${entries.length} reproduced notices).`,
    );
    return;
  }

  await writeFile(OUTPUT, content, "utf-8");
  console.log(`Wrote ${OUTPUT} (${deps.length} crates, ${entries.length} reproduced notices).`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      `generate-third-party-licenses: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
