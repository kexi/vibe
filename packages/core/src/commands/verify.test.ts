import { assertEquals } from "@std/assert";
import { verifyCommand } from "./verify.ts";
import { createMockContext } from "../context/testing.ts";
import type { FileInfo, RunResult } from "../runtime/types.ts";

// Helper to capture console output
function captureStderr(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  return {
    output,
    restore: () => {
      console.error = originalError;
    },
  };
}

Deno.test("verifyCommand exits with code 1 when no config files exist", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
    },
    process: {
      run: () =>
        Promise.resolve({
          code: 0,
          success: true,
          stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
          stderr: new Uint8Array(),
        } as RunResult),
    },
    control: {
      exit: ((code: number) => {
        exitCode = code;
      }) as never,
      cwd: () => "/tmp/mock-repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  await verifyCommand(ctx);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) =>
    line.includes("Neither .vibe.toml nor .vibe.local.toml found")
  );
  assertEquals(hasErrorMessage, true);
});

Deno.test("verifyCommand shows file path when config file exists", async () => {
  const stderr = captureStderr();

  let statCallCount = 0;
  const ctx = createMockContext({
    fs: {
      stat: (_path: string | URL) => {
        statCallCount++;
        // First call is for .vibe.toml - let it succeed
        if (statCallCount === 1) {
          return Promise.resolve({
            isFile: true,
            isDirectory: false,
            isSymlink: false,
            size: 100,
            mtime: null,
            atime: null,
            birthtime: null,
            mode: null,
          } as FileInfo);
        }
        // Second call is for .vibe.local.toml - not found
        return Promise.reject(new Error("File not found"));
      },
      readTextFile: () => Promise.resolve(""),
    },
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        // Mock git rev-parse --show-toplevel
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        // Mock git remote get-url origin (fail - local repo)
        if (args.includes("remote") && args.includes("get-url")) {
          return Promise.resolve({
            code: 1,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("fatal: not a git repository"),
          } as RunResult);
        }
        // Default mock for other git commands
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
    },
    control: {
      exit: (() => {}) as never,
      cwd: () => "/tmp/mock-repo",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  await verifyCommand(ctx);

  stderr.restore();

  // Should show verification header
  const hasHeader = stderr.output.some((line) => line.includes("Vibe Configuration Verification"));
  assertEquals(
    hasHeader,
    true,
    `Expected header but got: ${stderr.output.join("\n")}`,
  );

  // Should show file path
  const hasFilePath = stderr.output.some((line) => line.includes("File: .vibe.toml"));
  assertEquals(
    hasFilePath,
    true,
    `Expected file path but got: ${stderr.output.join("\n")}`,
  );
});
