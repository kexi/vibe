/**
 * Tests for scripts/resolve-npm-dist-tag.ts — the explicit dist-tag that keeps
 * a re-fired publish from moving npm's `latest` backwards (#616 hazard 2).
 *
 * What these guarantee:
 *   - the #616 regression itself: publishing 3.1.0 while the registry's latest
 *     is 3.2.0 resolves to a non-default tag, so `npm install @kexi/vibe` keeps
 *     resolving 3.2.0 while the older bytes remain installable by exact version;
 *   - the current version, and any newer one, still claims `latest`, so an
 *     ordinary release publishes exactly as before;
 *   - a package with no `latest` yet (npm view prints nothing) claims `latest`;
 *   - anything unorderable on either side fails closed onto the non-default tag
 *     rather than defaulting to `latest`.
 */

import { describe, it, expect } from "vitest";
import {
  NON_DEFAULT_DIST_TAG,
  parseCliArgs,
  resolveDistTag,
} from "../../../scripts/resolve-npm-dist-tag";

describe("parseCliArgs", () => {
  it("accepts a version and the registry's latest", () => {
    expect(parseCliArgs(["--version", "3.2.0", "--registry-latest", "3.1.0"])).toEqual({
      version: "3.2.0",
      registryLatest: "3.1.0",
    });
  });

  it("accepts an empty --registry-latest, the unpublished-package case", () => {
    // Distinct from the flag being absent: `npm view` prints nothing for a
    // package with no dist-tags, and the workflow passes that through verbatim.
    expect(parseCliArgs(["--version", "3.2.0", "--registry-latest", ""])).toEqual({
      version: "3.2.0",
      registryLatest: "",
    });
  });

  it("requires both flags", () => {
    expect(() => parseCliArgs(["--registry-latest", "3.1.0"])).toThrowError(
      /--version is required/,
    );
    expect(() => parseCliArgs(["--version", "3.2.0"])).toThrowError(/--registry-latest is required/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseCliArgs(["--tag", "beta"])).toThrowError(/Unknown argument/);
  });
});

describe("resolveDistTag", () => {
  it("keeps latest off an older version when a newer one is published (#616)", () => {
    expect(resolveDistTag("3.1.0", "3.2.0")).toBe(NON_DEFAULT_DIST_TAG);
  });

  it("claims latest for a newer version", () => {
    expect(resolveDistTag("3.2.0", "3.1.0")).toBe("latest");
  });

  it("claims latest when re-publishing the version that already is latest", () => {
    // The idempotent repair path: a platform package whose first publish failed
    // must still land on latest alongside its siblings.
    expect(resolveDistTag("3.2.0", "3.2.0")).toBe("latest");
  });

  it("claims latest when the package has no dist-tag yet", () => {
    expect(resolveDistTag("1.0.0", "")).toBe("latest");
    expect(resolveDistTag("1.0.0", "  \n")).toBe("latest");
  });

  it("compares numerically, so 3.9.0 does not displace 3.10.0", () => {
    expect(resolveDistTag("3.9.0", "3.10.0")).toBe(NON_DEFAULT_DIST_TAG);
  });

  it("tolerates a v-prefixed version on either side", () => {
    expect(resolveDistTag("v3.2.0", "v3.1.0")).toBe("latest");
  });

  it("fails closed onto the non-default tag for an unorderable version", () => {
    expect(resolveDistTag("nightly", "3.1.0")).toBe(NON_DEFAULT_DIST_TAG);
  });

  it("fails closed when the registry's latest cannot be ordered", () => {
    // An unrecognised latest means the comparison cannot be made, and a tag the
    // gate cannot reason about must not be allowed to move `latest`.
    expect(resolveDistTag("3.2.0", "next")).toBe(NON_DEFAULT_DIST_TAG);
  });

  it("never returns a tag npm would treat as a version range", () => {
    // npm rejects a dist-tag that parses as a semver range, so the fallback
    // name has to stay a plain identifier.
    expect(NON_DEFAULT_DIST_TAG).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
