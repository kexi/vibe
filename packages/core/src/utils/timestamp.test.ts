import { describe, it, expect } from "vitest";
import { formatLocalTimestamp } from "./timestamp.ts";

describe("formatLocalTimestamp", () => {
  it("returns YYYYMMDD-HHMMSS format with zero-padded values", () => {
    // Build a Date in local time so the test is timezone-independent.
    const d = new Date(2026, 0, 5, 7, 8, 9); // 2026-01-05 07:08:09 local
    const result = formatLocalTimestamp(d.getTime());
    expect(result).toBe("20260105-070809");
  });

  it("handles two-digit values without extra padding", () => {
    const d = new Date(2026, 11, 31, 23, 59, 59); // 2026-12-31 23:59:59 local
    const result = formatLocalTimestamp(d.getTime());
    expect(result).toBe("20261231-235959");
  });

  it("preserves second-level granularity at midnight", () => {
    const d = new Date(2026, 5, 15, 0, 0, 0); // 2026-06-15 00:00:00 local
    const result = formatLocalTimestamp(d.getTime());
    expect(result).toBe("20260615-000000");
  });

  it("matches the regex /^\\d{8}-\\d{6}$/", () => {
    const result = formatLocalTimestamp(Date.now());
    expect(result).toMatch(/^\d{8}-\d{6}$/);
  });
});
