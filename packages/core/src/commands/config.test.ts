import { assertEquals } from "@std/assert";
import { configCommand } from "./config.ts";
import { createMockContext } from "../context/testing.ts";

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

Deno.test("configCommand displays settings with default values when file not found", async () => {
  let exitCode: number | null = null;
  const stderr = captureStderr();

  const ctx = createMockContext({
    fs: {
      readTextFile: () => Promise.reject(new Error("File not found")),
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
        if (key === "XDG_CONFIG_HOME") return undefined;
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
    errors: {
      isNotFound: (error: unknown) => error instanceof Error && error.message === "File not found",
    },
  });

  await configCommand(ctx);

  stderr.restore();

  // Should not exit with error - defaults are used
  assertEquals(exitCode, null);

  // Should display settings file path
  const hasSettingsFile = stderr.output.some((line) => line.includes("Settings file:"));
  assertEquals(
    hasSettingsFile,
    true,
    `Expected settings file path but got: ${stderr.output.join("\n")}`,
  );

  // Should display permissions in JSON output
  const hasPermissions = stderr.output.some((line) => line.includes("permissions"));
  assertEquals(
    hasPermissions,
    true,
    `Expected permissions in output but got: ${stderr.output.join("\n")}`,
  );
});
