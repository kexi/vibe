// Progress tracking for hooks and file operations

import { type AppContext, getGlobalContext } from "../context/index.ts";
import type { Runtime } from "../runtime/types.ts";

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
  write?(p: Uint8Array): Promise<number>; // Optional async write
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
  private needsRender = false;

  private textEncoder = new TextEncoder();
  private pendingWrite: Promise<void> = Promise.resolve();
  private cleanupHandler?: () => void;
  private runtime: Runtime;

  constructor(options: ProgressOptions = {}, ctx: AppContext = getGlobalContext()) {
    this.runtime = ctx.runtime;
    this.enabled = options.enabled ?? this.runtime.io.stderr.isTerminal();
    this.stream = options.stream ?? this.runtime.io.stderr;

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
      this.runtime.control.exit(0);
    };

    try {
      this.runtime.signals.addListener("SIGINT", this.cleanupHandler);
      this.runtime.signals.addListener("SIGTERM", this.cleanupHandler);
    } catch {
      // Signal handlers might not be available in all environments
    }
  }

  private removeSignalHandlers(): void {
    if (!this.cleanupHandler) return;

    try {
      this.runtime.signals.removeListener("SIGINT", this.cleanupHandler);
      this.runtime.signals.removeListener("SIGTERM", this.cleanupHandler);
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

    this.needsRender = true;
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

    this.needsRender = true;
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

    this.needsRender = true;
  }

  /**
   * Start the progress animation
   */
  start(): void {
    if (!this.enabled) return;

    // Hide cursor for cleaner animation
    this.scheduleWrite(AnsiRenderer.HIDE_CURSOR);

    // Start spinner animation loop with throttled rendering
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % this.spinnerFrames.length;
      this.needsRender = true;

      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
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
    this.scheduleWrite(AnsiRenderer.SHOW_CURSOR);

    // Add newline after progress
    this.scheduleWrite("\n");

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
      this.scheduleWrite(clearSequence);
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
    this.scheduleWrite(output);

    // Update line count
    this.lastRenderLineCount = lines.length;
  }

  private scheduleWrite(text: string): void {
    const data = this.textEncoder.encode(text);

    const hasAsyncWrite = this.stream.write !== undefined;
    if (hasAsyncWrite) {
      // Async write with order guarantee via Promise chain
      this.pendingWrite = this.pendingWrite.then(async () => {
        await this.stream.write!(data);
      }).catch(() => {
        // Ignore write errors (might happen if stderr is closed)
      });
    } else {
      // Fallback: sync write
      try {
        this.stream.writeSync(data);
      } catch {
        // Ignore write errors (might happen if stderr is closed)
      }
    }
  }

  /**
   * Check if progress tracking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
