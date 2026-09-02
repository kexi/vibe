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
 *   - a package with no `latest` yet (npm view reports E404) claims `latest`;
 *   - anything unorderable on either side fails closed onto the non-default tag
 *     rather than defaulting to `latest`;
 *   - a `npm view` lookup that failed for any reason OTHER than an absent
 *     package aborts instead of being read as "no latest yet", which would hand
 *     `latest` to an older version on a transient registry outage.
 */

import { describe, it, expect } from "vitest";
import {
  NON_DEFAULT_DIST_TAG,
  interpretNpmView,
  parseCliArgs,
  resolveDistTag,
} from "../../../scripts/resolve-npm-dist-tag";

describe("parseCliArgs", () => {
  it("accepts a version and the npm view result", () => {
    expect(
      parseCliArgs([
        "--version",
        "3.2.0",
        "--npm-view-json",
        '"3.1.0"',
        "--npm-view-exit-code",
        "0",
      ]),
    ).toEqual({ version: "3.2.0", npmViewJson: '"3.1.0"', npmViewExitCode: 0 });
  });

  it("accepts empty --npm-view-json, which npm produces on some failures", () => {
    // Distinct from the flag being absent: the workflow passes npm's stdout
    // through verbatim, and that stdout can legitimately be empty.
    expect(
      parseCliArgs(["--version", "3.2.0", "--npm-view-json", "", "--npm-view-exit-code", "1"]),
    ).toEqual({ version: "3.2.0", npmViewJson: "", npmViewExitCode: 1 });
  });

  it("requires every flag", () => {
    expect(() =>
      parseCliArgs(["--npm-view-json", '"3.1.0"', "--npm-view-exit-code", "0"]),
    ).toThrowError(/--version is required/);
    expect(() =>
      parseCliArgs(["--version", "3.2.0", "--npm-view-exit-code", "0"]),
    ).toThrowError(/--npm-view-json is required/);
    expect(() => parseCliArgs(["--version", "3.2.0", "--npm-view-json", ""])).toThrowError(
      /--npm-view-exit-code is required/,
    );
  });

  it("rejects a non-numeric exit code rather than coercing it", () => {
    // NaN would compare false against 0 and silently take the failure path.
    expect(() =>
      parseCliArgs(["--version", "3.2.0", "--npm-view-json", "", "--npm-view-exit-code", "oops"]),
    ).toThrowError(/non-negative integer/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseCliArgs(["--tag", "beta"])).toThrowError(/Unknown argument/);
  });
});

describe("interpretNpmView", () => {
  it("reads the dist-tag from a successful lookup", () => {
    expect(interpretNpmView('"3.1.0"\n', 0)).toBe("3.1.0");
  });

  it("treats a confirmed E404 as a package with no latest yet", () => {
    const e404 = JSON.stringify({ error: { code: "E404", summary: "Not Found" } });
    expect(interpretNpmView(e404, 1)).toBeUndefined();
  });

  it("refuses to read a registry failure as an absent package (#616 fail-open)", () => {
    // The regression this guards: ECONNREFUSED and E404 both exit 1, and the
    // earlier `|| true` form collapsed them into the same empty string — so an
    // outage would have let an old version claim `latest`.
    const refused = JSON.stringify({ error: { code: "ECONNREFUSED", summary: "FetchError" } });
    expect(() => interpretNpmView(refused, 1)).toThrowError(/ECONNREFUSED/);
  });

  it("refuses a failure that carried no JSON body at all", () => {
    expect(() => interpretNpmView("", 1)).toThrowError(/cannot tell an unpublished package/);
    expect(() => interpretNpmView("npm error boom", 1)).toThrowError(/not valid JSON/);
  });

  it("refuses a success that reported no usable dist-tag", () => {
    expect(() => interpretNpmView("", 0)).toThrowError(/printed nothing/);
    expect(() => interpretNpmView("{}", 0)).toThrowError(/did not report a dist-tag string/);
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
    // `undefined` is what interpretNpmView returns for a confirmed E404 — the
    // only route to this branch now that a failed lookup throws instead.
    expect(resolveDistTag("1.0.0", undefined)).toBe("latest");
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
