import type { CopyStrategy, CopyStrategyType } from "./types.ts";
import {
  CloneStrategy,
  NativeCloneStrategy,
  RsyncStrategy,
  StandardStrategy,
} from "./strategies/index.ts";

export type { CopyCapabilities, CopyStrategy, CopyStrategyType } from "./types.ts";
export { detectCapabilities, resetCapabilitiesCache } from "./detector.ts";
export { CloneStrategy, NativeCloneStrategy, RsyncStrategy, StandardStrategy };

/**
 * CopyService manages copy operations with automatic strategy selection
 * and fallback handling.
 *
 * Strategy selection:
 * - File copy: Always uses Standard (Deno.copyFile) as it's fastest for individual files
 * - Directory copy:
 *   - macOS: NativeClone (clonefile FFI) > Clone (cp -c) > Rsync > Standard
 *   - Linux: Clone (cp --reflink=auto) > Rsync > Standard
 *
 * The overhead of spawning external processes (cp, rsync) makes them slower
 * for individual file copies, but they excel at bulk directory operations.
 */
export class CopyService {
  private directoryStrategies: CopyStrategy[];
  private selectedDirectoryStrategy: CopyStrategy | null = null;
  private standardStrategy: StandardStrategy;
  private nativeCloneStrategy: NativeCloneStrategy;

  constructor() {
    this.standardStrategy = new StandardStrategy();
    this.nativeCloneStrategy = new NativeCloneStrategy();
    // Priority order for directory copy:
    // macOS: native clone (clonefile) -> clone (cp -c) -> rsync -> standard
    // Linux: clone (cp --reflink) -> rsync -> standard
    // NativeCloneStrategy is only used when it supports directory cloning (macOS)
    this.directoryStrategies = [
      this.nativeCloneStrategy,
      new CloneStrategy(),
      new RsyncStrategy(),
      this.standardStrategy,
    ];
  }

  /**
   * Get the best available strategy for directory operations.
   * Result is cached for subsequent calls.
   */
  async getDirectoryStrategy(): Promise<CopyStrategy> {
    const hasCachedStrategy = this.selectedDirectoryStrategy !== null;
    if (hasCachedStrategy) {
      return this.selectedDirectoryStrategy!;
    }

    // Find the first available strategy
    for (const strategy of this.directoryStrategies) {
      // For NativeCloneStrategy, check if it supports directory cloning
      const isNativeClone = strategy instanceof NativeCloneStrategy;
      if (isNativeClone) {
        const isAvailable = await strategy.isAvailable();
        const supportsDirectory = strategy.supportsDirectoryClone();
        const canUseForDirectory = isAvailable && supportsDirectory;
        if (canUseForDirectory) {
          this.selectedDirectoryStrategy = strategy;
          return strategy;
        }
        continue;
      }

      const isAvailable = await strategy.isAvailable();
      if (isAvailable) {
        this.selectedDirectoryStrategy = strategy;
        return strategy;
      }
    }

    // Fallback to standard (should always be available)
    this.selectedDirectoryStrategy = this.standardStrategy;
    return this.standardStrategy;
  }

  /**
   * Get the name of the currently selected directory strategy.
   * Returns null if no strategy has been selected yet.
   */
  getSelectedStrategyName(): CopyStrategyType | null {
    return this.selectedDirectoryStrategy?.name ?? null;
  }

  /**
   * Copy a single file from src to dest.
   * Always uses Standard strategy (Deno.copyFile) for best performance.
   */
  async copyFile(src: string, dest: string): Promise<void> {
    await this.standardStrategy.copyFile(src, dest);
  }

  /**
   * Copy a directory recursively from src to dest.
   * Uses the best available strategy (Clone > Rsync > Standard).
   * Falls back to standard strategy on error.
   */
  async copyDirectory(src: string, dest: string): Promise<void> {
    const strategy = await this.getDirectoryStrategy();

    try {
      await strategy.copyDirectory(src, dest);
    } catch (error) {
      const isNotStandard = strategy.name !== "standard";
      if (isNotStandard) {
        console.warn(
          `Warning: ${strategy.name} directory copy failed, falling back to standard: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.standardStrategy.copyDirectory(src, dest);
      } else {
        throw error;
      }
    }
  }

  /**
   * Release FFI resources
   */
  close(): void {
    this.nativeCloneStrategy.close();
  }
}

/**
 * Default CopyService instance (singleton)
 */
let defaultCopyService: CopyService | null = null;

/**
 * Get the default CopyService instance.
 * Creates a new instance on first call.
 */
export function getCopyService(): CopyService {
  if (defaultCopyService === null) {
    defaultCopyService = new CopyService();
  }
  return defaultCopyService;
}

/**
 * Reset the default CopyService instance (for testing purposes)
 * Also releases FFI resources
 */
export function resetCopyService(): void {
  defaultCopyService?.close();
  defaultCopyService = null;
}
