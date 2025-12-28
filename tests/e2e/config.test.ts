import { getVibePath, VibeCommandRunner } from "./helpers/pty.ts";
import { setupTestGitRepo } from "./helpers/git-setup.ts";
import { assertExitCode, assertOutputContains } from "./helpers/assertions.ts";

Deno.test({
  name: "config: Display settings in JSON format",
  async fn() {
    const { repoPath, cleanup } = await setupTestGitRepo();
    const vibePath = getVibePath();
    const runner = new VibeCommandRunner(vibePath, repoPath);

    try {
      // Run vibe config
      await runner.spawn(["config"]);
      await runner.waitForExit();

      // Verify exit code
      assertExitCode(runner.getExitCode(), 0);

      const output = runner.getOutput();

      // Verify output contains settings information
      assertOutputContains(output, "Settings file:");
      assertOutputContains(output, "{");

      // Try to extract and parse JSON
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("Parsed JSON is not an object");
        }
      }
    } finally {
      runner.dispose();
      await cleanup();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
