import { describe, it, expect } from "vitest";
import { fuzzyMatch, FUZZY_MATCH_MIN_LENGTH } from "./fuzzy.ts";

describe("fuzzyMatch", () => {
  it("matches basic subsequence (feli → feat/login)", () => {
    const result = fuzzyMatch("feat/login", "feli");
    expect(result).not.toBeNull();
    // f=0, e=1, l=5, i=8 (feat/login)
    expect(result!.matchPositions).toEqual([0, 1, 5, 8]);
  });

  it("returns null when characters do not appear in order", () => {
    const result = fuzzyMatch("feat/login", "xyz");
    expect(result).toBeNull();
  });

  it("returns null when search is longer than target", () => {
    const result = fuzzyMatch("feat", "feat/login");
    expect(result).toBeNull();
  });

  it("returns null for empty search string", () => {
    const result = fuzzyMatch("feat/login", "");
    expect(result).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = fuzzyMatch("feat/login", "FELI");
    expect(result).not.toBeNull();
    // f=0, e=1, l=5, i=8 (feat/login)
    expect(result!.matchPositions).toEqual([0, 1, 5, 8]);
  });

  it("scores consecutive matches higher than scattered matches", () => {
    // "abc" in "abcdef" matches consecutively at positions 0,1,2
    const consecutive = fuzzyMatch("abcdef", "abc");
    // "ace" in "abcdef" matches scattered at positions 0,2,4
    const scattered = fuzzyMatch("abcdef", "ace");

    expect(consecutive).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(consecutive!.score).toBeGreaterThan(scattered!.score);
  });

  it("gives word boundary bonus when matching after delimiter", () => {
    // "l" matches at word boundary (after "/") in "feat/login"
    const atBoundary = fuzzyMatch("feat/login", "log");
    // "l" matches mid-word in "fallow"
    const midWord = fuzzyMatch("fallowing", "log");

    expect(atBoundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(atBoundary!.score).toBeGreaterThan(midWord!.score);
  });

  it("gives start bonus when first character matches at position 0", () => {
    const startMatch = fuzzyMatch("feat/login", "feat");
    const noStartMatch = fuzzyMatch("xfeat/login", "feat");

    expect(startMatch).not.toBeNull();
    expect(noStartMatch).not.toBeNull();
    expect(startMatch!.score).toBeGreaterThan(noStartMatch!.score);
  });

  it("matches all characters for exact subsequence", () => {
    const result = fuzzyMatch("abc", "abc");
    expect(result).not.toBeNull();
    expect(result!.matchPositions).toEqual([0, 1, 2]);
  });

  it("handles single character search", () => {
    const result = fuzzyMatch("feat/login", "f");
    expect(result).not.toBeNull();
    expect(result!.matchPositions).toEqual([0]);
  });

  it("matches with hyphens and underscores as boundaries", () => {
    const hyphenResult = fuzzyMatch("feat-login", "log");
    const underscoreResult = fuzzyMatch("feat_login", "log");

    expect(hyphenResult).not.toBeNull();
    expect(underscoreResult).not.toBeNull();
    // Both should get word boundary bonus
    expect(hyphenResult!.score).toBe(underscoreResult!.score);
  });

  it("exports FUZZY_MATCH_MIN_LENGTH as 3", () => {
    expect(FUZZY_MATCH_MIN_LENGTH).toBe(3);
  });

  it("penalizes long tails after last match", () => {
    const shortTail = fuzzyMatch("feat/login", "feat");
    const longTail = fuzzyMatch("feat/login-page-extra-long", "feat");

    expect(shortTail).not.toBeNull();
    expect(longTail).not.toBeNull();
    expect(shortTail!.score).toBeGreaterThan(longTail!.score);
  });

  it("penalizes gaps between matches", () => {
    // "fl" in "f-l" has gap of 1
    const smallGap = fuzzyMatch("f-login", "fl");
    // "fl" in "f----login" has gap of 4
    const largeGap = fuzzyMatch("f----login", "fl");

    expect(smallGap).not.toBeNull();
    expect(largeGap).not.toBeNull();
    expect(smallGap!.score).toBeGreaterThan(largeGap!.score);
  });
});
