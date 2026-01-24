import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/**
 * Create a temporary directory without git initialization
 * Useful for testing "not a git repository" errors
 */
export async function setupNonGitDirectory(): Promise<{
  dirPath: string;
  homePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "vibe-e2e-non-git-"));
  const homePath = mkdtempSync(join(tmpdir(), "vibe-e2e-home-"));

  const cleanup = async () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { dirPath: tempDir, homePath, cleanup };
}

/**
 * Create a git repository without user.email and user.name configuration
 * Useful for testing git config validation
 */
export async function setupGitRepoWithoutUserConfig(): Promise<{
  repoPath: string;
  homePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "vibe-e2e-no-config-"));
  const homePath = mkdtempSync(join(tmpdir(), "vibe-e2e-home-"));

  // Initialize Git repository WITHOUT user config
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });

  // Create initial commit using git -c flag (without setting permanent config)
  writeFileSync(join(tempDir, "README.md"), "# Test Repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: tempDir, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial commit",
    ],
    { cwd: tempDir, stdio: "pipe" },
  );

  // Ensure we're on main branch
  execFileSync("git", ["branch", "-M", "main"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Note: user.email and user.name are NOT set in local config
  // This will cause errors when trying to create commits

  const cleanup = async () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { repoPath: tempDir, homePath, cleanup };
}

/**
 * Create a git repository with corrupted .git/config file
 * Useful for testing git error handling
 */
export async function setupCorruptedGitRepo(): Promise<{
  repoPath: string;
  homePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "vibe-e2e-corrupted-"));
  const homePath = mkdtempSync(join(tmpdir(), "vibe-e2e-home-"));

  // Initialize a normal git repository first
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: tempDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Create initial commit
  writeFileSync(join(tempDir, "README.md"), "# Test Repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: tempDir,
    stdio: "pipe",
  });
  execFileSync("git", ["branch", "-M", "main"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Now corrupt the .git/config file
  const gitConfigPath = join(tempDir, ".git", "config");
  const validConfig = `
[core]
\trepositoryformatversion = 0
\tfilemode = true
[user]
\tname = Test User
\temail = test@example.com
`;

  // Store valid config for cleanup
  const corruptedConfig = "CORRUPTED INVALID CONFIG\n<<<<<<\n>>>>>>>\n";
  writeFileSync(gitConfigPath, corruptedConfig);

  const cleanup = async () => {
    try {
      // Restore valid config first to allow cleanup
      writeFileSync(gitConfigPath, validConfig);
    } catch {
      // Ignore if file doesn't exist
    }

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { repoPath: tempDir, homePath, cleanup };
}

/**
 * Create a git repository in detached HEAD state
 * Useful for testing detached HEAD handling
 */
export async function setupDetachedHeadRepo(): Promise<{
  repoPath: string;
  homePath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "vibe-e2e-detached-"));
  const homePath = mkdtempSync(join(tmpdir(), "vibe-e2e-home-"));

  // Initialize Git repository
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: tempDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Create initial commit
  writeFileSync(join(tempDir, "README.md"), "# Test Repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: tempDir,
    stdio: "pipe",
  });
  execFileSync("git", ["branch", "-M", "main"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  // Put repository in detached HEAD state
  execFileSync("git", ["checkout", "--detach", "HEAD"], {
    cwd: tempDir,
    stdio: "pipe",
  });

  const cleanup = async () => {
    try {
      // Try to return to main branch before cleanup
      try {
        execFileSync("git", ["checkout", "main"], {
          cwd: tempDir,
          stdio: "pipe",
        });
      } catch {
        // Ignore if checkout fails
      }

      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory is already removed
    }
  };

  return { repoPath: tempDir, homePath, cleanup };
}

/**
 * Make a file or directory read-only
 * Returns a cleanup function to restore original permissions
 */
export async function makeReadOnly(
  path: string,
): Promise<() => Promise<void>> {
  const stats = statSync(path);
  const originalMode = stats.mode;

  // Make read-only (555 for directories, 444 for files)
  const isDirectory = stats.isDirectory();
  chmodSync(path, isDirectory ? 0o555 : 0o444);

  // Return cleanup function that restores original permissions
  return async () => {
    try {
      chmodSync(path, originalMode);
    } catch (error: any) {
      console.warn(
        `Warning: Failed to restore permissions on ${path}: ${error.message}`,
      );
    }
  };
}

/**
 * Make parent directory read-only
 * Returns a cleanup function to restore original permissions
 */
export async function makeParentDirReadOnly(
  repoPath: string,
): Promise<() => Promise<void>> {
  const parentDir = dirname(repoPath);
  return makeReadOnly(parentDir);
}

/**
 * Make a file completely inaccessible (chmod 000)
 * Returns a cleanup function to restore original permissions
 */
export async function makeInaccessible(
  path: string,
): Promise<() => Promise<void>> {
  const stats = statSync(path);
  const originalMode = stats.mode;

  // Make completely inaccessible
  chmodSync(path, 0o000);

  // Return cleanup function that restores original permissions
  return async () => {
    try {
      chmodSync(path, originalMode);
    } catch (error: any) {
      console.warn(
        `Warning: Failed to restore permissions on ${path}: ${error.message}`,
      );
    }
  };
}

/**
 * Recursively make directory and all contents read-only
 * Returns a cleanup function to restore all original permissions
 */
export async function makeDirectoryTreeReadOnly(
  dirPath: string,
): Promise<() => Promise<void>> {
  const cleanupFunctions: Array<() => Promise<void>> = [];

  // Helper function to recursively chmod
  const chmodRecursive = (path: string) => {
    const stats = statSync(path);
    const originalMode = stats.mode;

    if (stats.isDirectory()) {
      chmodSync(path, 0o555);
    } else {
      chmodSync(path, 0o444);
    }

    // Store cleanup function
    cleanupFunctions.push(async () => {
      try {
        chmodSync(path, originalMode);
      } catch (error: any) {
        console.warn(
          `Warning: Failed to restore permissions on ${path}: ${error.message}`,
        );
      }
    });
  };

  // Start with the directory itself
  chmodRecursive(dirPath);

  // Return combined cleanup function
  return async () => {
    // Restore permissions in reverse order (deepest first)
    for (const cleanup of cleanupFunctions.reverse()) {
      await cleanup();
    }
  };
}
