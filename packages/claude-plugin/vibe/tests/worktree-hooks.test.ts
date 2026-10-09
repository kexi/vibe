import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

// What Claude Code passes a WorktreeCreate / WorktreeRemove hook, as its
// settings-hook stdin. Only the fields the plugin reads matter here.
const CREATE = { name: "feat-login", cwd: "/work/repo" };
const REMOVE = { worktree_path: "/work/repo-feat-login", cwd: "/work/repo-feat-login" };

// A repository with no remote, as $.session.repo() answers for /work/repo
const REPO = { root: "/work/repo", remote: null, internal: false, name: null };

const ran = (exitCode: number, stdout: string, stderr = "") => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
});

const VIBE_BANNER = ran(0, "vibe 4.2.0\nPlatform: macos-aarch64\n");

interface Run {
  argv: readonly string[];
  init: { cwd?: string; stdin?: string; timeoutMs?: number };
}

type Answer = ReturnType<typeof ran> | { deny: string };

interface StubOptions {
  /** What `vibe --version` answers; vibe's banner unless given. */
  version?: Answer;
  /** What $.session.repo() answers; /work/repo unless given. */
  repo?: typeof REPO | null;
}

/**
 * Stubs $.process.run: `vibe --version` answers `options.version`, the real
 * command (start or clean) answers `command`. Records each run, toast and log.
 */
function stubVibe(on: On, command: Answer, options: StubOptions = {}) {
  const seen = { runs: [] as Run[], toasts: [] as string[], logs: [] as string[] };
  const repo = options.repo === undefined ? REPO : options.repo;
  on("session.repo", () => ({ value: repo }));
  on("ui.log", ($, e) => {
    seen.logs.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("process.run", ($, e) => {
    seen.runs.push({ argv: e.argv, init: e.init ?? {} });
    return e.argv[1] === "--version" ? (options.version ?? VIBE_BANNER) : command;
  });
  return seen;
}

/** Stands for Claude Code's own behavior at the end of the chain; records that it ran. */
function stubClaudeCode(on: On) {
  const reached = { create: false, remove: false };
  on("classic.WorktreeCreate", () => {
    reached.create = true;
    return {};
  });
  on("classic.WorktreeRemove", () => {
    reached.remove = true;
    return {};
  });
  return reached;
}

const VIBE_ENOENT = { deny: "spawn vibe ENOENT" };

test("WorktreeCreate answers with the path vibe start prints", async ($, on) => {
  const { runs } = stubVibe(on, ran(0, "/work/repo-feat-login"));

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(result).toEqual({ worktreePath: "/work/repo-feat-login" });
  const start = runs.find((run) => run.argv[1] === "start");
  expect(start?.argv).toEqual(["vibe", "start", "--claude-code-worktree-hook"]);
  expect(start?.init.cwd).toBe("/work/repo");
  expect(start?.init.timeoutMs).toBe(300_000);
});

test("WorktreeCreate sends vibe only the worktree name on stdin", async ($, on) => {
  const { runs } = stubVibe(on, ran(0, "/work/repo-feat-login"));

  await $.classic.WorktreeCreate({ ...CREATE, transcript_path: "/home/me/.claude/t.jsonl" });

  const start = runs.find((run) => run.argv[1] === "start");
  expect(JSON.parse(start?.init.stdin ?? "")).toEqual({ name: "feat-login" });
});

test("WorktreeCreate blocks with vibe's Error line when vibe start fails", async ($, on) => {
  stubVibe(
    on,
    ran(1, "", "Fetching base...\nError: Base 'develop' not found\nhint: see vibe start --help\n"),
  );

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(result).toEqual({ block: "Error: Base 'develop' not found" });
});

test("WorktreeCreate tells Claude not to approve an untrusted config itself", async ($, on) => {
  const stderr =
    "/work/repo/.vibe.toml: .vibe.toml file is not trusted or has been modified.\nPlease run: vibe trust\n";
  stubVibe(on, ran(1, "", stderr));

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(result).toEqual({
    block:
      "vibe did not run because this repository's vibe config is not trusted. " +
      "The user has to review it and run `vibe trust` themselves; do not run it for them.",
  });
});

test("WorktreeCreate refuses output that is not one absolute path", async ($, on) => {
  stubVibe(on, ran(0, "relative/path"));

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(result).toEqual({ block: "vibe start failed (exit 0)" });
});

test("WorktreeCreate logs a pre_start gate and still answers with the path", async ($, on) => {
  const gate = "vibe: pre_start hook failed; worktree is not provisioned\n";
  const { logs } = stubVibe(on, ran(0, "/work/repo-feat-login", gate));

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(result).toEqual({ worktreePath: "/work/repo-feat-login" });
  expect(logs).toEqual(["pre_start hook failed; /work/repo-feat-login is not provisioned"]);
});

test("WorktreeCreate falls back to Claude Code when vibe cannot start", async ($, on) => {
  const { runs, toasts } = stubVibe(on, ran(0, "/work/repo-feat-login"), { version: VIBE_ENOENT });
  const reached = stubClaudeCode(on);

  await $.classic.WorktreeCreate(CREATE);

  expect(reached.create).toBe(true);
  expect(toasts.length).toBe(1);
  expect(runs.some((run) => run.argv[1] === "start")).toBe(false);
});

test("WorktreeCreate falls back when the vibe on PATH is some other program", async ($, on) => {
  const { runs } = stubVibe(on, ran(0, "/work/repo-feat-login"), {
    version: ran(0, "Vibe Player 2.0\n"),
  });
  const reached = stubClaudeCode(on);

  await $.classic.WorktreeCreate(CREATE);

  expect(reached.create).toBe(true);
  expect(runs.some((run) => run.argv[1] === "start")).toBe(false);
});

test("WorktreeCreate blocks, not falls back, when vibe start is cut off after it began", async ($, on) => {
  stubVibe(on, { deny: "timed out after 300000ms" });
  const reached = stubClaudeCode(on);

  const result = await $.classic.WorktreeCreate(CREATE);

  expect(reached.create).toBe(false);
  expect(result).toMatchObject({
    block: expect.stringMatching(/did not finish .*may be partly created$/),
  });
});

test(
  "WorktreeCreate leaves the event alone when worktreeHooks is off",
  { options: { worktreeHooks: false } },
  async ($, on) => {
    const { runs } = stubVibe(on, ran(0, "/work/repo-feat-login"));
    const reached = stubClaudeCode(on);

    await $.classic.WorktreeCreate(CREATE);

    expect(reached.create).toBe(true);
    expect(runs.length).toBe(0);
  },
);

test("WorktreeRemove runs vibe clean from the main worktree with the path on stdin", async ($, on) => {
  const { runs } = stubVibe(on, ran(0, ""));

  const result = await $.classic.WorktreeRemove(REMOVE);

  expect(result).toEqual({});
  const clean = runs.find((run) => run.argv[1] === "clean");
  expect(clean?.argv).toEqual(["vibe", "clean", "--claude-code-worktree-hook"]);
  expect(clean?.init.cwd).toBe("/work/repo");
  expect(JSON.parse(clean?.init.stdin ?? "")).toEqual({ worktree_path: "/work/repo-feat-login" });
});

test("WorktreeRemove blocks with vibe's Error line when vibe clean fails", async ($, on) => {
  stubVibe(on, ran(1, "", "Error: Not inside a git repository.\n"));

  const result = await $.classic.WorktreeRemove(REMOVE);

  expect(result).toEqual({ block: "Error: Not inside a git repository." });
});

test("WorktreeRemove runs vibe clean from the session's directory outside a repository", async ($, on) => {
  const { runs } = stubVibe(on, ran(0, ""), { repo: null });

  await $.classic.WorktreeRemove(REMOVE);

  expect(runs.find((run) => run.argv[1] === "clean")?.init.cwd).toBe("/work/repo-feat-login");
});

test("WorktreeRemove falls back to Claude Code when vibe cannot start", async ($, on) => {
  stubVibe(on, ran(0, ""), { version: VIBE_ENOENT });
  const reached = stubClaudeCode(on);

  await $.classic.WorktreeRemove(REMOVE);

  expect(reached.remove).toBe(true);
});
