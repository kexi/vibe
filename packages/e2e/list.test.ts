import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

/**
 * Add a worktree with `git` directly, so the listing is exercised against a
 * repository state built independently of `vibe start`.
 */
function addWorktree(repoPath: string, branch: string, dirName: string): string {
  // Prefixed with `basename(repoPath)` (the per-run `mkdtemp` name) rather than
  // used bare: `join(repoPath, "..", …)` climbs back out to the shared temp
  // root, so a bare `dirName` is a fixed path across every run. A run that dies
  // before cleanup would then leave a directory that makes the next run's
  // `git worktree add` fail on collision instead of testing the listing.
  const path = join(repoPath, "..", `${basename(repoPath)}-${dirName}`);
  execFileSync("git", ["worktree", "add", "-b", branch, path], {
    cwd: repoPath,
    stdio: "pipe",
  });
  return path;
}

/** Strip PTY carriage returns and ANSI escapes so lines can be matched. */
function toLines(output: string): string[] {
  return output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * Write a `[summary]` helper into the repository and return the command line
 * that runs it.
 *
 * The helper answers for every worktree it is asked about and appends one line
 * to `<repoPath>/summary-runs.log` per run. That log is what makes the cache
 * observable: a cache hit is only visible as the ABSENCE of a run.
 *
 * Written as a `.js` FILE driven by node rather than a shell script using `jq`
 * (not guaranteed on the CI runners) or a `node -e` one-liner (whose quoting
 * has to survive both a TOML string and `/bin/sh`, which is exactly the kind of
 * escaping bug a test should not be debugging).
 */
function summaryCommand(repoPath: string, homePath: string): string {
  const scriptPath = join(repoPath, "summary-helper.cjs");
  // Outside the worktree: the log is appended to on every run, and the
  // worktree's `git status` is part of the cache key — a log file inside it
  // would dirty the tree on each run and defeat the very cache under test.
  const logPath = join(homePath, "summary-runs.log");
  writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      "let d = '';",
      "process.stdin.on('data', (c) => { d += c; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(logPath)}, 'run\\n');`,
      "  const out = {};",
      "  for (const w of JSON.parse(d).worktrees) {",
      "    out[w.name] = 'summary of ' + w.name;",
      "  }",
      "  process.stdout.write(JSON.stringify(out));",
      "});",
      "",
    ].join("\n"),
  );
  // Both operands quoted for /bin/sh: the temp dir path can contain characters
  // the shell would otherwise split on.
  return `"${process.execPath}" "${scriptPath}"`;
}

/** How many times the summary command has run so far. */
function summaryRunCount(homePath: string): number {
  const logPath = join(homePath, "summary-runs.log");
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
}

/** Write and trust a `.vibe.toml` carrying the `[summary]` command. */
async function configureSummary(
  repoPath: string,
  homePath: string,
  toml: string,
): Promise<void> {
  writeFileSync(join(repoPath, ".vibe.toml"), toml);
  const trustRunner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
  try {
    await trustRunner.spawn(["trust"]);
    await trustRunner.waitForExit();
    assertExitCode(trustRunner.getExitCode(), 0, trustRunner.getOutput());
  } finally {
    trustRunner.dispose();
  }
}

/** The `.vibe.toml` body configuring `[summary]` with `timeout_seconds`. */
function summaryToml(repoPath: string, homePath: string, timeoutSeconds = 60): string {
  return `[summary]\ncommand = ${JSON.stringify(summaryCommand(repoPath, homePath))}\ntimeout_seconds = ${timeoutSeconds}\n`;
}

describe("list command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Lists every worktree and marks the current one", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-alpha");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Both worktrees appear, with their branch names.
      assertOutputContains(output, "main");
      assertOutputContains(output, "feature/alpha");

      // Exactly one row is marked, and it is the main worktree we ran from.
      const marked = toLines(output).filter((line) => line.startsWith("*"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain("main");
    } finally {
      runner.dispose();
    }
  });

  test("Marks the worktree the command is run from", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    const alphaPath = addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-cwd");

    // Run from inside the secondary worktree: the marker must follow the cwd.
    const runner = new VibeCommandRunner(getVibePath(), alphaPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const marked = toLines(output).filter((line) => line.startsWith("*"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain("feature/alpha");
    } finally {
      runner.dispose();
    }
  });

  test("--json emits a parseable array carrying every worktree", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-json");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list", "--json"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const jsonMatch = output.replace(/\r/g, "").match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![0]) as {
        branch: string;
        path: string;
        current: boolean;
        scratch: boolean;
      }[];

      expect(parsed).toHaveLength(2);
      const branches = parsed.map((entry) => entry.branch).sort();
      expect(branches).toEqual(["feature/alpha", "main"]);
      // Exactly one entry is the current worktree, and it is `main`.
      const current = parsed.filter((entry) => entry.current);
      expect(current).toHaveLength(1);
      expect(current[0].branch).toBe("main");
      expect(parsed.every((entry) => entry.scratch === false)).toBe(true);
    } finally {
      runner.dispose();
    }
  });

  test("Marks scratch worktrees so they are easy to spot", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "scratch/20260101120000", "vibe-e2e-list-scratch");

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const scratchLine = toLines(output).find((line) => line.includes("scratch/20260101120000"));
      expect(scratchLine).toBeDefined();
      expect(scratchLine).toContain("(scratch)");
    } finally {
      runner.dispose();
    }
  });
  test("A configured [summary] command fills the SUMMARY column", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    addWorktree(repoPath, "feature/alpha", "vibe-e2e-list-summary");
    await configureSummary(repoPath, homePath, summaryToml(repoPath, homePath));

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      // Every worktree the command answered for shows its summary.
      assertOutputContains(output, "summary of main");
      assertOutputContains(output, "summary of feature/alpha");
      expect(summaryRunCount(homePath)).toBe(1);
    } finally {
      runner.dispose();
    }
  });

  test("A second list of an unchanged repository does not run the command", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    await configureSummary(repoPath, homePath, summaryToml(repoPath, homePath));

    const first = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await first.spawn(["list"]);
      await first.waitForExit();
      assertExitCode(first.getExitCode(), 0, first.getOutput());
    } finally {
      first.dispose();
    }
    expect(summaryRunCount(homePath)).toBe(1);

    const second = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await second.spawn(["list"]);
      await second.waitForExit();

      const output = second.getOutput();
      assertExitCode(second.getExitCode(), 0, output);
      // Answered entirely from the cache, so the command was never spawned.
      assertOutputContains(output, "summary of main");
    } finally {
      second.dispose();
    }
    expect(summaryRunCount(homePath)).toBe(1);
  });

  test("--json carries the summary field when [summary] is configured", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    await configureSummary(repoPath, homePath, summaryToml(repoPath, homePath));

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list", "--json"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      assertExitCode(runner.getExitCode(), 0, output);

      const jsonMatch = output.replace(/\r/g, "").match(/\[[\s\S]*\]/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![0]) as { branch: string; summary?: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].summary).toBe("summary of main");
    } finally {
      runner.dispose();
    }
  });

  test("Editing [summary] revokes trust until vibe trust is run again", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;
    await configureSummary(repoPath, homePath, summaryToml(repoPath, homePath));

    // Change ONLY the [summary] section; the file's hash no longer matches.
    writeFileSync(join(repoPath, ".vibe.toml"), summaryToml(repoPath, homePath, 61));

    const runner = new VibeCommandRunner(getVibePath(), repoPath, homePath);
    try {
      await runner.spawn(["list"]);
      await runner.waitForExit();

      const output = runner.getOutput();
      // The command that would have run is no longer approved, so the listing
      // fails loudly instead of silently dropping the column.
      expect(runner.getExitCode()).not.toBe(0);
      assertOutputContains(output, "vibe trust");
      expect(summaryRunCount(homePath)).toBe(0);
    } finally {
      runner.dispose();
    }
  });
});
