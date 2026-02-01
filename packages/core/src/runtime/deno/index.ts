/**
 * Deno runtime implementation
 *
 * This module provides the Deno-specific implementation of the Runtime interface.
 */

import type { Runtime } from "../types.ts";
import { denoBuild, denoControl, denoEnv } from "./env.ts";
import { denoErrors } from "./errors.ts";
import { denoFFI } from "./ffi.ts";
import { denoFS } from "./fs.ts";
import { denoIO } from "./io.ts";
import { denoProcess } from "./process.ts";
import { denoSignals } from "./signals.ts";

/**
 * Deno runtime implementation
 */
export const denoRuntime: Runtime = {
  name: "deno",
  fs: denoFS,
  process: denoProcess,
  env: denoEnv,
  build: denoBuild,
  control: denoControl,
  io: denoIO,
  errors: denoErrors,
  signals: denoSignals,
  ffi: denoFFI,
};
