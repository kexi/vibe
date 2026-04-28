import { describe, it, expect, vi, afterEach } from "vitest";
import { scratchCommand } from "./scratch.ts";
import { createMockContext } from "../context/testing.ts";
import type { RunResult } from "../runtime/types.ts";
import * as startModule from "./start.ts";

interface MockOpts {
  // branches reported by `git for-each-ref refs/heads/scratch/`
  scratchBranches?: string[];
  // worktrees reported by `git worktree list --porcelain`
  worktrees?: { path: string; branch: string }[];
}

function makeCtx(opts: MockOpts = {}) {
  const scratchBranches = opts.scratchBranches ?? [];
  const worktrees = opts.worktrees ?? [];

  const ok = (stdout = ""): RunResult => ({
    code: 0,
    success: true,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  });

  const buildPorcelain = () => {
    const lines: string[] = [];
    for (const w of worktrees) {
      lines.push(`worktree ${w.path}`);
      lines.push(`branch refs/heads/${w.branch}`);
      lines.push("");
    }
    return lines.join("\n");
  };

  const exitTracker = { code: null as number | null };

  const ctx = createMockContext({
    process: {
      run: (opts: { args?: string[] }) => {
        const args = opts.args ?? [];
        if (args[0] === "for-each-ref") {
          return Promise.resolve(ok(scratchBranches.join("\n")));
        }
        if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
          return Promise.resolve(ok(buildPorcelain()));
        }
        return Promise.resolve(ok());
      },
    },
    control: {
      exit: ((code: number) => {
        exitTracker.code = code;
        throw new Error(`__exit_${code}__`);
      }) as never,
      cwd: () => "/tmp/mock",
      chdir: () => {},
      execPath: () => "/mock",
      args: [],
    },
  });

  return { ctx, exitTracker };
}

async function runAndCatchExit(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit_")) throw e;
  }
}

/** Pin Date.now() to a known local time and return the matching scratch base name. */
function pinNowToBaseName(): string {
  const fixed = new Date(2026, 5, 15, 12, 30, 45).getTime(); // 2026-06-15 12:30:45 local
  vi.spyOn(Date, "now").mockReturnValue(fixed);
  return "scratch/20260615-123045";
}

describe("scratchCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to startCommand with a scratch/<timestamp> branch name", async () => {
    pinNowToBaseName();
    const { ctx } = makeCtx();
    const startSpy = vi
      .spyOn(startModule, "startCommand")
      .mockImplementation(async () => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runAndCatchExit(() => scratchCommand({}, ctx));

    errSpy.mockRestore();
    expect(startSpy).toHaveBeenCalledOnce();
    const [branchArg] = startSpy.mock.calls[0];
    expect(branchArg).toBe("scratch/20260615-123045");
  });

  it("appends -2 (then -3, ...) when the base name collides", async () => {
    const baseName = pinNowToBaseName();
    // Pretend the unsuffixed scratch name already exists, but `-2` is free.
    const { ctx } = makeCtx({ scratchBranches: [baseName] });
    const startSpy = vi
      .spyOn(startModule, "startCommand")
      .mockImplementation(async () => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runAndCatchExit(() => scratchCommand({}, ctx));

    errSpy.mockRestore();
    expect(startSpy).toHaveBeenCalledOnce();
    const [branchArg] = startSpy.mock.calls[0];
    expect(branchArg).toBe(`${baseName}-2`);
  });

  it("skips the next suffix too if it is also taken", async () => {
    const baseName = pinNowToBaseName();
    const { ctx } = makeCtx({ scratchBranches: [baseName, `${baseName}-2`] });
    const startSpy = vi
      .spyOn(startModule, "startCommand")
      .mockImplementation(async () => undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runAndCatchExit(() => scratchCommand({}, ctx));

    const [branchArg] = startSpy.mock.calls[0];
    expect(branchArg).toBe(`${baseName}-3`);
  });

  it("treats an existing worktree on the base name as a collision", async () => {
    const baseName = pinNowToBaseName();
    const { ctx } = makeCtx({
      worktrees: [{ path: "/tmp/scratch-wt", branch: baseName }],
    });
    const startSpy = vi
      .spyOn(startModule, "startCommand")
      .mockImplementation(async () => undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runAndCatchExit(() => scratchCommand({}, ctx));

    const [branchArg] = startSpy.mock.calls[0];
    expect(branchArg).toBe(`${baseName}-2`);
  });

  it("transparently passes start flags through", async () => {
    pinNowToBaseName();
    const { ctx } = makeCtx();
    const startSpy = vi
      .spyOn(startModule, "startCommand")
      .mockImplementation(async () => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runAndCatchExit(() =>
      scratchCommand(
        {
          reuse: true,
          noHooks: true,
          noCopy: true,
          dryRun: true,
          base: "develop",
          baseFromEquals: true,
          track: true,
          verbose: true,
        },
        ctx,
      ),
    );

    errSpy.mockRestore();
    const [, opts] = startSpy.mock.calls[0];
    expect(opts).toMatchObject({
      reuse: true,
      noHooks: true,
      noCopy: true,
      dryRun: true,
      base: "develop",
      baseFromEquals: true,
      track: true,
      verbose: true,
    });
  });

  it("prints the rename hint after start succeeds", async () => {
    pinNowToBaseName();
    const { ctx } = makeCtx();
    vi.spyOn(startModule, "startCommand").mockImplementation(async () => undefined);
    const stderr: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(" "));
    });

    await runAndCatchExit(() => scratchCommand({}, ctx));

    errSpy.mockRestore();
    expect(stderr.some((l) => l.includes("Promote with: vibe rename"))).toBe(true);
  });

  it("suppresses the hint when quiet is set", async () => {
    pinNowToBaseName();
    const { ctx } = makeCtx();
    vi.spyOn(startModule, "startCommand").mockImplementation(async () => undefined);
    const stderr: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(" "));
    });

    await runAndCatchExit(() => scratchCommand({ quiet: true }, ctx));

    errSpy.mockRestore();
    expect(stderr.some((l) => l.includes("Promote with"))).toBe(false);
  });
});
