/**
 * Node.js environment variable implementation tests
 */

import { describe, it, expect, afterEach } from "vitest";
import { nodeEnv } from "../../packages/core/src/runtime/node/env.ts";

describe("nodeEnv", () => {
  // ===== get() Tests =====
  describe("get", () => {
    it("returns value for existing environment variable", () => {
      // PATH should exist on all systems
      const path = nodeEnv.get("PATH");
      expect(path).toBeDefined();
      expect(typeof path).toBe("string");
    });

    it("returns undefined for non-existent environment variable", () => {
      const value = nodeEnv.get("VIBE_TEST_NONEXISTENT_VAR_12345");
      expect(value).toBeUndefined();
    });

    it("returns HOME environment variable", () => {
      const home = nodeEnv.get("HOME");
      expect(home).toBeDefined();
      expect(home?.startsWith("/")).toBe(true);
    });
  });

  // ===== set() Tests =====
  describe("set", () => {
    const testKey = "VIBE_TEST_SET_NEW";

    afterEach(() => {
      delete process.env[testKey];
    });

    it("creates new environment variable", () => {
      const testValue = "test_value_123";
      nodeEnv.set(testKey, testValue);
      expect(process.env[testKey]).toBe(testValue);
    });

    it("overwrites existing environment variable", () => {
      nodeEnv.set(testKey, "original");
      nodeEnv.set(testKey, "overwritten");
      expect(process.env[testKey]).toBe("overwritten");
    });
  });

  // ===== delete() Tests =====
  describe("delete", () => {
    it("removes environment variable", () => {
      const testKey = "VIBE_TEST_DELETE";
      process.env[testKey] = "to_delete";
      expect(process.env[testKey]).toBe("to_delete");

      nodeEnv.delete(testKey);
      expect(process.env[testKey]).toBeUndefined();
    });

    it("does not throw for non-existent variable", () => {
      // Should not throw
      expect(() => {
        nodeEnv.delete("VIBE_TEST_DELETE_NONEXISTENT_12345");
      }).not.toThrow();
    });
  });

  // ===== existence check via get() Tests =====
  describe("existence check via get()", () => {
    it("returns value for PATH", () => {
      const path = nodeEnv.get("PATH");
      expect(path).toBeDefined();
    });

    it("returns undefined for non-existent variable", () => {
      const value = nodeEnv.get("VIBE_TEST_HAS_NONEXISTENT_12345");
      expect(value).toBeUndefined();
    });

    it("returns value after set", () => {
      const testKey = "VIBE_TEST_HAS_AFTER_SET";

      try {
        expect(nodeEnv.get(testKey)).toBeUndefined();
        nodeEnv.set(testKey, "value");
        expect(nodeEnv.get(testKey)).toBe("value");
      } finally {
        delete process.env[testKey];
      }
    });
  });

  // ===== toObject() Tests =====
  describe("toObject", () => {
    it("returns object with environment variables", () => {
      const env = nodeEnv.toObject();

      expect(typeof env).toBe("object");
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
    });

    it("includes custom variables", () => {
      const testKey = "VIBE_TEST_TO_OBJECT";
      const testValue = "test_value";

      try {
        process.env[testKey] = testValue;
        const env = nodeEnv.toObject();
        expect(env[testKey]).toBe(testValue);
      } finally {
        delete process.env[testKey];
      }
    });
  });

  // ===== Integration Tests =====
  describe("integration", () => {
    it("environment variable operations are consistent", () => {
      const testKey = "VIBE_TEST_CONSISTENCY";
      const testValue = "consistent_value";

      try {
        // Initial state
        expect(nodeEnv.get(testKey)).toBeUndefined();

        // After set
        nodeEnv.set(testKey, testValue);
        expect(nodeEnv.get(testKey)).toBe(testValue);

        // After delete
        nodeEnv.delete(testKey);
        expect(nodeEnv.get(testKey)).toBeUndefined();
      } finally {
        delete process.env[testKey];
      }
    });
  });
});
