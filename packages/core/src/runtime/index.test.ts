/**
 * Runtime detection and initialization tests
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  getRuntime,
  getRuntimeSync,
  initRuntime,
  IS_BUN,
  IS_DENO,
  IS_NODE,
  runtime,
  RUNTIME_NAME,
} from "./index.ts";

// ===== Runtime Detection Tests =====

Deno.test("RUNTIME_NAME is 'deno' when running on Deno", () => {
  assertEquals(RUNTIME_NAME, "deno");
});

Deno.test("IS_DENO is true when running on Deno", () => {
  assertEquals(IS_DENO, true);
});

Deno.test("IS_NODE is false when running on Deno", () => {
  assertEquals(IS_NODE, false);
});

Deno.test("IS_BUN is false when running on Deno", () => {
  assertEquals(IS_BUN, false);
});

// ===== Runtime Initialization Tests =====

Deno.test("getRuntime returns a valid runtime instance", async () => {
  const rt = await getRuntime();
  assertExists(rt);
  assertExists(rt.fs);
  assertExists(rt.process);
  assertExists(rt.env);
  assertExists(rt.io);
  assertExists(rt.signals);
  assertExists(rt.control);
});

Deno.test("getRuntime returns same instance on multiple calls", async () => {
  const rt1 = await getRuntime();
  const rt2 = await getRuntime();
  assertEquals(rt1, rt2);
});

Deno.test("initRuntime returns a valid runtime instance", async () => {
  const rt = await initRuntime();
  assertExists(rt);
  assertExists(rt.fs);
});

Deno.test("getRuntimeSync returns runtime after initialization", async () => {
  // Ensure runtime is initialized
  await initRuntime();
  const rt = getRuntimeSync();
  assertExists(rt);
  assertExists(rt.fs);
});

// ===== Runtime Proxy Tests =====

Deno.test("runtime proxy provides access to fs", async () => {
  await initRuntime();
  assertExists(runtime.fs);
  assertExists(runtime.fs.readTextFile);
});

Deno.test("runtime proxy provides access to process", async () => {
  await initRuntime();
  assertExists(runtime.process);
  assertExists(runtime.process.run);
  assertExists(runtime.process.spawn);
});

Deno.test("runtime proxy provides access to env", async () => {
  await initRuntime();
  assertExists(runtime.env);
  assertExists(runtime.env.get);
  assertExists(runtime.env.set);
});

Deno.test("runtime proxy provides access to io", async () => {
  await initRuntime();
  assertExists(runtime.io);
  assertExists(runtime.io.stderr);
  assertExists(runtime.io.stdin);
});

Deno.test("runtime proxy provides access to signals", async () => {
  await initRuntime();
  assertExists(runtime.signals);
  assertExists(runtime.signals.addListener);
});

Deno.test("runtime proxy provides access to control", async () => {
  await initRuntime();
  assertExists(runtime.control);
  assertExists(runtime.control.exit);
});

// ===== Concurrent Initialization Tests =====

Deno.test("concurrent getRuntime calls return same instance", async () => {
  // Call getRuntime multiple times concurrently
  const promises = [
    getRuntime(),
    getRuntime(),
    getRuntime(),
    getRuntime(),
    getRuntime(),
  ];

  const results = await Promise.all(promises);

  // All results should be the same instance
  const first = results[0];
  for (const rt of results) {
    assertEquals(rt, first);
  }
});
