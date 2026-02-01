#!/usr/bin/env bun

/**
 * Generate version.ts file for CI
 * This is a wrapper that calls build.ts with --generate-version-only
 */

import { spawn } from "node:child_process";

const proc = spawn("bun", ["run", "scripts/build.ts", "--generate-version-only"], {
  stdio: "inherit",
});

proc.on("close", (code) => {
  process.exit(code ?? 0);
});
