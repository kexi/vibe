import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

describe("upgrade command", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("Display version and check for updates", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe upgrade
      await runner.spawn(["upgrade"]);
      await runner.waitForExit();

      // Verify exit code (0 means success)
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Output should contain version info
      assertOutputContains(output, "vibe");
    } finally {
      runner.dispose();
    }
  });

  test("Display version info with --check flag", async () => {
    const { repoPath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe upgrade --check
      await runner.spawn(["upgrade", "--check"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Output should contain version info
      assertOutputContains(output, "vibe");
    } finally {
      runner.dispose();
    }
  });
});
