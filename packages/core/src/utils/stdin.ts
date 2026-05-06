import { isAbsolute } from "node:path";
import { validatePath } from "./copy/validation.ts";
import { validateWorktreePath } from "./worktree-path-validation.ts";
import { warnLog } from "./output.ts";
import type { AppContext } from "../context/index.ts";

/** Maximum stdin payload size in bytes (1 MB) to prevent resource exhaustion */
const MAX_STDIN_SIZE = 1024 * 1024;

/**
 * Read and parse JSON from stdin.
 * Returns the parsed object, or undefined if stdin is empty, interactive, or not valid JSON.
 *
 * Security: enforces a 1 MB size limit to prevent resource exhaustion.
 */
export async function readStdinJson(ctx: AppContext): Promise<Record<string, unknown> | undefined> {
  const isInteractive = ctx.runtime.io.stdin.isTerminal();
  if (isInteractive) return undefined;

  try {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(4096);
    let totalLength = 0;
    let bytesRead = await ctx.runtime.io.stdin.read(buf);
    while (bytesRead !== null && bytesRead > 0) {
      totalLength += bytesRead;
      // Guard against excessively large stdin payloads (max 1 MB)
      const exceedsMaxSize = totalLength > MAX_STDIN_SIZE;
      if (exceedsMaxSize) {
        warnLog(`Warning: stdin payload exceeds ${MAX_STDIN_SIZE} bytes, ignoring.`);
        return undefined;
      }

      chunks.push(buf.slice(0, bytesRead));
      bytesRead = await ctx.runtime.io.stdin.read(buf);
    }

    const hasNoInput = totalLength === 0;
    if (hasNoInput) return undefined;

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const text = new TextDecoder().decode(combined).trim();
    const hasNoText = text.length === 0;
    if (hasNoText) return undefined;

    const json = JSON.parse(text);
    const isObject = json !== null && typeof json === "object" && !Array.isArray(json);
    if (!isObject) return undefined;

    return json as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Read worktree name from stdin JSON (Claude Code WorktreeCreate hook format).
 * Expects `{"name": "feature-auth", ...}` on stdin.
 * Returns the name value, or undefined if stdin is empty or not valid.
 */
export async function readWorktreeHookName(ctx: AppContext): Promise<string | undefined> {
  const json = await readStdinJson(ctx);
  if (json === undefined) return undefined;

  const name = json.name;
  const isValidName = typeof name === "string" && name.length > 0;
  if (!isValidName) return undefined;

  // Defense-in-depth: reject null bytes in name (git also rejects these)
  const hasNullByte = name.includes("\0");
  if (hasNullByte) return undefined;

  return name;
}

/**
 * Read worktree path from stdin JSON (Claude Code WorktreeRemove hook format).
 * Expects `{"worktree_path": "/path/to/worktree", ...}` on stdin.
 * Returns the worktree_path value, or undefined if stdin is empty or not valid.
 *
 * Security: validates the path is absolute and passes validatePath().
 */
export async function readWorktreeHookPath(ctx: AppContext): Promise<string | undefined> {
  const json = await readStdinJson(ctx);
  if (json === undefined) return undefined;

  const worktreePath = json.worktree_path;
  const isValidPath = typeof worktreePath === "string" && worktreePath.length > 0;
  if (!isValidPath) return undefined;

  // Security: validate the path from untrusted stdin input
  const isAbsolutePath = isAbsolute(worktreePath);
  if (!isAbsolutePath) return undefined;

  try {
    validatePath(worktreePath);
    return validateWorktreePath(worktreePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnLog(`Warning: rejected worktree_path from stdin: ${reason}`);
    return undefined;
  }
}
