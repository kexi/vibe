import { describe, it, expect, beforeAll } from "vitest";
import { ProgressTracker } from "./progress.ts";
import { setupTestContext } from "../context/testing.ts";

// Initialize test context for modules that depend on getGlobalContext()
beforeAll(() => {
  setupTestContext();
});

describe("ProgressTracker", () => {
  describe("constructor", () => {
    it("creates with default options", () => {
      const tracker = new ProgressTracker({ enabled: false });
      expect(tracker.isEnabled()).toBe(false);
    });

    it("validates spinnerFrames", () => {
      expect(() => {
        new ProgressTracker({ enabled: false, spinnerFrames: [] });
      }).toThrow("spinnerFrames must contain at least one frame");
    });

    it("validates updateInterval minimum", () => {
      expect(() => {
        new ProgressTracker({ enabled: false, updateInterval: 10 });
      }).toThrow("updateInterval must be between 16ms and 1000ms");
    });

    it("validates updateInterval maximum", () => {
      expect(() => {
        new ProgressTracker({ enabled: false, updateInterval: 2000 });
      }).toThrow("updateInterval must be between 16ms and 1000ms");
    });
  });

  describe("addPhase", () => {
    it("returns phase ID", () => {
      const tracker = new ProgressTracker({ enabled: false });
      const phaseId = tracker.addPhase("Test phase");
      expect(typeof phaseId).toBe("string");
      expect(phaseId.startsWith("node-")).toBe(true);
    });
  });

  describe("addTask", () => {
    it("returns task ID", () => {
      const tracker = new ProgressTracker({ enabled: false });
      const phaseId = tracker.addPhase("Test phase");
      const taskId = tracker.addTask(phaseId, "Test task");
      expect(typeof taskId).toBe("string");
      expect(taskId.startsWith("node-")).toBe(true);
    });

    it("throws for non-existent phase", () => {
      const tracker = new ProgressTracker({ enabled: false });
      expect(() => {
        tracker.addTask("non-existent-id", "Test task");
      }).toThrow("Phase not found");
    });
  });

  describe("task operations", () => {
    it("startTask is no-op for non-existent task when disabled", () => {
      const tracker = new ProgressTracker({ enabled: false });
      // When disabled, operations are no-ops and don't throw
      tracker.startTask("non-existent-id");
    });

    it("completeTask is no-op for non-existent task when disabled", () => {
      const tracker = new ProgressTracker({ enabled: false });
      // When disabled, operations are no-ops and don't throw
      tracker.completeTask("non-existent-id");
    });

    it("failTask is no-op for non-existent task when disabled", () => {
      const tracker = new ProgressTracker({ enabled: false });
      // When disabled, operations are no-ops and don't throw
      tracker.failTask("non-existent-id");
    });
  });

  describe("finish", () => {
    it("can be called multiple times safely", async () => {
      const tracker = new ProgressTracker({ enabled: false });
      await tracker.finish();
      await tracker.finish();
      await tracker.finish();
      // Should not throw
    });
  });

  describe("workflow", () => {
    it("start and finish work correctly", async () => {
      const tracker = new ProgressTracker({ enabled: false });
      tracker.start();
      await tracker.finish();
      // Should not throw
    });

    it("complete workflow executes correctly", async () => {
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
      await tracker.finish();

      // Should not throw
    });
  });

  describe("TTY detection", () => {
    it("defaults correctly based on environment", async () => {
      // Create tracker without explicit enabled option
      const tracker = new ProgressTracker();

      // In test environment (non-TTY), should be disabled
      // Note: exact behavior depends on runtime environment
      expect(typeof tracker.isEnabled()).toBe("boolean");

      await tracker.finish();
    });
  });

  describe("custom options", () => {
    it("accepts custom title", async () => {
      const customTitle = "Custom Operation";
      const tracker = new ProgressTracker({
        enabled: false,
        title: customTitle,
      });

      // Can't directly test the title rendering without mocking,
      // but constructor should accept it without error
      await tracker.finish();
    });
  });
});
