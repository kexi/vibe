import * as pty from "node-pty";
import { join } from "path";

type IPty = pty.IPty;

/**
 * PTY-based command runner for E2E testing of vibe commands
 */
export class VibeCommandRunner {
  private pty: IPty | null = null;
  private output: string = "";
  private exitCode: number | null = null;
  private exitPromise: Promise<void> | null = null;

  constructor(
    private vibePath: string,
    private cwd: string,
  ) {}

  /**
   * Spawn a command in PTY
   * Waits for the first data from PTY before resolving to ensure the process is ready
   */
  spawn(args: string[]): Promise<void> {
    this.output = "";
    this.exitCode = null;

    return new Promise((resolve) => {
      this.pty = pty.spawn(this.vibePath, args, {
        cwd: this.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          VIBE_FORCE_INTERACTIVE: "1",
        },
        cols: 80,
        rows: 30,
      });

      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 1000);

      this.pty.onData((data: string) => {
        this.output += data;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve();
        }
      });

      this.exitPromise = new Promise((exitResolve) => {
        if (!this.pty) {
          exitResolve();
          return;
        }
        this.pty.onExit(({ exitCode }: { exitCode: number }) => {
          this.exitCode = exitCode;
          exitResolve();
        });
      });
    });
  }

  /**
   * Write input to the PTY (e.g., for responding to prompts)
   */
  write(input: string): void {
    if (!this.pty) {
      throw new Error("PTY not spawned");
    }
    this.pty.write(input);
  }

  /**
   * Wait for a specific pattern to appear in the output
   */
  async waitForPattern(pattern: RegExp, timeout = 15000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (pattern.test(this.output)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /**
   * Get the accumulated output
   */
  getOutput(): string {
    return this.output;
  }

  /**
   * Get the exit code (null if not exited yet)
   */
  getExitCode(): number | null {
    return this.exitCode;
  }

  /**
   * Wait for the process to exit
   */
  async waitForExit(): Promise<void> {
    if (this.exitPromise) {
      await this.exitPromise;
    }
  }

  /**
   * Dispose of the PTY
   */
  dispose(): void {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Ignore errors when killing
      }
      this.pty = null;
    }
  }
}

/**
 * Get the path to the vibe binary for testing
 * Defaults to the VIBE_BINARY_PATH environment variable or '<repo-root>/vibe-e2e'
 */
export function getVibePath(): string {
  if (process.env.VIBE_BINARY_PATH) {
    return process.env.VIBE_BINARY_PATH;
  }

  // Use process.cwd() which will be the repo root when tests run
  return join(process.cwd(), "vibe-e2e");
}
