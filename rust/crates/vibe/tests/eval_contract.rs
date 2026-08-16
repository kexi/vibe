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

/// An empty file used as `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, created in
/// `cwd`'s PARENT (the fixture root, outside any working tree) and returned.
///
/// Why not `/dev/null`: it does not exist on Windows, and git treats an
/// unreadable config path as *absent* — so the isolation would silently vanish
/// and the developer's real `~/.gitconfig` would be read. An empty regular file
/// is a valid, empty config on every OS.
///
/// Why the parent and not `cwd`: `cwd` is the repo under test, and an untracked
/// file there would make `clean`'s uncommitted-changes check fire.
///
/// Created once per fixture: the file is content-free, so re-writing it on every
/// `git()` call would be pure churn.
fn empty_git_config(cwd: &Path) -> PathBuf {
    let dir = cwd.parent().unwrap_or(cwd);
    let path = dir.join("empty.gitconfig");
    if !path.exists() {
        std::fs::write(&path, "").unwrap();
    }
    path
}

/// Run `git <args>` in `cwd`, panicking on failure (test setup must succeed).
///
/// The isolating empty config lives beside the repo under test, so callers do
/// not have to thread a second path through every helper.
fn git(cwd: &Path, args: &[&str]) {
    let config = empty_git_config(cwd);
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_SYSTEM", &config)
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
    let mut cmd = Command::new(vibe_bin());
    cmd.args(args)
        .current_dir(cwd)
        .env("HOME", home)
        // Keep color codes out of asserted bytes regardless of the CI terminal.
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1");
    isolate_config_env(&mut cmd, home);
    cmd.output().expect("failed to spawn vibe")
}

/// Point every config-discovery variable vibe reads at the isolated `home`.
///
/// `HOME` alone is not enough: `doctor` also consults `XDG_CONFIG_HOME` (and,
/// on the Windows branch, `APPDATA`/`USERPROFILE`/`OneDrive`). A developer with
/// `XDG_CONFIG_HOME` exported and a stale wrapper in it would otherwise see these
/// tests go red for reasons that have nothing to do with the change under test.
fn isolate_config_env(cmd: &mut Command, home: &Path) {
    for key in ["XDG_CONFIG_HOME", "APPDATA", "USERPROFILE", "OneDrive"] {
        cmd.env(key, home);
    }
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
    isolate_config_env(&mut cmd, home);
    // Applied after the isolation so a case can deliberately override it.
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

#[test]
fn help_writes_to_stderr_not_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["--help"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "help should exit 0: {stderr:?}");
    assert!(
        stdout.is_empty(),
        "help must not be eval'd from stdout: {stdout:?}"
    );
    assert!(stderr.contains("Usage: vibe"), "help missing from stderr");
}

#[test]
fn start_force_and_reuse_together_is_an_argument_error() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    // The guard fires in dispatch before any git work, so no repo is needed.
    let out = run_vibe(
        tmp.path(),
        home.path(),
        &["start", "feat", "--force", "--reuse"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        !out.status.success(),
        "contradictory flags must not exit 0: {stderr:?}"
    );
    // Nothing must reach the eval'd stdout on an error.
    assert!(stdout.is_empty(), "error must not write stdout: {stdout:?}");
    assert!(
        stderr.contains("--force and --reuse cannot be used together"),
        "missing mutual-exclusion message: {stderr:?}"
    );
}

#[test]
fn bare_invocation_help_writes_to_stderr_not_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &[]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        out.status.success(),
        "bare invocation should exit 0: {stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "bare help must not be eval'd from stdout: {stdout:?}"
    );
    assert!(stderr.contains("Usage: vibe"), "help missing from stderr");
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
///
/// This is ALSO the default-dialect regression witness: no `--eval-dialect` flag
/// is passed, so it pins the exact bytes an already-installed (pre-dialect)
/// bash/zsh/fish wrapper receives. The dialect cases below must never change
/// these bytes.
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
            "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nu ...$args); for line in ($out | lines) { if ($line | str starts-with \"__VIBE_CD__\") { cd ($line | str replace \"__VIBE_CD__\" \"\") } else { print $line } } }\n",
        ),
        (
            "powershell",
            "function vibe { $out = & vibe.exe --eval-dialect powershell @args; if ($out) { Invoke-Expression ($out -join \"`n\") } }\n",
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
/// evals a smuggled second line. POSIX permits a newline in a path, and since
/// the worktree list is read with `--porcelain -z` such a path now survives
/// parsing intact instead of being mangled into two entries — so this guard is
/// the REAL defense, not a belt-and-braces one. It is unit-tested directly in
/// `crates/vibe/src/eval_output.rs` (`rejects_cd_path_with_newline` /
/// `rejects_cd_path_with_carriage_return`), which drive the exact function the
/// binary calls at its single stdout write point; reproducing it end-to-end
/// would require creating a newline-named directory on the test host, which not
/// every filesystem we run CI on accepts.
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

// --- `--eval-dialect` (nushell / powershell stdout dialects) ---
//
// The hidden global `--eval-dialect` flag is what the NEW nushell/powershell
// wrappers pass; it changes ONLY how a `cd` outcome is rendered on stdout.
// These cases drive the real binary so the flag is proven end-to-end (argv →
// clap → dispatch → the single `write_outcome` call), with the flag placed
// BEFORE the subcommand exactly as the generated wrappers place it.
//
// Every case uses a worktree directory containing a literal `'`, because that
// is the character where the three dialects diverge: POSIX backslash-escapes it
// (`'\''`), PowerShell doubles it (`''`), and nushell must not quote it at all.

/// `--eval-dialect nu jump <branch>` → STDOUT is EXACTLY
/// `__VIBE_CD__<raw path>\n`: the sentinel plus the path VERBATIM (no quoting,
/// no escaping), because the nushell wrapper strips the prefix and hands the
/// remainder to `cd` as data that nu never parses as source.
#[test]
fn jump_nu_dialect_emits_sentinel_and_raw_path() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "it's-a-wt", "quoted");

    let out = run_vibe(
        &main_path,
        home.path(),
        &["--eval-dialect", "nu", "jump", "quoted"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "nu-dialect jump failed: {stderr:?}");

    let raw = secondary_path.display().to_string();
    assert!(
        raw.contains('\''),
        "fixture path must contain a quote: {raw}"
    );
    assert_eq!(
        stdout,
        format!("__VIBE_CD__{raw}\n"),
        "nu dialect must emit the sentinel followed by the raw, unescaped path"
    );
    // Explicitly NOT the POSIX form: no `cd '`, no `'\''` escape.
    assert!(
        !stdout.contains("cd '") && !stdout.contains("'\\''"),
        "nu dialect must not emit POSIX quoting: {stdout:?}"
    );
}

/// `--eval-dialect powershell jump <branch>` → STDOUT is EXACTLY
/// `Set-Location -LiteralPath '<path with '' doubled>'\n`.
#[test]
fn jump_powershell_dialect_emits_set_location_with_doubled_quote() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "it's-a-wt", "quoted");

    let out = run_vibe(
        &main_path,
        home.path(),
        &["--eval-dialect", "powershell", "jump", "quoted"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        out.status.success(),
        "powershell-dialect jump failed: {stderr:?}"
    );

    let raw = secondary_path.display().to_string();
    assert!(
        raw.contains('\''),
        "fixture path must contain a quote: {raw}"
    );
    let doubled = raw.replace('\'', "''");
    assert_eq!(
        stdout,
        format!("Set-Location -LiteralPath '{doubled}'\n"),
        "powershell dialect must double the quote inside a literal path"
    );
    // PowerShell has no backslash escape inside '...'; the POSIX form must not leak.
    assert!(
        !stdout.contains("'\\''"),
        "POSIX escape leaked into the powershell dialect: {stdout:?}"
    );
}

/// The dialect affects the `cd` rendering ONLY. A non-`cd` outcome (here
/// `shell-setup`, whose payload is verbatim `Outcome::stdout` text) is emitted
/// byte-identically no matter which dialect the wrapper asked for — otherwise
/// the nushell wrapper could not re-emit its own definition.
#[test]
fn shell_setup_wrapper_is_unchanged_by_the_nu_dialect() {
    let home = tempfile::tempdir().unwrap();
    let expected = "def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nu ...$args); for line in ($out | lines) { if ($line | str starts-with \"__VIBE_CD__\") { cd ($line | str replace \"__VIBE_CD__\" \"\") } else { print $line } } }\n";

    let out = run_vibe(
        home.path(),
        home.path(),
        &["--eval-dialect", "nu", "shell-setup", "--shell", "nushell"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "shell-setup failed: {stderr:?}");
    assert_eq!(
        stdout, expected,
        "the nu dialect must not alter verbatim stdout payloads"
    );
    assert!(stderr.is_empty(), "shell-setup wrote to stderr: {stderr:?}");
}

/// An unknown `--eval-dialect` value is a clap parse error: exit code 2, the
/// message on STDERR, and — the load-bearing half — STDOUT stays EMPTY. A parse
/// error must never put bytes on the eval channel, since the wrapper would
/// execute them.
#[test]
fn bogus_eval_dialect_exits_two_with_empty_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(
        tmp.path(),
        home.path(),
        &["--eval-dialect", "bogus", "jump", "x"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "clap parse errors must exit 2; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "parse error must keep the eval channel empty: {stdout:?}"
    );
    assert!(
        !stderr.is_empty(),
        "parse error must explain itself on stderr"
    );
}

/// `vibe list` renders a TABLE, which is the exact shape that would be
/// catastrophic on the eval channel: the POSIX wrapper would execute every row
/// as a command line (branch names and paths are attacker-influenced). The E2E
/// suite drives a PTY, which MERGES the two streams, so only this test can prove
/// the split. STDOUT must be byte-exact empty while the rows land on STDERR.
#[test]
fn list_writes_the_table_to_stderr_leaving_stdout_empty() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    let out = run_vibe(&main_path, home.path(), &["list"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "list failed; stderr={stderr:?}");
    assert!(
        stdout.is_empty(),
        "the listing must never reach the eval channel: {stdout:?}"
    );
    // The rows really were produced — otherwise an empty stdout proves nothing.
    assert!(
        stderr.contains("feature") && stderr.contains(&secondary_path.display().to_string()),
        "listing missing from stderr: {stderr:?}"
    );
    // The enrichment columns are populated from real `git for-each-ref` /
    // `git status` output, not fixtures. Asserted by picking the columns OUT of
    // the row rather than by searching the whole stream: a bare
    // `stderr.contains("m")` is satisfied by the word "main", so it would pass
    // even if every AGE cell had degraded to the unknown placeholder.
    let row = stderr
        .lines()
        .find(|l| l.contains("feature"))
        .unwrap_or_else(|| panic!("no row for the secondary worktree: {stderr:?}"));
    let cells: Vec<&str> = row.split_whitespace().collect();
    // `<BRANCH> <BASE> <AGE> <STATUS> <PATH>` — the marker column is blank for a
    // non-current row and so contributes no token.
    assert_eq!(cells[0], "feature", "unexpected row shape: {row:?}");
    // The fixture repo has no remote and no `init.defaultBranch`, so
    // `get_default_branch` reaches its documented last-resort `master` — even
    // though `git init -b main` named the branch differently. The assertion is
    // that BASE resolved to a NAME at all; which name is `get_default_branch`'s
    // contract, covered by its own unit tests.
    assert_ne!(cells[1], "-", "BASE did not resolve: {row:?}");
    assert!(
        is_age_cell(cells[2]),
        "AGE did not resolve to a duration: {row:?}"
    );
    assert_eq!(cells[3], "clean", "STATUS must resolve: {row:?}");
}

/// Whether a rendered AGE cell is a real duration (`now`, or digits followed by
/// one of the unit suffixes) rather than the unknown placeholder.
///
/// Hand-written rather than a regex crate: this is the only pattern match in the
/// integration suite, and `vibe` ships no regex dependency to borrow.
fn is_age_cell(cell: &str) -> bool {
    if cell == "now" {
        return true;
    }
    let digits: String = cell.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return false;
    }
    matches!(&cell[digits.len()..], "m" | "h" | "d" | "w" | "mo" | "y")
}

/// The same stdout guarantee for a worktree with a DIRTY tree.
///
/// Worth its own case because the STATUS column is the one cell whose value is
/// produced by a second `git` invocation per row: that call's output (and, on a
/// broken worktree, its error text) is the most likely thing to be echoed by a
/// naive implementation, and stdout is where an echo would be catastrophic.
///
/// The dirty count is asserted as well, so the test cannot pass by producing no
/// rows at all — an empty stdout proves nothing on its own.
///
/// Scope note: the fixture is an ordinary committed repository on a normal
/// branch, so no column actually degrades here. The degraded-cell rendering
/// (`-` for an unresolvable BASE/AGE, and the warning path for an unreadable
/// STATUS) is covered by the unit tests in `list_tests.rs`, which can inject a
/// failing git; reproducing a broken worktree through the real binary is not
/// worth the fixture complexity.
#[test]
fn list_keeps_stdout_empty_for_a_dirty_worktree() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");
    // An untracked file, which `--untracked-files=normal` counts as one entry,
    // so the STATUS column has something to report.
    std::fs::write(secondary_path.join("dirty.txt"), "x").unwrap();

    let out = run_vibe(&main_path, home.path(), &["list"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "list failed; stderr={stderr:?}");
    assert!(
        stdout.is_empty(),
        "the listing must never reach the eval channel: {stdout:?}"
    );
    assert!(
        stderr.contains("M 1"),
        "the untracked file was not counted: {stderr:?}"
    );
    // The count really came from the dirty worktree, not from the main one.
    assert!(
        stderr.contains(&secondary_path.display().to_string()),
        "the dirty worktree is missing from the listing: {stderr:?}"
    );
}

/// The same invariant for `--json`: the payload is machine-readable and belongs
/// on stderr too, and stdout must stay byte-exact empty. `--verbose` is passed
/// as well, because a diagnostic line prepended to the payload would both
/// corrupt the JSON and be the kind of stray write that lands on stdout.
#[test]
fn list_json_keeps_stdout_empty_and_stderr_pure_json() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, _secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    let out = run_vibe(&main_path, home.path(), &["--verbose", "list", "--json"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        out.status.success(),
        "list --json failed; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "the JSON payload must never reach the eval channel: {stdout:?}"
    );
    // Every byte on stderr is the payload: no `[verbose]` preamble before it and
    // nothing after it. (Parsing is covered by the unit tests; here the point is
    // that the stream STARTS with the document, which a diagnostic would break.)
    assert!(
        !stderr.contains("[verbose]"),
        "a diagnostic corrupted the payload: {stderr:?}"
    );
    // Deserialized rather than substring-matched: `starts_with('[')` +
    // `ends_with(']')` + `contains(…)` would also accept a payload with trailing
    // garbage or a trailing comma, which is exactly the corruption this contract
    // exists to catch. A successful parse is the only real proof the stream is
    // the document and nothing else.
    let payload: serde_json::Value = serde_json::from_str(&stderr)
        .unwrap_or_else(|e| panic!("stderr is not a single JSON document ({e}): {stderr:?}"));
    let entries = payload
        .as_array()
        .unwrap_or_else(|| panic!("payload is not a JSON array: {stderr:?}"));
    let feature = entries
        .iter()
        .find(|e| e.get("branch") == Some(&serde_json::json!("feature")))
        .unwrap_or_else(|| panic!("payload missing the worktree: {stderr:?}"));

    // Every published key is present against a REAL git, so a field that only
    // ever resolves in the unit fixtures cannot ship. Values are not pinned
    // (the sha and the timestamp are whatever this run produced); the schema is.
    for key in [
        "branch",
        "path",
        "current",
        "scratch",
        "name",
        "base",
        "head",
        "last_commit_at",
        "status",
        "dirty_files",
    ] {
        assert!(
            feature.get(key).is_some(),
            "payload missing `{key}`: {stderr:?}"
        );
    }
    assert_eq!(feature["name"], serde_json::json!("feature"));
    assert_eq!(feature["status"], serde_json::json!("clean"));
    assert!(
        feature["head"].as_str().is_some_and(|s| !s.is_empty()),
        "the HEAD sha must come through from the porcelain: {stderr:?}"
    );
}

/// `vibe doctor` is a diagnostics command, and diagnostics conventionally go to
/// stdout — but here stdout IS the eval channel, so a report there would be
/// EXECUTED by the POSIX wrapper. With an empty HOME (no profiles to find) the
/// command must still write ZERO bytes to stdout and exit 0.
#[test]
fn doctor_writes_nothing_to_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["doctor"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        stdout.is_empty(),
        "doctor must keep the eval channel empty: {stdout:?}"
    );
    assert_eq!(
        out.status.code(),
        Some(0),
        "a clean doctor run must exit 0; stderr={stderr:?}"
    );
    assert!(
        !stderr.is_empty(),
        "doctor must report on stderr, not stdout"
    );
}

/// The failing branch of the same invariant: a STALE wrapper makes `doctor` exit
/// 1 after printing a multi-line report, and that report must stay off stdout
/// too. This is the branch most at risk — an error path is where a stray
/// `println!` usually lands, and here it would be executed by the wrapper.
#[test]
fn doctor_with_a_stale_wrapper_exits_one_with_still_empty_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    // The pre-2.2.0 nushell wrapper, in the location doctor looks at:
    // `isolate_config_env` points `XDG_CONFIG_HOME` at `home` itself, and
    // doctor prefers that over `$HOME/.config`.
    let nushell_dir = home.path().join("nushell");
    std::fs::create_dir_all(&nushell_dir).unwrap();
    std::fs::write(
        nushell_dir.join("config.nu"),
        "def --env vibe [...args] { ^vibe ...$args | lines | each { |line| nu -c $line } }\n",
    )
    .unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["doctor"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        stdout.is_empty(),
        "doctor's failure path must keep the eval channel empty: {stdout:?}"
    );
    assert_eq!(
        out.status.code(),
        Some(1),
        "a stale wrapper must exit 1; stderr={stderr:?}"
    );
    assert!(stderr.contains("stale"), "got: {stderr:?}");
    assert!(stderr.contains("Fix: run"), "got: {stderr:?}");
    // AlreadyReported must not add a second, contentless `Error:` line.
    assert!(!stderr.contains("Error:"), "got: {stderr:?}");
}

/// The third doctor branch: with no usable profile root at all, nothing was
/// inspected, so the command fails with an explanation instead of reporting a
/// clean bill of health. It is a `Configuration` error rather than
/// `AlreadyReported`, so the binary's `Error:` line IS the report — and that line
/// still has to go to stderr, leaving the eval channel empty.
#[cfg(unix)]
#[test]
fn doctor_without_any_profile_root_exits_one_with_empty_stdout() {
    let tmp = tempfile::tempdir().unwrap();

    // Not `run_vibe`: that helper's whole job is to POINT the root variables at an
    // isolated home, and this case needs them gone.
    let out = Command::new(vibe_bin())
        .arg("doctor")
        .current_dir(tmp.path())
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .env_remove("HOME")
        .env_remove("XDG_CONFIG_HOME")
        .output()
        .expect("failed to spawn vibe");

    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(
        stdout.is_empty(),
        "doctor's no-root path must keep the eval channel empty: {stdout:?}"
    );
    assert_eq!(
        out.status.code(),
        Some(1),
        "no usable profile root must exit 1; stderr={stderr:?}"
    );
    assert!(stderr.contains("Error:"), "got: {stderr:?}");
    assert!(stderr.contains("HOME"), "got: {stderr:?}");
}

/// `--recent` and `--stale` are contradictory questions about the same commit
/// date. clap rejects the pair at parse time, and — like every other parse
/// failure — the eval channel must stay byte-exact empty: the wrapper runs
/// `eval "$(command vibe "$@")"`, so a diagnostic that leaked to stdout would be
/// executed as a shell command.
#[test]
fn list_recent_and_stale_together_exits_two_with_empty_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    // clap's conflict check runs before any git work, so no repo is needed.
    let out = run_vibe(
        tmp.path(),
        home.path(),
        &["list", "--recent", "1d", "--stale", "1d"],
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "conflicting filters must exit 2; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "parse error must keep the eval channel empty: {stdout:?}"
    );
    assert!(
        stderr.contains("--stale") && stderr.contains("--recent"),
        "the conflict must name both flags: {stderr:?}"
    );
}

/// The same for `--dirty` / `--clean`: a worktree cannot be both, so asking for
/// both is a mistake worth reporting rather than an empty listing.
#[test]
fn list_dirty_and_clean_together_exits_two_with_empty_stdout() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["list", "--dirty", "--clean"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "conflicting filters must exit 2; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "parse error must keep the eval channel empty: {stdout:?}"
    );
    assert!(
        stderr.contains("--dirty") && stderr.contains("--clean"),
        "the conflict must name both flags: {stderr:?}"
    );
}

/// A malformed duration is rejected by the value parser (exit 2) with the
/// core's own message, and never reaches the command. Includes `6mo`, which the
/// AGE column *displays* but the filter grammar deliberately does not accept.
#[test]
fn list_rejects_a_malformed_duration_with_exit_two() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    for value in ["", "30", "1.5d", "6mo", "0d", "abc"] {
        let out = run_vibe(tmp.path(), home.path(), &["list", "--recent", value]);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();

        assert_eq!(
            out.status.code(),
            Some(2),
            "`--recent {value}` must exit 2; stderr={stderr:?}"
        );
        assert!(
            stdout.is_empty(),
            "parse error must keep the eval channel empty: {stdout:?}"
        );
        assert!(
            !stderr.is_empty(),
            "`--recent {value}` must explain itself on stderr"
        );
    }
}

/// `--limit 0` is rejected rather than silently printing nothing: an empty
/// listing would be indistinguishable from a repository with no worktrees, and
/// `0` is far more often an unexpanded shell variable than a real request.
#[test]
fn list_rejects_a_zero_limit_with_exit_two() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["list", "--limit", "0"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "`--limit 0` must exit 2; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "parse error must keep the eval channel empty: {stdout:?}"
    );
    assert!(
        stderr.contains("--limit must be at least 1"),
        "got: {stderr:?}"
    );
}

/// An unknown `--sort` key is a clap ValueEnum rejection, and the error names
/// the accepted values so the user does not have to consult the docs.
#[test]
fn list_rejects_an_unknown_sort_key_with_exit_two() {
    let home = tempfile::tempdir().unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let out = run_vibe(tmp.path(), home.path(), &["list", "--sort", "bogus"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert_eq!(
        out.status.code(),
        Some(2),
        "an unknown sort key must exit 2; stderr={stderr:?}"
    );
    assert!(
        stdout.is_empty(),
        "parse error must keep the eval channel empty: {stdout:?}"
    );
    assert!(
        stderr.contains("age") && stderr.contains("name") && stderr.contains("status"),
        "the error must list the accepted keys: {stderr:?}"
    );
}

/// The filtered/sorted/limited listing is still a TABLE, so the same stdout
/// guarantee the unfiltered case has must hold with every flag in play — the
/// rows are attacker-influenced and would be executed if they reached stdout.
#[test]
fn list_with_filters_keeps_stdout_empty() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, _secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    for args in [
        vec!["list", "--sort", "age"],
        vec!["list", "--sort", "name", "--reverse"],
        vec!["list", "--clean"],
        vec!["list", "--recent", "1w"],
        vec!["list", "--stale", "1w"],
        vec!["list", "--limit", "1"],
        vec!["list", "--sort", "age", "--reverse", "--limit", "1"],
        vec!["list", "--json", "--sort", "status"],
    ] {
        let out = run_vibe(&main_path, home.path(), &args);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();

        assert!(out.status.success(), "{args:?} failed; stderr={stderr:?}");
        assert!(
            stdout.is_empty(),
            "{args:?} leaked to the eval channel: {stdout:?}"
        );
    }
}

/// `--limit` really does bound the listing end to end, and `--json` stays a
/// parseable document at the bounded size. Proven against a REAL git with two
/// worktrees so the count is not an artifact of a fake.
#[test]
fn list_limit_bounds_the_json_payload() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (main_path, _secondary_path) = setup_worktrees(tmp.path(), "feat", "feature");

    let unbounded = run_vibe(&main_path, home.path(), &["list", "--json"]);
    let unbounded: serde_json::Value =
        serde_json::from_str(&String::from_utf8(unbounded.stderr).unwrap()).unwrap();
    assert_eq!(
        unbounded.as_array().map(Vec::len),
        Some(2),
        "the fixture must have two worktrees for the limit to bound anything"
    );

    let out = run_vibe(&main_path, home.path(), &["list", "--json", "--limit", "1"]);
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();

    assert!(out.status.success(), "list failed; stderr={stderr:?}");
    assert!(
        stdout.is_empty(),
        "the payload must never reach the eval channel: {stdout:?}"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&stderr).expect("stderr must be pure JSON");
    assert_eq!(parsed.as_array().map(Vec::len), Some(1), "got: {parsed}");
}
