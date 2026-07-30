/**
 * What these guarantee for `scripts/check-markdown-i18n.ts`:
 *
 *   - a document with NO translation sibling (CONTRIBUTING.md, AGENTS.md,
 *     packages/npm/README.md …) is out of scope by derivation, so the check
 *     never needs an exclusion list to maintain;
 *   - once any translation exists, a missing en/ja/zh member is reported, in
 *     both directions (a lone `.zh.md` demands `.md` and `.ja.md` too);
 *   - the docs-site locale directories must hold exactly the English page set —
 *     an unmirrored page AND an orphan translation both fail;
 *   - the cross-language header check accepts every header styling the repo
 *     actually uses (bare link, 🇯🇵 blockquote, `> [!NOTE]` + `:jp:` shortcode)
 *     while still failing when a language is absent from it;
 *   - directory walking skips node_modules and other build output.
 *
 * The filesystem-touching cases build a throwaway fixture tree under the OS temp
 * dir; the pure set/link functions are driven directly with literals.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  collectMarkdownFiles,
  collectMdxFiles,
  markdownBase,
  markdownLocale,
  findIncompleteTriplets,
  diffDocsLocaleSets,
  expectedSiblingLinks,
  headerLinksTo,
  checkCrossLinks,
  collectFailures,
} from "../../../scripts/check-markdown-i18n.ts";

let root: string;

function write(relPath: string, content = "# placeholder\n"): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibe-i18n-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("markdownBase / markdownLocale", () => {
  it("groups the three locales of a document under one base", () => {
    expect(markdownBase("docs/architecture.md")).toBe("docs/architecture");
    expect(markdownBase("docs/architecture.ja.md")).toBe("docs/architecture");
    expect(markdownBase("docs/architecture.zh.md")).toBe("docs/architecture");
  });

  it("reports the locale of each member", () => {
    expect(markdownLocale("README.md")).toBe("en");
    expect(markdownLocale("README.ja.md")).toBe("ja");
    expect(markdownLocale("README.zh.md")).toBe("zh");
  });

  it("ignores non-markdown paths", () => {
    expect(markdownBase("package.json")).toBeNull();
  });
});

describe("findIncompleteTriplets", () => {
  it("accepts a complete en/ja/zh triplet", () => {
    const files = ["README.md", "README.ja.md", "README.zh.md"];
    expect(findIncompleteTriplets(files)).toEqual([]);
  });

  it("ignores an untranslated document instead of demanding translations", () => {
    const files = ["CONTRIBUTING.md", "AGENTS.md", "packages/npm/README.md"];
    expect(findIncompleteTriplets(files)).toEqual([]);
  });

  it("reports the missing Chinese member of a translated document", () => {
    const files = ["docs/architecture.md", "docs/architecture.ja.md"];
    expect(findIncompleteTriplets(files)).toEqual([
      { base: "docs/architecture", missing: ["docs/architecture.zh.md"] },
    ]);
  });

  it("demands the English original and the Japanese sibling of a lone Chinese file", () => {
    expect(findIncompleteTriplets(["guide.zh.md"])).toEqual([
      { base: "guide", missing: ["guide.md", "guide.ja.md"] },
    ]);
  });
});

describe("diffDocsLocaleSets", () => {
  it("passes when every locale mirrors the English page set", () => {
    const english = ["index.mdx", "commands/start.mdx"];
    const problems = diffDocsLocaleSets(english, {
      ja: ["index.mdx", "commands/start.mdx"],
      zh: ["commands/start.mdx", "index.mdx"],
    });
    expect(problems).toEqual([]);
  });

  it("reports a page missing from one locale", () => {
    const problems = diffDocsLocaleSets(["index.mdx", "setup.mdx"], {
      ja: ["index.mdx", "setup.mdx"],
      zh: ["index.mdx"],
    });
    expect(problems).toEqual([{ locale: "zh", missing: ["setup.mdx"], extra: [] }]);
  });

  it("reports an orphan translation with no English original", () => {
    const problems = diffDocsLocaleSets(["index.mdx"], {
      ja: ["index.mdx"],
      zh: ["index.mdx", "legacy.mdx"],
    });
    expect(problems).toEqual([{ locale: "zh", missing: [], extra: ["legacy.mdx"] }]);
  });
});

describe("expectedSiblingLinks / headerLinksTo", () => {
  it("expects each file to link to the other two languages by file name", () => {
    expect(expectedSiblingLinks("docs/architecture", "en")).toEqual([
      "architecture.ja.md",
      "architecture.zh.md",
    ]);
    expect(expectedSiblingLinks("docs/architecture", "ja")).toEqual([
      "architecture.md",
      "architecture.zh.md",
    ]);
    expect(expectedSiblingLinks("docs/architecture", "zh")).toEqual([
      "architecture.md",
      "architecture.ja.md",
    ]);
  });

  it("accepts both the ./-prefixed and bare link targets", () => {
    expect(headerLinksTo("> 🇯🇵 [日本語版](./x.ja.md)", "x.ja.md")).toBe(true);
    expect(headerLinksTo("[日本語](x.ja.md)", "x.ja.md")).toBe(true);
    expect(headerLinksTo("no links here", "x.ja.md")).toBe(false);
  });
});

describe("checkCrossLinks", () => {
  const files = ["doc.md", "doc.ja.md", "doc.zh.md"];

  it("accepts the 🇯🇵 blockquote styling", () => {
    const contents: Record<string, string> = {
      "doc.md": "> 🇯🇵 [日本語版](./doc.ja.md) | 🇨🇳 [简体中文](./doc.zh.md)\n\n# Doc\n",
      "doc.ja.md": "> 🇺🇸 [English](./doc.md) | 🇨🇳 [简体中文](./doc.zh.md)\n\n# Doc\n",
      "doc.zh.md": "> 🇺🇸 [English](./doc.md) | 🇯🇵 [日本語版](./doc.ja.md)\n\n# Doc\n",
    };
    expect(checkCrossLinks(files, (p) => contents[p] ?? "")).toEqual([]);
  });

  it("accepts the > [!NOTE] callout with GitHub emoji shortcodes", () => {
    const contents: Record<string, string> = {
      "doc.md": "> [!NOTE]\n> :jp: [日本語版](./doc.ja.md) | :cn: [简体中文](./doc.zh.md)\n\n# Doc\n",
      "doc.ja.md": "> [!NOTE]\n> :us: [English](./doc.md) | :cn: [简体中文](./doc.zh.md)\n\n# Doc\n",
      "doc.zh.md": "> [!NOTE]\n> :us: [English](./doc.md) | :jp: [日本語版](./doc.ja.md)\n\n# Doc\n",
    };
    expect(checkCrossLinks(files, (p) => contents[p] ?? "")).toEqual([]);
  });

  it("accepts a bare link line placed a few lines into the file", () => {
    const contents: Record<string, string> = {
      "doc.md": "# vibe\n\nTagline.\n\n[日本語](doc.ja.md) | [简体中文](doc.zh.md)\n",
      "doc.ja.md": "# vibe\n\n説明。\n\n[English](doc.md) | [简体中文](doc.zh.md)\n",
      "doc.zh.md": "# vibe\n\n说明。\n\n[English](doc.md) | [日本語版](doc.ja.md)\n",
    };
    expect(checkCrossLinks(files, (p) => contents[p] ?? "")).toEqual([]);
  });

  it("reports a header that omits the Chinese link", () => {
    const contents: Record<string, string> = {
      "doc.md": "> 🇯🇵 [日本語版](./doc.ja.md)\n\n# Doc\n",
      "doc.ja.md": "> 🇺🇸 [English](./doc.md) | 🇨🇳 [简体中文](./doc.zh.md)\n",
      "doc.zh.md": "> 🇺🇸 [English](./doc.md) | 🇯🇵 [日本語版](./doc.ja.md)\n",
    };
    expect(checkCrossLinks(files, (p) => contents[p] ?? "")).toEqual([
      { file: "doc.md", missingLinks: ["doc.zh.md"] },
    ]);
  });

  it("ignores a link that appears below the header window", () => {
    const contents: Record<string, string> = {
      "doc.md": "\n\n\n\n\n\n[日本語](doc.ja.md) | [简体中文](doc.zh.md)\n",
      "doc.ja.md": "[English](doc.md) | [简体中文](doc.zh.md)\n",
      "doc.zh.md": "[English](doc.md) | [日本語版](doc.ja.md)\n",
    };
    expect(checkCrossLinks(files, (p) => contents[p] ?? "")).toEqual([
      { file: "doc.md", missingLinks: ["doc.ja.md", "doc.zh.md"] },
    ]);
  });

  it("does not demand links from an untranslated document", () => {
    expect(checkCrossLinks(["CONTRIBUTING.md"], () => "# Contributing\n")).toEqual([]);
  });
});

describe("collectMarkdownFiles / collectMdxFiles", () => {
  it("walks nested directories and skips build output", () => {
    write("README.md");
    write("docs/architecture.md");
    write("node_modules/pkg/README.md");
    write("packages/docs/dist/index.md");

    expect(collectMarkdownFiles(root)).toEqual(["README.md", "docs/architecture.md"]);
  });

  it("returns mdx paths relative to the given directory", () => {
    write("content/index.mdx");
    write("content/commands/start.mdx");
    write("content/notes.txt");

    expect(collectMdxFiles(join(root, "content"))).toEqual([
      "commands/start.mdx",
      "index.mdx",
    ]);
  });
});

describe("collectFailures (end to end over a fixture tree)", () => {
  const DOCS = "packages/docs/src/content/docs";

  function writeCompleteFixture(): void {
    write("README.md", "[日本語](README.ja.md) | [简体中文](README.zh.md)\n");
    write("README.ja.md", "[English](README.md) | [简体中文](README.zh.md)\n");
    write("README.zh.md", "[English](README.md) | [日本語版](README.ja.md)\n");
    write("CONTRIBUTING.md", "# Contributing\n");
    for (const prefix of ["", "ja/", "zh/"]) {
      write(`${DOCS}/${prefix}index.mdx`);
      write(`${DOCS}/${prefix}commands/start.mdx`);
    }
  }

  it("passes on a fully synchronized tree", () => {
    writeCompleteFixture();
    expect(collectFailures(root)).toEqual([]);
  });

  it("fails with the missing markdown translation named", () => {
    writeCompleteFixture();
    rmSync(join(root, "README.zh.md"));

    const failures = collectFailures(root);
    expect(failures).toContain("README: missing README.zh.md");
  });

  it("fails with the missing docs page named", () => {
    writeCompleteFixture();
    rmSync(join(root, DOCS, "zh", "commands", "start.mdx"));

    const failures = collectFailures(root);
    expect(failures).toContain(`${DOCS}/zh/commands/start.mdx: missing translation`);
  });

  it("fails when a locale directory is absent entirely", () => {
    writeCompleteFixture();
    rmSync(join(root, DOCS, "zh"), { recursive: true });

    const failures = collectFailures(root);
    expect(failures).toContain(`${DOCS}/zh: locale directory does not exist`);
  });

  it("fails when a header lost a language link", () => {
    writeCompleteFixture();
    write("README.md", "[日本語](README.ja.md)\n");

    const failures = collectFailures(root);
    expect(failures).toContain(
      "README.md: header (first 5 lines) does not link to README.zh.md",
    );
  });
});
