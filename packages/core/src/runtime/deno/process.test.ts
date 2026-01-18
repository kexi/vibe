/**
 * Deno process implementation tests
 */

import { assertEquals, assertExists, assertMatch, assertRejects } from "@std/assert";
import { denoProcess } from "./process.ts";

// ===== run() Tests =====

Deno.test("run executes command and returns output", async () => {
  const result = await denoProcess.run({
    cmd: "echo",
    args: ["Hello, World!"],
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  assertEquals(result.code, 0);

  const stdout = new TextDecoder().decode(result.stdout);
  assertMatch(stdout, /Hello, World!/);
});

Deno.test("run returns non-zero exit code for failing command", async () => {
  const result = await denoProcess.run({
    cmd: "false",
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, false);
  assertEquals(result.code, 1);
});

Deno.test("run captures stderr output", async () => {
  const result = await denoProcess.run({
    cmd: "sh",
    args: ["-c", "echo error >&2"],
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const stderr = new TextDecoder().decode(result.stderr);
  assertMatch(stderr, /error/);
});

Deno.test("run with custom cwd executes in specified directory", async () => {
  const result = await denoProcess.run({
    cmd: "pwd",
    cwd: "/tmp",
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const stdout = new TextDecoder().decode(result.stdout).trim();
  // /tmp may resolve to /private/tmp on macOS
  assertEquals(stdout.endsWith("/tmp"), true);
});

Deno.test("run with custom env sets environment variables", async () => {
  const result = await denoProcess.run({
    cmd: "sh",
    args: ["-c", "echo $TEST_VAR"],
    env: { TEST_VAR: "test_value" },
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const stdout = new TextDecoder().decode(result.stdout).trim();
  assertEquals(stdout, "test_value");
});

Deno.test("run with piped stdout collects output", async () => {
  const result = await denoProcess.run({
    cmd: "seq",
    args: ["1", "5"],
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const stdout = new TextDecoder().decode(result.stdout);
  assertEquals(stdout.trim(), "1\n2\n3\n4\n5");
});

// ===== spawn() Tests =====

Deno.test("spawn creates child process", async () => {
  const child = denoProcess.spawn({
    cmd: "sleep",
    args: ["0.1"],
    stdout: "null",
    stderr: "null",
  });

  assertExists(child);
  assertExists(child.pid);

  const result = await child.wait();
  assertEquals(result.success, true);
  assertEquals(result.code, 0);
});

Deno.test("spawn returns pid", async () => {
  const child = denoProcess.spawn({
    cmd: "echo",
    args: ["test"],
    stdout: "null",
    stderr: "null",
  });

  // pid should be a positive number
  assertEquals(typeof child.pid, "number");
  assertEquals(child.pid > 0, true);

  // Wait for completion to avoid resource leak
  await child.wait();
});

Deno.test("spawn with wait returns exit code", async () => {
  const child = denoProcess.spawn({
    cmd: "sh",
    args: ["-c", "exit 42"],
    stdout: "null",
    stderr: "null",
  });

  const result = await child.wait();
  assertEquals(result.code, 42);
  assertEquals(result.success, false);
});

Deno.test({
  name: "spawn unref allows parent to exit",
  // Disable sanitizers because unref() intentionally leaves process untracked
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const child = denoProcess.spawn({
      cmd: "echo",
      args: ["test"],
      stdout: "null",
      stderr: "null",
    });

    // unref should not throw - marks process as not blocking event loop
    // Note: We don't call wait() after unref() because unref() means
    // we explicitly don't want to wait for the child process
    child.unref();

    // Brief delay to allow process to complete before next test runs
    await new Promise((resolve) => setTimeout(resolve, 50));
  },
});

// ===== Error Handling Tests =====

Deno.test("run throws for non-existent command", async () => {
  await assertRejects(
    () =>
      denoProcess.run({
        cmd: "nonexistent_command_12345",
        stdout: "piped",
        stderr: "piped",
      }),
    Deno.errors.NotFound,
  );
});

// ===== Integration Tests =====

Deno.test("run with git --version succeeds", async () => {
  const result = await denoProcess.run({
    cmd: "git",
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  });

  assertEquals(result.success, true);
  const stdout = new TextDecoder().decode(result.stdout);
  assertMatch(stdout, /git version/);
});
