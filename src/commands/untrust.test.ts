import { assertEquals } from "@std/assert";
import { untrustCommand } from "./untrust.ts";
import { createMockContext } from "../context/testing.ts";
import type { ProcessResult } from "../runtime/types.ts";

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

Deno.test("untrustCommand exits with code 1 when no config files exist", async () => {
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
        } as ProcessResult),
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

  await untrustCommand(ctx);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) =>
    line.includes("Neither .vibe.toml nor .vibe.local.toml found")
  );
  assertEquals(hasErrorMessage, true);
});

Deno.test("untrustCommand shows error on exception", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    fs: {
      stat: () => Promise.reject(new Error("File not found")),
    },
    process: {
      run: () => Promise.reject(new Error("git command failed")),
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

  await untrustCommand(ctx);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) =>
    line.includes("Error:")
  );
  assertEquals(hasErrorMessage, true);
});
