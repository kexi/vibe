/**
 * Tests for scripts/build-deb.ts — the .deb packaging step, specifically the
 * documentation it installs under /usr/share/doc/vibe.
 *
 * A Debian binary package has no License: control field, so the machine-readable
 * DEP-5 copyright file is the package's only statement of terms, and
 * THIRD-PARTY-LICENSES.md is the only place the statically-linked Rust crates'
 * notices appear. What these guarantee:
 *   - the copyright file is valid DEP-5 1.0: the Format URI, a Files/License
 *     stanza, and a license body reformatted with ` .` for blank lines;
 *   - the MIT body and the copyright holder are DERIVED from the repo LICENSE,
 *     never hardcoded, so the .deb cannot state terms the project does not ship;
 *   - a license text DEP-5 cannot represent (a line starting with `.`) or one
 *     with no recognizable copyright line is a hard failure, not a silently
 *     mangled legal document;
 *   - staging installs both documents with explicit, umask-independent modes
 *     (0755 dir / 0644 files) and treats either source's absence as fatal —
 *     both are committed files, so missing means a broken checkout.
 *
 * Runs against a temp root (the `root` option) so the real repo is never written to.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDebianCopyright,
  formatDep5Text,
  extractCopyrightLine,
  stageDocFiles,
} from "../../../scripts/build-deb";

const MIT_LICENSE = `MIT License

Copyright (c) 2025 Kei Nakayama (kexi) and the vibe contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
`;

describe("extractCopyrightLine", () => {
  it("pulls the Copyright (c) line out of the license text", () => {
    expect(extractCopyrightLine(MIT_LICENSE)).toBe(
      "Copyright (c) 2025 Kei Nakayama (kexi) and the vibe contributors",
    );
  });

  it("throws when no copyright line can be found (never invents a holder)", () => {
    expect(() => extractCopyrightLine("Some terms with no holder\n")).toThrowError(/Copyright/);
  });
});

describe("formatDep5Text", () => {
  it("indents non-blank lines by one space", () => {
    expect(formatDep5Text("alpha\nbeta\n")).toBe(" alpha\n beta");
  });

  it("represents blank lines as ' .'", () => {
    expect(formatDep5Text("alpha\n\nbeta\n")).toBe(" alpha\n .\n beta");
  });

  it("treats a whitespace-only line as blank", () => {
    expect(formatDep5Text("alpha\n   \nbeta\n")).toBe(" alpha\n .\n beta");
  });

  it("normalizes CRLF input", () => {
    expect(formatDep5Text("alpha\r\n\r\nbeta\r\n")).toBe(" alpha\n .\n beta");
  });

  it("throws on a line starting with '.' (DEP-5 would read it back as blank)", () => {
    expect(() => formatDep5Text("alpha\n.hidden\n")).toThrowError(/DEP-5/);
  });
});

describe("renderDebianCopyright", () => {
  const out = renderDebianCopyright({ licenseText: MIT_LICENSE });

  it("declares the machine-readable DEP-5 1.0 format on the first line", () => {
    expect(out.startsWith("Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n")).toBe(
      true,
    );
  });

  it("identifies the upstream project and source", () => {
    expect(out).toContain("Upstream-Name: vibe");
    expect(out).toContain("Source: https://github.com/kexi/vibe");
  });

  it("declares Files: * under the MIT license", () => {
    expect(out).toContain("Files: *");
    expect(out).toMatch(/^License: MIT$/m);
  });

  it("carries the copyright holder derived from the license text", () => {
    expect(out).toContain(
      "Copyright: Copyright (c) 2025 Kei Nakayama (kexi) and the vibe contributors",
    );
  });

  it("points at the third-party notices installed beside it", () => {
    expect(out).toContain("/usr/share/doc/vibe/THIRD-PARTY-LICENSES.md");
  });

  it("reproduces the MIT body as an indented DEP-5 block", () => {
    expect(out).toContain(" Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(out).toContain("\n .\n");
  });

  it("propagates a license text DEP-5 cannot represent", () => {
    expect(() => renderDebianCopyright({ licenseText: "Copyright (c) 2025 x\n.oops\n" })).toThrowError(
      /DEP-5/,
    );
  });
});

describe("stageDocFiles", () => {
  let root: string;
  let packageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vibe-deb-root-"));
    packageDir = mkdtempSync(join(tmpdir(), "vibe-deb-pkg-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  });

  function seedRoot(): void {
    writeFileSync(join(root, "LICENSE"), MIT_LICENSE);
    writeFileSync(join(root, "THIRD-PARTY-LICENSES.md"), "# Third-Party Licenses\n");
  }

  it("installs copyright and THIRD-PARTY-LICENSES.md under usr/share/doc/vibe", async () => {
    seedRoot();
    await stageDocFiles(packageDir, { root });

    const docDir = join(packageDir, "usr", "share", "doc", "vibe");
    expect(readFileSync(join(docDir, "copyright"), "utf-8")).toContain("Format: https://");
    expect(readFileSync(join(docDir, "THIRD-PARTY-LICENSES.md"), "utf-8")).toBe(
      "# Third-Party Licenses\n",
    );
  });

  it("copies the notices verbatim (uncompressed, byte-for-byte)", async () => {
    writeFileSync(join(root, "LICENSE"), MIT_LICENSE);
    const notices = "# Third-Party Licenses\n\n| Crate | Version |\n| a | 1.0 |\n";
    writeFileSync(join(root, "THIRD-PARTY-LICENSES.md"), notices);

    await stageDocFiles(packageDir, { root });

    const staged = join(packageDir, "usr", "share", "doc", "vibe", "THIRD-PARTY-LICENSES.md");
    expect(readFileSync(staged, "utf-8")).toBe(notices);
  });

  it("sets explicit 0755/0644 modes so the caller's umask cannot hide the docs", async () => {
    seedRoot();
    await stageDocFiles(packageDir, { root });

    const docDir = join(packageDir, "usr", "share", "doc", "vibe");
    expect(statSync(docDir).mode & 0o777).toBe(0o755);
    expect(statSync(join(docDir, "copyright")).mode & 0o777).toBe(0o644);
    expect(statSync(join(docDir, "THIRD-PARTY-LICENSES.md")).mode & 0o777).toBe(0o644);
  });

  it("throws when the root LICENSE is missing (a committed file: a broken checkout)", async () => {
    writeFileSync(join(root, "THIRD-PARTY-LICENSES.md"), "# notices\n");
    await expect(stageDocFiles(packageDir, { root })).rejects.toThrowError(/LICENSE not found/);
  });

  it("throws when THIRD-PARTY-LICENSES.md is missing (a .deb must not drop crate notices)", async () => {
    // Unlike the npm staging step, which only warns, there is no later release
    // gate for the .deb and the file is committed rather than a build product.
    writeFileSync(join(root, "LICENSE"), MIT_LICENSE);
    await expect(stageDocFiles(packageDir, { root })).rejects.toThrowError(
      /THIRD-PARTY-LICENSES\.md not found/,
    );
  });
});
