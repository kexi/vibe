import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GREEN, RED, RESET, colorize, isColorEnabled, resetColorDetection } from "./ansi.ts";

describe("ansi", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetColorDetection();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetColorDetection();
  });

  describe("isColorEnabled", () => {
    it("returns true when FORCE_COLOR is set", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1" };
      expect(isColorEnabled()).toBe(true);
    });

    it("returns false when NO_COLOR is set", () => {
      process.env = { ...originalEnv, NO_COLOR: "" };
      expect(isColorEnabled()).toBe(false);
    });

    it("FORCE_COLOR takes precedence over NO_COLOR", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1", NO_COLOR: "" };
      expect(isColorEnabled()).toBe(true);
    });

    it("falls back to process.stderr.isTTY when neither env var is set", () => {
      const { FORCE_COLOR: _, NO_COLOR: __, ...envWithout } = originalEnv;
      process.env = envWithout;
      const expected = process.stderr?.isTTY ?? false;
      expect(isColorEnabled()).toBe(expected);
    });

    it("caches the result across calls", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1" };
      expect(isColorEnabled()).toBe(true);

      // Change env after cache is set — should still return cached value
      delete process.env.FORCE_COLOR;
      process.env.NO_COLOR = "";
      expect(isColorEnabled()).toBe(true);
    });
  });

  describe("resetColorDetection", () => {
    it("clears cache so next call re-detects", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1" };
      expect(isColorEnabled()).toBe(true);

      resetColorDetection();
      const { FORCE_COLOR: _, ...envWithout } = process.env;
      process.env = { ...envWithout, NO_COLOR: "" };
      expect(isColorEnabled()).toBe(false);
    });
  });

  describe("colorize", () => {
    it("wraps message with ANSI codes when color is enabled", () => {
      process.env = { ...originalEnv, FORCE_COLOR: "1" };
      expect(colorize(RED, "error")).toBe(`${RED}error${RESET}`);
    });

    it("returns plain message when color is disabled", () => {
      process.env = { ...originalEnv, NO_COLOR: "" };
      expect(colorize(GREEN, "success")).toBe("success");
    });
  });
});
