import { assertEquals } from "@std/assert";
import { findWorktreeByBranch, sanitizeBranchName } from "./git.ts";

Deno.test("sanitizeBranchName replaces slashes with dashes", () => {
  const result = sanitizeBranchName("feat/new-feature");
  assertEquals(result, "feat-new-feature");
});

Deno.test("sanitizeBranchName handles multiple slashes", () => {
  const result = sanitizeBranchName("feat/user/auth/login");
  assertEquals(result, "feat-user-auth-login");
});

Deno.test("sanitizeBranchName returns unchanged string without slashes", () => {
  const result = sanitizeBranchName("simple-branch");
  assertEquals(result, "simple-branch");
});

Deno.test("sanitizeBranchName handles empty string", () => {
  const result = sanitizeBranchName("");
  assertEquals(result, "");
});

Deno.test({
  name: "findWorktreeByBranch returns null when branch is not found",
  ignore: true, // 実際のgitリポジトリが必要なため、手動テスト用にignore
  async fn() {
    const result = await findWorktreeByBranch("non-existent-branch");
    assertEquals(result, null);
  },
});
