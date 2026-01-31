/**
 * Prompt function tests
 *
 * Note: These tests require mocking stdin, so actual test cases
 * are verified through manual testing.
 * Here we only verify that functions are correctly exported.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { confirm, select } from "./prompt.ts";
import { setupTestContext } from "../context/testing.ts";

// Initialize test context for modules that depend on getGlobalContext()
beforeAll(() => {
  setupTestContext();
});

describe("prompt utilities", () => {
  it("confirm function is exported", () => {
    expect(typeof confirm).toBe("function");
  });

  it("select function is exported", () => {
    expect(typeof select).toBe("function");
  });

  it("confirm returns false in non-interactive mode", async () => {
    // This test verifies that confirm handles non-interactive environments
    // In actual CI/test environments, stdin.isTTY is false
    // We can't easily mock isTTY, so this is more of a documentation test

    // In non-interactive mode (like CI), confirm should return false
    // Skip test in interactive environments
    if (process.stdin.isTTY) {
      return;
    }

    const result = await confirm("Test prompt");
    expect(result).toBe(false);
  });
});
