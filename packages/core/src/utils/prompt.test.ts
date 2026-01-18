/**
 * Prompt function tests
 *
 * Note: These tests require mocking stdin, so actual test cases
 * are verified through manual testing.
 * Here we only verify that functions are correctly exported.
 */

import { confirm, select } from "./prompt.ts";
import { assertEquals } from "@std/assert";
import { setupTestContext } from "../context/testing.ts";

// Initialize test context for modules that depend on getGlobalContext()
setupTestContext();

Deno.test("confirm function is exported", () => {
  const isConfirmFunction = typeof confirm === "function";
  assertEquals(isConfirmFunction, true);
});

Deno.test("select function is exported", () => {
  const isSelectFunction = typeof select === "function";
  assertEquals(isSelectFunction, true);
});

Deno.test({
  name: "confirm returns false in non-interactive mode",
  fn: async () => {
    // This test verifies that confirm handles non-interactive environments
    // In actual CI/test environments, Deno.stdin.isTerminal() returns false
    // We can't easily mock isTerminal(), so this is more of a documentation test

    // Skip this test if we're in an interactive terminal
    const isInteractive = Deno.stdin.isTerminal?.() ?? false;
    if (isInteractive) {
      // In interactive mode, we can't test the non-interactive path
      // without mocking, which is complex with Deno.stdin
      return;
    }

    const result = await confirm("Test prompt");
    assertEquals(result, false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
