import * as pty from "node-pty";

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
   * Spawn a command in PTY and return a promise that resolves when the command exits
   */
  spawn(args: string[]): Promise<void> {
    this.output = "";
    this.exitCode = null;

    this.pty = pty.spawn(this.vibePath, args, {
      cwd: this.cwd,
      env: { ...Deno.env.toObject(), TERM: "xterm-256color" },
      cols: 80,
      rows: 30,
    });

    this.pty.onData((data: string) => {
      this.output += data;
    });

    this.exitPromise = new Promise((resolve) => {
      this.pty!.onExit(({ exitCode }: { exitCode: number }) => {
        this.exitCode = exitCode;
        resolve();
      });
    });

    return this.exitPromise;
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
  async waitForPattern(pattern: RegExp, timeout = 5000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (pattern.test(this.output)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
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
 * Defaults to the VIBE_BINARY_PATH environment variable or './vibe-e2e'
 */
export function getVibePath(): string {
  return Deno.env.get("VIBE_BINARY_PATH") || "./vibe-e2e";
}
