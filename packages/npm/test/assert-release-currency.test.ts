/**
 * Tests for scripts/assert-release-currency.ts — the fail-closed gate that stops
 * a stale release run from publishing an old version (#616 hazard 1).
 *
 * What these guarantee:
 *   - the #616 regression itself: releasing 3.1.0 while 3.2.0 is already
 *     released is refused, because publishing it would move GitHub's latest
 *     pointer (and, through #608's isLatest check, the Homebrew tap) backwards;
 *   - re-releasing the CURRENT version is allowed, so #598's idempotent resume
 *     path is not broken by the gate;
 *   - a first release with no prior releases is allowed;
 *   - a malformed, empty or non-array release list is a hard error rather than
 *     being read as "no releases exist" — the reading that lets a stale run
 *     through;
 *   - beta ordinals order correctly, so the beta mirror rests on the same rule.
 */

import { describe, it, expect } from "vitest";
import {
  extractTagNames,
  judgeReleaseCurrency,
  parseCliArgs,
} from "../../../scripts/assert-release-currency";

const releaseList = (...tags: string[]) => JSON.stringify(tags.map((tagName) => ({ tagName })));

describe("parseCliArgs", () => {
  it("accepts --version", () => {
    expect(parseCliArgs(["--version", "3.2.0"])).toEqual({ version: "3.2.0" });
  });

  it("requires --version rather than defaulting to something", () => {
    expect(() => parseCliArgs([])).toThrowError(/--version is required/);
    expect(() => parseCliArgs(["--version", ""])).toThrowError(/--version is required/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseCliArgs(["--channel", "stable"])).toThrowError(/Unknown argument/);
  });
});

describe("extractTagNames", () => {
  it("returns the tag names of a gh release list payload", () => {
    expect(extractTagNames(releaseList("v3.2.0", "v3.1.0"))).toEqual(["v3.2.0", "v3.1.0"]);
  });

  it("returns an empty list for an empty JSON array (a repo with no releases)", () => {
    expect(extractTagNames("[]")).toEqual([]);
  });

  it("throws on empty stdin instead of reading it as no releases", () => {
    // A silently-failed `gh release list` producing nothing must not be
    // indistinguishable from "this is the first release".
    expect(() => extractTagNames("")).toThrowError(/no release list on stdin/);
    expect(() => extractTagNames("   \n")).toThrowError(/no release list on stdin/);
  });

  it("throws on malformed JSON", () => {
    expect(() => extractTagNames("{oops")).toThrowError(/not valid JSON/);
  });

  it("throws when the payload is not an array", () => {
    expect(() => extractTagNames('{"tagName":"v3.1.0"}')).toThrowError(/not a JSON array/);
  });

  it("throws on an entry with no usable tagName, naming its index", () => {
    expect(() => extractTagNames('[{"tagName":"v3.1.0"},{"name":"x"}]')).toThrowError(
      /entry 1 has no tagName/,
    );
    expect(() => extractTagNames('[{"tagName":""}]')).toThrowError(/entry 0 has no tagName/);
    expect(() => extractTagNames("[null]")).toThrowError(/entry 0 has no tagName/);
  });
});

describe("judgeReleaseCurrency", () => {
  it("refuses an older version when a newer release exists (#616)", () => {
    const verdict = judgeReleaseCurrency("3.1.0", ["v3.2.0", "v3.1.0"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.newest).toBe("3.2.0");
    expect(verdict.problem).toMatch(/refusing to release 3\.1\.0/);
  });

  it("names the operator's remedy in the refusal", () => {
    // The message is the only thing an operator staring at a red run sees.
    expect(judgeReleaseCurrency("3.1.0", ["v3.2.0"]).problem).toMatch(
      /Dispatch a fresh release for the current version/,
    );
  });

  it("allows re-releasing the current version (the #598 resume path)", () => {
    expect(judgeReleaseCurrency("3.2.0", ["v3.2.0", "v3.1.0"]).ok).toBe(true);
  });

  it("allows a newer version", () => {
    expect(judgeReleaseCurrency("3.3.0", ["v3.2.0"]).ok).toBe(true);
  });

  it("allows the first release, when no releases exist", () => {
    expect(judgeReleaseCurrency("1.0.0", []).ok).toBe(true);
  });

  it("compares numerically, so 3.9.0 is refused after 3.10.0", () => {
    expect(judgeReleaseCurrency("3.9.0", ["v3.10.0"]).ok).toBe(false);
  });

  it("accepts a v-prefixed version argument", () => {
    expect(judgeReleaseCurrency("v3.3.0", ["v3.2.0"]).ok).toBe(true);
  });

  it("refuses a version it cannot order rather than waving it through", () => {
    const verdict = judgeReleaseCurrency("nightly", ["v3.2.0"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problem).toMatch(/not a version this gate can order/);
  });

  it("ignores existing tags it cannot order", () => {
    expect(judgeReleaseCurrency("3.3.0", ["nightly", "v3.2.0"]).ok).toBe(true);
  });

  it("refuses an older beta ordinal when a newer beta is published", () => {
    // The beta-release.yml mirror: re-running beta.7 after beta.9 shipped.
    expect(judgeReleaseCurrency("3.1.0-beta.7", ["v3.1.0-beta.9"]).ok).toBe(false);
  });

  it("allows a beta whose base version is newer than the published beta", () => {
    // A base bump on develop resets the ordinal; a bare ordinal compare would
    // refuse this legitimate cut.
    expect(judgeReleaseCurrency("3.2.0-beta.1", ["v3.1.0-beta.99"]).ok).toBe(true);
  });

  it("allows the newest beta ordinal to be re-released", () => {
    expect(judgeReleaseCurrency("3.1.0-beta.9", ["v3.1.0-beta.9"]).ok).toBe(true);
  });
});
