import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveWorktreePath } from "./worktree-path.ts";
import type { VibeConfig } from "../types/config.ts";
import type { VibeSettings } from "./settings.ts";
import { setupRealTestContext } from "../context/testing.ts";

// Initialize test context with real runtime for filesystem tests
beforeAll(async () => {
  await setupRealTestContext();
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
});
