#!/usr/bin/env bun

/**
 * Enforce the three-language (en / ja / zh) documentation invariants that
 * `.claude/rules/markdown.md` and `.claude/rules/docs-i18n.md` describe in prose.
 *
 * Two independent corpora, two different shapes of the same rule:
 *
 *   1. Repository markdown (README.md, docs/**) uses a filename suffix:
 *      `x.md` / `x.ja.md` / `x.zh.md`. Membership is DERIVED — a document is in
 *      scope only once at least one translation of it exists on disk. That is
 *      why CONTRIBUTING.md, AGENTS.md, CLAUDE.md and packages/npm/README.md
 *      need no exclusion list: having no `.ja.md`/`.zh.md` sibling, they are
 *      untranslated documents, not violations. A hardcoded allowlist would have
 *      to be edited every time a doc is added and would silently rot.
 *
 *   2. The docs site (packages/docs/src/content/docs) uses Starlight's
 *      directory-per-locale layout: the English page set at the root (minus the
 *      locale dirs) must equal the `ja/` set and the `zh/` set, exactly.
 *
 * Cross-language links are checked structurally rather than byte-exactly: the
 * repo deliberately carries three stylings of the same header line (a bare
 * `[日本語](README.ja.md)`, a `> 🇯🇵 [日本語版](./x.ja.md)` blockquote, and a
 * `> [!NOTE]` callout with GitHub `:jp:`/`:us:`/`:cn:` shortcodes). Pinning the
 * exact bytes would force a churny rewrite of files whose content this change
 * must not touch, so the assertion is the one that actually matters: within the
 * first few lines, each file links to the other two languages.
 *
 * Usage:
 *   bun run scripts/check-markdown-i18n.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Locale suffixes for repository markdown, in report order. */
export const MARKDOWN_LOCALES = ["ja", "zh"] as const;

/** Locale directories under the docs content root, in report order. */
export const DOCS_LOCALE_DIRS = ["ja", "zh"] as const;

/** Directories never walked when collecting repository markdown. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  "build",
  ".astro",
  "coverage",
  ".next",
  "result",
]);

/** How many leading lines may contain the cross-language link header. */
export const LINK_HEADER_LINES = 5;

/** Repository markdown paths, relative to the repo root, using `/` separators. */
export function collectMarkdownFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const isIgnored = entry.isDirectory() && IGNORED_DIRS.has(entry.name);
      if (isIgnored) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const isMarkdown = entry.isFile() && entry.name.endsWith(".md");
      if (!isMarkdown) continue;

      found.push(toPosix(relative(root, full)));
    }
  };

  walk(root);
  return found.sort();
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * The base name of a markdown path with its locale suffix stripped, or null
 * when the path is not markdown. `docs/x.ja.md` and `docs/x.md` both yield
 * `docs/x`, which is what groups a translation triplet together.
 */
export function markdownBase(path: string): string | null {
  if (!path.endsWith(".md")) return null;
  for (const locale of MARKDOWN_LOCALES) {
    const suffix = `.${locale}.md`;
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return path.slice(0, -".md".length);
}

/** The locale of a markdown path: one of MARKDOWN_LOCALES, or "en" for the base file. */
export function markdownLocale(path: string): string {
  for (const locale of MARKDOWN_LOCALES) {
    if (path.endsWith(`.${locale}.md`)) return locale;
  }
  return "en";
}

export interface TripletProblem {
  /** Base path without locale suffix, e.g. `docs/architecture`. */
  base: string;
  /** Files that must exist but do not, e.g. `docs/architecture.zh.md`. */
  missing: string[];
}

/**
 * Groups markdown files by base name and reports every group that has at least
 * one translation but is not a complete en/ja/zh triplet. Groups consisting of
 * only the base `.md` are untranslated and intentionally not reported.
 */
export function findIncompleteTriplets(files: string[]): TripletProblem[] {
  const groups = new Map<string, Set<string>>();

  for (const file of files) {
    const base = markdownBase(file);
    if (base === null) continue;
    const locales = groups.get(base) ?? new Set<string>();
    locales.add(markdownLocale(file));
    groups.set(base, locales);
  }

  const problems: TripletProblem[] = [];
  for (const [base, locales] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const isUntranslated = locales.size === 1 && locales.has("en");
    if (isUntranslated) continue;

    const missing: string[] = [];
    if (!locales.has("en")) missing.push(`${base}.md`);
    for (const locale of MARKDOWN_LOCALES) {
      if (!locales.has(locale)) missing.push(`${base}.${locale}.md`);
    }
    if (missing.length > 0) problems.push({ base, missing });
  }
  return problems;
}

/** Relative `.mdx` paths under `dir` (recursively), using `/` separators. */
export function collectMdxFiles(dir: string): string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const isIgnored = entry.isDirectory() && IGNORED_DIRS.has(entry.name);
      if (isIgnored) continue;

      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".mdx")) {
        found.push(toPosix(relative(dir, full)));
      }
    }
  };

  walk(dir);
  return found.sort();
}

export interface DocsSetProblem {
  locale: string;
  /** Pages present in English but absent from this locale. */
  missing: string[];
  /** Pages present in this locale but absent from English. */
  extra: string[];
}

/**
 * Compares the English page set against each locale's page set. Both directions
 * are reported: an orphan translation (no English original) is as much a
 * synchronization failure as a missing one, and only the two-way check catches
 * a page that was renamed in one locale.
 */
export function diffDocsLocaleSets(
  englishPages: string[],
  localePages: Record<string, string[]>,
): DocsSetProblem[] {
  const english = new Set(englishPages);
  const problems: DocsSetProblem[] = [];

  for (const [locale, pages] of Object.entries(localePages)) {
    const translated = new Set(pages);
    const missing = [...english].filter((p) => !translated.has(p)).sort();
    const extra = [...translated].filter((p) => !english.has(p)).sort();
    if (missing.length > 0 || extra.length > 0) problems.push({ locale, missing, extra });
  }
  return problems;
}

/** The sibling markdown paths a file of `locale` must link to, by base name. */
export function expectedSiblingLinks(base: string, locale: string): string[] {
  const fileName = base.split("/").pop() ?? base;
  const all = [`${fileName}.md`, ...MARKDOWN_LOCALES.map((l) => `${fileName}.${l}.md`)];
  const self = locale === "en" ? `${fileName}.md` : `${fileName}.${locale}.md`;
  return all.filter((f) => f !== self);
}

/**
 * True when the header links to the given sibling file. Matches the target
 * inside a markdown link, with or without the `./` prefix, so all three header
 * stylings in the repo satisfy the same check.
 */
export function headerLinksTo(header: string, target: string): boolean {
  return header.includes(`(./${target})`) || header.includes(`(${target})`);
}

export interface LinkProblem {
  file: string;
  /** Sibling files that are not linked from the header. */
  missingLinks: string[];
}

/**
 * Verifies that the first LINK_HEADER_LINES lines of `content` link to both
 * other languages. `path` is the file's repo-relative path; `read` is injected
 * so tests can drive this from a fixture map instead of the filesystem.
 */
export function checkCrossLinks(files: string[], read: (path: string) => string): LinkProblem[] {
  const problems: LinkProblem[] = [];
  const markdown = files.filter((f) => markdownBase(f) !== null);

  const bases = new Map<string, Set<string>>();
  for (const file of markdown) {
    const base = markdownBase(file);
    if (base === null) continue;
    const locales = bases.get(base) ?? new Set<string>();
    locales.add(markdownLocale(file));
    bases.set(base, locales);
  }

  for (const file of [...markdown].sort()) {
    const base = markdownBase(file);
    if (base === null) continue;
    const locales = bases.get(base);
    // Untranslated documents have no counterparts to link to.
    if (!locales || (locales.size === 1 && locales.has("en"))) continue;

    const header = read(file).split("\n").slice(0, LINK_HEADER_LINES).join("\n");
    const missingLinks = expectedSiblingLinks(base, markdownLocale(file)).filter(
      (target) => !headerLinksTo(header, target),
    );
    if (missingLinks.length > 0) problems.push({ file, missingLinks });
  }
  return problems;
}

const DOCS_CONTENT_DIR = join("packages", "docs", "src", "content", "docs");

/** Everything the check found wrong, as printable lines. Empty means success. */
export function collectFailures(root: string): string[] {
  const failures: string[] = [];
  const markdownFiles = collectMarkdownFiles(root);

  for (const { base, missing } of findIncompleteTriplets(markdownFiles)) {
    failures.push(`${base}: missing ${missing.join(", ")}`);
  }

  for (const { file, missingLinks } of checkCrossLinks(markdownFiles, (p) =>
    readFileSync(join(root, p), "utf-8"),
  )) {
    failures.push(
      `${file}: header (first ${LINK_HEADER_LINES} lines) does not link to ${missingLinks.join(", ")}`,
    );
  }

  const contentRoot = join(root, DOCS_CONTENT_DIR);
  const localeDirs = new Set<string>(DOCS_LOCALE_DIRS);
  const englishPages = collectMdxFiles(contentRoot).filter(
    (p) => !localeDirs.has(p.split("/")[0] ?? ""),
  );

  const localePages: Record<string, string[]> = {};
  for (const locale of DOCS_LOCALE_DIRS) {
    const dir = join(contentRoot, locale);
    const exists = safeIsDirectory(dir);
    localePages[locale] = exists ? collectMdxFiles(dir) : [];
    if (!exists) failures.push(`${DOCS_CONTENT_DIR}/${locale}: locale directory does not exist`);
  }

  for (const { locale, missing, extra } of diffDocsLocaleSets(englishPages, localePages)) {
    for (const page of missing) {
      failures.push(`${DOCS_CONTENT_DIR}/${locale}/${page}: missing translation`);
    }
    for (const page of extra) {
      failures.push(`${DOCS_CONTENT_DIR}/${page}: missing English original for ${locale}/${page}`);
    }
  }

  return failures;
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(): void {
  const root = process.cwd();
  const failures = collectFailures(root);

  if (failures.length > 0) {
    console.error("✗ documentation i18n is out of sync:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nSee .claude/rules/markdown.md and .claude/rules/docs-i18n.md: every translated document must exist in en, ja and zh, and link to its counterparts.",
    );
    process.exit(1);
  }

  console.log("✓ documentation i18n is in sync (en / ja / zh).");
}

if (import.meta.main) {
  main();
}
