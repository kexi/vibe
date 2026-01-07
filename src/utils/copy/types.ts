/**
 * Copy strategy type identifier
 */
export type CopyStrategyType = "clone" | "rsync" | "standard";

/**
 * Interface for copy strategies
 */
export interface CopyStrategy {
  /** Strategy identifier */
  readonly name: CopyStrategyType;

  /**
   * Check if this strategy is available on the current system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Copy a single file from src to dest
   */
  copyFile(src: string, dest: string): Promise<void>;

  /**
   * Copy a directory recursively from src to dest
   */
  copyDirectory(src: string, dest: string): Promise<void>;
}

/**
 * System capabilities for copy operations
 */
export interface CopyCapabilities {
  /** Whether CoW (Copy-on-Write) clone is supported */
  cloneSupported: boolean;
  /** Whether rsync command is available */
  rsyncAvailable: boolean;
}
