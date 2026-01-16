/**
 * Node.js runtime implementation
 *
 * This module provides the Node.js-specific implementation of the Runtime interface.
 */

import type { Runtime } from "../types.ts";
import { nodeBuild, nodeControl, nodeEnv } from "./env.ts";
import { nodeErrors } from "./errors.ts";
import { nodeFS } from "./fs.ts";
import { nodeIO } from "./io.ts";
import { nodeProcess } from "./process.ts";
import { nodeSignals } from "./signals.ts";

/**
 * Node.js runtime implementation
 */
export const nodeRuntime: Runtime = {
  name: "node",
  fs: nodeFS,
  process: nodeProcess,
  env: nodeEnv,
  build: nodeBuild,
  control: nodeControl,
  io: nodeIO,
  errors: nodeErrors,
  signals: nodeSignals,
  // FFI is not available in Node.js by default
  // Use @vibe/native package for native operations
  ffi: undefined,
};
