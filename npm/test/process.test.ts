/**
 * Node.js process implementation tests
 */

import { describe, it, expect } from "vitest";
import { nodeProcess } from "../../src/runtime/node/process.ts";

describe("nodeProcess", () => {
  // ===== run() Tests =====
  describe("run", () => {
    it("executes command and returns output", async () => {
      const result = await nodeProcess.run({
        cmd: "echo",
        args: ["Hello, World!"],
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      expect(result.code).toBe(0);

      const stdout = new TextDecoder().decode(result.stdout);
      expect(stdout).toMatch(/Hello, World!/);
    });

    it("returns non-zero exit code for failing command", async () => {
      const result = await nodeProcess.run({
        cmd: "false",
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe(1);
    });

    it("captures stderr output", async () => {
      const result = await nodeProcess.run({
        cmd: "sh",
        args: ["-c", "echo error >&2"],
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toMatch(/error/);
    });

    it("with custom cwd executes in specified directory", async () => {
      const result = await nodeProcess.run({
        cmd: "pwd",
        cwd: "/tmp",
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      const stdout = new TextDecoder().decode(result.stdout).trim();
      // /tmp may resolve to /private/tmp on macOS
      expect(stdout.endsWith("/tmp")).toBe(true);
    });

    it("with custom env sets environment variables", async () => {
      const result = await nodeProcess.run({
        cmd: "sh",
        args: ["-c", "echo $TEST_VAR"],
        env: { TEST_VAR: "test_value" },
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      const stdout = new TextDecoder().decode(result.stdout).trim();
      expect(stdout).toBe("test_value");
    });

    it("with piped stdout collects output", async () => {
      const result = await nodeProcess.run({
        cmd: "seq",
        args: ["1", "5"],
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      const stdout = new TextDecoder().decode(result.stdout);
      expect(stdout.trim()).toBe("1\n2\n3\n4\n5");
    });
  });

  // ===== spawn() Tests =====
  describe("spawn", () => {
    it("creates child process", async () => {
      const child = nodeProcess.spawn({
        cmd: "sleep",
        args: ["0.1"],
        stdout: "null",
        stderr: "null",
      });

      expect(child).toBeDefined();
      expect(child.pid).toBeDefined();

      const result = await child.wait();
      expect(result.success).toBe(true);
      expect(result.code).toBe(0);
    });

    it("returns pid", async () => {
      const child = nodeProcess.spawn({
        cmd: "echo",
        args: ["test"],
        stdout: "null",
        stderr: "null",
      });

      // pid should be a positive number
      expect(typeof child.pid).toBe("number");
      expect(child.pid).toBeGreaterThan(0);

      // Wait for completion to avoid resource leak
      await child.wait();
    });

    it("with wait returns exit code", async () => {
      const child = nodeProcess.spawn({
        cmd: "sh",
        args: ["-c", "exit 42"],
        stdout: "null",
        stderr: "null",
      });

      const result = await child.wait();
      expect(result.code).toBe(42);
      expect(result.success).toBe(false);
    });

    it("unref allows parent to exit", async () => {
      const child = nodeProcess.spawn({
        cmd: "echo",
        args: ["test"],
        stdout: "null",
        stderr: "null",
      });

      // unref should not throw
      expect(() => child.unref()).not.toThrow();

      // Wait a bit for the process to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  // ===== Error Handling Tests =====
  describe("error handling", () => {
    it("run throws for non-existent command", async () => {
      await expect(
        nodeProcess.run({
          cmd: "nonexistent_command_12345",
          stdout: "piped",
          stderr: "piped",
        }),
      ).rejects.toThrow();
    });
  });

  // ===== Integration Tests =====
  describe("integration", () => {
    it("run with git --version succeeds", async () => {
      const result = await nodeProcess.run({
        cmd: "git",
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });

      expect(result.success).toBe(true);
      const stdout = new TextDecoder().decode(result.stdout);
      expect(stdout).toMatch(/git version/);
    });
  });
});
