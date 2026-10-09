import { expect, test } from "claude-code/testing";

test("the plugin loads and lets the session start unchanged", async ($, on) => {
  on("session.start", () => ({ cwd: "/work" }));

  const result = await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

  expect(result).toEqual({ cwd: "/work" });
});
