/**
 * Native clone operation interface
 *
 * Used by both Deno and Node.js to provide Copy-on-Write cloning.
 * Both runtimes now use @kexi/vibe-native (N-API module).
 */
export interface NativeClone {
  /** Whether the native module is available and initialized */
  readonly available: boolean;

  /**
   * Clone a file using native system call
   * @param src Source file path
   * @param dest Destination file path
   */
  cloneFile(src: string, dest: string): Promise<void>;

  /**
   * Clone a directory using native system call
   * @param src Source directory path
   * @param dest Destination directory path
   */
  cloneDirectory(src: string, dest: string): Promise<void>;

  /**
   * Whether this implementation supports directory cloning
   * - macOS clonefile: true
   * - Linux FICLONE: false
   */
  supportsDirectoryClone(): boolean;

  /**
   * Release native resources
   */
  close(): void;
}
