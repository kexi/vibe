//! End-to-end eval-contract tests for the real `vibe` binary.
//!
//! The shell wrapper runs `eval "$(command vibe ...)"`, so STDOUT is executed
//! verbatim and STDERR is the human channel. The single highest-risk invariant
//! of this CLI is that `home`/`jump` write ONLY a `cd '<path>'` line to STDOUT
//! (everything else on STDERR), and `shell-setup` writes ONLY its wrapper to
//! STDOUT. Unit tests over `Outcome` can't prove this: the binary's
//! `eval_output::write_outcome` prints to the real stdout via `println!`, and
//! the stderr/stdout split only exists at the process boundary.
//!
//! These tests therefore drive the BUILT binary (`CARGO_BIN_EXE_vibe`) with
//! stdout and stderr captured on SEPARATE pipes (not a PTY) and assert the exact
//! bytes on each stream — argv → dispatch → stdout, all the way through.
//!
//! Git-backed cases shell out to `git` to build a real worktree layout. CI has
//! git; if `git` is somehow unavailable the helper skips those cases rather than
//! failing spuriously.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// Path to the binary under test (Cargo sets this for integration tests).
fn vibe_bin() -> &'static str {
    env!("CARGO_BIN_EXE_vibe")
}

/// Run `git <args>` in `cwd`, panicking on failure (test setup must succeed).
fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {args:?} failed in {cwd:?}");
}

/// Whether `git` can be invoked at all (gate git-dependent cases).
fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run the vibe binary in `cwd` with the given args, returning captured output.
///
/// Crucially, `Command` captures stdout and stderr on independent pipes, so the
/// returned `Output` lets us assert each stream's exact bytes. `$HOME` is
/// redirected to an isolated dir so MRU/settings writes never touch the real
/// home (and stay off both streams).
fn run_vibe(cwd: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(vibe_bin())
        .args(args)
        .current_dir(cwd)
        .env("HOME", home)
        // Keep color codes out of asserted bytes regardless of the CI terminal.
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .output()
        .expect("failed to spawn vibe")
}

/// Run the vibe binary with `stdin_data` piped to its stdin, returning the
/// captured output. Used for the stdin-driven hook modes and the
/// `VIBE_FORCE_INTERACTIVE` confirm path (which reads a `y\n` answer).
///
/// `extra_env` lets a case set additional environment (e.g.
/// `VIBE_FORCE_INTERACTIVE=1`) without growing `run_vibe`'s signature.
fn run_vibe_stdin(
    cwd: &Path,
    home: &Path,
    args: &[&str],
    stdin_data: &str,
    extra_env: &[(&str, &str)],
) -> Output {
    let mut cmd = Command::new(vibe_bin());
    cmd.args(args)
        .current_dir(cwd)
        .env("HOME", home)
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("failed to spawn vibe");
    child
        .stdin
        .take()
        .expect("stdin pipe")
        .write_all(stdin_data.as_bytes())
        .expect("write stdin");
    child.wait_with_output().expect("wait vibe")
}

/// A single main worktree at `<root>/main` (no secondary). Returns the
/// canonicalized main path. Used by create-path cases (start / scratch / jump).
fn setup_main_repo(root: &Path) -> PathBuf {
    let main = root.join("main");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    git(&main, &["config", "user.email", "test@example.com"]);
    git(&main, &["config", "user.name", "Test"]);
    git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
    std::fs::canonicalize(&main).unwrap()
}

/// A main worktree at `<root>/main` plus a secondary worktree at `<root>/<dir>`
/// on branch `<branch>`. Returns (main_path, secondary_path).
fn setup_worktrees(root: &Path, secondary_dir: &str, branch: &str) -> (PathBuf, PathBuf) {
    let main = root.join("main");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    git(&main, &["config", "user.email", "test@example.com"]);
    git(&main, &["config", "user.name", "Test"]);
    git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);

    let secondary = root.join(secondary_dir);
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            secondary.to_str().unwrap(),
        ],
    );
    // `git worktree list` reports canonicalized paths (e.g. /private/tmp on
    // macOS), so canonicalize here too for byte-exact comparison.
    (
        std::fs::canonicalize(&main).unwrap(),
        std::fs::canonicalize(&secondary).unwrap(),
    )
}

/// Case 1: `vibe home` from a secondary worktree.
/// STDOUT is EXACTLY `cd '<main>'\n`; the "Returning to main worktree" human
/// line is on STDERR, never on STDOUT.
#[test]
fn home_writes_only_cd_to_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feat");

    let out = run_vibe(&secondary_path, home.path(), &["home"]);

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        stdout,
        format!("cd '{}'\n", main_path.display()),
        "stdout must be exactly the cd line"
    );
    // The human text is on stderr, NOT stdout.
    assert!(
        !stdout.contains("Returning to main worktree"),
        "human text leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("Returning to main worktree"),
        "human text missing from stderr: {stderr:?}"
    );
    assert!(out.status.success());
}

/// Case 2: `vibe jump <branch>` exact match.
/// STDOUT is exactly `cd '<wt>'\n`; nothing else.
#[test]
fn jump_exact_writes_only_cd_to_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    // Jump from the main worktree to `feature` by its exact branch name.
    let out = run_vibe(&main_path, home.path(), &["jump", "feature"]);

    let stdout = String::from_utf8(out.stdout).unwrap();

    assert_eq!(
        stdout,
        format!("cd '{}'\n", secondary_path.display()),
        "stdout must be exactly the cd line for the exact match"
    );
    assert!(out.status.success());
}

/// Case 2 (verbose channel): a non-exact match prints `Matched:` to STDERR only,
/// never STDOUT.
#[test]
fn jump_partial_matched_line_is_stderr_only() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    // "feat" is a substring of "feature" → single partial match → prints
    // `Matched: feature` to stderr and the cd to stdout.
    let out = run_vibe(&main_path, home.path(), &["jump", "feat"]);

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(stdout, format!("cd '{}'\n", secondary_path.display()));
    assert!(
        !stdout.contains("Matched:"),
        "Matched: leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("Matched: feature"),
        "Matched: missing from stderr: {stderr:?}"
    );
}

/// Case 3: a worktree path containing a single quote `'`.
/// The emitted `cd` is single-quote-escaped (`'\''`), byte-exact.
#[test]
fn jump_escapes_single_quote_in_path() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    // Directory name literally contains a single quote.
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "it's-a-wt", "quoted");

    let out = run_vibe(&main_path, home.path(), &["jump", "quoted"]);
    let stdout = String::from_utf8(out.stdout).unwrap();

    // The raw path has a `'`; the emitted line escapes it as `'\''`.
    let raw = secondary_path.display().to_string();
    assert!(
        raw.contains('\''),
        "fixture path must contain a quote: {raw}"
    );
    let escaped = raw.replace('\'', "'\\''");
    assert_eq!(
        stdout,
        format!("cd '{escaped}'\n"),
        "single quote in path must be shell-escaped byte-exact"
    );
    // And there is no bare, unescaped `cd '<...>'` containing a lone quote that
    // would terminate the quoted string early.
    assert!(
        stdout.contains("'\\''"),
        "expected '\\'' escape in {stdout:?}"
    );
}

/// Case 4: `vibe shell-setup --shell <s>` emits exactly the known TS wrapper on
/// STDOUT for every supported shell (byte-for-byte), and nothing on STDERR.
#[test]
fn shell_setup_wrappers_are_byte_exact_on_stdout() {
    let home = tempfile::tempdir().unwrap();
    let cases = [
        ("bash", "vibe() { eval \"$(command vibe \"$@\")\"; }\n"),
        ("zsh", "vibe() { eval \"$(command vibe \"$@\")\"; }\n"),
        ("fish", "function vibe; eval (command vibe $argv); end\n"),
        (
            "nushell",
            "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }\n",
        ),
        (
            "powershell",
            "function vibe { Invoke-Expression (& vibe.exe $args) }\n",
        ),
    ];

    for (shell, expected) in cases {
        let out = run_vibe(home.path(), home.path(), &["shell-setup", "--shell", shell]);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert_eq!(stdout, expected, "wrapper mismatch for {shell}");
        assert!(
            stderr.is_empty(),
            "shell-setup {shell} wrote to stderr: {stderr:?}"
        );
        assert!(out.status.success(), "shell-setup {shell} failed");
    }
}

/// Case 5 (newline guard) — reachability note + the observable boundary check.
///
/// The contract guard lives in `eval_output::write_outcome`: a `cd_path`
/// containing `\n`/`\r` returns an error instead of printing, so the shell never
/// evals a smuggled second line. A literal newline cannot exist in a real
/// on-disk worktree path, AND the porcelain parser splits on `\n`, so the guard
/// is genuinely UNREACHABLE through real `git` — meaning we can't manufacture a
/// newline-bearing `cd_path` end-to-end. The guard itself is unit-tested in
/// `crates/vibe/src/eval_output.rs` (`rejects_cd_path_with_newline` /
/// `rejects_cd_path_with_carriage_return`), which drive the exact function the
/// binary calls at its single stdout write point.
///
/// What we CAN assert at the process boundary is the complementary invariant the
/// guard protects: when a command fails (here, `home` outside any git repo) the
/// binary exits non-zero and emits NO `cd` line on stdout — stdout stays empty.
#[test]
fn failure_path_exits_nonzero_with_empty_stdout() {
    let home = tempfile::tempdir().unwrap();
    // Run in a fresh empty dir that is not a git repo.
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["home"]);
    let stdout = String::from_utf8(out.stdout).unwrap();

    assert!(
        !out.status.success(),
        "home outside a repo should exit non-zero; stdout={stdout:?}"
    );
    assert!(
        stdout.is_empty(),
        "failure path must keep stdout empty (no cd line): {stdout:?}"
    );
}

/// R-7 (a): `vibe rename <new>` success → STDOUT is EXACTLY `cd '<newPath>'\n`;
/// the "Renamed ..." and "Directory: ..." human lines are on STDERR only.
#[test]
fn rename_success_writes_only_cd_to_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    // main at <root>/main; secondary at <root>/feat on branch `feat`.
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feat");

    // Default new path = dirname(main)/<repo_name>-<sanitized> = <root>/main-renamed.
    let expected_new = main_path.parent().unwrap().join("main-renamed");

    // Run rename FROM the secondary worktree (renaming main is refused).
    let out = run_vibe(&secondary_path, home.path(), &["rename", "renamed"]);

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "rename failed; stderr={stderr:?}");
    assert_eq!(
        stdout,
        format!("cd '{}'\n", expected_new.display()),
        "stdout must be exactly the cd line"
    );
    // Human lines on stderr, NOT stdout.
    assert!(
        !stdout.contains("Renamed") && !stdout.contains("Directory:"),
        "human text leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("Renamed feat -> renamed"),
        "Renamed line missing from stderr: {stderr:?}"
    );
    assert!(
        stderr.contains("Directory:"),
        "Directory line missing from stderr: {stderr:?}"
    );
}

/// R-7 (b): same-name rename → STDOUT is EXACTLY `cd '<oldPath>'\n`; the "Already
/// named" line is on STDERR only.
#[test]
fn rename_same_name_writes_only_cd_to_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (_main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feat");

    // Rename to the SAME branch name → no-op cd back to the current worktree.
    let out = run_vibe(&secondary_path, home.path(), &["rename", "feat"]);

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "same-name rename failed: {stderr:?}");
    assert_eq!(
        stdout,
        format!("cd '{}'\n", secondary_path.display()),
        "stdout must be exactly the cd back to the old path"
    );
    assert!(
        !stdout.contains("Already named"),
        "human text leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("Already named 'feat'"),
        "Already named line missing from stderr: {stderr:?}"
    );
}

/// R-7 (c): dry-run rename → STDOUT EMPTY, exit 0, the 3 dry-run lines on STDERR.
#[test]
fn rename_dry_run_emits_no_cd_and_three_stderr_lines() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (_main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feat");

    let out = run_vibe(
        &secondary_path,
        home.path(),
        &["rename", "renamed", "--dry-run"],
    );

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "dry-run rename failed: {stderr:?}");
    // Dry-run performs no side effects and emits NO cd.
    assert!(
        stdout.is_empty(),
        "dry-run must keep stdout empty: {stdout:?}"
    );
    // The three dry-run lines, all on stderr.
    assert!(
        stderr.contains("Would run: git worktree move"),
        "missing move dry-run line: {stderr:?}"
    );
    assert!(
        stderr.contains("Would run: git branch -m feat renamed"),
        "missing branch dry-run line: {stderr:?}"
    );
    assert!(
        stderr.contains("Would change directory to:"),
        "missing change-dir dry-run line: {stderr:?}"
    );
}

// --- Phase 4 lifecycle commands (start / scratch / clean) eval contract ---

/// G-1: `vibe start <newbranch>` success → STDOUT is EXACTLY `cd '<wt>'\n`; the
/// "Setting up..."/progress text stays on STDERR. A `.vibe.toml` post_start hook
/// that echoes to stdout must NOT leak to the parent stdout.
///
/// NOTE on the hook channel: `start` ALWAYS runs its hooks through the progress
/// tracker (`run_lifecycle_hooks` passes `Some(HookTrackerInfo)`), and the tracker
/// branch in `run_hooks` SUPPRESSES hook stdout entirely (TS parity — see the
/// `tracker.is_none()` gate in `hooks.rs`). So the load-bearing invariant proven
/// here is "hook stdout never reaches the parent's stdout"; we assert the sentinel
/// is absent from stdout (it is suppressed, not forwarded to stderr in this path).
#[test]
fn start_success_writes_only_cd_to_stdout_and_hooks_do_not_leak() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let main_path = setup_main_repo(tmp.path());

    // A post_start hook that prints a sentinel to ITS stdout. If hook stdout were
    // wired to the parent's stdout, the sentinel would corrupt the eval'd `cd`.
    let sentinel = "HOOK_STDOUT_SENTINEL_xyz";
    std::fs::write(
        main_path.join(".vibe.toml"),
        format!("[hooks]\npost_start = [\"echo {sentinel}\"]\n"),
    )
    .unwrap();

    // Trust the config so the hook actually runs (vibe verifies the hash).
    let trust = run_vibe(&main_path, home.path(), &["trust"]);
    assert!(
        trust.status.success(),
        "trust failed: {}",
        String::from_utf8_lossy(&trust.stderr)
    );

    let out = run_vibe(&main_path, home.path(), &["start", "feature"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "start failed; stderr={stderr:?}");

    // Default new-worktree path = dirname(main)/<repo_name>-feature = <root>/main-feature.
    let expected = main_path.parent().unwrap().join("main-feature");
    assert_eq!(
        stdout,
        format!("cd '{}'\n", expected.display()),
        "stdout must be EXACTLY the cd line"
    );
    // The hook's stdout sentinel must NOT have leaked onto the parent stdout
    // (it is suppressed by the tracker path).
    assert!(
        !stdout.contains(sentinel),
        "hook stdout leaked to parent stdout: {stdout:?}"
    );
    // The worktree was actually created on disk.
    assert!(expected.exists(), "worktree dir should exist: {expected:?}");
}

/// G-2: `vibe start --claude-code-worktree-hook` with a name via stdin JSON →
/// STDOUT is the worktree PATH (NOT `cd '...'`), proving the `Outcome::stdout`
/// branch through the real binary. The path is emitted verbatim (no trailing
/// newline, unlike the `cd` form).
#[test]
fn start_worktree_hook_mode_outputs_path_not_cd() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let main_path = setup_main_repo(tmp.path());

    let out = run_vibe_stdin(
        &main_path,
        home.path(),
        &["start", "--claude-code-worktree-hook"],
        r#"{"name": "hooked"}"#,
        &[],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "hook start failed; stderr={stderr:?}");

    let expected = main_path.parent().unwrap().join("main-hooked");
    // Hook mode emits the PATH verbatim, NOT a `cd '...'` line.
    assert_eq!(
        stdout,
        expected.display().to_string(),
        "hook mode must output the bare worktree path"
    );
    assert!(
        !stdout.starts_with("cd '"),
        "hook mode must NOT emit a cd line: {stdout:?}"
    );
    assert!(
        expected.exists(),
        "worktree should be created: {expected:?}"
    );
}

/// G-3: `vibe clean` from a secondary worktree → STDOUT is EXACTLY `cd '<main>'\n`;
/// the "Worktree ... removed"/progress text stays on STDERR.
#[test]
fn clean_writes_only_cd_to_main_on_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feat");

    let out = run_vibe(&secondary_path, home.path(), &["clean"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "clean failed; stderr={stderr:?}");
    assert_eq!(
        stdout,
        format!("cd '{}'\n", main_path.display()),
        "stdout must be EXACTLY the cd-to-main line"
    );
    // The human "removed" line is on stderr, never stdout.
    assert!(
        !stdout.contains("has been removed"),
        "human text leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("has been removed"),
        "removed line missing from stderr: {stderr:?}"
    );
}

/// G-4: `vibe scratch` → STDOUT is EXACTLY `cd '<scratchPath>'\n`; the
/// "Promote with:" hint stays on STDERR. The path is auto-named
/// `<repo_name>-scratch-<timestamp>` so we assert the prefix + the `scratch`
/// marker rather than an exact timestamp.
#[test]
fn scratch_writes_only_cd_to_stdout() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let main_path = setup_main_repo(tmp.path());

    let out = run_vibe(&main_path, home.path(), &["scratch"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "scratch failed; stderr={stderr:?}");

    // Exactly one line: `cd '<...scratch...>'\n`.
    let prefix = format!("cd '{}-scratch-", main_path.display());
    assert!(
        stdout.starts_with(&prefix) && stdout.ends_with("'\n"),
        "stdout must be exactly the scratch cd line: {stdout:?}"
    );
    assert_eq!(stdout.lines().count(), 1, "stdout must be a single cd line");
    // The promote hint is on stderr only.
    assert!(
        !stdout.contains("Promote with:"),
        "promote hint leaked to stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("Promote with: vibe rename <new-name>"),
        "promote hint missing from stderr: {stderr:?}"
    );
}

/// G-5 (a): `vibe start --dry-run` → STDOUT EMPTY, exit 0, the dry-run lines on
/// STDERR. Mirrors rename's existing dry-run eval test.
#[test]
fn start_dry_run_emits_no_cd_and_stderr_lines() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let main_path = setup_main_repo(tmp.path());

    let out = run_vibe(&main_path, home.path(), &["start", "feature", "--dry-run"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "dry-run start failed: {stderr:?}");
    assert!(
        stdout.is_empty(),
        "dry-run must keep stdout empty: {stdout:?}"
    );
    assert!(
        stderr.contains("Would run: git worktree add"),
        "missing dry-run create line: {stderr:?}"
    );
    assert!(
        stderr.contains("Would change directory to:"),
        "missing change-dir dry-run line: {stderr:?}"
    );
    // Nothing was created on disk.
    let unexpected = main_path.parent().unwrap().join("main-feature");
    assert!(
        !unexpected.exists(),
        "dry-run must not create the worktree: {unexpected:?}"
    );
}

// G-5 (b) `vibe clean --dry-run` is NOT implemented: `clean` has no `--dry-run`
// flag (verified against the TS `clean.ts` and the completion spec — clean only
// exposes --force/--delete-branch/--keep-branch/--claude-code-worktree-hook).
// Asserting clap rejects it would be a CLI-surface test, not an eval-contract
// one, and is already covered by the cli.rs consistency suite. So only the start
// dry-run half of G-5 is meaningful at the eval-contract boundary; this is noted
// as an intentional gap rather than a missing test.

/// G-21: jump → RealStart create path (the flagship Phase 4 wiring). In a real
/// repo, `vibe jump <nonexistent>` with `y\n` piped (and VIBE_FORCE_INTERACTIVE=1
/// so the confirm prompt works under a pipe) must run the REAL start command:
/// the worktree is created on disk AND stdout is EXACTLY `cd '<newWt>'\n`.
#[test]
fn jump_create_path_runs_real_start_and_cds() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let main_path = setup_main_repo(tmp.path());

    let out = run_vibe_stdin(
        &main_path,
        home.path(),
        &["jump", "brandnew"],
        "y\n",
        &[("VIBE_FORCE_INTERACTIVE", "1")],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        out.status.success(),
        "jump-create failed; stderr={stderr:?}"
    );
    let expected = main_path.parent().unwrap().join("main-brandnew");
    assert_eq!(
        stdout,
        format!("cd '{}'\n", expected.display()),
        "stdout must be EXACTLY the cd line into the new worktree"
    );
    // The real start command actually created the worktree.
    assert!(
        expected.exists(),
        "jump-create must create the worktree on disk: {expected:?}"
    );
    // And the no-match prompt line was on stderr, never stdout.
    assert!(
        !stdout.contains("No worktree found"),
        "prompt text leaked to stdout: {stdout:?}"
    );
}
