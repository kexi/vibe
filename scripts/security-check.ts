#!/usr/bin/env bun

/**
 * Custom security check script.
 * Scans source files for dangerous patterns that static analysis might miss.
 */

import { readFile } from "node:fs/promises";
import { globSync } from "fast-glob";

interface SecurityPattern {
  name: string;
  pattern: RegExp;
  severity: "error" | "warn";
  message: string;
}

const patterns: SecurityPattern[] = [
  {
    name: "eval-usage",
    pattern: /\beval\s*\(/,
    severity: "error",
    message: "Use of eval() is dangerous. Avoid dynamic code execution.",
  },
  {
    name: "exec-sync-usage",
    pattern: /\bexecSync\s*\(/,
    severity: "error",
    message: "Use of execSync() is dangerous. Use spawn() with array arguments instead.",
  },
  {
    name: "exec-usage",
    pattern: /\bexec\s*\(/,
    severity: "warn",
    message: "Use of exec() detected. Prefer spawn() with array arguments.",
  },
  {
    name: "shell-true",
    pattern: /shell\s*:\s*true/,
    severity: "error",
    message: "shell: true in spawn options enables shell injection. Use array arguments instead.",
  },
  {
    name: "unescaped-cd-output",
    pattern: /console\.log\(`cd '\$\{(?!escapeShellPath)/,
    severity: "error",
    message: "Unescaped path in cd output. Use escapeShellPath() to prevent shell injection.",
  },
  {
    name: "new-function",
    pattern: /\bnew\s+Function\s*\(/,
    severity: "error",
    message: "Use of new Function() is equivalent to eval(). Avoid dynamic code execution.",
  },
  {
    name: "child-process-import",
    pattern: /from\s+["']child_process["']/,
    severity: "warn",
    message: "Direct import of child_process detected. Use the runtime abstraction layer instead.",
  },
];

const excludePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/*.test.ts",
  "**/*.spec.ts",
  "packages/e2e/**",
  ".vibedev",
  "scripts/security-check.ts",
];

async function main(): Promise<void> {
  const files = globSync("**/*.ts", {
    ignore: excludePatterns,
    cwd: process.cwd(),
  });

  let errorCount = 0;
  let warnCount = 0;

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trimStart();
      const isComment =
        trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
      if (isComment) continue;

      for (const rule of patterns) {
        const hasMatch = rule.pattern.test(line);
        if (!hasMatch) continue;

        const lineNumber = lineIndex + 1;
        const prefix = rule.severity === "error" ? "ERROR" : "WARN";

        console.error(`  ${prefix}: ${file}:${lineNumber} [${rule.name}] ${rule.message}`);

        if (rule.severity === "error") {
          errorCount++;
        } else {
          warnCount++;
        }
      }
    }
  }

  console.error("");
  console.error(`Security check complete: ${errorCount} error(s), ${warnCount} warning(s)`);

  const hasErrors = errorCount > 0;
  if (hasErrors) {
    process.exit(1);
  }
}

main();
