import { join } from "node:path";
import { type AppContext, getGlobalContext } from "../context/index.ts";
import { getConfigDir, ensureConfigDir } from "./config-path.ts";

/** MRU entry representing a recently used worktree */
export interface MruEntry {
  branch: string;
  path: string;
  timestamp: number;
}

/** Maximum number of MRU entries to keep */
const MAX_MRU_ENTRIES = 50;

function getMruFilePath(ctx: AppContext): string {
  return join(getConfigDir(ctx), "mru.json");
}

/**
 * Load MRU data from mru.json.
 * Returns empty array if file is missing or has parse errors.
 */
export async function loadMruData(ctx: AppContext = getGlobalContext()): Promise<MruEntry[]> {
  try {
    const content = await ctx.runtime.fs.readTextFile(getMruFilePath(ctx));
    const parsed = JSON.parse(content);

    const isArray = Array.isArray(parsed);
    if (!isArray) return [];

    return parsed.filter(
      (entry: unknown): entry is MruEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as MruEntry).branch === "string" &&
        typeof (entry as MruEntry).path === "string" &&
        typeof (entry as MruEntry).timestamp === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Save MRU data using atomic write (temp + rename).
 */
async function saveMruData(entries: MruEntry[], ctx: AppContext): Promise<void> {
  const mruFile = getMruFilePath(ctx);

  await ensureConfigDir(ctx);

  const content = JSON.stringify(entries, null, 2) + "\n";
  const tempFile = `${mruFile}.tmp.${Date.now()}.${crypto.randomUUID()}`;

  try {
    await ctx.runtime.fs.writeTextFile(tempFile, content);
    await ctx.runtime.fs.rename(tempFile, mruFile);
  } catch (error) {
    try {
      await ctx.runtime.fs.remove(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Record an MRU entry. Updates timestamp if same path exists, otherwise adds new entry.
 * Keeps at most MAX_MRU_ENTRIES entries (oldest removed first).
 */
export async function recordMruEntry(
  branch: string,
  path: string,
  ctx: AppContext = getGlobalContext(),
): Promise<void> {
  const entries = await loadMruData(ctx);

  // Remove existing entry with same path
  const filtered = entries.filter((e) => e.path !== path);

  // Add new entry at the beginning
  filtered.unshift({ branch, path, timestamp: Date.now() });

  // Trim to max size
  const isOverLimit = filtered.length > MAX_MRU_ENTRIES;
  const trimmed = isOverLimit ? filtered.slice(0, MAX_MRU_ENTRIES) : filtered;

  await saveMruData(trimmed, ctx);
}

/**
 * Sort matches by MRU order. Pure function.
 * - Entries found in MRU come first, sorted by timestamp descending (most recent first)
 * - Entries not in MRU maintain their original order after MRU entries
 */
export function sortByMru<T extends { path: string }>(matches: T[], mruEntries: MruEntry[]): T[] {
  // Build a map from path to timestamp for O(1) lookup
  const mruMap = new Map<string, number>();
  for (const entry of mruEntries) {
    mruMap.set(entry.path, entry.timestamp);
  }

  const inMru: { match: T; timestamp: number }[] = [];
  const notInMru: T[] = [];

  for (const match of matches) {
    const timestamp = mruMap.get(match.path);
    const isInMru = timestamp !== undefined;
    if (isInMru) {
      inMru.push({ match, timestamp });
    } else {
      notInMru.push(match);
    }
  }

  // Sort MRU entries by timestamp descending (most recent first)
  inMru.sort((a, b) => b.timestamp - a.timestamp);

  return [...inMru.map((item) => item.match), ...notInMru];
}

// Export for testing
export const _internal = {
  MAX_MRU_ENTRIES,
  getMruFilePath,
  saveMruData,
};
