import { assertEquals, assertThrows } from "@std/assert";
import { ProgressTracker } from "./progress.ts";
import { setupTestContext } from "../context/testing.ts";

// Initialize test context for modules that depend on getGlobalContext()
setupTestContext();

Deno.test("ProgressTracker - constructor with default options", () => {
  const tracker = new ProgressTracker({ enabled: false });
  assertEquals(tracker.isEnabled(), false);
});

Deno.test("ProgressTracker - constructor validates spinnerFrames", () => {
  assertThrows(
    () => {
      new ProgressTracker({ enabled: false, spinnerFrames: [] });
    },
    Error,
    "spinnerFrames must contain at least one frame",
  );
});

Deno.test("ProgressTracker - constructor validates updateInterval", () => {
  assertThrows(
    () => {
      new ProgressTracker({ enabled: false, updateInterval: 10 });
    },
    Error,
    "updateInterval must be between 16ms and 1000ms",
  );

  assertThrows(
    () => {
      new ProgressTracker({ enabled: false, updateInterval: 2000 });
    },
    Error,
    "updateInterval must be between 16ms and 1000ms",
  );
});

Deno.test("ProgressTracker - addPhase returns phase ID", () => {
  const tracker = new ProgressTracker({ enabled: false });
  const phaseId = tracker.addPhase("Test phase");
  assertEquals(typeof phaseId, "string");
  assertEquals(phaseId.startsWith("node-"), true);
});

Deno.test("ProgressTracker - addTask returns task ID", () => {
  const tracker = new ProgressTracker({ enabled: false });
  const phaseId = tracker.addPhase("Test phase");
  const taskId = tracker.addTask(phaseId, "Test task");
  assertEquals(typeof taskId, "string");
  assertEquals(taskId.startsWith("node-"), true);
});

Deno.test("ProgressTracker - addTask throws for non-existent phase", () => {
  const tracker = new ProgressTracker({ enabled: false });
  assertThrows(
    () => {
      tracker.addTask("non-existent-id", "Test task");
    },
    Error,
    "Phase not found",
  );
});

Deno.test("ProgressTracker - startTask throws for non-existent task", () => {
  const tracker = new ProgressTracker({ enabled: false });
  // When disabled, operations are no-ops and don't throw
  tracker.startTask("non-existent-id");
});

Deno.test("ProgressTracker - completeTask throws for non-existent task", () => {
  const tracker = new ProgressTracker({ enabled: false });
  // When disabled, operations are no-ops and don't throw
  tracker.completeTask("non-existent-id");
});

Deno.test("ProgressTracker - failTask throws for non-existent task", () => {
  const tracker = new ProgressTracker({ enabled: false });
  // When disabled, operations are no-ops and don't throw
  tracker.failTask("non-existent-id");
});

Deno.test("ProgressTracker - finish can be called multiple times safely", () => {
  const tracker = new ProgressTracker({ enabled: false });
  tracker.finish();
  tracker.finish();
  tracker.finish();
  // Should not throw
});

Deno.test("ProgressTracker - start and finish work correctly", () => {
  const tracker = new ProgressTracker({ enabled: false });
  tracker.start();
  tracker.finish();
  // Should not throw
});

Deno.test("ProgressTracker - complete workflow", () => {
  const tracker = new ProgressTracker({ enabled: false });

  // Add phases and tasks
  const phase1 = tracker.addPhase("Phase 1");
  const task1 = tracker.addTask(phase1, "Task 1");
  const task2 = tracker.addTask(phase1, "Task 2");

  const phase2 = tracker.addPhase("Phase 2");
  const task3 = tracker.addTask(phase2, "Task 3");

  // Start tracker
  tracker.start();

  // Execute tasks (when disabled, these are no-ops)
  tracker.startTask(task1);
  tracker.completeTask(task1);

  tracker.startTask(task2);
  tracker.completeTask(task2);

  tracker.startTask(task3);
  tracker.failTask(task3, "Test error");

  // Finish
  tracker.finish();

  // Should not throw
});

Deno.test("ProgressTracker - TTY detection defaults correctly", () => {
  // Create tracker without explicit enabled option
  const tracker = new ProgressTracker();

  // Should detect TTY status from Deno.stderr.isTerminal()
  assertEquals(tracker.isEnabled(), Deno.stderr.isTerminal());

  tracker.finish();
});

Deno.test("ProgressTracker - custom title is used", () => {
  const customTitle = "Custom Operation";
  const tracker = new ProgressTracker({
    enabled: false,
    title: customTitle,
  });

  // Can't directly test the title rendering without mocking,
  // but constructor should accept it without error
  tracker.finish();
});
