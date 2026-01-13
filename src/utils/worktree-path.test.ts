import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveWorktreePath } from "./worktree-path.ts";
import type { VibeConfig } from "../types/config.ts";
import type { VibeSettings } from "./settings.ts";

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

Deno.test("resolveWorktreePath - returns default path when no path_script is configured", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = join(tempDir, "repo");

    const config: VibeConfig = {};
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    assertEquals(result, join(tempDir, "test-repo-feat-test-branch"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - uses config path_script when configured", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    // Create a script that outputs a custom path
    const scriptPath = join(repoRoot, "path-script.sh");
    const customPath = join(tempDir, "custom-worktrees", "my-worktree");
    await Deno.writeTextFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await Deno.chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./path-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    assertEquals(result, customPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - uses settings path_script as fallback", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    // Create a script that outputs a custom path
    const scriptPath = join(repoRoot, "settings-script.sh");
    const customPath = join(tempDir, "settings-worktrees", "my-worktree");
    await Deno.writeTextFile(scriptPath, `#!/bin/bash\necho "${customPath}"\n`);
    await Deno.chmod(scriptPath, 0o755);

    const config: VibeConfig = {}; // No worktree config
    const settings: VibeSettings = {
      version: 3,
      worktree: { path_script: scriptPath }, // Absolute path in settings
      permissions: { allow: [], deny: [] },
    };
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    assertEquals(result, customPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - config path_script takes precedence over settings", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    // Create two scripts
    const configScriptPath = join(repoRoot, "config-script.sh");
    const settingsScriptPath = join(repoRoot, "settings-script.sh");
    const configPath = join(tempDir, "config-path");
    const settingsPath = join(tempDir, "settings-path");

    await Deno.writeTextFile(configScriptPath, `#!/bin/bash\necho "${configPath}"\n`);
    await Deno.chmod(configScriptPath, 0o755);
    await Deno.writeTextFile(settingsScriptPath, `#!/bin/bash\necho "${settingsPath}"\n`);
    await Deno.chmod(settingsScriptPath, 0o755);

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

    assertEquals(result, configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - throws error when script does not exist", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    const config: VibeConfig = {
      worktree: { path_script: "./nonexistent-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await assertRejects(
      () => resolveWorktreePath(config, settings, context),
      Error,
      "Worktree path script not found",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - throws error when script outputs relative path", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    // Create a script that outputs a relative path
    const scriptPath = join(repoRoot, "bad-script.sh");
    await Deno.writeTextFile(scriptPath, `#!/bin/bash\necho "relative/path"\n`);
    await Deno.chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./bad-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    await assertRejects(
      () => resolveWorktreePath(config, settings, context),
      Error,
      "must output an absolute path",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("resolveWorktreePath - passes environment variables to script", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-test-" });
  try {
    const repoRoot = tempDir;

    // Create a script that uses environment variables
    const scriptPath = join(repoRoot, "env-script.sh");
    await Deno.writeTextFile(
      scriptPath,
      `#!/bin/bash\necho "/worktrees/\${VIBE_REPO_NAME}-\${VIBE_SANITIZED_BRANCH}"\n`,
    );
    await Deno.chmod(scriptPath, 0o755);

    const config: VibeConfig = {
      worktree: { path_script: "./env-script.sh" },
    };
    const settings = createEmptySettings();
    const context = createContext(repoRoot);

    const result = await resolveWorktreePath(config, settings, context);

    assertEquals(result, "/worktrees/test-repo-feat-test-branch");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
