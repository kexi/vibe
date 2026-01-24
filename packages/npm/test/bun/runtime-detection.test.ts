/**
 * Bun runtime detection tests
 */

import { describe, it, expect } from "bun:test";
import {
  RUNTIME_NAME,
  IS_BUN,
  IS_DENO,
  IS_NODE,
} from "../../../core/src/runtime/index.ts";

describe("runtime detection in Bun", () => {
  describe("RUNTIME_NAME", () => {
    it("is detected as 'bun'", () => {
      expect(RUNTIME_NAME).toBe("bun");
    });
  });

  describe("IS_BUN", () => {
    it("is true", () => {
      expect(IS_BUN).toBe(true);
    });
  });

  describe("IS_DENO", () => {
    it("is false", () => {
      expect(IS_DENO).toBe(false);
    });
  });

  describe("IS_NODE", () => {
    it("is false", () => {
      expect(IS_NODE).toBe(false);
    });
  });

  describe("Bun global", () => {
    it("is available", () => {
      expect(typeof globalThis.Bun).toBe("object");
    });

    it("has version property", () => {
      expect(Bun.version).toBeDefined();
      expect(typeof Bun.version).toBe("string");
    });
  });
});
