/**
 * Tests for scripts/release-version-order.ts — the ordering every #616 rollback
 * gate is built on.
 *
 * What these guarantee:
 *   - X.Y.Z and X.Y.Z-beta.N parse, and nothing else does, so a hand-made tag
 *     can never be mistaken for a version the gates may reason about;
 *   - components compare numerically, not as strings, so 3.10.0 outranks 3.9.0
 *     (the comparison a lexical sort gets backwards);
 *   - a -beta.N sorts before its own stable release and after lower ordinals;
 *   - newestVersion picks the maximum regardless of input order, which is what
 *     makes the gates independent of how `gh release list` happens to sort.
 */

import { describe, it, expect } from "vitest";
import {
  compareReleaseVersions,
  compareVersionStrings,
  newestVersion,
  parseReleaseVersion,
  stripTagPrefix,
} from "../../../scripts/release-version-order";

describe("parseReleaseVersion", () => {
  it("parses a stable version with no beta ordinal", () => {
    expect(parseReleaseVersion("3.1.0")).toEqual({ major: 3, minor: 1, patch: 0 });
  });

  it("parses a beta version's ordinal", () => {
    expect(parseReleaseVersion("3.1.0-beta.42")).toEqual({
      major: 3,
      minor: 1,
      patch: 0,
      beta: 42,
    });
  });

  it("parses multi-digit components numerically", () => {
    expect(parseReleaseVersion("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it("rejects a leading v, which callers must strip first", () => {
    // stripTagPrefix is the seam; folding it in here would make "vv3.1.0" parse.
    expect(parseReleaseVersion("v3.1.0")).toBeUndefined();
  });

  it("rejects a version with a trailing newline the anchored regex alone accepts", () => {
    expect(parseReleaseVersion("3.1.0\n")).toBeUndefined();
  });

  it("rejects prerelease shapes this project does not publish", () => {
    expect(parseReleaseVersion("3.1.0-rc.1")).toBeUndefined();
    expect(parseReleaseVersion("3.1.0-beta")).toBeUndefined();
    expect(parseReleaseVersion("3.1.0+build.5")).toBeUndefined();
  });

  it("rejects a partial or empty version", () => {
    expect(parseReleaseVersion("3.1")).toBeUndefined();
    expect(parseReleaseVersion("")).toBeUndefined();
  });
});

describe("stripTagPrefix", () => {
  it("removes exactly one leading v", () => {
    expect(stripTagPrefix("v3.1.0")).toBe("3.1.0");
    expect(stripTagPrefix("3.1.0")).toBe("3.1.0");
  });
});

describe("compareReleaseVersions", () => {
  const parse = (v: string) => {
    const parsed = parseReleaseVersion(v);
    if (!parsed) throw new Error(`test fixture does not parse: ${v}`);
    return parsed;
  };

  it("orders major, then minor, then patch", () => {
    expect(compareReleaseVersions(parse("4.0.0"), parse("3.9.9"))).toBeGreaterThan(0);
    expect(compareReleaseVersions(parse("3.2.0"), parse("3.1.9"))).toBeGreaterThan(0);
    expect(compareReleaseVersions(parse("3.1.2"), parse("3.1.1"))).toBeGreaterThan(0);
  });

  it("compares components numerically, so 3.10.0 outranks 3.9.0", () => {
    // A lexical comparison gets this backwards, which would let a 3.9.0 re-run
    // pass the currency gate after 3.10.0 shipped.
    expect(compareReleaseVersions(parse("3.10.0"), parse("3.9.0"))).toBeGreaterThan(0);
  });

  it("reports equality for identical versions, the idempotent re-run case", () => {
    expect(compareReleaseVersions(parse("3.1.0"), parse("3.1.0"))).toBe(0);
  });

  it("sorts a beta before its own stable release", () => {
    expect(compareReleaseVersions(parse("3.1.0-beta.9"), parse("3.1.0"))).toBeLessThan(0);
    expect(compareReleaseVersions(parse("3.1.0"), parse("3.1.0-beta.9"))).toBeGreaterThan(0);
  });

  it("orders beta ordinals numerically", () => {
    expect(compareReleaseVersions(parse("3.1.0-beta.10"), parse("3.1.0-beta.9"))).toBeGreaterThan(
      0,
    );
  });

  it("sorts a higher base version above a lower one's beta", () => {
    // The case a bare -beta.N ordinal compare gets wrong after a version bump.
    expect(compareReleaseVersions(parse("3.2.0-beta.1"), parse("3.1.0-beta.99"))).toBeGreaterThan(
      0,
    );
  });
});

describe("compareVersionStrings", () => {
  it("orders parsed strings", () => {
    expect(compareVersionStrings("3.2.0", "3.1.0")).toBeGreaterThan(0);
  });

  it("throws on a version it cannot order rather than guessing", () => {
    expect(() => compareVersionStrings("3.1.0", "not-a-version")).toThrowError(/unparseable/);
  });
});

describe("newestVersion", () => {
  it("returns the maximum irrespective of input order", () => {
    // `gh release list` orders by creation time, and a re-run that recreates a
    // release gets a fresh timestamp — so the gates must not trust list order.
    expect(newestVersion(["v3.1.0", "v3.10.0", "v3.2.0"])).toBe("3.10.0");
    expect(newestVersion(["v3.10.0", "v3.1.0"])).toBe("3.10.0");
  });

  it("strips the v prefix from what it returns", () => {
    expect(newestVersion(["v3.1.0"])).toBe("3.1.0");
  });

  it("skips entries it cannot order instead of failing", () => {
    // Hand-made or legacy tags exist in this repo's history; they must not stop
    // a release, only be ignored.
    expect(newestVersion(["nightly", "v3.1.0", "v2.2.0-rc.1"])).toBe("3.1.0");
  });

  it("returns undefined when nothing is comparable", () => {
    expect(newestVersion([])).toBeUndefined();
    expect(newestVersion(["nightly", "latest"])).toBeUndefined();
  });

  it("prefers a stable over its own beta", () => {
    expect(newestVersion(["v3.1.0-beta.9", "v3.1.0"])).toBe("3.1.0");
  });
});
