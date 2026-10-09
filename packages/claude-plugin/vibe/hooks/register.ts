import type { Register } from "claude-code";

// Entry point Claude Code calls when the plugin loads. Each feature keeps its
// hooks in a module of its own; this file only wires them together.
export const register: Register = (on) => {
  on("session.start", async ($, e, next) => next(e));
};
