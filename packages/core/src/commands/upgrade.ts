import { BUILD_INFO } from "../version.ts";
import { log, type OutputOptions, verboseLog } from "../utils/output.ts";
import { type AppContext, getGlobalContext } from "../context/index.ts";

const JSR_META_URL = "https://jsr.io/@kexi/vibe/meta.json";
const GITHUB_RELEASES_URL = "https://github.com/kexi/vibe/releases";

type InstallMethod = "jsr" | "homebrew" | "deb" | "binary" | "dev" | "unknown";

interface UpgradeOptions extends OutputOptions {
  check: boolean;
}

interface JsrMeta {
  scope: string;
  name: string;
  versions: Record<string, { yanked?: boolean }>;
}

const MAX_RESPONSE_SIZE = 1_000_000; // 1MB limit

/**
 * Fetch the latest version from JSR registry
 */
async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(JSR_META_URL, {
    signal: AbortSignal.timeout(5000),
  });

  const isNotOk = !response.ok;
  if (isNotOk) {
    throw new Error(`Failed to fetch version information (HTTP ${response.status})`);
  }

  // Validate Content-Type
  const contentType = response.headers.get("content-type");
  const isNotJson = !contentType?.includes("application/json");
  if (isNotJson) {
    throw new Error("Invalid response format: expected JSON");
  }

  // Validate response size and parse JSON
  const text = await response.text();
  const isTooLarge = text.length > MAX_RESPONSE_SIZE;
  if (isTooLarge) {
    throw new Error("Response too large");
  }

  let meta: JsrMeta;
  try {
    meta = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON response");
  }

  // Filter out yanked versions and find the latest
  const availableVersions = Object.entries(meta.versions)
    .filter(([_, info]) => !info.yanked)
    .map(([version]) => version);

  const hasNoVersions = availableVersions.length === 0;
  if (hasNoVersions) {
    throw new Error("No available versions found");
  }

  // Sort versions and get the latest
  availableVersions.sort(compareVersions);
  return availableVersions[availableVersions.length - 1];
}

/**
 * Parse and validate a semver version string
 * Returns array of [major, minor, patch] or throws if invalid
 */
export function parseVersion(v: string): number[] {
  const [semver] = v.split("+");
  const parts = semver.split(".").map((n) => parseInt(n, 10));

  // Validate that we have valid numbers
  const hasInvalidParts = parts.some((n) => Number.isNaN(n));
  if (hasInvalidParts) {
    throw new Error(`Invalid version format: ${v}`);
  }

  const hasTooFewParts = parts.length < 1;
  if (hasTooFewParts) {
    throw new Error(`Invalid version format: ${v}`);
  }

  // Pad with zeros to ensure [major, minor, patch] format
  while (parts.length < 3) {
    parts.push(0);
  }

  return parts;
}

/**
 * Compare two semver versions
 * Returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    const isDifferent = aVal !== bVal;
    if (isDifferent) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Extract semver from version string (removes commit hash suffix)
 */
function parseSemver(version: string): string {
  const [semver] = version.split("+");
  return semver;
}

/**
 * Check if the executable is installed via Homebrew
 */
async function checkHomebrewInstall(ctx: AppContext): Promise<boolean> {
  const { runtime } = ctx;
  const isMac = runtime.build.os === "darwin";
  if (!isMac) {
    return false;
  }

  const execPath = runtime.control.execPath();

  // Resolve symlinks to get the real path
  let realPath: string;
  try {
    realPath = await runtime.fs.realPath(execPath);
  } catch {
    // If realPath fails, fall back to original path
    realPath = execPath;
  }

  const homebrewPrefixes = ["/opt/homebrew", "/usr/local"];
  const isInHomebrewPath = homebrewPrefixes.some(
    (prefix) => execPath.startsWith(prefix) || realPath.startsWith(prefix),
  );

  return isInHomebrewPath;
}

/**
 * Detect the installation method
 */
async function detectInstallMethod(ctx: AppContext): Promise<InstallMethod> {
  const distribution = BUILD_INFO.distribution;

  const isJSR = distribution === "jsr";
  if (isJSR) {
    return "jsr";
  }

  const isDeb = distribution === "deb";
  if (isDeb) {
    return "deb";
  }

  const isBinaryOrDev = distribution === "binary" || distribution === "dev";
  if (isBinaryOrDev) {
    const isHomebrewInstalled = await checkHomebrewInstall(ctx);
    if (isHomebrewInstalled) {
      return "homebrew";
    }

    const isBinary = distribution === "binary";
    if (isBinary) {
      return "binary";
    }

    return "dev";
  }

  return "unknown";
}

/**
 * Get the upgrade command for the detected installation method
 */
function getUpgradeCommand(method: InstallMethod): string | null {
  switch (method) {
    case "homebrew":
      return "brew upgrade vibe";
    case "jsr":
      return "deno install -A --global jsr:@kexi/vibe";
    case "deb":
      return "sudo apt update && sudo apt upgrade vibe";
    case "binary":
      return null; // Will show download link instead
    case "dev":
      return "deno task compile";
    case "unknown":
      return null;
  }
}

/**
 * Main upgrade command
 */
export async function upgradeCommand(
  options: UpgradeOptions = { check: false },
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const { runtime } = ctx;
  const { check, verbose = false, quiet = false } = options;
  const outputOpts: OutputOptions = { verbose, quiet };

  try {
    const currentVersion = parseSemver(BUILD_INFO.version);

    verboseLog(`Checking for updates from ${JSR_META_URL}`, outputOpts);
    log(`vibe ${BUILD_INFO.version}`, outputOpts);
    log("", outputOpts);

    // Fetch latest version
    let latestVersion: string;
    try {
      latestVersion = await fetchLatestVersion();
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
      if (isTimeout) {
        console.error("Error: Request timed out while checking for updates.");
        console.error("Please check your network connection and try again.");
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${errorMessage}`);
      }
      runtime.control.exit(1);
      return; // TypeScript flow analysis: exit never returns
    }

    const comparison = compareVersions(currentVersion, latestVersion);
    const isUpToDate = comparison >= 0;

    if (isUpToDate) {
      log("You are using the latest version.", outputOpts);
      return;
    }

    // Update available
    log(`A new version is available: ${latestVersion}`, outputOpts);
    log("", outputOpts);

    // If --check flag, just show version info
    if (check) {
      log(`Current: ${currentVersion}`, outputOpts);
      log(`Latest:  ${latestVersion}`, outputOpts);
      return;
    }

    // Detect installation method and show upgrade command
    const installMethod = await detectInstallMethod(ctx);
    verboseLog(`Detected install method: ${installMethod}`, outputOpts);
    const upgradeCmd = getUpgradeCommand(installMethod);

    if (upgradeCmd) {
      log("To upgrade:", outputOpts);
      log(`  ${upgradeCmd}`, outputOpts);
    } else {
      log("Download the latest version:", outputOpts);
      log(`  ${GITHUB_RELEASES_URL}/tag/v${latestVersion}`, outputOpts);
    }

    log("", outputOpts);
    log("Release notes:", outputOpts);
    log(`  ${GITHUB_RELEASES_URL}/tag/v${latestVersion}`, outputOpts);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    runtime.control.exit(1);
  }
}
