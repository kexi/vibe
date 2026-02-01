/**
 * Deno Runtime Smoke Test
 *
 * This test file is designed to run with Deno to verify that the Deno runtime
 * implementation works correctly. It should be run separately from the main
 * test suite which runs under Bun.
 *
 * Usage:
 *   deno test --allow-env --allow-read --allow-run packages/core/src/runtime/deno/smoke.test.ts
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { denoEnv, denoBuild, denoControl } from "./env.ts";
import { denoProcess } from "./process.ts";
import { denoFS } from "./fs.ts";
import { denoIO } from "./io.ts";
import { denoSignals } from "./signals.ts";
import { denoErrors } from "./errors.ts";
import { denoFFI } from "./ffi.ts";

Deno.test("denoEnv - get/set/delete environment variables", () => {
  const testKey = "__VIBE_TEST_ENV__";

  // Initially undefined
  assertEquals(denoEnv.get(testKey), undefined);

  // Set and get
  denoEnv.set(testKey, "test_value");
  assertEquals(denoEnv.get(testKey), "test_value");

  // Delete
  denoEnv.delete(testKey);
  assertEquals(denoEnv.get(testKey), undefined);
});

Deno.test("denoEnv - toObject returns current environment", () => {
  const env = denoEnv.toObject();
  assertExists(env);
  // PATH should exist on all platforms
  assertExists(env.PATH || env.Path);
});

Deno.test("denoBuild - has valid os and arch", () => {
  const validOS = ["darwin", "linux", "windows"];
  const validArch = ["x86_64", "aarch64", "arm"];

  assertEquals(validOS.includes(denoBuild.os), true, `Invalid OS: ${denoBuild.os}`);
  assertEquals(validArch.includes(denoBuild.arch), true, `Invalid arch: ${denoBuild.arch}`);
});

Deno.test("denoControl - cwd returns current directory", () => {
  const cwd = denoControl.cwd();
  assertExists(cwd);
  assertEquals(typeof cwd, "string");
});

Deno.test("denoControl - execPath returns deno path", () => {
  const execPath = denoControl.execPath();
  assertExists(execPath);
  assertEquals(typeof execPath, "string");
});

Deno.test("denoControl - args is an array", () => {
  assertExists(denoControl.args);
  assertEquals(Array.isArray(denoControl.args), true);
});

Deno.test("denoProcess - run executes command and returns result", async () => {
  const result = await denoProcess.run({
    cmd: "echo",
    args: ["hello"],
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  assertEquals(result.code, 0);
  assertExists(result.stdout);
});

Deno.test("denoProcess - run merges environment variables", async () => {
  const result = await denoProcess.run({
    cmd: denoBuild.os === "windows" ? "cmd" : "sh",
    args:
      denoBuild.os === "windows" ? ["/c", "echo %VIBE_TEST_VAR%"] : ["-c", "echo $VIBE_TEST_VAR"],
    env: { VIBE_TEST_VAR: "merged_value" },
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const output = new TextDecoder().decode(result.stdout).trim();
  assertEquals(output, "merged_value");
});

Deno.test("denoProcess - spawn creates child process", async () => {
  const child = denoProcess.spawn({
    cmd: "echo",
    args: ["spawn_test"],
    stdout: "piped",
    stderr: "piped",
  });

  assertExists(child.pid);
  assertEquals(typeof child.pid, "number");

  const status = await child.wait();
  assertEquals(status.success, true);
  assertEquals(status.code, 0);
});

Deno.test("denoFS - exists returns correct result", async () => {
  // Current directory should exist
  const cwdExists = await denoFS.exists(".");
  assertEquals(cwdExists, true);

  // Non-existent file should not exist
  const nonExistent = await denoFS.exists("__non_existent_file_12345__");
  assertEquals(nonExistent, false);
});

Deno.test("denoFS - readDir lists directory contents", async () => {
  const entries = [];
  for await (const entry of denoFS.readDir(".")) {
    entries.push(entry);
    if (entries.length > 5) break; // Limit to first 5 entries
  }

  assertEquals(entries.length > 0, true);
  assertExists(entries[0].name);
  assertExists(entries[0].isFile);
  assertExists(entries[0].isDirectory);
});

Deno.test("denoIO - stdin and stderr are available", () => {
  // RuntimeIO provides stdin and stderr (not stdout - that's handled by process)
  assertExists(denoIO.stdin);
  assertExists(denoIO.stderr);
  assertEquals(typeof denoIO.stdin.read, "function");
  assertEquals(typeof denoIO.stderr.write, "function");
});

Deno.test("denoSignals - can add and remove listeners", () => {
  const handler = () => {};

  // Should not throw
  denoSignals.addListener("SIGINT", handler);
  denoSignals.removeListener("SIGINT", handler);
});

Deno.test("denoErrors - NotFound error class exists", () => {
  assertExists(denoErrors.NotFound);
  assertEquals(denoErrors.NotFound.name, "NotFound");
});

Deno.test("denoErrors - PermissionDenied error class exists", () => {
  assertExists(denoErrors.PermissionDenied);
  assertEquals(denoErrors.PermissionDenied.name, "PermissionDenied");
});

Deno.test("denoErrors - error type checking functions work", () => {
  const notFoundError = new Deno.errors.NotFound("test");
  const permissionError = new Deno.errors.PermissionDenied("test");

  assertEquals(denoErrors.isNotFound(notFoundError), true);
  assertEquals(denoErrors.isNotFound(new Error("test")), false);

  assertEquals(denoErrors.isPermissionDenied(permissionError), true);
  assertEquals(denoErrors.isPermissionDenied(new Error("test")), false);
});

Deno.test("denoFFI - available is true", () => {
  assertEquals(denoFFI.available, true);
});

console.log("\n✅ All Deno runtime smoke tests completed!\n");
