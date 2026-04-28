/**
 * Format a millisecond Unix timestamp as a local-time `YYYYMMDD-HHMMSS` string.
 * Used by `vibe scratch` to generate predictable, sortable, collision-resistant branch names.
 */
export function formatLocalTimestamp(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
