import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readStdinJson,
  readWorktreeHookName,
  readWorktreeHookPath,
  readTargetFromStdin,
} from "./stdin.ts";
import { createMockContext } from "../context/testing.ts";
import type { RuntimeIO } from "../runtime/types.ts";

/**
 * Create a mock stdin that returns the given data bytes, then EOF.
 */
function createMockStdin(data: string, isTerminal = false): RuntimeIO["stdin"] {
  const encoded = new TextEncoder().encode(data);
  let offset = 0;
  return {
    read: (buf: Uint8Array) => {
      const isEof = offset >= encoded.length;
      if (isEof) return Promise.resolve(null);
      const remaining = encoded.length - offset;
      const bytesToCopy = Math.min(remaining, buf.length);
      buf.set(encoded.subarray(offset, offset + bytesToCopy));
      offset += bytesToCopy;
      return Promise.resolve(bytesToCopy);
    },
    isTerminal: () => isTerminal,
  };
}

/**
 * Create a mock stdin that returns EOF immediately (empty stdin).
 */
function createEmptyStdin(isTerminal = false): RuntimeIO["stdin"] {
  return {
    read: () => Promise.resolve(null),
    isTerminal: () => isTerminal,
  };
}

describe("readStdinJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when stdin is a terminal", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin(true) },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when stdin is empty", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin() },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined for whitespace-only stdin", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin("   \n  \t  ") },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid JSON", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin("not valid json{{{") },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined for JSON array", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin("[1, 2, 3]") },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined for JSON string", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin('"hello"') },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined for JSON null", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin("null") },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });

  it("returns parsed object for valid JSON", async () => {
    const input = { name: "test-branch", cwd: "/tmp/test" };
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify(input)) },
    });

    const result = await readStdinJson(ctx);

    expect(result).toEqual(input);
  });

  it("trims whitespace around JSON", async () => {
    const input = { key: "value" };
    const ctx = createMockContext({
      io: { stdin: createMockStdin(`  \n${JSON.stringify(input)}\n  `) },
    });

    const result = await readStdinJson(ctx);

    expect(result).toEqual(input);
  });

  it("returns undefined when stdin exceeds 1 MB", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oversizedPayload = "x".repeat(1024 * 1024 + 1);
    const ctx = createMockContext({
      io: { stdin: createMockStdin(oversizedPayload) },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
    const hasWarning = consoleWarnSpy.mock.calls.some((args) =>
      args.some((arg) => String(arg).includes("stdin payload exceeds")),
    );
    expect(hasWarning).toBe(true);

    consoleWarnSpy.mockRestore();
  });

  it("returns undefined when read throws an error", async () => {
    const ctx = createMockContext({
      io: {
        stdin: {
          read: () => Promise.reject(new Error("read error")),
          isTerminal: () => false,
        },
      },
    });

    const result = await readStdinJson(ctx);

    expect(result).toBeUndefined();
  });
});

describe("readWorktreeHookName", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns name from valid stdin JSON", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ name: "feature-auth" })) },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBe("feature-auth");
  });

  it("returns undefined when stdin is empty", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin() },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when stdin is a terminal", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin(true) },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when name field is missing", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ cwd: "/tmp/test" })) },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when name field is empty string", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ name: "" })) },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when name field is not a string", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ name: 123 })) },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBeUndefined();
  });

  it("reads name with extra fields present", async () => {
    const ctx = createMockContext({
      io: {
        stdin: createMockStdin(
          JSON.stringify({ name: "my-branch", cwd: "/tmp/project", session_id: "abc" }),
        ),
      },
    });

    const result = await readWorktreeHookName(ctx);

    expect(result).toBe("my-branch");
  });
});

describe("readWorktreeHookPath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns worktree_path from valid stdin JSON", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ worktree_path: "/tmp/worktree" })) },
    });

    const result = await readWorktreeHookPath(ctx);

    expect(result).toBe("/tmp/worktree");
  });

  it("returns undefined when stdin is empty", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin() },
    });

    const result = await readWorktreeHookPath(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when worktree_path field is missing", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ name: "test" })) },
    });

    const result = await readWorktreeHookPath(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when worktree_path is a relative path", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ worktree_path: "./relative/path" })) },
    });

    const result = await readWorktreeHookPath(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when worktree_path is empty", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ worktree_path: "" })) },
    });

    const result = await readWorktreeHookPath(ctx);

    expect(result).toBeUndefined();
  });

  it("throws when worktree_path contains null byte", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ worktree_path: "/tmp/test\0malicious" })) },
    });

    await expect(readWorktreeHookPath(ctx)).rejects.toThrow("null byte");
  });
});

describe("readTargetFromStdin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cwd from valid stdin JSON", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ cwd: "/tmp/worktree" })) },
    });

    const result = await readTargetFromStdin(ctx);

    expect(result).toBe("/tmp/worktree");
  });

  it("returns undefined when stdin is empty", async () => {
    const ctx = createMockContext({
      io: { stdin: createEmptyStdin() },
    });

    const result = await readTargetFromStdin(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when cwd field is missing", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ name: "test" })) },
    });

    const result = await readTargetFromStdin(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when cwd is a relative path", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ cwd: "./relative/path" })) },
    });

    const result = await readTargetFromStdin(ctx);

    expect(result).toBeUndefined();
  });

  it("returns undefined when cwd is an empty string", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ cwd: "" })) },
    });

    const result = await readTargetFromStdin(ctx);

    expect(result).toBeUndefined();
  });

  it("throws when cwd contains null byte", async () => {
    const ctx = createMockContext({
      io: { stdin: createMockStdin(JSON.stringify({ cwd: "/tmp/test\0malicious" })) },
    });

    await expect(readTargetFromStdin(ctx)).rejects.toThrow("null byte");
  });
});
