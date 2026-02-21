import { describe, it, expect } from "vitest";
import { withConcurrencyLimit } from "./copy-runner.ts";

describe("withConcurrencyLimit", () => {
  it("executes all items", async () => {
    const results: number[] = [];
    await withConcurrencyLimit([1, 2, 3, 4, 5], 3, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects concurrency limit", async () => {
    let currentConcurrency = 0;
    let maxConcurrency = 0;

    await withConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      currentConcurrency++;
      maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      currentConcurrency--;
    });

    expect(maxConcurrency).toBeLessThanOrEqual(2);
  });

  it("handles empty items array", async () => {
    const results: number[] = [];
    await withConcurrencyLimit([], 3, async (item) => {
      results.push(item);
    });
    expect(results).toEqual([]);
  });

  it("handles limit larger than items", async () => {
    const results: number[] = [];
    await withConcurrencyLimit([1, 2], 10, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2]);
  });

  it("passes correct index to handler", async () => {
    const indices: number[] = [];
    await withConcurrencyLimit(["a", "b", "c"], 2, async (_item, index) => {
      indices.push(index);
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});
