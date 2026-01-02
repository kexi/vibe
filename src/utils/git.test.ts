import { assertEquals } from "@std/assert";
import {
  findWorktreeByBranch,
  hasUncommittedChanges,
  normalizeRemoteUrl,
  sanitizeBranchName,
} from "./git.ts";

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

Deno.test("hasUncommittedChanges returns false when there are no changes", async () => {
  // This test runs in the current repository
  // We assume the test environment has a clean working tree or the changes are committed
  const originalDir = Deno.cwd();

  try {
    // Create a temporary directory for testing
    const tempDir = await Deno.makeTempDir();
    Deno.chdir(tempDir);

    // Initialize a git repository
    await new Deno.Command("git", {
      args: ["init"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.email", "test@example.com"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.name", "Test User"],
    }).output();

    // Create and commit a file to have a valid repository
    await Deno.writeTextFile("test.txt", "initial content");
    await new Deno.Command("git", {
      args: ["add", "test.txt"],
    }).output();

    await new Deno.Command("git", {
      args: ["commit", "-m", "Initial commit"],
    }).output();

    // Now the repository should have no uncommitted changes
    const result = await hasUncommittedChanges();
    assertEquals(result, false);

    // Clean up
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  } catch (error) {
    Deno.chdir(originalDir);
    throw error;
  }
});

Deno.test("hasUncommittedChanges returns true when there are uncommitted changes", async () => {
  const originalDir = Deno.cwd();

  try {
    // Create a temporary directory for testing
    const tempDir = await Deno.makeTempDir();
    Deno.chdir(tempDir);

    // Initialize a git repository
    await new Deno.Command("git", {
      args: ["init"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.email", "test@example.com"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.name", "Test User"],
    }).output();

    // Create and commit a file
    await Deno.writeTextFile("test.txt", "initial content");
    await new Deno.Command("git", {
      args: ["add", "test.txt"],
    }).output();

    await new Deno.Command("git", {
      args: ["commit", "-m", "Initial commit"],
    }).output();

    // Make an uncommitted change
    await Deno.writeTextFile("test.txt", "modified content");

    // Now the repository should have uncommitted changes
    const result = await hasUncommittedChanges();
    assertEquals(result, true);

    // Clean up
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  } catch (error) {
    Deno.chdir(originalDir);
    throw error;
  }
});

Deno.test("hasUncommittedChanges returns true when there are untracked files", async () => {
  const originalDir = Deno.cwd();

  try {
    // Create a temporary directory for testing
    const tempDir = await Deno.makeTempDir();
    Deno.chdir(tempDir);

    // Initialize a git repository
    await new Deno.Command("git", {
      args: ["init"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.email", "test@example.com"],
    }).output();

    await new Deno.Command("git", {
      args: ["config", "user.name", "Test User"],
    }).output();

    // Create and commit a file
    await Deno.writeTextFile("test.txt", "initial content");
    await new Deno.Command("git", {
      args: ["add", "test.txt"],
    }).output();

    await new Deno.Command("git", {
      args: ["commit", "-m", "Initial commit"],
    }).output();

    // Create an untracked file
    await Deno.writeTextFile("untracked.txt", "untracked content");

    // Now the repository should have untracked files
    const result = await hasUncommittedChanges();
    assertEquals(result, true);

    // Clean up
    Deno.chdir(originalDir);
    await Deno.remove(tempDir, { recursive: true });
  } catch (error) {
    Deno.chdir(originalDir);
    throw error;
  }
});

Deno.test({
  name: "findWorktreeByBranch returns null when branch is not found",
  ignore: true, // Requires actual git repository, ignored for automated tests
  async fn() {
    const result = await findWorktreeByBranch("non-existent-branch");
    assertEquals(result, null);
  },
});

// ===== URL Normalization Tests =====

Deno.test("normalizeRemoteUrl: HTTPS URL with .git suffix", () => {
  const result = normalizeRemoteUrl("https://github.com/user/repo.git");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: SSH URL (git@host:path format)", () => {
  const result = normalizeRemoteUrl("git@github.com:user/repo.git");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: SSH URL with protocol", () => {
  const result = normalizeRemoteUrl("ssh://git@github.com/user/repo.git");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: HTTP URL without .git suffix", () => {
  const result = normalizeRemoteUrl("http://github.com/user/repo");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: URL with credentials", () => {
  const result = normalizeRemoteUrl("https://token@github.com/user/repo.git");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: URL with user:password credentials", () => {
  const result = normalizeRemoteUrl("https://user:pass@github.com/user/repo.git");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: already normalized URL", () => {
  const result = normalizeRemoteUrl("github.com/user/repo");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: complex SSH with port", () => {
  const result = normalizeRemoteUrl("ssh://git@github.com:22/user/repo.git");
  assertEquals(result, "github.com:22/user/repo");
});

Deno.test("normalizeRemoteUrl: URL with spaces (edge case)", () => {
  const result = normalizeRemoteUrl("  https://github.com/user/repo.git  ");
  assertEquals(result, "github.com/user/repo");
});

Deno.test("normalizeRemoteUrl: GitLab SSH format", () => {
  const result = normalizeRemoteUrl("git@gitlab.com:group/subgroup/repo.git");
  assertEquals(result, "gitlab.com/group/subgroup/repo");
});
