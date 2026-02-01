#!/usr/bin/env bun

/**
 * Get version from package.json
 * Outputs just the version string for use in CI scripts
 */

import { readFile } from "node:fs/promises";

async function main(): Promise<void> {
  const content = await readFile("package.json", "utf-8");
  const json = JSON.parse(content);
  console.log(json.version);
}

main();
