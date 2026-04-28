import { describe, it, expect, vi, afterEach } from "vitest";
import { renameCommand } from "./rename.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";

interface GitMockOptions {
  // path/branch pairs returned by `git worktree list --porcelain`
  worktrees: { path: string; branch: string }[];
  // values returned by branchExists() — `git show-ref --verify refs/heads/<name>`
  existingBranches?: string[];
  // value returned by `git config --get branch.<oldBranch>.remote`
  upstream?: { code: number; stdout?: string; stderr?: string };
  // override behavior for `git worktree move`
  worktreeMove?: { code: number; stderr?: string };
  // override behavior for `git branch -m`
  branchMove?: { code: number; stderr?: string };
  // path returned by `git rev-parse --show-toplevel` (i.e. the current worktree's root)
  currentRepoRoot: string;
}

interface GitMockResult {
  process: {
    run: (opts: { cmd: string; args: string[] }) => Promise<RunResult>;
  };
  calls: { cmd: string; args: string[] }[];
}

function makeGitMock(opts: GitMockOptions): GitMockResult {
  const calls: { cmd: string; args: string[] }[] = [];

  const buildWorktreePorcelain = () => {
    const lines: string[] = [];
    for (const w of opts.worktrees) {
      lines.push(`worktree ${w.path}`);
      lines.push(`branch refs/heads/${w.branch}`);
      lines.push("");
    }
    return lines.join("\n");
  };

  const ok = (stdout = ""): RunResult => ({
    code: 0,
    success: true,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  });
  const fail = (code = 1, stderr = ""): RunResult => ({
    code,
    success: false,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(stderr),
  });

  return {
    calls,
    process: {
      run: ({ cmd, args }) => {
        calls.push({ cmd, args });

        // git worktree list --porcelain
        if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
          return Promise.resolve(ok(buildWorktreePorcelain()));
        }

        // git rev-parse --show-toplevel — the *current* worktree's root
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return Promise.resolve(ok(opts.currentRepoRoot + "\n"));
        }

        // git show-ref --verify --quiet refs/heads/<name>
        if (args[0] === "show-ref" && args[1] === "--verify") {
          const ref = args[args.length - 1];
          const branchName = ref.replace(/^refs\/heads\//, "");
          const exists = (opts.existingBranches ?? []).includes(branchName);
          return Promise.resolve(exists ? ok() : fail());
        }

        // git config --get branch.<n>.remote
        if (args[0] === "config" && args[1] === "--get" && args[2]?.startsWith("branch.")) {
          const u = opts.upstream ?? { code: 1 };
          if (u.code === 0) return Promise.resolve(ok(u.stdout ?? ""));
          return Promise.resolve(fail(u.code, u.stderr ?? ""));
        }

        // git worktree move
        if (args[0] === "worktree" && args[1] === "move") {
          const r = opts.worktreeMove ?? { code: 0 };
          if (r.code === 0) return Promise.resolve(ok());
          return Promise.resolve(fail(r.code, r.stderr));
        }

        // git branch -m
        if (args[0] === "branch" && args[1] === "-m") {
          const r = opts.branchMove ?? { code: 0 };
          if (r.code === 0) return Promise.resolve(ok());
          return Promise.resolve(fail(r.code, r.stderr));
        }

        // Default: no-op success
        return Promise.resolve(ok());
      },
    },
  };
}

interface ConsoleSpies {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureConsoles(): ConsoleSpies {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  return {
    stdout,
    stderr,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

function makeRenameCtx(cwd: string, gitMock: GitMockResult, exitTracker: { code: number | null }) {
  return createMockContext({
    process: gitMock.process,
    env: {
      get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
      set: () => {},
      delete: () => {},
      toObject: () => ({ HOME: "/home/test" }),
    },
    fs: {
      readTextFile: () => Promise.reject(new Error("ENOENT")),
      realPath: (p: string) => Promise.resolve(p),
      exists: () => Promise.resolve(false),
      stat: () => Promise.reject(new Error("ENOENT")),
    },
    errors: {
      // Treat any thrown error as NotFound so loadUserSettings/loadVibeConfig
      // gracefully fall back to defaults in tests.
      isNotFound: () => true,
    },
    control: {
      exit: ((code: number) => {
        exitTracker.code = code;
        // Throw to short-circuit (mimics process.exit behavior)
        throw new Error(`__exit_${code}__`);
      }) as never,
      cwd: () => cwd,
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });
}

async function runAndCatchExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit_")) throw e;
  }
}

describe("renameCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with error when new name is empty", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({ worktrees: [], currentRepoRoot: "/tmp/mock" });
    const ctx = makeRenameCtx("/tmp/mock", gitMock, exit);

    await runAndCatchExit(() => renameCommand("", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("New branch name is required"))).toBe(true);
  });

  it("exits with error when not in a vibe worktree", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat/x" },
      ],
      currentRepoRoot: "/some/other/dir",
    });
    const ctx = makeRenameCtx("/some/other/dir", gitMock, exit);

    await runAndCatchExit(() => renameCommand("foo", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("Not in a vibe worktree"))).toBe(true);
  });

  it("rejects renaming the main worktree", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat/x" },
      ],
      currentRepoRoot: "/repo-main",
    });
    const ctx = makeRenameCtx("/repo-main", gitMock, exit);

    await runAndCatchExit(() => renameCommand("foo", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("Cannot rename main worktree"))).toBe(true);
  });

  it("is a no-op when target name equals current branch", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat-x" },
      ],
      currentRepoRoot: "/repo-feat",
    });
    const ctx = makeRenameCtx("/repo-feat", gitMock, exit);

    await runAndCatchExit(() => renameCommand("feat-x", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(null);
    expect(console_.stdout.some((l) => l.startsWith("cd '/repo-feat'"))).toBe(true);
    expect(console_.stderr.some((l) => l.includes("Already named 'feat-x'"))).toBe(true);
    // Should not invoke git worktree move or git branch -m
    expect(gitMock.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "move")).toBe(false);
    expect(gitMock.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-m")).toBe(false);
  });

  it("rejects rename when branch has a remote upstream (pushed)", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "scratch/2026" },
      ],
      currentRepoRoot: "/repo-feat",
      upstream: { code: 0, stdout: "origin\n" },
    });
    const ctx = makeRenameCtx("/repo-feat", gitMock, exit);

    await runAndCatchExit(() => renameCommand("my-feature", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("is pushed to 'origin'"))).toBe(true);
    expect(console_.stderr.some((l) => l.includes("git branch -m scratch/2026 my-feature"))).toBe(
      true,
    );
    expect(console_.stderr.some((l) => l.includes("git push origin -u my-feature"))).toBe(true);
    expect(console_.stderr.some((l) => l.includes("git push origin --delete scratch/2026"))).toBe(
      true,
    );
  });

  it("treats local-tracking upstream ('.') as not pushed and continues", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat-x" },
      ],
      currentRepoRoot: "/repo-feat",
      upstream: { code: 0, stdout: ".\n" },
    });
    const ctx = makeRenameCtx("/repo-feat", gitMock, exit);

    await runAndCatchExit(() => renameCommand("renamed", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(null);
    expect(gitMock.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-m")).toBe(true);
  });

  it("rejects when target branch already exists", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat-x" },
      ],
      currentRepoRoot: "/repo-feat",
      existingBranches: ["other-branch"],
    });
    const ctx = makeRenameCtx("/repo-feat", gitMock, exit);

    await runAndCatchExit(() => renameCommand("other-branch", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("'other-branch' already exists"))).toBe(true);
  });

  it("dry-run prints planned commands and does not invoke git move/branch -m", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat", branch: "feat-x" },
      ],
      currentRepoRoot: "/repo-feat",
    });
    const ctx = makeRenameCtx("/repo-feat", gitMock, exit);

    await runAndCatchExit(() => renameCommand("renamed", { dryRun: true }, ctx));
    console_.restore();

    expect(exit.code).toBe(null);
    expect(
      console_.stderr.some((l) => l.includes("[dry-run]") && l.includes("git branch -m")),
    ).toBe(true);
    expect(
      console_.stderr.some(
        (l) => l.includes("[dry-run]") && l.includes("Would change directory to:"),
      ),
    ).toBe(true);
    // No cd output on dry-run
    expect(console_.stdout.some((l) => l.startsWith("cd '"))).toBe(false);
    // No actual git ops
    expect(gitMock.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "move")).toBe(false);
    expect(gitMock.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-m")).toBe(false);
  });

  it("rolls back worktree move when branch -m fails", async () => {
    const console_ = captureConsoles();
    const exit = { code: null as number | null };
    const gitMock = makeGitMock({
      worktrees: [
        { path: "/repo-main", branch: "develop" },
        { path: "/repo-feat-x", branch: "feat-x" },
      ],
      currentRepoRoot: "/repo-feat-x",
      branchMove: { code: 1, stderr: "fatal: simulated failure" },
    });
    const ctx = makeRenameCtx("/repo-feat-x", gitMock, exit);

    await runAndCatchExit(() => renameCommand("renamed", {}, ctx));
    console_.restore();

    expect(exit.code).toBe(1);
    expect(console_.stderr.some((l) => l.includes("failed to rename branch"))).toBe(true);
    expect(console_.stderr.some((l) => l.includes("rolled back"))).toBe(true);

    // git worktree move should be called twice: forward and rollback
    const moveCalls = gitMock.calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "move");
    expect(moveCalls).toHaveLength(2);
  });
});
