import { assertEquals } from "@std/assert";
import { assertArgument, handleError, withErrorHandler } from "./handler.ts";
import { createMockContext, setupTestContext } from "../context/testing.ts";
import { ErrorSeverity, HookExecutionError, UserCancelledError, VibeError } from "./index.ts";

// Initialize test context with mock runtime
setupTestContext();

// Helper to capture console output
function captureConsoleError(): { output: string[]; restore: () => void } {
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

// Test VibeError subclass for testing
class TestVibeError extends VibeError {
  readonly severity = ErrorSeverity.Fatal;
  readonly exitCode = 42;
}

Deno.test("handleError returns 1 for non-VibeError errors", () => {
  const stderr = captureConsoleError();

  const exitCode = handleError(new Error("Generic error"));

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Error: Generic error"));
  assertEquals(hasErrorMessage, true);
});

Deno.test("handleError returns 1 for string errors", () => {
  const stderr = captureConsoleError();

  const exitCode = handleError("String error message");

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasErrorMessage = stderr.output.some((line) =>
    line.includes("Error: String error message")
  );
  assertEquals(hasErrorMessage, true);
});

Deno.test("handleError handles DOMException TimeoutError", () => {
  const stderr = captureConsoleError();

  const error = new DOMException("Request timed out", "TimeoutError");
  const exitCode = handleError(error);

  stderr.restore();

  assertEquals(exitCode, 1);
  const hasTimeoutMessage = stderr.output.some((line) => line.includes("Request timed out"));
  assertEquals(hasTimeoutMessage, true);
  const hasNetworkMessage = stderr.output.some((line) => line.includes("network connection"));
  assertEquals(hasNetworkMessage, true);
});

Deno.test("handleError handles UserCancelledError silently", () => {
  const stderr = captureConsoleError();

  const error = new UserCancelledError();
  const exitCode = handleError(error);

  stderr.restore();

  assertEquals(exitCode, 130);
  // Default "Operation cancelled" message should not be printed
  const hasMessage = stderr.output.some((line) => line.includes("Operation cancelled"));
  assertEquals(hasMessage, false);
});

Deno.test("handleError handles UserCancelledError with custom message", () => {
  const stderr = captureConsoleError();

  const error = new UserCancelledError("User declined the action");
  const exitCode = handleError(error);

  stderr.restore();

  assertEquals(exitCode, 130);
  // Custom message should be printed
  const hasMessage = stderr.output.some((line) => line.includes("User declined the action"));
  assertEquals(hasMessage, true);
});

Deno.test("handleError handles HookExecutionError with warning", () => {
  const stderr = captureConsoleError();

  const error = new HookExecutionError("npm install", "exit code 1");
  const exitCode = handleError(error);

  stderr.restore();

  assertEquals(exitCode, 0); // Hooks don't cause non-zero exit
  const hasWarning = stderr.output.some((line) => line.includes("Warning:"));
  assertEquals(hasWarning, true);
});

Deno.test("handleError handles VibeError with correct exit code", () => {
  const stderr = captureConsoleError();

  const error = new TestVibeError("Test error message");
  const exitCode = handleError(error);

  stderr.restore();

  assertEquals(exitCode, 42);
  const hasErrorMessage = stderr.output.some((line) => line.includes("Error: Test error message"));
  assertEquals(hasErrorMessage, true);
});

Deno.test("handleError prints stack trace when verbose is true", () => {
  const stderr = captureConsoleError();

  const error = new Error("Error with stack");
  handleError(error, { verbose: true });

  stderr.restore();

  const hasStackTrace = stderr.output.some((line) => line.includes("Stack trace:"));
  assertEquals(hasStackTrace, true);
});

Deno.test("handleError suppresses output when quiet is true", () => {
  const stderr = captureConsoleError();

  handleError(new Error("Suppressed error"), { quiet: true });

  stderr.restore();

  assertEquals(stderr.output.length, 0);
});

Deno.test("handleError suppresses DOMException output when quiet is true", () => {
  const stderr = captureConsoleError();

  const error = new DOMException("Request timed out", "TimeoutError");
  handleError(error, { quiet: true });

  stderr.restore();

  assertEquals(stderr.output.length, 0);
});

Deno.test("withErrorHandler executes function successfully", async () => {
  let executed = false;

  const ctx = createMockContext({
    control: {
      exit: (() => {}) as never,
      cwd: () => "/mock/cwd",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  const wrappedFn = withErrorHandler(
    () => {
      executed = true;
      return Promise.resolve();
    },
    {},
    ctx,
  );

  await wrappedFn();

  assertEquals(executed, true);
});

Deno.test("withErrorHandler calls exit on error", async () => {
  let exitCode: number | undefined;
  const stderr = captureConsoleError();

  const ctx = createMockContext({
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

  const wrappedFn = withErrorHandler(
    () => {
      throw new Error("Test error");
    },
    {},
    ctx,
  );

  await wrappedFn();

  stderr.restore();

  assertEquals(exitCode, 1);
});

Deno.test("withErrorHandler does not call exit on exitCode 0", async () => {
  let exitCalled = false;
  const stderr = captureConsoleError();

  const ctx = createMockContext({
    control: {
      exit: (() => {
        exitCalled = true;
      }) as never,
      cwd: () => "/mock/cwd",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  const wrappedFn = withErrorHandler(
    () => {
      throw new HookExecutionError("npm install", "exit code 1");
    },
    {},
    ctx,
  );

  await wrappedFn();

  stderr.restore();

  assertEquals(exitCalled, false);
});

Deno.test("withErrorHandler passes arguments correctly", async () => {
  let capturedArgs: [string, number] | undefined;

  const ctx = createMockContext({
    control: {
      exit: (() => {}) as never,
      cwd: () => "/mock/cwd",
      chdir: () => {},
      execPath: () => "/mock/exec",
      args: [],
    },
  });

  const wrappedFn = withErrorHandler(
    (a: string, b: number) => {
      capturedArgs = [a, b];
      return Promise.resolve();
    },
    {},
    ctx,
  );

  await wrappedFn("test", 42);

  assertEquals(capturedArgs, ["test", 42]);
});

Deno.test("assertArgument passes when condition is true", () => {
  // Should not throw
  assertArgument(true, "This should pass");
  assertArgument(1 === 1, "Numbers should match");
  assertArgument("test".length > 0, "String should have length");
});

Deno.test("assertArgument throws when condition is false", () => {
  let threw = false;
  let errorMessage = "";

  try {
    assertArgument(false, "This should fail");
  } catch (error) {
    threw = true;
    if (error instanceof Error) {
      errorMessage = error.message;
    }
  }

  assertEquals(threw, true);
  assertEquals(errorMessage.includes("Argument error"), true);
  assertEquals(errorMessage.includes("This should fail"), true);
});

Deno.test("assertArgument includes argument name in error message", () => {
  let errorMessage = "";

  try {
    assertArgument(false, "Value must be positive", "count");
  } catch (error) {
    if (error instanceof Error) {
      errorMessage = error.message;
    }
  }

  assertEquals(errorMessage.includes("(count)"), true);
  assertEquals(errorMessage.includes("Value must be positive"), true);
});

Deno.test("assertArgument works as type assertion", () => {
  const value: string | undefined = "hello";

  // After assertArgument, TypeScript knows value is not undefined
  assertArgument(value !== undefined, "Value must be defined", "value");

  // This should compile without error
  const length: number = value.length;
  assertEquals(length, 5);
});
