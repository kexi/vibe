import type { CopyStrategy, CopyStrategyType } from "./types.ts";
import { CloneStrategy, RsyncStrategy, StandardStrategy } from "./strategies/index.ts";

export type { CopyCapabilities, CopyStrategy, CopyStrategyType } from "./types.ts";
export { detectCapabilities, resetCapabilitiesCache } from "./detector.ts";
export { CloneStrategy, RsyncStrategy, StandardStrategy };

/**
 * CopyService manages copy operations with automatic strategy selection
 * and fallback handling.
 *
 * Strategy selection:
 * - File copy: Always uses Standard (Deno.copyFile) as it's fastest for individual files
 * - Directory copy: Uses Clone (CoW) > Rsync > Standard based on availability
 *
 * The overhead of spawning external processes (cp, rsync) makes them slower
 * for individual file copies, but they excel at bulk directory operations.
 */
export class CopyService {
  private directoryStrategies: CopyStrategy[];
  private selectedDirectoryStrategy: CopyStrategy | null = null;
  private standardStrategy: StandardStrategy;

  constructor() {
    this.standardStrategy = new StandardStrategy();
    // Priority order for directory copy: clone (CoW) -> rsync -> standard
    this.directoryStrategies = [
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
    if (this.selectedDirectoryStrategy !== null) {
      return this.selectedDirectoryStrategy;
    }

    // Find the first available strategy
    for (const strategy of this.directoryStrategies) {
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
 */
export function resetCopyService(): void {
  defaultCopyService = null;
}
