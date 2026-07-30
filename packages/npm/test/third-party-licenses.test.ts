/**
 * Tests for scripts/generate-third-party-licenses.ts — the generator behind the
 * committed THIRD-PARTY-LICENSES.md, and the guards on the committed artifact.
 *
 * The shipped binary statically links its Rust dependencies. Where a crate's
 * SPDX expression is a top-level `AND`, no `OR` election can shed the
 * obligation, so the crate's own license/notice files must be reproduced in
 * full. What these guarantee:
 *   - the SPDX analysis distinguishes an electable `OR` from a binding `AND`,
 *     including the legacy `/` shorthand, parenthesized subexpressions and
 *     `WITH` exceptions — a misparse would silently drop a required notice;
 *   - notice discovery lists a crate's root license files deterministically and
 *     refuses symlinks, so a crafted crate cannot inline a file from elsewhere
 *     on the machine into a published document;
 *   - notice text is normalized (BOM, CRLF, trailing newline) and REJECTED
 *     rather than repaired when oversized, non-UTF-8 or control-carrying —
 *     a truncated or sanitized license is no longer the license;
 *   - the code fence adapts to backtick runs in the content (aws-lc-sys's
 *     LICENSE really does contain a ``` run, which a fixed fence would break);
 *   - the committed THIRD-PARTY-LICENSES.md actually carries the Apache-2.0
 *     text and an appendix section for every top-level-AND row in its table.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSpdx,
  parseSpdx,
  hasNonElectableObligation,
  discoverNoticeFiles,
  normalizeNoticeText,
  renderNoticeAppendix,
  fenceFor,
} from "../../../scripts/generate-third-party-licenses";

// Repo root: packages/npm/test -> ../../..
const REPO_ROOT = join(__dirname, "..", "..", "..");

describe("normalizeSpdx", () => {
  it("rewrites the legacy slash shorthand as an OR choice", () => {
    expect(normalizeSpdx("MIT/Apache-2.0")).toBe("MIT OR Apache-2.0");
  });

  it("collapses redundant whitespace", () => {
    expect(normalizeSpdx("  MIT   OR   Apache-2.0 ")).toBe("MIT OR Apache-2.0");
  });

  it("leaves a modern expression unchanged", () => {
    expect(normalizeSpdx("ISC AND (Apache-2.0 OR ISC)")).toBe("ISC AND (Apache-2.0 OR ISC)");
  });
});

describe("parseSpdx", () => {
  it("parses a bare license as an atom", () => {
    expect(parseSpdx("MIT")).toEqual({ kind: "license", id: "MIT" });
  });

  it("binds AND tighter than OR", () => {
    // `A OR B AND C` must be A OR (B AND C), so the root is a disjunction.
    const node = parseSpdx("MIT OR Apache-2.0 AND ISC");
    expect(node.kind).toBe("or");
  });

  it("treats a WITH exception as a single atom", () => {
    expect(parseSpdx("Apache-2.0 WITH LLVM-exception")).toEqual({
      kind: "license",
      id: "Apache-2.0 WITH LLVM-exception",
    });
  });

  it("respects parentheses over natural precedence", () => {
    const node = parseSpdx("(MIT OR Apache-2.0) AND Unicode-3.0");
    expect(node.kind).toBe("and");
  });

  it("parses nested parentheses", () => {
    const node = parseSpdx("A AND (B OR (C AND D))");
    expect(node).toEqual({
      kind: "and",
      operands: [
        { kind: "license", id: "A" },
        {
          kind: "or",
          operands: [
            { kind: "license", id: "B" },
            {
              kind: "and",
              operands: [
                { kind: "license", id: "C" },
                { kind: "license", id: "D" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("rejects an unbalanced parenthesis", () => {
    expect(() => parseSpdx("(MIT OR Apache-2.0")).toThrowError(/unbalanced/);
  });
});

describe("hasNonElectableObligation", () => {
  it("returns false for a plain OR choice", () => {
    expect(hasNonElectableObligation("MIT OR Apache-2.0")).toBe(false);
  });

  it("returns false for the legacy slash shorthand", () => {
    expect(hasNonElectableObligation("Unlicense/MIT")).toBe(false);
  });

  it("returns false for a single license", () => {
    expect(hasNonElectableObligation("MIT")).toBe(false);
  });

  it("returns true for aws-lc-rs's conjunction", () => {
    expect(hasNonElectableObligation("ISC AND (Apache-2.0 OR ISC)")).toBe(true);
  });

  it("returns true for aws-lc-sys's full expression", () => {
    const expr =
      "ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND " +
      "(Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)";
    expect(hasNonElectableObligation(expr)).toBe(true);
  });

  it("returns true for ring's conjunction", () => {
    expect(hasNonElectableObligation("Apache-2.0 AND ISC")).toBe(true);
  });

  it("returns true for unicode-ident's parenthesized OR conjoined with Unicode-3.0", () => {
    expect(hasNonElectableObligation("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe(true);
  });

  it("returns false when an AND is nested under a top-level OR (the OR is still electable)", () => {
    expect(hasNonElectableObligation("MIT OR (Apache-2.0 AND ISC)")).toBe(false);
  });

  it("handles a WITH exception inside a conjunction", () => {
    expect(hasNonElectableObligation("Apache-2.0 WITH LLVM-exception AND MIT")).toBe(true);
  });
});

describe("discoverNoticeFiles", () => {
  let crateDir: string;

  beforeEach(() => {
    crateDir = mkdtempSync(join(tmpdir(), "vibe-notice-"));
  });

  afterEach(() => {
    rmSync(crateDir, { recursive: true, force: true });
  });

  it("lists matching root files sorted by name", async () => {
    writeFileSync(join(crateDir, "LICENSE-MIT"), "mit");
    writeFileSync(join(crateDir, "LICENSE-APACHE"), "apache");
    writeFileSync(join(crateDir, "NOTICE"), "notice");
    writeFileSync(join(crateDir, "COPYING"), "copying");

    expect(await discoverNoticeFiles(crateDir)).toEqual([
      "COPYING",
      "LICENSE-APACHE",
      "LICENSE-MIT",
      "NOTICE",
    ]);
  });

  it("ignores files that are not license notices", async () => {
    writeFileSync(join(crateDir, "LICENSE"), "terms");
    writeFileSync(join(crateDir, "Cargo.toml"), "[package]");
    writeFileSync(join(crateDir, "README.md"), "# readme");

    expect(await discoverNoticeFiles(crateDir)).toEqual(["LICENSE"]);
  });

  it("excludes a symlink rather than following it out of the crate", async () => {
    // A crate that points LICENSE at a file elsewhere on the machine would
    // otherwise have that file's contents inlined into a published document.
    const outside = mkdtempSync(join(tmpdir(), "vibe-outside-"));
    const secret = join(outside, "secret");
    writeFileSync(secret, "SECRET");
    writeFileSync(join(crateDir, "LICENSE"), "real terms");
    symlinkSync(secret, join(crateDir, "LICENSE-EVIL"));

    expect(await discoverNoticeFiles(crateDir)).toEqual(["LICENSE"]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("excludes a directory that matches the notice name pattern", async () => {
    mkdirSync(join(crateDir, "LICENSES"));
    writeFileSync(join(crateDir, "LICENSE"), "terms");

    expect(await discoverNoticeFiles(crateDir)).toEqual(["LICENSE"]);
  });

  it("returns nothing for a crate that ships no notices", async () => {
    writeFileSync(join(crateDir, "Cargo.toml"), "[package]");
    expect(await discoverNoticeFiles(crateDir)).toEqual([]);
  });
});

describe("normalizeNoticeText", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeNoticeText(Buffer.from("a\r\nb\r\n"), "x/LICENSE")).toBe("a\nb\n");
  });

  it("strips a leading BOM", () => {
    expect(normalizeNoticeText(Buffer.from("\ufeffMIT License\n"), "x/LICENSE")).toBe(
      "MIT License\n",
    );
  });

  it("collapses trailing newlines to exactly one", () => {
    expect(normalizeNoticeText(Buffer.from("terms\n\n\n"), "x/LICENSE")).toBe("terms\n");
  });

  it("appends a trailing newline when the file lacks one", () => {
    expect(normalizeNoticeText(Buffer.from("terms"), "x/LICENSE")).toBe("terms\n");
  });

  it("preserves tabs and interior blank lines", () => {
    expect(normalizeNoticeText(Buffer.from("a\n\n\tb\n"), "x/LICENSE")).toBe("a\n\n\tb\n");
  });

  it("rejects a file over the 1 MiB limit instead of truncating it", () => {
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x41);
    expect(() => normalizeNoticeText(oversized, "big/LICENSE")).toThrowError(/over the/);
  });

  it("accepts a file exactly at the limit", () => {
    const exact = Buffer.alloc(1024 * 1024, 0x41);
    expect(normalizeNoticeText(exact, "big/LICENSE")).toHaveLength(1024 * 1024 + 1);
  });

  it("rejects invalid UTF-8", () => {
    expect(() => normalizeNoticeText(Buffer.from([0xff, 0xfe, 0x00]), "bad/LICENSE")).toThrowError(
      /not valid UTF-8/,
    );
  });

  it("rejects control characters rather than sanitizing them", () => {
    expect(() => normalizeNoticeText(Buffer.from("a\u0007b"), "bad/LICENSE")).toThrowError(
      /control characters/,
    );
  });

  it("rejects an ANSI escape sequence", () => {
    expect(() => normalizeNoticeText(Buffer.from("\u001b[31mred"), "bad/LICENSE")).toThrowError(
      /control characters/,
    );
  });

  it("names the crate and file but never echoes the content", () => {
    const attempt = () => normalizeNoticeText(Buffer.from("secret\u0007payload"), "evil/LICENSE");
    expect(attempt).toThrowError(/evil\/LICENSE/);
    expect(attempt).not.toThrowError(/secret/);
  });
});

describe("fenceFor", () => {
  it("uses three backticks for content with none", () => {
    expect(fenceFor("plain text\n")).toBe("```");
  });

  it("outgrows the longest backtick run in the content", () => {
    expect(fenceFor("see ``` fenced\n")).toBe("````");
    expect(fenceFor("see ````` fenced\n")).toBe("``````");
  });

  it("counts a run that appears mid-line, not only at line start", () => {
    expect(fenceFor("prefix ```` suffix\n")).toBe("`````");
  });
});

describe("renderNoticeAppendix", () => {
  it("renders a heading per crate and per file", () => {
    const out = renderNoticeAppendix([
      {
        name: "demo",
        version: "1.0.0",
        license: "Apache-2.0 AND ISC",
        files: [
          { name: "LICENSE", text: "terms\n" },
          { name: "NOTICE", text: "notice\n" },
        ],
      },
    ]);

    expect(out).toContain("## Appendix: License texts and notices for non-electable obligations");
    expect(out).toContain("### demo 1.0.0 — Apache-2.0 AND ISC");
    expect(out).toContain("#### LICENSE");
    expect(out).toContain("#### NOTICE");
  });

  it("widens the fence when a notice itself contains a triple backtick", () => {
    // aws-lc-sys's real LICENSE contains a ``` run; a fixed three-backtick
    // fence would end the block early and corrupt the reproduced text.
    const out = renderNoticeAppendix([
      {
        name: "fencey",
        version: "0.1.0",
        license: "Apache-2.0 AND ISC",
        files: [{ name: "LICENSE", text: "before\n```\ninside\n```\nafter\n" }],
      },
    ]);

    expect(out).toContain("````\nbefore\n```\ninside\n```\nafter\n````");
  });

  it("keeps the crate order it is given", () => {
    const out = renderNoticeAppendix([
      { name: "alpha", version: "1.0.0", license: "A AND B", files: [{ name: "L", text: "a\n" }] },
      { name: "beta", version: "2.0.0", license: "A AND B", files: [{ name: "L", text: "b\n" }] },
    ]);
    expect(out.indexOf("### alpha")).toBeLessThan(out.indexOf("### beta"));
  });
});

describe("committed THIRD-PARTY-LICENSES.md", () => {
  const doc = readFileSync(join(REPO_ROOT, "THIRD-PARTY-LICENSES.md"), "utf-8");

  it("reproduces the Apache-2.0 body in full", () => {
    // Both ends of the license, so a truncated reproduction fails too.
    expect(doc).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(doc).toContain("END OF TERMS AND CONDITIONS");
  });

  it("carries the appendix section", () => {
    expect(doc).toContain("## Appendix: License texts and notices for non-electable obligations");
  });

  it("has an appendix heading for every top-level-AND row in the crate table", () => {
    // Drives off the committed table rather than a hardcoded crate list, so a
    // newly added AND-licensed dependency without a reproduced notice fails.
    const rows = [...doc.matchAll(/^\| (\S+) \| (\S+) \| (.+?) \|$/gm)]
      .filter(([, name]) => name !== "Crate" && !name.startsWith("-"))
      .map(([, name, version, license]) => ({ name, version, license }));
    expect(rows.length).toBeGreaterThan(0);

    const obligated = rows.filter((r) => hasNonElectableObligation(r.license));
    expect(obligated.length).toBeGreaterThan(0);

    const missing = obligated
      .filter((r) => !doc.includes(`### ${r.name} ${r.version} — ${r.license}`))
      .map((r) => `${r.name} ${r.version}`);
    expect(missing).toEqual([]);
  });
});
