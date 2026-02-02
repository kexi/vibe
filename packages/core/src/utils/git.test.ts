import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  detectBrokenWorktreeLink,
  findWorktreeByBranch,
  hasUncommittedChanges,
  normalizeRemoteUrl,
  sanitizeBranchName,
} from "./git.ts";
import { createMockContext, setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real Deno runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

describe("sanitizeBranchName", () => {
  it("replaces slashes with dashes", () => {
    const result = sanitizeBranchName("feat/new-feature");
    expect(result).toBe("feat-new-feature");
  });

  it("handles multiple slashes", () => {
    const result = sanitizeBranchName("feat/user/auth/login");
    expect(result).toBe("feat-user-auth-login");
  });

  it("returns unchanged string without slashes", () => {
    const result = sanitizeBranchName("simple-branch");
    expect(result).toBe("simple-branch");
  });

  it("handles empty string", () => {
    const result = sanitizeBranchName("");
    expect(result).toBe("");
  });
});

describe("hasUncommittedChanges", () => {
  let tempDir: string;
  let originalDir: string;

  beforeAll(() => {
    originalDir = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalDir);
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("returns false when there are no changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    process.chdir(tempDir);

    // Initialize a git repository
    execSync("git init", { stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { stdio: "ignore" });
    execSync("git config user.name 'Test User'", { stdio: "ignore" });

    // Create and commit a file to have a valid repository
    await writeFile(join(tempDir, "test.txt"), "initial content");
    execSync("git add test.txt", { stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { stdio: "ignore" });

    // Now the repository should have no uncommitted changes
    const result = await hasUncommittedChanges();
    expect(result).toBe(false);
  });

  it("returns true when there are uncommitted changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    process.chdir(tempDir);

    // Initialize a git repository
    execSync("git init", { stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { stdio: "ignore" });
    execSync("git config user.name 'Test User'", { stdio: "ignore" });

    // Create and commit a file
    await writeFile(join(tempDir, "test.txt"), "initial content");
    execSync("git add test.txt", { stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { stdio: "ignore" });

    // Make an uncommitted change
    await writeFile(join(tempDir, "test.txt"), "modified content");

    // Now the repository should have uncommitted changes
    const result = await hasUncommittedChanges();
    expect(result).toBe(true);
  });

  it("returns true when there are untracked files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    process.chdir(tempDir);

    // Initialize a git repository
    execSync("git init", { stdio: "ignore" });
    execSync("git config user.email 'test@example.com'", { stdio: "ignore" });
    execSync("git config user.name 'Test User'", { stdio: "ignore" });

    // Create and commit a file
    await writeFile(join(tempDir, "test.txt"), "initial content");
    execSync("git add test.txt", { stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { stdio: "ignore" });

    // Create an untracked file
    await writeFile(join(tempDir, "untracked.txt"), "untracked content");

    // Now the repository should have untracked files
    const result = await hasUncommittedChanges();
    expect(result).toBe(true);
  });
});

describe("findWorktreeByBranch", () => {
  it("returns null when branch is not found", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          const isWorktreeListCommand = args.includes("worktree") && args.includes("list");
          if (isWorktreeListCommand) {
            // Return worktrees without the target branch
            const output = `worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\n`;
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(output),
              stderr: new Uint8Array(),
            });
          }
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          });
        },
      },
    });

    const result = await findWorktreeByBranch("non-existent-branch", ctx);
    expect(result).toBe(null);
  });

  it("returns path when branch is found", async () => {
    const ctx = createMockContext({
      process: {
        run: (opts) => {
          const args = opts.args as string[];
          const isWorktreeListCommand = args.includes("worktree") && args.includes("list");
          if (isWorktreeListCommand) {
            const output = `worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /test/worktrees/feature\nHEAD def456\nbranch refs/heads/feature-branch\n\n`;
            return Promise.resolve({
              code: 0,
              success: true,
              stdout: new TextEncoder().encode(output),
              stderr: new Uint8Array(),
            });
          }
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          });
        },
      },
    });

    const result = await findWorktreeByBranch("feature-branch", ctx);
    expect(result).toBe("/test/worktrees/feature");
  });
});

describe("normalizeRemoteUrl", () => {
  it("HTTPS URL with .git suffix", () => {
    const result = normalizeRemoteUrl("https://github.com/user/repo.git");
    expect(result).toBe("github.com/user/repo");
  });

  it("SSH URL (git@host:path format)", () => {
    const result = normalizeRemoteUrl("git@github.com:user/repo.git");
    expect(result).toBe("github.com/user/repo");
  });

  it("SSH URL with protocol", () => {
    const result = normalizeRemoteUrl("ssh://git@github.com/user/repo.git");
    expect(result).toBe("github.com/user/repo");
  });

  it("HTTP URL without .git suffix", () => {
    const result = normalizeRemoteUrl("http://github.com/user/repo");
    expect(result).toBe("github.com/user/repo");
  });

  it("URL with credentials", () => {
    const result = normalizeRemoteUrl("https://token@github.com/user/repo.git");
    expect(result).toBe("github.com/user/repo");
  });

  it("URL with user:password credentials", () => {
    const result = normalizeRemoteUrl("https://user:pass@github.com/user/repo.git");
    expect(result).toBe("github.com/user/repo");
  });

  it("already normalized URL", () => {
    const result = normalizeRemoteUrl("github.com/user/repo");
    expect(result).toBe("github.com/user/repo");
  });

  it("complex SSH with port", () => {
    const result = normalizeRemoteUrl("ssh://git@github.com:22/user/repo.git");
    expect(result).toBe("github.com:22/user/repo");
  });

  it("URL with spaces (edge case)", () => {
    const result = normalizeRemoteUrl("  https://github.com/user/repo.git  ");
    expect(result).toBe("github.com/user/repo");
  });

  it("GitLab SSH format", () => {
    const result = normalizeRemoteUrl("git@gitlab.com:group/subgroup/repo.git");
    expect(result).toBe("gitlab.com/group/subgroup/repo");
  });
});

describe("detectBrokenWorktreeLink", () => {
  it("returns isBroken=false when .git is a directory (main worktree)", async () => {
    const ctx = createMockContext({
      fs: {
        stat: () =>
          Promise.resolve({
            isFile: false,
            isDirectory: true,
            isSymlink: false,
            size: 0,
            mtime: null,
            atime: null,
            birthtime: null,
            mode: null,
          }),
      },
      control: {
        cwd: () => "/test/main-repo",
        exit: (() => {}) as never,
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    const result = await detectBrokenWorktreeLink(ctx);
    expect(result.isBroken).toBe(false);
  });

  it("returns isBroken=false when gitdir target exists", async () => {
    const ctx = createMockContext({
      fs: {
        stat: () =>
          Promise.resolve({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: 0,
            mtime: null,
            atime: null,
            birthtime: null,
            mode: null,
          }),
        readTextFile: () => Promise.resolve("gitdir: /test/main-repo/.git/worktrees/feature\n"),
        exists: () => Promise.resolve(true),
      },
      control: {
        cwd: () => "/test/worktrees/feature",
        exit: (() => {}) as never,
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    const result = await detectBrokenWorktreeLink(ctx);
    expect(result.isBroken).toBe(false);
  });

  it("returns isBroken=true when gitdir target does not exist", async () => {
    const ctx = createMockContext({
      fs: {
        stat: () =>
          Promise.resolve({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: 0,
            mtime: null,
            atime: null,
            birthtime: null,
            mode: null,
          }),
        readTextFile: () => Promise.resolve("gitdir: /test/main-repo/.git/worktrees/feature\n"),
        exists: () => Promise.resolve(false),
      },
      control: {
        cwd: () => "/test/worktrees/feature",
        exit: (() => {}) as never,
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    const result = await detectBrokenWorktreeLink(ctx);
    expect(result.isBroken).toBe(true);
    expect(result.gitDir).toBe("/test/main-repo/.git/worktrees/feature");
    expect(result.mainWorktreePath).toBe("/test/main-repo");
  });
});
