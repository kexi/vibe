import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shellSetupCommand } from "./shell-setup.ts";
import { createMockContext } from "../context/testing.ts";

describe("shellSetupCommand", () => {
  let stderrOutput: string[];
  let stdoutOutput: string[];
  let originalError: typeof console.error;
  let originalLog: typeof console.log;

  beforeEach(() => {
    stderrOutput = [];
    stdoutOutput = [];
    originalError = console.error;
    originalLog = console.log;
    console.error = vi.fn((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
    console.log = vi.fn((...args: unknown[]) => {
      stdoutOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    console.error = originalError;
    console.log = originalLog;
  });

  it("outputs bash/zsh function when SHELL is /bin/zsh", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/bin/zsh" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe(`vibe() { eval "$(command vibe "$@")"; }`);
  });

  it("outputs bash/zsh function when SHELL is /bin/bash", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/bin/bash" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe(`vibe() { eval "$(command vibe "$@")"; }`);
  });

  it("outputs fish function when SHELL is /usr/bin/fish", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/usr/bin/fish" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe("function vibe; eval (command vibe $argv); end");
  });

  it("outputs nushell function when SHELL contains nu", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/usr/bin/nu" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe(
      "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }",
    );
  });

  it("outputs powershell function when SHELL contains pwsh", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/usr/local/bin/pwsh" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe("function vibe { Invoke-Expression (& vibe.exe $args) }");
  });

  it("--shell flag overrides SHELL env var", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/bin/zsh" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({ shell: "fish" }, ctx);

    expect(stdoutOutput).toHaveLength(1);
    expect(stdoutOutput[0]).toBe("function vibe; eval (command vibe $argv); end");
  });

  it("exits with error when SHELL is not set and --shell is not provided", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      env: {
        get: () => undefined,
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Could not detect shell"));
    expect(hasErrorMessage).toBe(true);
  });

  it("exits with error for unsupported shell", async () => {
    let exitCode: number | null = null;

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/usr/bin/csh" : undefined),
      },
      control: {
        exit: ((code: number) => {
          exitCode = code;
        }) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({}, ctx);

    expect(exitCode).toBe(1);
    const hasErrorMessage = stderrOutput.some((line) => line.includes("Could not detect shell"));
    expect(hasErrorMessage).toBe(true);
  });

  it("shows verbose output when verbose option is enabled", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/bin/zsh" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({ verbose: true }, ctx);

    const hasVerboseMessage = stderrOutput.some((line) => line.includes("Detected shell: zsh"));
    expect(hasVerboseMessage).toBe(true);
  });

  it("suppresses verbose output with quiet option", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "SHELL" ? "/bin/zsh" : undefined),
      },
      control: {
        exit: (() => {}) as never,
        cwd: () => "/mock/cwd",
        chdir: () => {},
        execPath: () => "/mock/exec",
        args: [],
      },
    });

    await shellSetupCommand({ verbose: true, quiet: true }, ctx);

    const hasVerboseMessage = stderrOutput.some((line) => line.includes("Detected shell"));
    expect(hasVerboseMessage).toBe(false);
    // stdout should still have the function
    expect(stdoutOutput).toHaveLength(1);
  });
});
