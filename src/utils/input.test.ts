import { assertEquals } from "@std/assert";
import { confirmPrompt } from "./input.ts";

// Note: Testing confirmPrompt is challenging because it requires mocking stdin.
// We test the non-interactive environment detection here.
// Interactive mode testing is covered by manual/integration tests.

Deno.test({
  name: "confirmPrompt returns false in non-interactive mode",
  fn: async () => {
    // This test verifies that confirmPrompt handles non-interactive environments
    // In actual CI/test environments, Deno.stdin.isTerminal() returns false
    // We can't easily mock isTerminal(), so this is more of a documentation test

    // For now, we just verify the function can be called
    // In a real non-interactive environment, it would return false
    // Manual testing has confirmed this behavior

    // Skip this test if we're in an interactive terminal
    const isInteractive = Deno.stdin.isTerminal?.() ?? false;
    if (isInteractive) {
      // In interactive mode, we can't test the non-interactive path
      // without mocking, which is complex with Deno.stdin
      return;
    }

    const result = await confirmPrompt("Test prompt");
    assertEquals(result, false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
