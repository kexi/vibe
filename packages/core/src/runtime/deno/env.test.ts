/**
 * Deno environment variable implementation tests
 */

import { assertEquals, assertExists } from "@std/assert";
import { denoEnv } from "./env.ts";

// ===== get() Tests =====

Deno.test("get returns value for existing environment variable", () => {
  // PATH should exist on all systems
  const path = denoEnv.get("PATH");
  assertExists(path);
  assertEquals(typeof path, "string");
});

Deno.test("get returns undefined for non-existent environment variable", () => {
  const value = denoEnv.get("VIBE_TEST_NONEXISTENT_VAR_12345");
  assertEquals(value, undefined);
});

Deno.test("get returns HOME environment variable", () => {
  const home = denoEnv.get("HOME");
  assertExists(home);
  assertEquals(home.startsWith("/"), true);
});

// ===== set() Tests =====

Deno.test("set creates new environment variable", () => {
  const testKey = "VIBE_TEST_SET_NEW";
  const testValue = "test_value_123";

  try {
    denoEnv.set(testKey, testValue);
    assertEquals(Deno.env.get(testKey), testValue);
  } finally {
    Deno.env.delete(testKey);
  }
});

Deno.test("set overwrites existing environment variable", () => {
  const testKey = "VIBE_TEST_SET_OVERWRITE";

  try {
    denoEnv.set(testKey, "original");
    denoEnv.set(testKey, "overwritten");
    assertEquals(Deno.env.get(testKey), "overwritten");
  } finally {
    Deno.env.delete(testKey);
  }
});

// ===== delete() Tests =====

Deno.test("delete removes environment variable", () => {
  const testKey = "VIBE_TEST_DELETE";

  Deno.env.set(testKey, "to_delete");
  assertEquals(Deno.env.get(testKey), "to_delete");

  denoEnv.delete(testKey);
  assertEquals(Deno.env.get(testKey), undefined);
});

Deno.test("delete does not throw for non-existent variable", () => {
  // Should not throw
  denoEnv.delete("VIBE_TEST_DELETE_NONEXISTENT_12345");
});

// ===== existence check via get() Tests =====

Deno.test("get returns value for PATH (existence check)", () => {
  const path = denoEnv.get("PATH");
  assertExists(path);
});

Deno.test("get returns undefined for non-existent variable (existence check)", () => {
  const value = denoEnv.get("VIBE_TEST_HAS_NONEXISTENT_12345");
  assertEquals(value, undefined);
});

Deno.test("get returns value after set (existence check)", () => {
  const testKey = "VIBE_TEST_HAS_AFTER_SET";

  try {
    assertEquals(denoEnv.get(testKey), undefined);
    denoEnv.set(testKey, "value");
    assertEquals(denoEnv.get(testKey), "value");
  } finally {
    Deno.env.delete(testKey);
  }
});

// ===== toObject() Tests =====

Deno.test("toObject returns object with environment variables", () => {
  const env = denoEnv.toObject();

  assertEquals(typeof env, "object");
  assertExists(env.PATH);
  assertExists(env.HOME);
});

Deno.test("toObject includes custom variables", () => {
  const testKey = "VIBE_TEST_TO_OBJECT";
  const testValue = "test_value";

  try {
    Deno.env.set(testKey, testValue);
    const env = denoEnv.toObject();
    assertEquals(env[testKey], testValue);
  } finally {
    Deno.env.delete(testKey);
  }
});

// ===== Integration Tests =====

Deno.test("environment variable operations are consistent", () => {
  const testKey = "VIBE_TEST_CONSISTENCY";
  const testValue = "consistent_value";

  try {
    // Initial state
    assertEquals(denoEnv.get(testKey), undefined);

    // After set
    denoEnv.set(testKey, testValue);
    assertEquals(denoEnv.get(testKey), testValue);

    // After delete
    denoEnv.delete(testKey);
    assertEquals(denoEnv.get(testKey), undefined);
  } finally {
    Deno.env.delete(testKey);
  }
});
