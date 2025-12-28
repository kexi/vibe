import { getVibePath, VibeCommandRunner } from "./helpers/pty.ts";
import { setupTestGitRepo } from "./helpers/git-setup.ts";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.ts";

Deno.test({
  name: "trust: Add .vibe.toml to trusted list",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Create .vibe.toml
      await Deno.writeTextFile(
        `${repoPath}/.vibe.toml`,
        '[hooks]\npost_start = ["echo test"]\n',
      );

      // Run vibe trust
      await runner.spawn(["trust"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output confirms trust
      assertOutputContains(output, "Trusted:");
      assertOutputContains(output, ".vibe.toml");
    } finally {
      runner.dispose();
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "verify: Display trust status and hash history",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();

    try {
      // Create and trust .vibe.toml
      await Deno.writeTextFile(
        `${repoPath}/.vibe.toml`,
        '[hooks]\npost_start = ["echo test"]\n',
      );

      const trustRunner = new VibeCommandRunner(vibePath, repoPath);
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      trustRunner.dispose();

      // Run vibe verify
      const verifyRunner = new VibeCommandRunner(vibePath, repoPath);
      await verifyRunner.spawn(["verify"]);
      await verifyRunner.waitForExit();

      // Verify exit code
      assertExitCode(verifyRunner.getExitCode(), 0);

      const output = verifyRunner.getOutput();

      // Verify output shows trust status
      assertOutputContains(output, "TRUSTED");
      assertOutputContains(output, "Hash History");

      verifyRunner.dispose();
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "untrust: Remove from trusted list",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();

    try {
      // Create and trust .vibe.toml
      await Deno.writeTextFile(
        `${repoPath}/.vibe.toml`,
        '[hooks]\npost_start = ["echo test"]\n',
      );

      const trustRunner = new VibeCommandRunner(vibePath, repoPath);
      await trustRunner.spawn(["trust"]);
      await trustRunner.waitForExit();
      trustRunner.dispose();

      // Run vibe untrust
      const untrustRunner = new VibeCommandRunner(vibePath, repoPath);
      await untrustRunner.spawn(["untrust"]);
      await untrustRunner.waitForExit();

      // Verify exit code
      assertExitCode(untrustRunner.getExitCode(), 0);

      const output = untrustRunner.getOutput();

      // Verify output confirms untrust
      assertOutputContains(output, "Untrusted:");
      assertOutputContains(output, ".vibe.toml");

      untrustRunner.dispose();
    } finally {
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "trust: Handle .vibe.local.toml",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Create .vibe.local.toml
      await Deno.writeTextFile(
        `${repoPath}/.vibe.local.toml`,
        '[hooks]\npost_start = ["echo local test"]\n',
      );

      // Run vibe trust
      await runner.spawn(["trust"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output confirms trust
      assertOutputContains(output, "Trusted:");
      assertOutputContains(output, ".vibe.local.toml");
    } finally {
      runner.dispose();
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
