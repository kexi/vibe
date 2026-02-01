import { describe, it, expect, vi, afterEach } from "vitest";
import { configCommand } from "./config.ts";
import { createMockContext } from "../context/testing.ts";

describe("configCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays settings with default values when file not found", async () => {
    let exitCode: number | null = null;
    const stderrOutput: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });

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
        isNotFound: (error: unknown) =>
          error instanceof Error && error.message === "File not found",
      },
    });

    await configCommand(ctx);

    consoleErrorSpy.mockRestore();

    // Should not exit with error - defaults are used
    expect(exitCode).toBeNull();

    // Should display settings file path
    const hasSettingsFile = stderrOutput.some((line) => line.includes("Settings file:"));
    expect(hasSettingsFile).toBe(true);

    // Should display permissions in JSON output
    const hasPermissions = stderrOutput.some((line) => line.includes("permissions"));
    expect(hasPermissions).toBe(true);
  });
});
