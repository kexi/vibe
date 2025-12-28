import { existsSync, statSync } from "fs";
import { expect } from "vitest";

/**
 * Assert that output contains expected string
 */
export function assertOutputContains(output: string, expected: string): void {
  expect(output).toContain(expected);
}

/**
 * Assert that the exit code matches the expected value
 */
export function assertExitCode(
  actual: number | null,
  expected: number,
): void {
  expect(actual).toBe(expected);
}

/**
 * Assert that a directory exists at the given path
 */
export async function assertDirectoryExists(path: string): Promise<void> {
  expect(existsSync(path)).toBe(true);
  const stats = statSync(path);
  expect(stats.isDirectory()).toBe(true);
}

/**
 * Assert that a directory does not exist at the given path
 */
export async function assertDirectoryNotExists(path: string): Promise<void> {
  expect(existsSync(path)).toBe(false);
}
