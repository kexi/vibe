import { describe, it, expect, vi } from "vitest";
import { withConcurrencyLimit, resolveCopyConcurrency } from "./copy-runner.ts";
import { createMockContext } from "../context/testing.ts";

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

describe("resolveCopyConcurrency", () => {
  it("returns default value when no env or config is set", () => {
    const ctx = createMockContext({
      env: { get: () => undefined },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(4);
  });

  it("returns config value when set and no env override", () => {
    const ctx = createMockContext({
      env: { get: () => undefined },
    });
    const result = resolveCopyConcurrency({ copy: { concurrency: 8 } }, ctx);
    expect(result).toBe(8);
  });

  it("returns env value when valid", () => {
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "16" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(16);
  });

  it("env value overrides config value", () => {
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "10" : undefined) },
    });
    const result = resolveCopyConcurrency({ copy: { concurrency: 8 } }, ctx);
    expect(result).toBe(10);
  });

  it("returns default for env value of 0", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "0" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(4);
    warnSpy.mockRestore();
  });

  it("returns default for negative env value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "-1" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(4);
    warnSpy.mockRestore();
  });

  it("returns default for env value exceeding max (33)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "33" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(4);
    warnSpy.mockRestore();
  });

  it("returns default for non-numeric env value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "abc" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(4);
    warnSpy.mockRestore();
  });

  it("accepts boundary value of 1", () => {
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "1" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(1);
  });

  it("accepts boundary value of 32", () => {
    const ctx = createMockContext({
      env: { get: (key: string) => (key === "VIBE_COPY_CONCURRENCY" ? "32" : undefined) },
    });
    const result = resolveCopyConcurrency(undefined, ctx);
    expect(result).toBe(32);
  });
});
