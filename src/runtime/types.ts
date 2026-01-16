/**
 * Runtime abstraction layer types
 *
 * This module defines interfaces for runtime-agnostic operations,
 * allowing the vibe CLI to run on Deno, Node.js, and Bun.
 */

// ===== File System Types =====

/**
 * File information returned by stat operations
 */
export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  mode: number | null;
}

/**
 * Directory entry returned by readDir operations
 */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/**
 * Options for mkdir operations
 */
export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

/**
 * Options for remove operations
 */
export interface RemoveOptions {
  recursive?: boolean;
}

/**
 * Runtime file system interface
 */
export interface RuntimeFS {
  /**
   * Read file contents as Uint8Array
   */
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Read file contents as UTF-8 string
   */
  readTextFile(path: string): Promise<string>;

  /**
   * Write text content to a file
   */
  writeTextFile(path: string, content: string): Promise<void>;

  /**
   * Create a directory
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;

  /**
   * Remove a file or directory
   */
  remove(path: string, options?: RemoveOptions): Promise<void>;

  /**
   * Rename/move a file or directory
   */
  rename(src: string, dest: string): Promise<void>;

  /**
   * Get file/directory information
   */
  stat(path: string): Promise<FileInfo>;

  /**
   * Get file/directory information, following symlinks
   */
  lstat(path: string): Promise<FileInfo>;

  /**
   * Copy a file
   */
  copyFile(src: string, dest: string): Promise<void>;

  /**
   * Read directory entries
   */
  readDir(path: string): AsyncIterable<DirEntry>;

  /**
   * Create a temporary directory
   */
  makeTempDir(options?: { prefix?: string }): Promise<string>;

  /**
   * Resolve symlinks and return the real path
   */
  realPath(path: string): Promise<string>;

  /**
   * Check if a path exists
   */
  exists(path: string): Promise<boolean>;
}

// ===== Process Types =====

/**
 * Options for running a command
 */
export interface RunOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "inherit" | "null" | "piped";
  stdout?: "inherit" | "null" | "piped";
  stderr?: "inherit" | "null" | "piped";
}

/**
 * Result of running a command
 */
export interface RunResult {
  code: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/**
 * Child process handle
 */
export interface ChildProcess {
  /**
   * Detach the child process so parent can exit without waiting
   */
  unref(): void;

  /**
   * Wait for the child process to complete
   */
  wait(): Promise<{ code: number; success: boolean }>;

  /**
   * Process ID
   */
  readonly pid: number;
}

/**
 * Options for spawning a command
 */
export interface SpawnOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "inherit" | "null" | "piped";
  stdout?: "inherit" | "null" | "piped";
  stderr?: "inherit" | "null" | "piped";
}

/**
 * Runtime process interface
 */
export interface RuntimeProcess {
  /**
   * Run a command and wait for completion
   */
  run(options: RunOptions): Promise<RunResult>;

  /**
   * Spawn a command without waiting
   */
  spawn(options: SpawnOptions): ChildProcess;
}

// ===== Environment Types =====

/**
 * Runtime environment interface
 */
export interface RuntimeEnv {
  /**
   * Get an environment variable
   */
  get(key: string): string | undefined;

  /**
   * Set an environment variable
   */
  set(key: string, value: string): void;

  /**
   * Delete an environment variable
   */
  delete(key: string): void;

  /**
   * Get all environment variables as an object
   */
  toObject(): Record<string, string>;
}

// ===== Build/Platform Types =====

/**
 * Supported operating systems
 */
export type OS = "darwin" | "linux" | "windows";

/**
 * Supported CPU architectures
 */
export type Arch = "x86_64" | "aarch64" | "arm";

/**
 * Runtime build/platform information
 */
export interface RuntimeBuild {
  readonly os: OS;
  readonly arch: Arch;
}

// ===== Process Control Types =====

/**
 * Runtime process control interface
 */
export interface RuntimeControl {
  /**
   * Exit the process with the given code
   */
  exit(code: number): never;

  /**
   * Change the current working directory
   */
  chdir(path: string): void;

  /**
   * Get the current working directory
   */
  cwd(): string;

  /**
   * Get the path to the current executable
   */
  execPath(): string;

  /**
   * Command-line arguments (excluding runtime and script name)
   */
  readonly args: readonly string[];
}

// ===== I/O Types =====

/**
 * Standard input stream
 */
export interface StdinStream {
  /**
   * Read bytes into buffer, returns number of bytes read or null if EOF
   */
  read(buffer: Uint8Array): Promise<number | null>;

  /**
   * Check if stdin is a terminal (TTY)
   */
  isTerminal(): boolean;
}

/**
 * Standard error stream
 */
export interface StderrStream {
  /**
   * Write bytes synchronously, returns number of bytes written
   */
  writeSync(data: Uint8Array): number;

  /**
   * Write bytes asynchronously
   */
  write(data: Uint8Array): Promise<number>;

  /**
   * Check if stderr is a terminal (TTY)
   */
  isTerminal(): boolean;
}

/**
 * Runtime I/O interface
 */
export interface RuntimeIO {
  readonly stdin: StdinStream;
  readonly stderr: StderrStream;
}

// ===== Error Types =====

/**
 * Runtime-specific error class constructors
 */
export interface RuntimeErrors {
  /**
   * File/directory not found
   */
  NotFound: new (message?: string) => Error;

  /**
   * File/directory already exists
   */
  AlreadyExists: new (message?: string) => Error;

  /**
   * Permission denied
   */
  PermissionDenied: new (message?: string) => Error;

  /**
   * Check if error is NotFound
   */
  isNotFound(error: unknown): boolean;

  /**
   * Check if error is AlreadyExists
   */
  isAlreadyExists(error: unknown): boolean;

  /**
   * Check if error is PermissionDenied
   */
  isPermissionDenied(error: unknown): boolean;
}

// ===== FFI Types (Deno-specific, optional) =====

/**
 * FFI interface for native operations (optional, Deno-only)
 */
export interface RuntimeFFI {
  /**
   * Whether FFI is available
   */
  readonly available: boolean;

  /**
   * Open a dynamic library (Deno-only)
   */
  dlopen?<T extends Record<string, Deno.ForeignFunction>>(
    path: string,
    symbols: T,
  ): Deno.DynamicLibrary<T>;
}

// ===== Signal Types =====

/**
 * Signal types for process signals
 */
export type Signal = "SIGINT" | "SIGTERM";

/**
 * Signal handler interface
 */
export interface RuntimeSignals {
  /**
   * Add a signal listener
   */
  addListener(signal: Signal, handler: () => void): void;

  /**
   * Remove a signal listener
   */
  removeListener(signal: Signal, handler: () => void): void;
}

// ===== Unified Runtime Interface =====

/**
 * Unified runtime interface providing platform-agnostic access to
 * file system, process, environment, and I/O operations.
 */
export interface Runtime {
  /** Runtime name identifier */
  readonly name: "deno" | "node" | "bun";

  /** File system operations */
  readonly fs: RuntimeFS;

  /** Process execution operations */
  readonly process: RuntimeProcess;

  /** Environment variables */
  readonly env: RuntimeEnv;

  /** Build/platform information */
  readonly build: RuntimeBuild;

  /** Process control (exit, chdir, args) */
  readonly control: RuntimeControl;

  /** Standard I/O streams */
  readonly io: RuntimeIO;

  /** Runtime-specific errors */
  readonly errors: RuntimeErrors;

  /** Signal handling */
  readonly signals: RuntimeSignals;

  /** FFI operations (optional, Deno-only) */
  readonly ffi?: RuntimeFFI;
}
