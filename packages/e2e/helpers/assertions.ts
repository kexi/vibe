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
 * @param actual - The actual exit code
 * @param expected - The expected exit code
 * @param output - Optional output to include in error message for debugging
 */
export function assertExitCode(actual: number | null, expected: number, output?: string): void {
  if (actual !== expected && output) {
    console.error(`Exit code mismatch. Command output:\n${output}`);
  }
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

/**
 * Assert that the exit code is non-zero (error state)
 */
export function assertNonZeroExitCode(actual: number | null): void {
  expect(actual).not.toBe(0);
  expect(actual).not.toBeNull();
}

/**
 * Assert that output contains "Error" message
 */
export function assertErrorInOutput(output: string): void {
  expect(output).toContain("Error");
}

/**
 * Assert that output contains a specific git error pattern
 */
export function assertGitError(output: string, errorPattern: string): void {
  expect(output).toMatch(new RegExp(errorPattern, "i"));
}

/**
 * Assert that output contains a permission error
 */
export function assertPermissionError(output: string): void {
  const permissionPatterns = [
    /permission denied/i,
    /EACCES/i,
    /EPERM/i,
    /read-only/i,
    /cannot create directory/i,
  ];

  const hasPermissionError = permissionPatterns.some((pattern) => pattern.test(output));
  expect(hasPermissionError).toBe(true);
}

/**
 * Wait for a condition to be true using polling
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100, errorMessage } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await condition();
    if (result) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  const message = errorMessage ?? "Timeout waiting for condition";
  throw new Error(message);
}

/**
 * Wait for a path to not exist (be deleted)
 */
export async function waitForPathRemoval(
  path: string,
  options: {
    timeout?: number;
    interval?: number;
  } = {},
): Promise<void> {
  const isRemoved = !existsSync(path);
  if (isRemoved) return;

  await waitForCondition(() => !existsSync(path), {
    ...options,
    errorMessage: `Timeout waiting for path to be removed: ${path}`,
  });
}
