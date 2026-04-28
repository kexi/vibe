import { describe, it, expect } from "vitest";
import { createMockContext } from "../../context/testing.ts";
import { createWorktree, removeWorktree, getCreateWorktreeCommand } from "./operations.ts";

interface CapturedCall {
  args: string[];
}

function createTrackingContext() {
  const calls: CapturedCall[] = [];
  const ctx = createMockContext({
    process: {
      run: (opts) => {
        const args = (opts.args ?? []) as string[];
        calls.push({ args: [...args] });
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      },
    },
  });
  return { ctx, calls };
}

describe("createWorktree", () => {
  it("rejects '..' in worktree path before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(
      createWorktree(
        {
          branchName: "feat/x",
          worktreePath: "/tmp/../etc",
          branchExists: false,
        },
        ctx,
      ),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("rejects worktree path starting with '-' before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(
      createWorktree(
        {
          branchName: "feat/x",
          worktreePath: "-rf",
          branchExists: false,
        },
        ctx,
      ),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("rejects relative worktree path before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(
      createWorktree(
        {
          branchName: "feat/x",
          worktreePath: "relative/path",
          branchExists: false,
        },
        ctx,
      ),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("invokes git worktree add with normalized path on happy path (existing branch)", async () => {
    const { ctx, calls } = createTrackingContext();

    await createWorktree(
      {
        branchName: "feat/x",
        worktreePath: "/tmp/foo/bar",
        branchExists: true,
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "add", "/tmp/foo/bar", "feat/x"]);
  });

  it("invokes git worktree add -b on happy path (new branch)", async () => {
    const { ctx, calls } = createTrackingContext();

    await createWorktree(
      {
        branchName: "feat/x",
        worktreePath: "/tmp/foo/bar",
        branchExists: false,
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "add", "-b", "feat/x", "/tmp/foo/bar"]);
  });

  it("passes the canonical (normalized) path to git, not the raw input", async () => {
    const { ctx, calls } = createTrackingContext();

    await createWorktree(
      {
        branchName: "feat/x",
        worktreePath: "/tmp//foo/./bar",
        branchExists: true,
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "add", "/tmp/foo/bar", "feat/x"]);
  });
});

describe("removeWorktree", () => {
  it("rejects '..' in worktree path before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(removeWorktree({ worktreePath: "/tmp/../etc" }, ctx)).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("rejects worktree path starting with '-' before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(removeWorktree({ worktreePath: "--exec=evil" }, ctx)).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("rejects worktree path with control character before invoking git", async () => {
    const { ctx, calls } = createTrackingContext();

    await expect(removeWorktree({ worktreePath: "/tmp/foo\x1b[2J" }, ctx)).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("invokes git worktree remove with normalized path on happy path", async () => {
    const { ctx, calls } = createTrackingContext();

    await removeWorktree({ worktreePath: "/tmp/foo/bar" }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "remove", "/tmp/foo/bar"]);
  });

  it("invokes git worktree remove --force when force=true", async () => {
    const { ctx, calls } = createTrackingContext();

    await removeWorktree({ worktreePath: "/tmp/foo/bar", force: true }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "remove", "--force", "/tmp/foo/bar"]);
  });

  it("passes the canonical (normalized) path to git, not the raw input", async () => {
    const { ctx, calls } = createTrackingContext();

    await removeWorktree({ worktreePath: "/tmp/./foo//bar" }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["worktree", "remove", "/tmp/foo/bar"]);
  });
});

describe("getCreateWorktreeCommand", () => {
  it("rejects malicious worktree path", () => {
    expect(() =>
      getCreateWorktreeCommand({
        branchName: "feat/x",
        worktreePath: "/tmp/../etc",
        branchExists: false,
      }),
    ).toThrow();
  });

  it("returns the dry-run string with normalized path on happy path", () => {
    const result = getCreateWorktreeCommand({
      branchName: "feat/x",
      worktreePath: "/tmp/foo//bar",
      branchExists: true,
    });

    expect(result).toBe("git worktree add '/tmp/foo/bar' feat/x");
  });

  it("escapes single quotes in worktree path for safe shell display", () => {
    const result = getCreateWorktreeCommand({
      branchName: "feat/x",
      worktreePath: "/tmp/it's/foo",
      branchExists: true,
    });

    expect(result).toBe("git worktree add '/tmp/it'\\''s/foo' feat/x");
  });
});
