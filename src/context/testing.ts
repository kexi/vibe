/**
 * Testing utilities for AppContext
 *
 * This module provides mock factories for testing components
 * that depend on AppContext without requiring the full runtime.
 */

import type { AppContext, UserSettings } from "./index.ts";
import type {
  Runtime,
  RuntimeBuild,
  RuntimeControl,
  RuntimeEnv,
  RuntimeErrors,
  RuntimeFS,
  RuntimeIO,
  RuntimeProcess,
  RuntimeSignals,
} from "../runtime/types.ts";
import type { VibeConfig } from "../types/config.ts";

/**
 * Options for creating a mock runtime
 */
export interface MockRuntimeOptions {
  name?: "deno" | "node" | "bun";
  fs?: Partial<RuntimeFS>;
  process?: Partial<RuntimeProcess>;
  env?: Partial<RuntimeEnv>;
  build?: Partial<RuntimeBuild>;
  control?: Partial<RuntimeControl>;
  io?: Partial<RuntimeIO>;
  errors?: Partial<RuntimeErrors>;
  signals?: Partial<RuntimeSignals>;
}

/**
 * Create a mock RuntimeFS
 */
function createMockFS(overrides: Partial<RuntimeFS> = {}): RuntimeFS {
  return {
    readFile: () => Promise.resolve(new Uint8Array()),
    readTextFile: () => Promise.resolve(""),
    writeTextFile: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    stat: () =>
      Promise.resolve({
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        size: 0,
        mtime: null,
        atime: null,
        birthtime: null,
        mode: null,
      }),
    lstat: () =>
      Promise.resolve({
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        size: 0,
        mtime: null,
        atime: null,
        birthtime: null,
        mode: null,
      }),
    copyFile: () => Promise.resolve(),
    readDir: async function* () {},
    makeTempDir: () => Promise.resolve("/tmp/mock"),
    realPath: (path) => Promise.resolve(path),
    exists: () => Promise.resolve(false),
    ...overrides,
  };
}

/**
 * Create a mock RuntimeProcess
 */
function createMockProcess(overrides: Partial<RuntimeProcess> = {}): RuntimeProcess {
  return {
    run: () =>
      Promise.resolve({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }),
    spawn: () => ({
      pid: 12345,
      unref: () => {},
      wait: () => Promise.resolve({ code: 0, success: true }),
    }),
    ...overrides,
  };
}

/**
 * Create a mock RuntimeEnv
 */
function createMockEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  const envMap = new Map<string, string>();
  return {
    get: (key) => envMap.get(key),
    set: (key, value) => {
      envMap.set(key, value);
    },
    delete: (key) => {
      envMap.delete(key);
    },
    toObject: () => Object.fromEntries(envMap),
    ...overrides,
  };
}

/**
 * Create a mock RuntimeBuild
 */
function createMockBuild(overrides: Partial<RuntimeBuild> = {}): RuntimeBuild {
  return {
    os: "darwin",
    arch: "aarch64",
    ...overrides,
  };
}

/**
 * Create a mock RuntimeControl
 */
function createMockControl(overrides: Partial<RuntimeControl> = {}): RuntimeControl {
  return {
    exit: (() => {
      throw new Error("exit called");
    }) as never,
    chdir: () => {},
    cwd: () => "/mock/cwd",
    execPath: () => "/mock/exec",
    args: [],
    ...overrides,
  };
}

/**
 * Create a mock RuntimeIO
 */
function createMockIO(overrides: Partial<RuntimeIO> = {}): RuntimeIO {
  return {
    stdin: {
      read: () => Promise.resolve(null),
      isTerminal: () => false,
    },
    stderr: {
      writeSync: () => 0,
      write: () => Promise.resolve(0),
      isTerminal: () => false,
    },
    ...overrides,
  };
}

/**
 * Create a mock RuntimeErrors
 */
function createMockErrors(overrides: Partial<RuntimeErrors> = {}): RuntimeErrors {
  class MockNotFound extends Error {
    constructor(message?: string) {
      super(message ?? "Not found");
      this.name = "NotFound";
    }
  }

  class MockAlreadyExists extends Error {
    constructor(message?: string) {
      super(message ?? "Already exists");
      this.name = "AlreadyExists";
    }
  }

  class MockPermissionDenied extends Error {
    constructor(message?: string) {
      super(message ?? "Permission denied");
      this.name = "PermissionDenied";
    }
  }

  return {
    NotFound: MockNotFound,
    AlreadyExists: MockAlreadyExists,
    PermissionDenied: MockPermissionDenied,
    isNotFound: (error) => error instanceof MockNotFound,
    isAlreadyExists: (error) => error instanceof MockAlreadyExists,
    isPermissionDenied: (error) => error instanceof MockPermissionDenied,
    ...overrides,
  };
}

/**
 * Create a mock RuntimeSignals
 */
function createMockSignals(overrides: Partial<RuntimeSignals> = {}): RuntimeSignals {
  return {
    addListener: () => {},
    removeListener: () => {},
    ...overrides,
  };
}

/**
 * Create a mock Runtime for testing
 */
export function createMockRuntime(options: MockRuntimeOptions = {}): Runtime {
  return {
    name: options.name ?? "deno",
    fs: createMockFS(options.fs),
    process: createMockProcess(options.process),
    env: createMockEnv(options.env),
    build: createMockBuild(options.build),
    control: createMockControl(options.control),
    io: createMockIO(options.io),
    errors: createMockErrors(options.errors),
    signals: createMockSignals(options.signals),
  };
}

/**
 * Options for creating a mock AppContext
 */
export interface MockAppContextOptions extends MockRuntimeOptions {
  config?: VibeConfig;
  settings?: UserSettings;
}

/**
 * Create a mock AppContext for testing
 */
export function createMockContext(options: MockAppContextOptions = {}): AppContext {
  const { config, settings, ...runtimeOptions } = options;
  return {
    runtime: createMockRuntime(runtimeOptions),
    config,
    settings,
  };
}
