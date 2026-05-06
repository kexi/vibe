import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { __resetEmittedWarningsForTest, resolveWorktreePath } from "./worktree-path.ts";
import type { VibeConfig } from "../types/config.ts";
import type { VibeSettings } from "./settings.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
});

beforeEach(() => {
  __resetEmittedWarningsForTest();
});

const createContext = (repoRoot: string) => ({
  repoName: "test-repo",
  branchName: "feat/test-branch",
  sanitizedBranch: "feat-test-branch",
  repoRoot,
});

const createEmptySettings = (): VibeSettings => ({
  version: 3,
  permissions: { allow: [], deny: [] },
});

describe("resolveWorktreePath", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns default path when no path_script is configured", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = join(tempDir, "repo");

    const config: VibeConfig = {};
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    expect(result).toBe(join(tempDir, "test-repo-feat-test-branch"));
  });

  it("uses config path_script when configured", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Create a script that outputs a custom path
    const scriptPath = join(repoRoot, "path-script.sh");
    const customPath = join(tempDir, "custom-worktrees", "my-worktree");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./path-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    expect(result).toBe(customPath);
  });

  it("uses settings path_script as fallback", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Create a script that outputs a custom path
    const scriptPath = join(repoRoot, "settings-script.sh");
    const customPath = join(tempDir, "settings-worktrees", "my-worktree");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = {}; // No worktree config
    const settings: VibeSettings = {
      version: 3,
      worktree: { path_script: scriptPath }, // Absolute path in settings
      permissions: { allow: [], deny: [] },
    };
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    expect(result).toBe(customPath);
  });

  it("config path_script takes precedence over settings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Create two scripts
    const configScriptPath = join(repoRoot, "config-script.sh");
    const settingsScriptPath = join(repoRoot, "settings-script.sh");
    const configPath = join(tempDir, "config-path");
    const settingsPath = join(tempDir, "settings-path");

    await writeFile(configScriptPath, `#!/bin/bash\necho "${configPath}"\n`);
    await chmod(configScriptPath, 0o755);
    await writeFile(settingsScriptPath, `#!/bin/bash\necho "${settingsPath}"\n`);
    await chmod(settingsScriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./config-script.sh" },
    };
    const settings: VibeSettings = {
      version: 3,
      worktree: { path_script: settingsScriptPath },
      permissions: { allow: [], deny: [] },
    };
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    expect(result).toBe(configPath);
  });

  it("throws error when script does not exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const config: VibeConfig = {
      worktree: { path_script: "./nonexistent-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      "Worktree path script not found",
    );
  });

  it("throws error when script outputs relative path", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Create a script that outputs a relative path
    const scriptPath = join(repoRoot, "bad-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "relative/path"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./bad-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      "must output an absolute path",
    );
  });

  it("passes environment variables to script", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Create a script that uses environment variables
    const scriptPath = join(repoRoot, "env-script.sh");
    await writeFile(
      scriptPath,
      `#!/bin/bash\necho "/worktrees/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"\n`,
    );
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./env-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    expect(result).toBe("/worktrees/test-repo-feat-test-branch");
  });

  it("rejects branch names with control characters before executing the script", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const scriptPath = join(repoRoot, "noop.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${tempDir}/should-not-run"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./noop.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test-repo",
      branchName: "feat/test\nrm -rf /",
      sanitizedBranch: "feat-test-branch",
      repoRoot,
    };

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /VIBE_BRANCH_NAME contains a control character \(0x0a\)/,
    );
  });

  it("rejects repo root with NUL byte", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const scriptPath = join(repoRoot, "noop.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${tempDir}/x"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./noop.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test-repo",
      branchName: "feat/test",
      sanitizedBranch: "feat-test",
      repoRoot: `${repoRoot}\x00evil`,
    };

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /VIBE_REPO_ROOT contains a control character \(0x00\)/,
    );
  });

  it("warns when branch name contains shell metacharacters but still executes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const customPath = join(tempDir, "out");
    const scriptPath = join(repoRoot, "warn-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: VibeConfig = { worktree: { path_script: "./warn-script.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test-repo",
      branchName: "feat/$evil;rm",
      sanitizedBranch: "feat-evil-rm",
      repoRoot,
    };

    try {
      const result = await resolveWorktreePath(config, settings, context);
      expect(result).toBe(customPath);

      const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
      const hasBranchWarning = warnings.some((w) => w.includes("VIBE_BRANCH_NAME"));
      expect(hasBranchWarning).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("dedupes warnings for the same field+metachars combination", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const customPath = join(tempDir, "out");
    const scriptPath = join(repoRoot, "warn-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: VibeConfig = { worktree: { path_script: "./warn-script.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test-repo",
      branchName: "feat/$evil",
      sanitizedBranch: "feat-evil",
      repoRoot,
    };

    try {
      await resolveWorktreePath(config, settings, context);
      await resolveWorktreePath(config, settings, context);

      const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
      const branchWarnings = warnings.filter((w) => w.includes("VIBE_BRANCH_NAME"));
      expect(branchWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when only repoRoot would otherwise trigger metachar checks", async () => {
    // repoRoot is intentionally excluded from metachar warnings (paths with `$`
    // or `\` are common and would just produce noise).
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const customPath = join(tempDir, "out");
    const scriptPath = join(repoRoot, "warn-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: VibeConfig = { worktree: { path_script: "./warn-script.sh" } };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    try {
      await resolveWorktreePath(config, settings, context);
      const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
      const anyVibeWarning = warnings.some((w) => w.includes("VIBE_"));
      expect(anyVibeWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects script output containing embedded newlines", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    // Script outputs two lines; trim() would otherwise hide the second.
    const scriptPath = join(repoRoot, "multiline-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\nprintf '%s\\n%s\\n' '${tempDir}/a' 'evil'\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./multiline-script.sh" } };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /control character \(0x0a\)/,
    );
  });

  it("rejects sanitizedBranch with control characters (regression: all four fields are wired)", async () => {
    // Regression guard: branchName / repoName / repoRoot are clean and only
    // sanitizedBranch carries a control character. This ensures
    // `assertNoControlChars` is invoked for VIBE_SANITIZED_BRANCH specifically
    // and not silently skipped.
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const scriptPath = join(repoRoot, "noop.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${tempDir}/should-not-run"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./noop.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test-repo",
      branchName: "feat/test-branch",
      sanitizedBranch: "feat-test\x1bevil",
      repoRoot,
    };

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /VIBE_SANITIZED_BRANCH contains a control character \(0x1b\)/,
    );
  });

  it("rejects repoName with control characters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const scriptPath = join(repoRoot, "noop.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${tempDir}/should-not-run"\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./noop.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test\x00repo",
      branchName: "feat/test-branch",
      sanitizedBranch: "feat-test-branch",
      repoRoot,
    };

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /VIBE_REPO_NAME contains a control character \(0x00\)/,
    );
  });

  it("warns about both branch and repo metacharacters when present in different fields", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const customPath = join(tempDir, "out");
    const scriptPath = join(repoRoot, "warn-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await chmod(scriptPath, 0o755);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: VibeConfig = { worktree: { path_script: "./warn-script.sh" } };
    const settings = createEmptySettings();
    const context = {
      repoName: "test;repo",
      branchName: "feat/$evil",
      sanitizedBranch: "feat-evil",
      repoRoot,
    };

    try {
      const result = await resolveWorktreePath(config, settings, context);
      expect(result).toBe(customPath);

      const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
      const hasBranchWarning = warnings.some((w) => w.includes("VIBE_BRANCH_NAME"));
      const hasRepoWarning = warnings.some((w) => w.includes("VIBE_REPO_NAME"));
      expect(hasBranchWarning).toBe(true);
      expect(hasRepoWarning).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects script output containing carriage returns", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const repoRoot = tempDir;

    const scriptPath = join(repoRoot, "cr-script.sh");
    await writeFile(scriptPath, `#!/bin/bash\nprintf '%s\\r\\n' '${tempDir}/a'\n`);
    await chmod(scriptPath, 0o755);

    const config: VibeConfig = { worktree: { path_script: "./cr-script.sh" } };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await expect(resolveWorktreePath(config, settings, context)).rejects.toThrow(
      /control character \(0x0d\)/,
    );
  });
});
