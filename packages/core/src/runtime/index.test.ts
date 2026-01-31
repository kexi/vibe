/**
 * Runtime detection and initialization tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  getRuntime,
  getRuntimeSync,
  initRuntime,
  IS_BUN,
  IS_DENO,
  IS_NODE,
  runtime,
  RUNTIME_NAME,
} from "./index.ts";

// Initialize runtime before tests
beforeAll(async () => {
  await initRuntime();
});

describe("Runtime Detection", () => {
  it("RUNTIME_NAME is 'bun' or 'node' when running on Bun/Node", () => {
    // In Bun environment, it should be 'bun', in Node it should be 'node'
    expect(["bun", "node"]).toContain(RUNTIME_NAME);
  });

  it("IS_DENO is false when running on Bun/Node", () => {
    expect(IS_DENO).toBe(false);
  });

  it("IS_NODE or IS_BUN is true when running on Bun/Node", () => {
    expect(IS_NODE || IS_BUN).toBe(true);
  });
});

describe("Runtime Initialization", () => {
  it("getRuntime returns a valid runtime instance", async () => {
    const rt = await getRuntime();
    expect(rt).toBeDefined();
    expect(rt.fs).toBeDefined();
    expect(rt.process).toBeDefined();
    expect(rt.env).toBeDefined();
    expect(rt.io).toBeDefined();
    expect(rt.signals).toBeDefined();
    expect(rt.control).toBeDefined();
  });

  it("getRuntime returns same instance on multiple calls", async () => {
    const rt1 = await getRuntime();
    const rt2 = await getRuntime();
    expect(rt1).toBe(rt2);
  });

  it("initRuntime returns a valid runtime instance", async () => {
    const rt = await initRuntime();
    expect(rt).toBeDefined();
    expect(rt.fs).toBeDefined();
  });

  it("getRuntimeSync returns runtime after initialization", async () => {
    // Ensure runtime is initialized
    await initRuntime();
    const rt = getRuntimeSync();
    expect(rt).toBeDefined();
    expect(rt.fs).toBeDefined();
  });
});

describe("Runtime Proxy", () => {
  it("provides access to fs", async () => {
    await initRuntime();
    expect(runtime.fs).toBeDefined();
    expect(runtime.fs.readTextFile).toBeDefined();
  });

  it("provides access to process", async () => {
    await initRuntime();
    expect(runtime.process).toBeDefined();
    expect(runtime.process.run).toBeDefined();
    expect(runtime.process.spawn).toBeDefined();
  });

  it("provides access to env", async () => {
    await initRuntime();
    expect(runtime.env).toBeDefined();
    expect(runtime.env.get).toBeDefined();
    expect(runtime.env.set).toBeDefined();
  });

  it("provides access to io", async () => {
    await initRuntime();
    expect(runtime.io).toBeDefined();
    expect(runtime.io.stderr).toBeDefined();
    expect(runtime.io.stdin).toBeDefined();
  });

  it("provides access to signals", async () => {
    await initRuntime();
    expect(runtime.signals).toBeDefined();
    expect(runtime.signals.addListener).toBeDefined();
  });

  it("provides access to control", async () => {
    await initRuntime();
    expect(runtime.control).toBeDefined();
    expect(runtime.control.exit).toBeDefined();
  });
});

describe("Concurrent Initialization", () => {
  it("concurrent getRuntime calls return same instance", async () => {
    // Call getRuntime multiple times concurrently
    const promises = [getRuntime(), getRuntime(), getRuntime(), getRuntime(), getRuntime()];

    const results = await Promise.all(promises);

    // All results should be the same instance
    const first = results[0];
    for (const rt of results) {
      expect(rt).toBe(first);
    }
  });
});
