import { describe, it, expect, vi, afterEach } from "vitest";
import { sortByMru, loadMruData, recordMruEntry, type MruEntry, _internal } from "./mru.ts";
import { createMockContext } from "../context/testing.ts";

describe("sortByMru", () => {
  it("returns original order when MRU is empty", () => {
    const matches = [
      { path: "/a", branch: "a" },
      { path: "/b", branch: "b" },
      { path: "/c", branch: "c" },
    ];

    const result = sortByMru(matches, []);

    expect(result).toEqual(matches);
  });

  it("puts MRU entries first", () => {
    const matches = [
      { path: "/a", branch: "a" },
      { path: "/b", branch: "b" },
      { path: "/c", branch: "c" },
    ];

    const mruEntries: MruEntry[] = [{ branch: "b", path: "/b", timestamp: 1000 }];

    const result = sortByMru(matches, mruEntries);

    expect(result[0].path).toBe("/b");
    expect(result[1].path).toBe("/a");
    expect(result[2].path).toBe("/c");
  });

  it("sorts MRU entries by timestamp descending", () => {
    const matches = [
      { path: "/a", branch: "a" },
      { path: "/b", branch: "b" },
      { path: "/c", branch: "c" },
    ];

    const mruEntries: MruEntry[] = [
      { branch: "a", path: "/a", timestamp: 1000 },
      { branch: "c", path: "/c", timestamp: 3000 },
    ];

    const result = sortByMru(matches, mruEntries);

    expect(result[0].path).toBe("/c"); // timestamp 3000 (most recent)
    expect(result[1].path).toBe("/a"); // timestamp 1000
    expect(result[2].path).toBe("/b"); // not in MRU
  });

  it("preserves original order for non-MRU entries", () => {
    const matches = [
      { path: "/a", branch: "a" },
      { path: "/b", branch: "b" },
      { path: "/c", branch: "c" },
      { path: "/d", branch: "d" },
    ];

    const mruEntries: MruEntry[] = [{ branch: "c", path: "/c", timestamp: 1000 }];

    const result = sortByMru(matches, mruEntries);

    expect(result[0].path).toBe("/c"); // MRU entry first
    expect(result[1].path).toBe("/a"); // original order preserved
    expect(result[2].path).toBe("/b");
    expect(result[3].path).toBe("/d");
  });

  it("handles all entries in MRU", () => {
    const matches = [
      { path: "/a", branch: "a" },
      { path: "/b", branch: "b" },
    ];

    const mruEntries: MruEntry[] = [
      { branch: "a", path: "/a", timestamp: 2000 },
      { branch: "b", path: "/b", timestamp: 3000 },
    ];

    const result = sortByMru(matches, mruEntries);

    expect(result[0].path).toBe("/b"); // timestamp 3000
    expect(result[1].path).toBe("/a"); // timestamp 2000
  });

  it("handles no entries in MRU", () => {
    const matches = [
      { path: "/x", branch: "x" },
      { path: "/y", branch: "y" },
    ];

    const mruEntries: MruEntry[] = [
      { branch: "a", path: "/a", timestamp: 1000 },
      { branch: "b", path: "/b", timestamp: 2000 },
    ];

    const result = sortByMru(matches, mruEntries);

    expect(result).toEqual(matches);
  });

  it("works with extra properties on matches", () => {
    const matches = [
      { path: "/a", branch: "a", score: 90 },
      { path: "/b", branch: "b", score: 80 },
    ];

    const mruEntries: MruEntry[] = [{ branch: "b", path: "/b", timestamp: 1000 }];

    const result = sortByMru(matches, mruEntries);

    expect(result[0]).toEqual({ path: "/b", branch: "b", score: 80 });
    expect(result[1]).toEqual({ path: "/a", branch: "a", score: 90 });
  });
});

describe("loadMruData", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when file does not exist", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.reject(new Error("ENOENT")),
      },
    });

    const result = await loadMruData(ctx);

    expect(result).toEqual([]);
  });

  it("returns empty array when file has invalid JSON", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve("not valid json"),
      },
    });

    const result = await loadMruData(ctx);

    expect(result).toEqual([]);
  });

  it("returns empty array when file contains non-array JSON", async () => {
    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve('{"not": "an array"}'),
      },
    });

    const result = await loadMruData(ctx);

    expect(result).toEqual([]);
  });

  it("filters out invalid entries", async () => {
    const data = [
      { branch: "valid", path: "/valid", timestamp: 1000 },
      { branch: "missing-timestamp", path: "/missing" },
      { branch: 123, path: "/invalid-branch", timestamp: 1000 },
      null,
      "string entry",
    ];

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve(JSON.stringify(data)),
      },
    });

    const result = await loadMruData(ctx);

    expect(result).toEqual([{ branch: "valid", path: "/valid", timestamp: 1000 }]);
  });

  it("returns valid entries from file", async () => {
    const entries: MruEntry[] = [
      { branch: "feat/a", path: "/repo-a", timestamp: 2000 },
      { branch: "feat/b", path: "/repo-b", timestamp: 1000 },
    ];

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve(JSON.stringify(entries)),
      },
    });

    const result = await loadMruData(ctx);

    expect(result).toEqual(entries);
  });
});

describe("recordMruEntry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a new entry to an empty file", async () => {
    let writtenContent = "";

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.reject(new Error("ENOENT")),
        writeTextFile: (_path: string, content: string) => {
          writtenContent = content;
          return Promise.resolve();
        },
        mkdir: () => Promise.resolve(),
        rename: () => Promise.resolve(),
      },
    });

    await recordMruEntry("feat/test", "/repo-test", ctx);

    const saved = JSON.parse(writtenContent);
    expect(saved).toHaveLength(1);
    expect(saved[0].branch).toBe("feat/test");
    expect(saved[0].path).toBe("/repo-test");
    expect(typeof saved[0].timestamp).toBe("number");
  });

  it("updates timestamp for existing path", async () => {
    const existing: MruEntry[] = [
      { branch: "feat/old", path: "/repo-test", timestamp: 1000 },
      { branch: "feat/other", path: "/repo-other", timestamp: 500 },
    ];
    let writtenContent = "";

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve(JSON.stringify(existing)),
        writeTextFile: (_path: string, content: string) => {
          writtenContent = content;
          return Promise.resolve();
        },
        mkdir: () => Promise.resolve(),
        rename: () => Promise.resolve(),
      },
    });

    await recordMruEntry("feat/new-name", "/repo-test", ctx);

    const saved = JSON.parse(writtenContent);
    expect(saved).toHaveLength(2);
    // New entry should be first (most recent)
    expect(saved[0].branch).toBe("feat/new-name");
    expect(saved[0].path).toBe("/repo-test");
    expect(saved[0].timestamp).toBeGreaterThan(1000);
    // Other entry should remain
    expect(saved[1].path).toBe("/repo-other");
  });

  it("trims old entries when exceeding max limit", async () => {
    const existing: MruEntry[] = Array.from({ length: _internal.MAX_MRU_ENTRIES }, (_, i) => ({
      branch: `feat/${i}`,
      path: `/repo-${i}`,
      timestamp: i * 100,
    }));
    let writtenContent = "";

    const ctx = createMockContext({
      env: {
        get: (key: string) => (key === "HOME" ? "/home/test" : undefined),
        set: () => {},
        delete: () => {},
        toObject: () => ({}),
      },
      fs: {
        readTextFile: () => Promise.resolve(JSON.stringify(existing)),
        writeTextFile: (_path: string, content: string) => {
          writtenContent = content;
          return Promise.resolve();
        },
        mkdir: () => Promise.resolve(),
        rename: () => Promise.resolve(),
      },
    });

    await recordMruEntry("feat/new", "/repo-new", ctx);

    const saved = JSON.parse(writtenContent);
    expect(saved).toHaveLength(_internal.MAX_MRU_ENTRIES);
    // New entry should be first
    expect(saved[0].branch).toBe("feat/new");
    expect(saved[0].path).toBe("/repo-new");
    // Last entry (highest index) should be trimmed off
    const hasLast = saved.some(
      (e: MruEntry) => e.path === `/repo-${_internal.MAX_MRU_ENTRIES - 1}`,
    );
    expect(hasLast).toBe(false);
    // First entry should still exist
    const hasFirst = saved.some((e: MruEntry) => e.path === "/repo-0");
    expect(hasFirst).toBe(true);
  });
});
