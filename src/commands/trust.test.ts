import { assertEquals } from "@std/assert";
import { trustCommand } from "./trust.ts";
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

Deno.test("trustCommand exits with code 1 when no config files exist", async () => {
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

  await trustCommand(ctx);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) =>
    line.includes("Neither .vibe.toml nor .vibe.local.toml found")
  );
  assertEquals(hasErrorMessage, true);
});

Deno.test("trustCommand reports error when trust fails", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  let statCallCount = 0;
  const ctx = createMockContext({
    fs: {
      stat: () => {
        statCallCount++;
        // .vibe.toml exists
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
        // .vibe.local.toml doesn't exist
        return Promise.reject(new Error("File not found"));
      },
      readTextFile: () => Promise.resolve(""),
      readFile: () => Promise.reject(new Error("Cannot read file")),
      writeTextFile: () => Promise.resolve(),
      mkdir: () => Promise.resolve(),
    },
    process: {
      run: (opts) => {
        const args = opts.args as string[];
        if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("/tmp/mock-repo\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        if (args.includes("remote") && args.includes("get-url")) {
          return Promise.resolve({
            code: 0,
            success: true,
            stdout: new TextEncoder().encode("git@github.com:test/repo.git\n"),
            stderr: new Uint8Array(),
          } as RunResult);
        }
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        } as RunResult);
      },
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
    env: {
      get: (key: string) => {
        if (key === "HOME") return "/tmp/home";
        return undefined;
      },
      set: () => {},
      delete: () => {},
      toObject: () => ({}),
    },
    build: {
      os: "darwin",
      arch: "aarch64",
    },
  });

  await trustCommand(ctx);

  stderr.restore();

  // Should exit with error
  assertEquals(exitCode, 1);

  // Should show error message
  const hasFailedMessage = stderr.output.some((line) => line.includes("Failed to trust"));
  assertEquals(
    hasFailedMessage,
    true,
    `Expected failed message but got: ${stderr.output.join("\n")}`,
  );
});
