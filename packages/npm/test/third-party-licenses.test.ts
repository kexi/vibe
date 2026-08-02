/**
 * Tests for scripts/generate-third-party-licenses.ts — the generator behind the
 * committed THIRD-PARTY-LICENSES.md, and the guards on the committed artifact.
 *
 * The shipped binary statically links its Rust dependencies. Where a crate's
 * SPDX expression is a top-level `AND`, no `OR` election can shed the
 * obligation, so the crate's own license/notice files must be reproduced in
 * full (Appendix A). Where an arm is elected, the elected license itself
 * usually still requires its notice to travel with the distribution, so its
 * text is reproduced too (Appendix B). What these guarantee:
 *   - the SPDX analysis distinguishes an electable `OR` from a binding `AND`,
 *     including the legacy `/` shorthand, parenthesized subexpressions and
 *     `WITH` exceptions — a misparse would silently drop a required notice;
 *   - election picks a deterministic arm, exempts only the genuinely
 *     obligation-free licenses, and FAILS LOUDLY on anything unclassified
 *     rather than quietly omitting a crate's notice;
 *   - the file chosen for an elected license matches that license, across the
 *     several suffix spellings crates actually use, WITHOUT confusing licenses
 *     that share a prefix (MIT vs MIT-0 are different grants);
 *   - a crate shipping no license file gets the canonical text reconstructed
 *     from its manifest instead of being dropped;
 *   - notice discovery lists a crate's root license files deterministically and
 *     refuses symlinks, so a crafted crate cannot inline a file from elsewhere
 *     on the machine into a published document;
 *   - a manifest's `license_file` pointer — fully attacker-chosen text — is
 *     confined to the crate directory and REJECTS rather than skips, so neither
 *     a `../` escape nor a symlink can pull an unrelated file into the document;
 *   - notice text is normalized (BOM, CRLF, trailing newline) and REJECTED
 *     rather than repaired when oversized, non-UTF-8 or control-carrying —
 *     a truncated or sanitized license is no longer the license;
 *   - the code fence adapts to backtick runs in the content (aws-lc-sys's
 *     LICENSE really does contain a ``` run, which a fixed fence would break);
 *   - the committed THIRD-PARTY-LICENSES.md actually carries the Apache-2.0
 *     text, an Appendix A section for every top-level-AND row in its table, and
 *     an Appendix B section for every row whose elected license obligates.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  normalizeSpdx,
  parseSpdx,
  hasNonElectableObligation,
  electLicense,
  selectNoticeFiles,
  copyrightLine,
  synthesizeNoticeFile,
  discoverNoticeFiles,
  resolveLicenseFile,
  normalizeNoticeText,
  renderNoticeAppendix,
  renderElectedAppendix,
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

describe("electLicense", () => {
  it("elects the only license of a single-atom expression", () => {
    expect(electLicense("MIT")).toBe("MIT");
    expect(electLicense("Apache-2.0")).toBe("Apache-2.0");
    expect(electLicense("Zlib")).toBe("Zlib");
    expect(electLicense("BSD-3-Clause")).toBe("BSD-3-Clause");
    expect(electLicense("CDLA-Permissive-2.0")).toBe("CDLA-Permissive-2.0");
  });

  it("prefers MIT over Apache-2.0 regardless of the order the crate wrote them", () => {
    // The two orderings are both common for the identical pair of files, so the
    // election must not depend on which the crate happened to declare first.
    expect(electLicense("MIT OR Apache-2.0")).toBe("MIT");
    expect(electLicense("Apache-2.0 OR MIT")).toBe("MIT");
  });

  it("elects MIT through the legacy slash shorthand", () => {
    expect(electLicense("MIT/Apache-2.0")).toBe("MIT");
  });

  it("returns null when an arm imposes no attribution obligation", () => {
    expect(electLicense("Unlicense OR MIT")).toBeNull();
    expect(electLicense("Unlicense/MIT")).toBeNull();
    expect(electLicense("CC0-1.0 OR MIT-0 OR Apache-2.0")).toBeNull();
    expect(electLicense("0BSD OR MIT")).toBeNull();
  });

  it("returns null for a top-level AND, which Appendix A covers instead", () => {
    expect(electLicense("Apache-2.0 AND ISC")).toBeNull();
    expect(electLicense("(MIT OR Apache-2.0) AND Unicode-3.0")).toBeNull();
  });

  it("judges a WITH-exception arm by its base license", () => {
    expect(electLicense("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT")).toBe("MIT");
    expect(electLicense("Apache-2.0 WITH LLVM-exception")).toBe("Apache-2.0");
  });

  it("skips a copyleft arm in favour of the permissive one", () => {
    expect(electLicense("MIT OR Apache-2.0 OR LGPL-2.1-or-later")).toBe("MIT");
  });

  it("throws on a compound OR arm rather than guessing which is cheaper", () => {
    expect(() => electLicense("MIT OR (Apache-2.0 AND ISC)")).toThrowError(/is itself a conjunction/);
  });

  it("throws when no arm is a known attribution license", () => {
    // Failing loudly is the point: a silent skip is indistinguishable from
    // "this crate has no obligations", and ships a binary missing a notice.
    expect(() => electLicense("GPL-3.0-only")).toThrowError(/none of \[GPL-3.0-only\]/);
  });
});

describe("selectNoticeFiles", () => {
  it("picks the file matching the elected license over its sibling", () => {
    expect(selectNoticeFiles(["LICENSE-APACHE", "LICENSE-MIT"], "MIT")).toEqual(["LICENSE-MIT"]);
    expect(selectNoticeFiles(["LICENSE-APACHE", "LICENSE-MIT"], "Apache-2.0")).toEqual([
      "LICENSE-APACHE",
    ]);
  });

  it("matches the suffix spellings crates actually ship", () => {
    expect(selectNoticeFiles(["license-apache-2.0", "license-mit"], "MIT")).toEqual(["license-mit"]);
    expect(selectNoticeFiles(["LICENSE_MIT"], "MIT")).toEqual(["LICENSE_MIT"]);
    expect(selectNoticeFiles(["LICENSE.MIT"], "MIT")).toEqual(["LICENSE.MIT"]);
    expect(selectNoticeFiles(["LICENSE-MIT.txt"], "MIT")).toEqual(["LICENSE-MIT.txt"]);
  });

  it("matches a hyphenated license id spelled out in full", () => {
    expect(selectNoticeFiles(["LICENSE-BSD-3-Clause", "LICENSE-MIT"], "BSD-3-Clause")).toEqual([
      "LICENSE-BSD-3-Clause",
    ]);
    expect(selectNoticeFiles(["LICENSE-Apache-2.0"], "Apache-2.0")).toEqual(["LICENSE-Apache-2.0"]);
  });

  it("accepts the version-eliding shorthand crates use", () => {
    // `LICENSE-APACHE` for Apache-2.0 is the single most common notice filename
    // in the graph, so requiring the ID in full would miss almost everything.
    expect(selectNoticeFiles(["LICENSE-APACHE"], "Apache-2.0")).toEqual(["LICENSE-APACHE"]);
    expect(selectNoticeFiles(["LICENSE-BSD"], "BSD-3-Clause")).toEqual(["LICENSE-BSD"]);
  });

  it("does not confuse licenses that merely share a token prefix", () => {
    // MIT-0 is a different grant from MIT — it drops the attribution clause
    // entirely — so reproducing one in place of the other misstates the terms.
    // A concatenated prefix test ("mit0".startsWith("mit")) got this wrong.
    expect(selectNoticeFiles(["LICENSE-MIT-0"], "MIT")).toEqual([]);
    expect(selectNoticeFiles(["LICENSE-MIT-0"], "MIT-0")).toEqual(["LICENSE-MIT-0"]);
    expect(selectNoticeFiles(["LICENSE-MIT"], "MIT")).toEqual(["LICENSE-MIT"]);
  });

  it("declines to read a plain LICENSE-MIT as an abbreviation of MIT-0", () => {
    // The shortened form names a license we know, so it is far likelier to be
    // that license's text than an abbreviation of the longer id.
    expect(selectNoticeFiles(["LICENSE-MIT"], "MIT-0")).toEqual([]);
  });

  it("picks the exact file over a WITH-exception variant of the same license", () => {
    // The exception variant is a different document; only the plain Apache-2.0
    // spelling (or its APACHE shorthand) is the elected license's own text.
    expect(
      selectNoticeFiles(["LICENSE-APACHE", "LICENSE-Apache-2.0_WITH_LLVM-exception"], "Apache-2.0"),
    ).toEqual(["LICENSE-APACHE"]);
  });

  it("falls back to the unqualified file when nothing names the license", () => {
    expect(selectNoticeFiles(["LICENSE"], "ISC")).toEqual(["LICENSE"]);
    expect(selectNoticeFiles(["LICENSE.txt"], "ISC")).toEqual(["LICENSE.txt"]);
    expect(selectNoticeFiles(["COPYING"], "Zlib")).toEqual(["COPYING"]);
  });

  it("does not treat a dual-license COPYING as the elected text when a match exists", () => {
    expect(selectNoticeFiles(["COPYING", "LICENSE-MIT"], "MIT")).toEqual(["LICENSE-MIT"]);
  });

  it("carries a NOTICE alongside an elected Apache-2.0 (its §4(d) obligation)", () => {
    expect(selectNoticeFiles(["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"], "Apache-2.0")).toEqual([
      "LICENSE-APACHE",
      "NOTICE",
    ]);
  });

  it("leaves a NOTICE out when the elected license does not require it", () => {
    expect(selectNoticeFiles(["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"], "MIT")).toEqual([
      "LICENSE-MIT",
    ]);
  });

  it("returns nothing when the crate ships no notice file at all", () => {
    expect(selectNoticeFiles([], "MIT")).toEqual([]);
  });
});

describe("copyrightLine", () => {
  it("uses the manifest authors when present", () => {
    expect(copyrightLine("objc2", ["Mads Marquart <mads@marquart.dk>"])).toBe(
      "Copyright (c) Mads Marquart <mads@marquart.dk>",
    );
  });

  it("joins multiple authors", () => {
    expect(copyrightLine("demo", ["A <a@x>", "B <b@x>"])).toBe("Copyright (c) A <a@x>, B <b@x>");
  });

  it("falls back to the collective form when the manifest names nobody", () => {
    expect(copyrightLine("wasmparser", [])).toBe("Copyright (c) The wasmparser Authors");
    expect(copyrightLine("wasmparser", ["  "])).toBe("Copyright (c) The wasmparser Authors");
  });
});

describe("synthesizeNoticeFile", () => {
  it("reconstructs the MIT body with the crate's copyright line", () => {
    const file = synthesizeNoticeFile("objc2", ["Mads Marquart <mads@marquart.dk>"], "MIT");
    expect(file.name).toBe("MIT (reconstructed)");
    expect(file.text).toContain("Copyright (c) Mads Marquart <mads@marquart.dk>");
    expect(file.text).toContain("Permission is hereby granted, free of charge");
    expect(file.text).toContain("shall be included in all");
  });

  it("throws rather than approximating a license it has no canonical text for", () => {
    expect(() => synthesizeNoticeFile("demo", [], "Zlib")).toThrowError(/LICENSE_TEMPLATES/);
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

describe("resolveLicenseFile", () => {
  // Unlike discoverNoticeFiles, this path follows a pointer written in a
  // third-party Cargo.toml, so the value is fully attacker-chosen. It must be
  // confined to the crate directory and must THROW on rejection: skipping would
  // drop the crate's only statement of terms from the generated document.
  let crateDir: string;
  let outside: string;

  beforeEach(() => {
    crateDir = mkdtempSync(join(tmpdir(), "vibe-lf-"));
    outside = mkdtempSync(join(tmpdir(), "vibe-lf-outside-"));
  });

  afterEach(() => {
    rmSync(crateDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a plain file at the crate root", async () => {
    writeFileSync(join(crateDir, "LICENSE-CUSTOM"), "terms");
    expect(await resolveLicenseFile(crateDir, "LICENSE-CUSTOM", "demo 1.0.0")).toBe(
      "LICENSE-CUSTOM",
    );
  });

  it("accepts a file in a subdirectory of the crate", async () => {
    // A license_file may legitimately point below the root, which containment
    // must permit — only escaping the crate is forbidden.
    mkdirSync(join(crateDir, "licenses"));
    writeFileSync(join(crateDir, "licenses", "TERMS"), "terms");
    expect(await resolveLicenseFile(crateDir, "licenses/TERMS", "demo 1.0.0")).toBe(
      "licenses/TERMS",
    );
  });

  it("rejects a relative path that climbs out of the crate", async () => {
    // The attack in the review: `../../..` reaching a checkout's credentials,
    // whose contents would then be inlined into a committed, published file.
    writeFileSync(join(outside, "secret"), "SECRET");
    const escape = join("..", basename(outside), "secret");
    await expect(resolveLicenseFile(crateDir, escape, "demo 1.0.0")).rejects.toThrow(
      /resolves outside the crate directory/,
    );
  });

  it("rejects an absolute path outside the crate", async () => {
    const secret = join(outside, "secret");
    writeFileSync(secret, "SECRET");
    await expect(resolveLicenseFile(crateDir, secret, "demo 1.0.0")).rejects.toThrow(
      /resolves outside the crate directory/,
    );
  });

  it("rejects a symlink even when it points inside the crate", async () => {
    // Symlinks are refused outright rather than resolved, matching
    // discoverNoticeFiles: whether the target is safe is not the question, the
    // indirection itself is what is declined.
    writeFileSync(join(crateDir, "real"), "terms");
    symlinkSync(join(crateDir, "real"), join(crateDir, "LICENSE-LINK"));
    await expect(resolveLicenseFile(crateDir, "LICENSE-LINK", "demo 1.0.0")).rejects.toThrow(
      /is a symlink/,
    );
  });

  it("rejects a symlink that escapes the crate", async () => {
    const secret = join(outside, "secret");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(crateDir, "LICENSE-EVIL"));
    await expect(resolveLicenseFile(crateDir, "LICENSE-EVIL", "demo 1.0.0")).rejects.toThrow(
      /is a symlink/,
    );
  });

  it("rejects a directory", async () => {
    mkdirSync(join(crateDir, "LICENSE-DIR"));
    await expect(resolveLicenseFile(crateDir, "LICENSE-DIR", "demo 1.0.0")).rejects.toThrow(
      /is not a regular file/,
    );
  });

  it("rejects a pointer to a file that does not exist", async () => {
    await expect(resolveLicenseFile(crateDir, "MISSING", "demo 1.0.0")).rejects.toThrow(
      /does not exist/,
    );
  });

  it("rejects the crate directory itself", async () => {
    await expect(resolveLicenseFile(crateDir, ".", "demo 1.0.0")).rejects.toThrow(
      /is not a regular file/,
    );
  });

  it("names the crate and the declared path but never the resolved target", async () => {
    // Echoing the resolved path would push an attacker-chosen filesystem
    // location into CI logs.
    writeFileSync(join(outside, "secret"), "SECRET");
    const secret = join(outside, "secret");
    await expect(resolveLicenseFile(crateDir, secret, "evil 6.6.6")).rejects.toThrow(/evil 6.6.6/);
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

    expect(out).toContain("## Appendix A: License texts and notices for non-electable obligations");
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

describe("renderElectedAppendix", () => {
  it("names both the elected license and the expression it came from", () => {
    const out = renderElectedAppendix([
      {
        name: "demo",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        elected: "MIT",
        files: [{ name: "LICENSE-MIT", text: "terms\n" }],
        synthesized: false,
      },
    ]);

    expect(out).toContain("## Appendix B: Notices for elected licenses");
    expect(out).toContain("### demo 1.0.0 — elected MIT (from MIT OR Apache-2.0)");
    expect(out).toContain("#### LICENSE-MIT");
    expect(out).not.toContain("ships no license file");
  });

  it("flags a reconstructed text so a reader knows the crate did not ship it", () => {
    const out = renderElectedAppendix([
      {
        name: "demo",
        version: "1.0.0",
        license: "MIT",
        elected: "MIT",
        files: [{ name: "MIT (reconstructed)", text: "terms\n" }],
        synthesized: true,
      },
    ]);

    expect(out).toContain("This crate ships no license file");
    expect(out).toContain("#### MIT (reconstructed)");
  });
});

describe("committed THIRD-PARTY-LICENSES.md", () => {
  const doc = readFileSync(join(REPO_ROOT, "THIRD-PARTY-LICENSES.md"), "utf-8");
  const rows = [...doc.matchAll(/^\| (\S+) \| (\S+) \| (.+?) \|$/gm)]
    .filter(([, name]) => name !== "Crate" && !name.startsWith("-"))
    .map(([, name, version, license]) => ({ name, version, license }));

  it("reproduces the Apache-2.0 body in full", () => {
    // Both ends of the license, so a truncated reproduction fails too.
    expect(doc).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(doc).toContain("END OF TERMS AND CONDITIONS");
  });

  it("carries both appendix sections", () => {
    expect(doc).toContain("## Appendix A: License texts and notices for non-electable obligations");
    expect(doc).toContain("## Appendix B: Notices for elected licenses");
  });

  it("has an Appendix A heading for every top-level-AND row in the crate table", () => {
    // Drives off the committed table rather than a hardcoded crate list, so a
    // newly added AND-licensed dependency without a reproduced notice fails.
    expect(rows.length).toBeGreaterThan(0);

    const obligated = rows.filter((r) => hasNonElectableObligation(r.license));
    expect(obligated.length).toBeGreaterThan(0);

    const missing = obligated
      .filter((r) => !doc.includes(`### ${r.name} ${r.version} — ${r.license}`))
      .map((r) => `${r.name} ${r.version}`);
    expect(missing).toEqual([]);
  });

  it("has an Appendix B heading for every row whose elected license obligates", () => {
    // The strong invariant: every crate the election leaves with an attribution
    // duty must have its elected text reproduced. A crate silently dropped from
    // Appendix B is exactly the compliance gap this file exists to close.
    const electable = rows
      .map((r) => ({ ...r, elected: electLicense(r.license) }))
      .filter((r) => r.elected !== null);
    expect(electable.length).toBeGreaterThan(100);

    const missing = electable
      .filter((r) => !doc.includes(`### ${r.name} ${r.version} — elected ${r.elected} (from `))
      .map((r) => `${r.name} ${r.version}`);
    expect(missing).toEqual([]);
  });

  it("omits crates whose election sheds every obligation", () => {
    const exempt = rows.filter((r) => !hasNonElectableObligation(r.license))
      .filter((r) => electLicense(r.license) === null);
    expect(exempt.length).toBeGreaterThan(0);

    const present = exempt
      .filter((r) => doc.includes(`### ${r.name} ${r.version} — elected `))
      .map((r) => `${r.name} ${r.version}`);
    expect(present).toEqual([]);
  });

  it("reproduces the MIT permission grant for representative elected crates", () => {
    for (const crate of ["bytes", "console", "indicatif"]) {
      const start = doc.indexOf(`### ${crate} `);
      expect(start, `${crate} has no appendix section`).toBeGreaterThan(-1);
      const section = doc.slice(start, doc.indexOf("\n### ", start + 1));
      expect(section, `${crate} section lacks the MIT grant`).toContain(
        "Permission is hereby granted",
      );
    }
  });
});
