// Progress tracking for hooks and file operations

export type ProgressState = "pending" | "running" | "completed" | "failed";

export interface ProgressNode {
  id: string;
  label: string;
  state: ProgressState;
  children: ProgressNode[];
  parent?: ProgressNode;
  startTime?: number;
  endTime?: number;
  error?: string;
}

// Simple writer interface for compatibility
interface Writer {
  writeSync(p: Uint8Array): number;
}

export interface ProgressOptions {
  title?: string;
  enabled?: boolean;
  stream?: Writer;
  spinnerFrames?: string[];
  updateInterval?: number;
}

/**
 * ANSI escape code utilities
 */
class AnsiRenderer {
  static readonly CLEAR_LINE = "\x1b[2K";
  static readonly CURSOR_UP = (n: number) => `\x1b[${n}A`;
  static readonly CURSOR_COLUMN_0 = "\x1b[0G";
  static readonly HIDE_CURSOR = "\x1b[?25l";
  static readonly SHOW_CURSOR = "\x1b[?25h";

  // Text styling
  static readonly BOLD = "\x1b[1m";
  static readonly DIM = "\x1b[2m";
  static readonly STRIKETHROUGH = "\x1b[9m";
  static readonly RED = "\x1b[31m";
  static readonly RESET = "\x1b[0m";

  static clearLastRender(lineCount: number): string {
    if (lineCount === 0) return "";

    const moves = AnsiRenderer.CURSOR_COLUMN_0 + AnsiRenderer.CURSOR_UP(lineCount);
    const clears = Array(lineCount).fill(AnsiRenderer.CLEAR_LINE + "\n").join("");
    return moves + clears + AnsiRenderer.CURSOR_UP(lineCount) + AnsiRenderer.CURSOR_COLUMN_0;
  }
}

/**
 * Tree formatting utilities
 */
class TreeFormatter {
  // Box-drawing characters for tree structure
  static readonly MAIN_TASK = "✶";
  static readonly SUB_TASK = "┗";
  static readonly INDENT = "   ";

  // State symbols
  static readonly PENDING = "☐";
  static readonly COMPLETED = "☒";
  static readonly FAILED = "✗";

  static truncateLabel(label: string, maxWidth = 80): string {
    if (label.length <= maxWidth) return label;
    return label.substring(0, maxWidth - 3) + "...";
  }

  static getStateSymbol(state: ProgressState, spinnerFrame?: string): string {
    switch (state) {
      case "pending":
        return TreeFormatter.PENDING;
      case "running":
        return spinnerFrame || TreeFormatter.PENDING;
      case "completed":
        return TreeFormatter.COMPLETED;
      case "failed":
        return TreeFormatter.FAILED;
    }
  }

  static getStateStyle(state: ProgressState): string {
    switch (state) {
      case "pending":
        return AnsiRenderer.DIM; // Dim gray
      case "running":
        return AnsiRenderer.BOLD; // Bold
      case "completed":
        return AnsiRenderer.DIM + AnsiRenderer.STRIKETHROUGH; // Dim + strikethrough
      case "failed":
        return AnsiRenderer.RED; // Red
    }
  }

  static formatNode(
    node: ProgressNode,
    prefix: string,
    spinnerFrame?: string,
  ): string {
    const symbol = TreeFormatter.getStateSymbol(node.state, spinnerFrame);
    const style = TreeFormatter.getStateStyle(node.state);
    const labelText = node.error ? `${node.label} (${node.error})` : node.label;
    const label = TreeFormatter.truncateLabel(labelText);

    return `${prefix}${style}${symbol} ${label}${AnsiRenderer.RESET}`;
  }

  static formatTree(
    nodes: ProgressNode[],
    depth = 0,
    spinnerFrame?: string,
    showMarkerOnFirst = false,
  ): string[] {
    const lines: string[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isFirstWithMarker = i === 0 && showMarkerOnFirst;
      const basePrefix = depth === 0 ? "" : TreeFormatter.INDENT.repeat(depth);
      const prefix = isFirstWithMarker
        ? basePrefix + TreeFormatter.SUB_TASK + " "
        : basePrefix + "  ";

      // Format current node
      lines.push(TreeFormatter.formatNode(node, prefix, spinnerFrame));

      // Recursively format children
      if (node.children.length > 0) {
        const childLines = TreeFormatter.formatTree(
          node.children,
          depth + 1,
          spinnerFrame,
          true,
        );
        lines.push(...childLines);
      }
    }

    return lines;
  }
}

/**
 * Progress tracker for displaying real-time progress of hooks and file operations
 */
export class ProgressTracker {
  private enabled: boolean;
  private stream: Writer;
  private spinnerFrames: string[];
  private updateInterval: number;

  private title: string;
  private root: ProgressNode;
  private nodes: Map<string, ProgressNode>;
  private nextId = 0;

  private lastRenderLineCount = 0;
  private spinnerInterval?: ReturnType<typeof setInterval>;
  private spinnerFrameIndex = 0;
  private finished = false;

  private textEncoder = new TextEncoder();
  private cleanupHandler?: () => void;

  constructor(options: ProgressOptions = {}) {
    this.enabled = options.enabled ?? Deno.stderr.isTerminal();
    this.stream = options.stream ?? Deno.stderr;

    // Validate spinner frames
    const spinnerFrames = options.spinnerFrames ?? [
      "⠋",
      "⠙",
      "⠹",
      "⠸",
      "⠼",
      "⠴",
      "⠦",
      "⠧",
      "⠇",
      "⠏",
    ];
    if (spinnerFrames.length === 0) {
      throw new Error("spinnerFrames must contain at least one frame");
    }
    this.spinnerFrames = spinnerFrames;

    // Validate update interval (min 16ms for 60fps, max 1000ms for 1fps)
    const updateInterval = options.updateInterval ?? 80;
    if (updateInterval < 16 || updateInterval > 1000) {
      throw new Error(
        "updateInterval must be between 16ms and 1000ms",
      );
    }
    this.updateInterval = updateInterval;

    this.title = options.title ?? "Processing";

    // Create root node (not rendered, just holds phases)
    this.root = {
      id: "root",
      label: this.title,
      state: "pending",
      children: [],
    };
    this.nodes = new Map();
    this.nodes.set("root", this.root);

    // Setup signal handlers for cleanup
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    if (!this.enabled) return;

    this.cleanupHandler = () => {
      this.finish();
      Deno.exit(0);
    };

    try {
      Deno.addSignalListener("SIGINT", this.cleanupHandler);
      Deno.addSignalListener("SIGTERM", this.cleanupHandler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  }

  private removeSignalHandlers(): void {
    if (!this.cleanupHandler) return;

    try {
      Deno.removeSignalListener("SIGINT", this.cleanupHandler);
      Deno.removeSignalListener("SIGTERM", this.cleanupHandler);
    } catch {
      // Signal handlers might not be available in all environments
    }
    this.cleanupHandler = undefined;
  }

  private generateId(): string {
    return `node-${this.nextId++}`;
  }

  /**
   * Add a phase (top-level task group)
   */
  addPhase(label: string): string {
    const id = this.generateId();
    const node: ProgressNode = {
      id,
      label,
      state: "pending",
      children: [],
      parent: this.root,
    };
    this.root.children.push(node);
    this.nodes.set(id, node);
    return id;
  }

  /**
   * Add a task under a phase
   */
  addTask(phaseId: string, label: string): string {
    const phase = this.nodes.get(phaseId);
    if (!phase) {
      throw new Error(`Phase not found: ${phaseId}`);
    }

    const id = this.generateId();
    const node: ProgressNode = {
      id,
      label,
      state: "pending",
      children: [],
      parent: phase,
    };
    phase.children.push(node);
    this.nodes.set(id, node);
    return id;
  }

  /**
   * Start a task (mark as running)
   */
  startTask(taskId: string): void {
    if (!this.enabled) return;

    const task = this.nodes.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.state = "running";
    task.startTime = Date.now();

    // Auto-cascade: start parent phase if pending
    if (task.parent && task.parent.state === "pending") {
      task.parent.state = "running";
      task.parent.startTime = Date.now();
    }

    this.render();
  }

  /**
   * Complete a task (mark as completed)
   */
  completeTask(taskId: string): void {
    if (!this.enabled) return;

    const task = this.nodes.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.state = "completed";
    task.endTime = Date.now();

    // Auto-cascade: check if all siblings are completed
    if (task.parent) {
      const allCompleted = task.parent.children.every(
        (child) => child.state === "completed",
      );
      if (allCompleted) {
        task.parent.state = "completed";
        task.parent.endTime = Date.now();
      }
    }

    this.render();
  }

  /**
   * Fail a task (mark as failed)
   */
  failTask(taskId: string, error?: string): void {
    if (!this.enabled) return;

    const task = this.nodes.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.state = "failed";
    task.endTime = Date.now();
    task.error = error;

    // Auto-cascade: fail parent phase
    if (task.parent) {
      task.parent.state = "failed";
      task.parent.endTime = Date.now();
    }

    this.render();
  }

  /**
   * Start the progress animation
   */
  start(): void {
    if (!this.enabled) return;

    // Hide cursor for cleaner animation
    this.write(AnsiRenderer.HIDE_CURSOR);

    // Start spinner animation loop
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length;
      this.render();
    }, this.updateInterval);

    // Initial render
    this.render();
  }

  /**
   * Stop the progress animation and show final state
   */
  finish(): void {
    if (!this.enabled || this.finished) return;
    this.finished = true;

    // Stop animation
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
    }

    // Final render
    this.render();

    // Show cursor
    this.write(AnsiRenderer.SHOW_CURSOR);

    // Add newline after progress
    this.write("\n");

    // Remove signal handlers
    this.removeSignalHandlers();
  }

  /**
   * Render the current progress state
   */
  private render(): void {
    if (!this.enabled) return;

    // Clear previous render
    if (this.lastRenderLineCount > 0) {
      const clearSequence = AnsiRenderer.clearLastRender(
        this.lastRenderLineCount,
      );
      this.write(clearSequence);
    }

    // Build output lines
    const lines: string[] = [];

    // Main task title
    const mainStyle = AnsiRenderer.BOLD;
    lines.push(
      `${mainStyle}${TreeFormatter.MAIN_TASK} ${this.title}…${AnsiRenderer.RESET}`,
    );

    // Render phases and their tasks
    if (this.root.children.length > 0) {
      const spinnerFrame = this.spinnerFrames[this.spinnerFrameIndex];
      const phaseLines = TreeFormatter.formatTree(
        this.root.children,
        0,
        spinnerFrame,
        true,
      );
      lines.push(...phaseLines);
    }

    // Write output
    const output = lines.join("\n") + "\n";
    this.write(output);

    // Update line count
    this.lastRenderLineCount = lines.length;
  }

  private write(text: string): void {
    try {
      this.stream.writeSync(this.textEncoder.encode(text));
    } catch (error) {
      // Ignore write errors (might happen if stderr is closed)
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Progress write error: ${errorMessage}`);
    }
  }

  /**
   * Check if progress tracking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
