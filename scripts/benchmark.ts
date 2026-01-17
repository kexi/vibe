/**
 * Benchmark script for vibe CLI performance testing
 *
 * Runs `vibe start` and `vibe clean` multiple times and calculates median execution time.
 * Compares results against baseline and detects performance regressions.
 *
 * Environment variables:
 *   VIBE_BINARY         - Path to the vibe binary to test
 *   REACT_NATIVE_PATH   - Path to the React Native project
 *   BASELINE_PATH       - Path to baseline results JSON (optional)
 *   RESULTS_PATH        - Path to write results JSON
 *   BENCHMARK_OS        - OS name (e.g., "Linux", "macOS", "Windows")
 *   BENCHMARK_FILESYSTEM - Filesystem type (e.g., "ext4", "Btrfs", "APFS", "NTFS")
 *   BENCHMARK_COW       - Whether CoW is enabled ("true" or "false")
 *   BENCHMARK_NAME      - Benchmark configuration name
 */

import { z } from "zod";

interface CommandResult {
  times: number[];
  median: number;
  diff?: string;
}

interface BenchmarkResults {
  start: CommandResult;
  clean: CommandResult;
  threshold: number;
  failed: boolean;
  os: string;
  filesystem: string;
  cow: boolean;
  name: string;
}

const BaselineSchema = z.object({
  start: z.object({ median: z.number() }),
  clean: z.object({ median: z.number() }),
});

type Baseline = z.infer<typeof BaselineSchema>;

const ITERATIONS = 3;
const REGRESSION_THRESHOLD_SECONDS = 30;

function getEnvOrThrow(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  return Deno.env.get(name) ?? defaultValue;
}

async function runCommand(
  binary: string,
  args: string[],
  cwd: string,
): Promise<number> {
  const startTime = performance.now();

  const command = new Deno.Command(binary, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  const { success, stderr } = await command.output();

  const endTime = performance.now();
  const durationSeconds = (endTime - startTime) / 1000;

  if (!success) {
    const errorMessage = new TextDecoder().decode(stderr);
    throw new Error(`Command failed: ${binary} ${args.join(" ")}\n${errorMessage}`);
  }

  return durationSeconds;
}

function calculateMedian(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  const isEven = sorted.length % 2 === 0;
  if (isEven) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function formatDiff(current: number, baseline: number): string {
  const diff = current - baseline;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(2)}s`;
}

async function loadBaseline(path: string): Promise<Baseline | null> {
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    const result = BaselineSchema.safeParse(parsed);

    if (!result.success) {
      console.log(`Invalid baseline format: ${result.error.message}`);
      console.log("This will establish a new baseline.");
      return null;
    }

    return result.data;
  } catch {
    console.log("No baseline found, this will establish the baseline.");
    return null;
  }
}

async function runBenchmark(
  binary: string,
  projectPath: string,
  command: string,
): Promise<number[]> {
  const times: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    console.log(`  Run ${i + 1}/${ITERATIONS}...`);
    const duration = await runCommand(binary, [command], projectPath);
    times.push(duration);
    console.log(`    ${duration.toFixed(2)}s`);
  }

  return times;
}

async function main(): Promise<void> {
  const vibeBinary = getEnvOrThrow("VIBE_BINARY");
  const reactNativePath = getEnvOrThrow("REACT_NATIVE_PATH");
  const baselinePath = getEnvOrDefault("BASELINE_PATH", "/tmp/baseline.json");
  const resultsPath = getEnvOrDefault("RESULTS_PATH", "/tmp/results.json");

  // Platform info
  const osName = getEnvOrDefault("BENCHMARK_OS", Deno.build.os);
  const filesystem = getEnvOrDefault("BENCHMARK_FILESYSTEM", "unknown");
  const cow = getEnvOrDefault("BENCHMARK_COW", "false") === "true";
  const benchmarkName = getEnvOrDefault("BENCHMARK_NAME", "local");

  console.log("=== Vibe Performance Benchmark ===\n");
  console.log(`Binary: ${vibeBinary}`);
  console.log(`Project: ${reactNativePath}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`\nPlatform Info:`);
  console.log(`  OS: ${osName}`);
  console.log(`  Filesystem: ${filesystem}`);
  console.log(`  CoW: ${cow ? "enabled" : "disabled"}`);
  console.log(`  Name: ${benchmarkName}\n`);

  // Load baseline if exists
  const baseline = await loadBaseline(baselinePath);

  // Benchmark vibe start
  console.log("Benchmarking 'vibe start'...");
  const startTimes = await runBenchmark(vibeBinary, reactNativePath, "start");
  const startMedian = calculateMedian(startTimes);
  console.log(`  Median: ${startMedian.toFixed(2)}s\n`);

  // Benchmark vibe clean
  console.log("Benchmarking 'vibe clean'...");
  const cleanTimes = await runBenchmark(vibeBinary, reactNativePath, "clean");
  const cleanMedian = calculateMedian(cleanTimes);
  console.log(`  Median: ${cleanMedian.toFixed(2)}s\n`);

  // Calculate diffs and check for regression
  let failed = false;
  let startDiff: string | undefined;
  let cleanDiff: string | undefined;

  if (baseline) {
    startDiff = formatDiff(startMedian, baseline.start.median);
    cleanDiff = formatDiff(cleanMedian, baseline.clean.median);

    const startRegression = startMedian - baseline.start.median;
    const cleanRegression = cleanMedian - baseline.clean.median;

    const hasStartRegression = startRegression > REGRESSION_THRESHOLD_SECONDS;
    const hasCleanRegression = cleanRegression > REGRESSION_THRESHOLD_SECONDS;

    if (hasStartRegression || hasCleanRegression) {
      failed = true;
      console.log("WARNING: Performance regression detected!");
      if (hasStartRegression) {
        console.log(`  'vibe start' regressed by ${startRegression.toFixed(2)}s`);
      }
      if (hasCleanRegression) {
        console.log(`  'vibe clean' regressed by ${cleanRegression.toFixed(2)}s`);
      }
    }
  }

  // Build results
  const results: BenchmarkResults = {
    start: {
      times: startTimes,
      median: startMedian,
      diff: startDiff,
    },
    clean: {
      times: cleanTimes,
      median: cleanMedian,
      diff: cleanDiff,
    },
    threshold: REGRESSION_THRESHOLD_SECONDS,
    failed,
    os: osName,
    filesystem,
    cow,
    name: benchmarkName,
  };

  // Write results
  await Deno.writeTextFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${resultsPath}`);

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Platform: ${osName} / ${filesystem} (CoW: ${cow ? "yes" : "no"})`);
  console.log(`vibe start: ${startMedian.toFixed(2)}s ${startDiff ? `(${startDiff})` : ""}`);
  console.log(`vibe clean: ${cleanMedian.toFixed(2)}s ${cleanDiff ? `(${cleanDiff})` : ""}`);

  if (failed) {
    console.log("\nBenchmark FAILED: Performance regression detected");
  } else {
    console.log("\nBenchmark PASSED: Performance within acceptable range");
  }
}

main();
