import { describe, it, expect } from "vitest";
import {
  getBranchUpstream,
  getMoveWorktreeCommand,
  getRenameBranchCommand,
  moveWorktree,
  renameBranch,
} from "./rename.ts";
import { createMockContext } from "../../context/testing.ts";

function makeMockProcess(
  handler: (
    cmd: string,
    args: string[],
  ) => {
    code: number;
    stdout?: string;
    stderr?: string;
  },
) {
  return {
    run: ({ cmd, args }: { cmd: string; args: string[] }) => {
      const result = handler(cmd, args);
      return Promise.resolve({
        code: result.code,
        success: result.code === 0,
        stdout: new TextEncoder().encode(result.stdout ?? ""),
        stderr: new TextEncoder().encode(result.stderr ?? ""),
      });
    },
  };
}

describe("moveWorktree", () => {
  it("invokes 'git worktree move <old> <new>'", async () => {
    const captured: { cmd: string; args: string[] }[] = [];
    const ctx = createMockContext({
      process: makeMockProcess((cmd, args) => {
        captured.push({ cmd, args });
        return { code: 0 };
      }),
    });

    await moveWorktree("/old/path", "/new/path", ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0].cmd).toBe("git");
    expect(captured[0].args).toEqual(["worktree", "move", "/old/path", "/new/path"]);
  });

  it("propagates git failure as an error", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 1, stderr: "fatal: refusing to move" })),
    });

    await expect(moveWorktree("/old", "/new", ctx)).rejects.toThrow(
      /worktree move \/old \/new failed/,
    );
  });
});

describe("renameBranch", () => {
  it("invokes 'git branch -m <old> <new>'", async () => {
    const captured: { cmd: string; args: string[] }[] = [];
    const ctx = createMockContext({
      process: makeMockProcess((cmd, args) => {
        captured.push({ cmd, args });
        return { code: 0 };
      }),
    });

    await renameBranch("scratch/2026", "my-feature", ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0].cmd).toBe("git");
    expect(captured[0].args).toEqual(["branch", "-m", "scratch/2026", "my-feature"]);
  });

  it("propagates git failure as an error", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 128, stderr: "fatal: branch already exists" })),
    });

    await expect(renameBranch("a", "b", ctx)).rejects.toThrow(/branch -m a b failed/);
  });
});

describe("getBranchUpstream", () => {
  it("returns 'none' when git config is missing the key (exit 1)", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 1, stderr: "" })),
    });

    const result = await getBranchUpstream("feat/x", ctx);
    expect(result).toBe("none");
  });

  it("returns 'none' when value is empty", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 0, stdout: "" })),
    });

    const result = await getBranchUpstream("feat/x", ctx);
    expect(result).toBe("none");
  });

  it("returns 'local' when value is '.' (local-tracking branch)", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 0, stdout: ".\n" })),
    });

    const result = await getBranchUpstream("feat/x", ctx);
    expect(result).toBe("local");
  });

  it("returns { remote } when value is a remote name", async () => {
    const ctx = createMockContext({
      process: makeMockProcess(() => ({ code: 0, stdout: "origin\n" })),
    });

    const result = await getBranchUpstream("feat/x", ctx);
    expect(result).toEqual({ remote: "origin" });
  });

  it("queries 'git config --get branch.<name>.remote'", async () => {
    const captured: { cmd: string; args: string[] }[] = [];
    const ctx = createMockContext({
      process: makeMockProcess((cmd, args) => {
        captured.push({ cmd, args });
        return { code: 0, stdout: "origin" };
      }),
    });

    await getBranchUpstream("scratch/foo", ctx);

    expect(captured[0].args).toEqual(["config", "--get", "branch.scratch/foo.remote"]);
  });
});

describe("getMoveWorktreeCommand / getRenameBranchCommand", () => {
  it("returns a quoted git worktree move command", () => {
    expect(getMoveWorktreeCommand("/old", "/new")).toBe("git worktree move '/old' '/new'");
  });

  it("returns a git branch -m command", () => {
    expect(getRenameBranchCommand("a", "b")).toBe("git branch -m a b");
  });
});
