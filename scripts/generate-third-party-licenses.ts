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
 * (Apache-2.0's §4 notice requirement, most notably). For those Appendix A
 * reproduces the crate's own LICENSE/NOTICE files verbatim.
 *
 * Electing an arm of an `OR` does not make the appendix unnecessary: the
 * elected license is itself almost always MIT or another attribution license,
 * whose grant is conditioned on reproducing the copyright notice and permission
 * text in distributions. Appendix B therefore reproduces the text of the
 * *elected* license for every such crate. Only arms that impose no notice
 * obligation at all (Unlicense, CC0-1.0, MIT-0, 0BSD) let a crate out entirely.
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
  /** Used only to build a copyright line when a crate ships no license file. */
  authors: string[];
}

interface CargoMetadata {
  packages: CargoPackage[];
}

/** A crate's reproduced notice file: its basename and normalized UTF-8 text. */
export interface NoticeFile {
  name: string;
  text: string;
}

/** One Appendix A entry: a crate with a non-electable obligation, plus its notices. */
export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  files: NoticeFile[];
}

/** One Appendix B entry: a crate whose elected license still requires attribution. */
export interface ElectedEntry {
  name: string;
  version: string;
  /** The crate's full SPDX expression, as declared. */
  license: string;
  /** The single license ID elected out of that expression. */
  elected: string;
  files: NoticeFile[];
  /** True when `files` was synthesized from a template, not shipped by the crate. */
  synthesized: boolean;
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

// --- Election --------------------------------------------------------------

/**
 * Licenses that grant permission unconditionally: no copyright notice, no
 * permission text, nothing to carry downstream. Electing one of these ends the
 * crate's obligations, so it needs no appendix entry at all.
 */
const NO_ATTRIBUTION_LICENSES = new Set(["Unlicense", "CC0-1.0", "MIT-0", "0BSD"]);

/**
 * Preference order among attribution licenses, most to least convenient.
 *
 * Why not elect the first arm as written: crates order their `OR` arms
 * arbitrarily (`MIT OR Apache-2.0` and `Apache-2.0 OR MIT` are both common for
 * the identical pair of files), and Apache-2.0 drags in §4(d) NOTICE handling
 * and a 200-line body. A fixed preference makes the election deterministic and
 * keeps the reproduced text short wherever the crate offers the choice.
 */
const ELECTION_PREFERENCE = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Zlib",
  "Unicode-3.0",
  "CDLA-Permissive-2.0",
  "Apache-2.0",
];

/** `Apache-2.0 WITH LLVM-exception` obligates exactly as `Apache-2.0` does. */
function baseLicenseId(id: string): string {
  return id.split(" WITH ")[0].trim();
}

/**
 * Elect one license out of a crate's SPDX expression.
 *
 * Returns `null` in two cases the caller treats identically — nothing to
 * reproduce: a top-level `AND` (handled by Appendix A instead), or an arm that
 * imposes no attribution obligation.
 *
 * Why throw on an unrecognized or compound arm rather than skipping the crate:
 * a silent skip is indistinguishable from "this crate has no obligations", and
 * the failure mode is shipping a binary that omits a required notice. Every
 * expression in today's graph resolves, so a throw means the graph gained
 * something new that a human must classify.
 */
export function electLicense(expr: string): string | null {
  const node = parseSpdx(expr);
  const isNonElectable = node.kind === "and";
  if (isNonElectable) {
    return null;
  }

  const arms = node.kind === "or" ? node.operands : [node];
  const ids: string[] = [];
  for (const arm of arms) {
    const isCompoundArm = arm.kind !== "license";
    if (isCompoundArm) {
      throw new Error(
        `cannot elect from SPDX expression '${expr}': an OR arm is itself a conjunction, ` +
          `which requires deciding whether the compound arm is cheaper than its siblings`,
      );
    }
    ids.push(baseLicenseId(arm.id));
  }

  const hasFreeArm = ids.some((id) => NO_ATTRIBUTION_LICENSES.has(id));
  if (hasFreeArm) {
    return null;
  }

  const elected = ELECTION_PREFERENCE.find((candidate) => ids.includes(candidate));
  if (elected === undefined) {
    throw new Error(
      `cannot elect from SPDX expression '${expr}': none of [${ids.join(", ")}] is a known ` +
        `attribution license; add it to ELECTION_PREFERENCE (with its obligations reviewed)`,
    );
  }
  return elected;
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

/** `LICENSE` / `LICENCE` / `COPYING` with no license-naming suffix. */
const UNQUALIFIED_NOTICE_PATTERN = /^(LICENSE|LICENCE|COPYING)(\.(txt|md))?$/i;

/**
 * Rank a crate's notice files against an elected license ID.
 *
 * The suffix match is deliberately loose (`LICENSE-MIT`, `license-mit`,
 * `LICENSE_MIT`, `LICENSE-Apache-2.0_WITH_LLVM-exception`, `license-apache-2.0`
 * all appear in the current graph). Why not require an exact `LICENSE-<ID>`
 * form: crates spell the suffix in at least five ways, and a stricter matcher
 * would silently fall through to the unqualified branch — reproducing, say, a
 * dual-license COPYING where the crate shipped the exact MIT text next to it.
 */
export function selectNoticeFiles(names: string[], elected: string): string[] {
  const wanted = elected.toLowerCase().replace(/[^a-z0-9]/g, "");
  // The shorthand spelling drops the version too (`LICENSE-APACHE` for
  // Apache-2.0), so a prefix test has to run in both directions; requiring the
  // file to spell the ID out in full would miss the single most common name in
  // the graph.
  const matchesElected = (name: string): boolean => {
    if (wanted.length === 0) {
      return false;
    }
    const suffix = name
      .toLowerCase()
      .replace(/^(license|licence|copying)[-._]?/, "")
      .replace(/[^a-z0-9]/g, "");
    if (suffix.length === 0) {
      return false;
    }
    return suffix.startsWith(wanted) || wanted.startsWith(suffix);
  };

  const qualified = names.filter((name) => matchesElected(name));
  if (qualified.length > 0) {
    // Apache-2.0 §4(d) makes a shipped NOTICE part of the license's own terms,
    // so it travels with the elected text rather than being an optional extra.
    const isApache = elected === "Apache-2.0";
    const notices = isApache ? names.filter((name) => /^NOTICE([-._].*)?$/i.test(name)) : [];
    return [...qualified, ...notices];
  }

  return names.filter((name) => UNQUALIFIED_NOTICE_PATTERN.test(name));
}

/**
 * Canonical bodies for licenses we may have to reproduce without a file from
 * the crate. `%COPYRIGHT%` is substituted with the crate's copyright line.
 *
 * Why not a generic "see the SPDX registry" pointer: MIT conditions the grant
 * on the permission notice being *included* in the distribution, so a reference
 * does not discharge it. Only licenses actually reached by the fallback are
 * implemented; anything else throws rather than shipping an approximation.
 */
const LICENSE_TEMPLATES: Record<string, string> = {
  MIT: `MIT License

%COPYRIGHT%

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

/**
 * Build the copyright line for a synthesized notice from `cargo metadata`'s
 * `authors`. Falls back to the collective form when the manifest declares none,
 * which is both true and the convention crates use when authorship is a group.
 */
export function copyrightLine(crate: string, authors: string[]): string {
  const named = authors.map((author) => author.trim()).filter((author) => author.length > 0);
  if (named.length === 0) {
    return `Copyright (c) The ${crate} Authors`;
  }
  return `Copyright (c) ${named.join(", ")}`;
}

/**
 * Reproduce the canonical text of `elected` for a crate that ships no license
 * file, attributed from its manifest.
 */
export function synthesizeNoticeFile(
  crate: string,
  authors: string[],
  elected: string,
): NoticeFile {
  const template = LICENSE_TEMPLATES[elected];
  if (template === undefined) {
    throw new Error(
      `${crate} elects ${elected} but ships no license file, and no canonical ${elected} ` +
        `text is available; add it to LICENSE_TEMPLATES`,
    );
  }
  return {
    name: `${elected} (reconstructed)`,
    text: template.replace("%COPYRIGHT%", copyrightLine(crate, authors)),
  };
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

function pushNoticeBlocks(lines: string[], files: NoticeFile[]): void {
  for (const file of files) {
    const fence = fenceFor(file.text);
    lines.push(`#### ${file.name}`);
    lines.push("");
    lines.push(fence);
    lines.push(file.text.replace(/\n$/, ""));
    lines.push(fence);
    lines.push("");
  }
}

/** Render Appendix A: crates whose obligations survive any `OR` election. */
export function renderNoticeAppendix(entries: NoticeEntry[]): string {
  const lines: string[] = [];
  lines.push("## Appendix A: License texts and notices for non-electable obligations");
  lines.push("");
  lines.push("The crates in this appendix have an SPDX expression whose top-level operator");
  lines.push("is `AND`, so every conjunct binds and no election can shed any of them. Their");
  lines.push("obligations travel with the shipped binary in full, and every license and");
  lines.push("notice file each crate distributes is reproduced below verbatim, exactly as");
  lines.push("published on crates.io.");
  lines.push("");
  lines.push("Like the table above, this appendix is drawn from the conservative full");
  lines.push("dependency graph, so it may reproduce notices for crates that are not linked");
  lines.push("into any shipped binary. Reproducing a notice is not a representation that the");
  lines.push("crate is present in a given build.");
  lines.push("");

  for (const entry of entries) {
    lines.push(`### ${entry.name} ${entry.version} — ${entry.license}`);
    lines.push("");
    pushNoticeBlocks(lines, entry.files);
  }

  return lines.join("\n");
}

/** Render Appendix B: the elected license text for every attribution-bearing crate. */
export function renderElectedAppendix(entries: ElectedEntry[]): string {
  const lines: string[] = [];
  lines.push("## Appendix B: Notices for elected licenses");
  lines.push("");
  lines.push("Electing the permissive arm of an `OR` narrows a crate's terms to one license;");
  lines.push("it does not end its obligations. MIT, ISC, the BSD licenses, Zlib and");
  lines.push("Apache-2.0 all condition their grant on the copyright notice and permission");
  lines.push("text being reproduced in distributions of the software, and vibe ships those");
  lines.push("crates statically linked into its binary. This appendix therefore reproduces,");
  lines.push("for each such crate, the text of the license vibe elected out of its SPDX");
  lines.push("expression.");
  lines.push("");
  lines.push("Crates offering an arm that imposes no attribution obligation at all");
  lines.push("(`Unlicense`, `CC0-1.0`, `MIT-0`, `0BSD`) elect that arm and are omitted here.");
  lines.push("Crates with a top-level `AND` are covered by Appendix A instead.");
  lines.push("");
  lines.push("Where a crate publishes no license file of its own, the canonical text of the");
  lines.push("license it declares in `Cargo.toml` is reproduced instead, with the copyright");
  lines.push("line taken from that manifest's `authors`. Such sections are marked");
  lines.push("`(reconstructed)`.");
  lines.push("");

  for (const entry of entries) {
    lines.push(
      `### ${entry.name} ${entry.version} — elected ${entry.elected} (from ${entry.license})`,
    );
    lines.push("");
    if (entry.synthesized) {
      lines.push(
        `This crate ships no license file; the canonical ${entry.elected} text is reproduced`,
      );
      lines.push("below from its `Cargo.toml` declaration.");
      lines.push("");
    }
    pushNoticeBlocks(lines, entry.files);
  }

  return lines.join("\n");
}

/** Render the whole document: preamble, crate table, and both appendices. */
export function render(
  deps: CargoPackage[],
  entries: NoticeEntry[],
  elected: ElectedEntry[],
): string {
  const lines: string[] = [];
  lines.push("# Third-Party Licenses");
  lines.push("");
  lines.push("The `vibe` binary is written in Rust and statically links the crates listed");
  lines.push("below. Each is distributed under a permissive license (MIT, Apache-2.0, ISC,");
  lines.push("BSD-3-Clause, Zlib, Unlicense, CC0-1.0, Unicode-3.0, CDLA-Permissive-2.0, or a");
  lines.push("dual/multi-license `OR` of these). Where a crate is multi-licensed with `OR`,");
  lines.push("vibe's distribution elects one arm.");
  lines.push("");
  lines.push("Electing an arm narrows the terms but rarely ends them: MIT, ISC, the BSD");
  lines.push("licenses, Zlib and Apache-2.0 each require their copyright notice and");
  lines.push("permission text to be reproduced in distributions. This file therefore carries");
  lines.push("two appendices:");
  lines.push("");
  lines.push("- **Appendix A** — crates whose SPDX expression is a top-level `AND`");
  lines.push("  conjunction, where no election can shed any conjunct. Every license and");
  lines.push("  notice file those crates ship is reproduced in full.");
  lines.push("- **Appendix B** — crates where an arm was elected and that elected license");
  lines.push("  still requires attribution. The text of the elected license is reproduced");
  lines.push("  for each. Crates offering an obligation-free arm (`Unlicense`, `CC0-1.0`,");
  lines.push("  `MIT-0`, `0BSD`) elect that arm and appear in neither appendix.");
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
  lines.push(renderElectedAppendix(elected));
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
 * Collect Appendix B entries: one per dependency whose elected license still
 * carries an attribution obligation, in the same name→version order as the
 * table so the rendered document is byte-stable across runs and platforms.
 */
async function collectElectedEntries(deps: CargoPackage[]): Promise<ElectedEntry[]> {
  const entries: ElectedEntry[] = [];
  for (const dep of deps) {
    const label = `${dep.name} ${dep.version}`;
    const crateDir = dirname(dep.manifest_path);

    // A crate declaring only `license_file` points at terms with no SPDX name,
    // so there is nothing to elect — the referenced file is the whole grant.
    const hasOnlyLicenseFile = dep.license === null && dep.license_file !== null;
    if (hasOnlyLicenseFile) {
      const name = dep.license_file as string;
      const files = [await readNoticeFile(crateDir, name, label)];
      entries.push({
        name: dep.name,
        version: dep.version,
        license: `see ${name}`,
        elected: `see ${name}`,
        files,
        synthesized: false,
      });
      continue;
    }

    if (dep.license === null) {
      throw new Error(`${label} declares neither 'license' nor 'license_file'`);
    }

    const elected = electLicense(dep.license);
    if (elected === null) {
      continue;
    }

    const names = await discoverNoticeFiles(crateDir);
    const selected = selectNoticeFiles(names, elected);
    if (selected.length === 0) {
      entries.push({
        name: dep.name,
        version: dep.version,
        license: dep.license,
        elected,
        files: [synthesizeNoticeFile(dep.name, dep.authors, elected)],
        synthesized: true,
      });
      continue;
    }

    const files: NoticeFile[] = [];
    for (const name of selected) {
      files.push(await readNoticeFile(crateDir, name, label));
    }
    entries.push({
      name: dep.name,
      version: dep.version,
      license: dep.license,
      elected,
      files,
      synthesized: false,
    });
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
  const elected = await collectElectedEntries(deps);

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

  // The same reasoning for Appendix B, which is the far larger of the two: the
  // graph is overwhelmingly `MIT OR Apache-2.0`, so an empty election means the
  // elect path stopped firing rather than that the obligations went away.
  if (elected.length === 0) {
    throw new Error(
      "no crate with an elected attribution license was found; the election analysis has " +
        "regressed (the dependency graph is expected to be dominated by MIT/Apache-2.0 crates)",
    );
  }

  const content = render(deps, entries, elected);

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
      `${OUTPUT} is up to date (${deps.length} crates, ${entries.length} non-electable, ` +
        `${elected.length} elected).`,
    );
    return;
  }

  await writeFile(OUTPUT, content, "utf-8");
  console.log(
    `Wrote ${OUTPUT} (${deps.length} crates, ${entries.length} non-electable, ` +
      `${elected.length} elected).`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      `generate-third-party-licenses: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
