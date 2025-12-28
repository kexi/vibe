import { assertEquals, AssertionError } from "@std/assert";

/**
 * Assert that output contains expected string
 */
export function assertOutputContains(output: string, expected: string): void {
  if (!output.includes(expected)) {
    throw new AssertionError(
      `Output does not contain expected string.\n` +
        `Expected: "${expected}"\n` +
        `Actual output:\n${output}`,
    );
  }
}

/**
 * Assert that the exit code matches the expected value
 */
export function assertExitCode(
  actual: number | null,
  expected: number,
): void {
  assertEquals(
    actual,
    expected,
    `Expected exit code ${expected}, got ${actual}`,
  );
}

/**
 * Assert that a directory exists at the given path
 */
export async function assertDirectoryExists(path: string): Promise<void> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      throw new AssertionError(`${path} exists but is not a directory`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new AssertionError(`Directory does not exist: ${path}`);
    }
    throw error;
  }
}

/**
 * Assert that a directory does not exist at the given path
 */
export async function assertDirectoryNotExists(path: string): Promise<void> {
  try {
    await Deno.stat(path);
    throw new AssertionError(`Directory should not exist: ${path}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Expected - directory does not exist
      return;
    }
    throw error;
  }
}
