import { writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, test } from "vitest";
import { getVibePath, VibeCommandRunner } from "./helpers/pty.js";
import { setupTestGitRepo } from "./helpers/git-setup.js";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.js";

describe("trust/untrust/verify commands", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  test("trust: Add .vibe.toml to trusted list", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);

    try {
      // Create .vibe.toml
      writeFileSync(join(repoPath, ".vibe.toml"), '[hooks]\npost_start = ["echo test"]\n');

      // Run vibe trust
      await runner.spawn(["trust"]);
      await runner.waitForExit();

      const output = runner.getOutput();

      // Verify exit code (pass output for debugging)
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify output confirms trust
      assertOutputContains(output, "Trusted files:");
      assertOutputContains(output, ".vibe.toml");
    } finally {
      runner.dispose();
    }
  });

  test("verify: Display trust status and hash history", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create and trust .vibe.toml
    writeFileSync(join(repoPath, ".vibe.toml"), '[hooks]\npost_start = ["echo test"]\n');

    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    await trustRunner.spawn(["trust"]);
    await trustRunner.waitForExit();
    const trustOutput = trustRunner.getOutput();
    assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    trustRunner.dispose();

    // Run vibe verify
    const verifyRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    await verifyRunner.spawn(["verify"]);
    await verifyRunner.waitForExit();

    const output = verifyRunner.getOutput();

    // Verify exit code (pass output for debugging)
    assertExitCode(verifyRunner.getExitCode(), 0, output);

    // Verify output shows trust status
    assertOutputContains(output, "TRUSTED");
    assertOutputContains(output, "Hash History");

    verifyRunner.dispose();
  });

  test("untrust: Remove from trusted list", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();

    // Create and trust .vibe.toml
    writeFileSync(join(repoPath, ".vibe.toml"), '[hooks]\npost_start = ["echo test"]\n');

    const trustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    await trustRunner.spawn(["trust"]);
    await trustRunner.waitForExit();
    const trustOutput = trustRunner.getOutput();
    assertExitCode(trustRunner.getExitCode(), 0, trustOutput);
    trustRunner.dispose();

    // Run vibe untrust
    const untrustRunner = new VibeCommandRunner(vibePath, repoPath, homePath);
    await untrustRunner.spawn(["untrust"]);
    await untrustRunner.waitForExit();

    const output = untrustRunner.getOutput();

    // Verify exit code (pass output for debugging)
    assertExitCode(untrustRunner.getExitCode(), 0, output);

    // Verify output confirms untrust
    assertOutputContains(output, "Untrusted:");
    assertOutputContains(output, ".vibe.toml");

    untrustRunner.dispose();
  });

  test("trust: Handle .vibe.local.toml", async () => {
    const { repoPath, homePath, cleanup: repoCleanup } = await setupTestGitRepo();
    cleanup = repoCleanup;

    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath, homePath);

    try {
      // Create .vibe.local.toml
      writeFileSync(
        join(repoPath, ".vibe.local.toml"),
        '[hooks]\npost_start = ["echo local test"]\n',
      );

      // Run vibe trust
      await runner.spawn(["trust"]);
      await runner.waitForExit();

      const output = runner.getOutput();

      // Verify exit code (pass output for debugging)
      assertExitCode(runner.getExitCode(), 0, output);

      // Verify output confirms trust
      assertOutputContains(output, "Trusted files:");
      assertOutputContains(output, ".vibe.local.toml");
    } finally {
      runner.dispose();
    }
  });
});
