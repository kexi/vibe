//! Live round-trip proof that the generated shell wrappers actually change the
//! REAL shell's working directory.
//!
//! `eval_contract.rs` proves the binary emits the right BYTES on stdout;
//! `shell_setup.rs` proves the wrapper text is byte-exact. Neither proves the
//! two halves fit together — that a real bash/zsh/fish/nu/pwsh process, having
//! sourced the wrapper we ship, ends up in the worktree directory after
//! `vibe jump`. That gap is where the nushell and PowerShell dialects live:
//! nushell has no `eval` (so its wrapper parses a `__VIBE_CD__` sentinel
//! line-by-line) and PowerShell doubles `'` instead of backslashing it. A
//! purely byte-level test cannot tell a correct sentinel protocol from a
//! plausible-looking broken one.
//!
//! So each leg here spawns the actual shell, sources the actual wrapper (via
//! `vibe shell-setup`, not a hardcoded copy), runs `vibe jump` against a real
//! git worktree whose directory name contains a single quote, and asserts the
//! shell's final `pwd` IS that worktree. The quote is the whole point: it is the
//! character every dialect quotes differently, and the one that would silently
//! truncate or inject if a dialect got it wrong.
//!
//! Shell availability: a missing shell SKIPS by default (developer machines
//! rarely have all five). Set `VIBE_REQUIRE_SHELLS=bash,zsh,fish,nu,pwsh` to
//! turn "missing" into a hard failure — CI sets it so a shell silently
//! disappearing from the toolchain cannot quietly disable coverage.

// stdout of the TEST process is not the eval channel (the binary under test has
// its own pipe), but the workspace denies `print_stdout` to keep that channel
// sacred, so skip notices go to stderr like the sibling suite's `git_available`.
#![allow(clippy::print_stderr)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Path to the binary under test (Cargo sets this for integration tests).
fn vibe_bin() -> &'static str {
    env!("CARGO_BIN_EXE_vibe")
}

// --- git fixture helpers ---
//
// Duplicated from `tests/eval_contract.rs` on purpose: each file under `tests/`
// is a SEPARATE integration crate, so there is no way to share these without
// introducing a `tests/common/` module (which cargo would then also try to
// compile as its own test target) or a support crate. Twenty lines of git
// plumbing is the cheaper duplication. Keep the two copies behaviourally
// equivalent if you touch either.

/// An empty file used as `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, created inside
/// `dir` and returned.
///
/// Why not `/dev/null`: it does not exist on Windows, and git treats an
/// unreadable config path as *absent* — so the isolation would silently vanish
/// and the developer's real `~/.gitconfig` would be read. An empty regular file
/// is a valid, empty config on every OS.
fn empty_git_config(dir: &Path) -> PathBuf {
    let path = dir.join("empty.gitconfig");
    std::fs::write(&path, "").unwrap();
    path
}

/// Run `git <args>` in `cwd`, panicking on failure (test setup must succeed).
fn git(cwd: &Path, args: &[&str], git_config: &Path) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", git_config)
        .env("GIT_CONFIG_SYSTEM", git_config)
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

/// A main worktree at `<root>/main` plus a secondary worktree at `<root>/<dir>`
/// on branch `<branch>`. Returns (main_path, secondary_path), canonicalized.
///
/// The worktree is created with `git worktree add` directly rather than with
/// `vibe start`: this suite is about the eval protocol, and routing setup
/// through `start` would drag in the copy/hook machinery (and its failure
/// modes) for no added coverage.
fn setup_worktrees(
    root: &Path,
    secondary_dir: &str,
    branch: &str,
    git_config: &Path,
) -> (PathBuf, PathBuf) {
    let main = root.join("main");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"], git_config);
    git(
        &main,
        &["config", "user.email", "test@example.com"],
        git_config,
    );
    git(&main, &["config", "user.name", "Test"], git_config);
    git(
        &main,
        &["commit", "-q", "--allow-empty", "-m", "init"],
        git_config,
    );

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
        git_config,
    );
    // `git worktree list` reports canonicalized paths (e.g. /private/tmp on
    // macOS), so canonicalize here too for byte-exact comparison.
    (
        std::fs::canonicalize(&main).unwrap(),
        std::fs::canonicalize(&secondary).unwrap(),
    )
}

// --- shell availability ---

/// Shells named in `VIBE_REQUIRE_SHELLS` must exist; anything else may skip.
fn shell_is_required(shell: &str) -> bool {
    std::env::var("VIBE_REQUIRE_SHELLS")
        .unwrap_or_default()
        .split(',')
        .any(|name| name.trim() == shell)
}

fn shell_on_path(shell: &str) -> bool {
    // `--version` is understood by all five shells and never enters a REPL.
    Command::new(shell)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Returns false (and prints a skip notice) when `shell` is absent and not
/// required; panics when it is absent but listed in `VIBE_REQUIRE_SHELLS`.
fn shell_available(shell: &str) -> bool {
    if shell_on_path(shell) {
        return true;
    }
    assert!(
        !shell_is_required(shell),
        "VIBE_REQUIRE_SHELLS lists `{shell}` but it is not on PATH. \
         The wrapper round-trip for {shell} cannot be verified; install it \
         (Linux/macOS CI gets nu/fish/zsh from the Nix dev shell, and pwsh from \
         the runner image) or drop it from VIBE_REQUIRE_SHELLS."
    );
    eprintln!("skipping {shell} round-trip: `{shell}` not on PATH");
    false
}

// --- shim: make `vibe` and `vibe.exe` resolvable by name ---

/// Create a directory containing `vibe` and `vibe.exe` symlinks to the built
/// binary, and return it.
///
/// Both names are needed: the POSIX wrappers call `command vibe`, while the
/// PowerShell wrapper calls the literal `vibe.exe` (correct on Windows, and on
/// Unix pwsh happily resolves a file literally named `vibe.exe` from PATH).
fn shim_dir(root: &Path) -> PathBuf {
    let dir = root.join("shim");
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["vibe", "vibe.exe"] {
        let link = dir.join(name);
        #[cfg(unix)]
        std::os::unix::fs::symlink(vibe_bin(), &link).unwrap();
        #[cfg(not(unix))]
        std::fs::copy(vibe_bin(), &link).unwrap();
    }
    dir
}

/// Spawn `program` with `args`, with the shim dir prepended to PATH and the
/// environment isolated (own HOME, no color, no user/system git config).
///
/// `START` is exported so each shell script can `cd` there without embedding a
/// path — which would just re-create the quoting problem inside the test.
fn run_shell(program: &str, args: &[&str], fx: &Fixture, start: &Path) -> Output {
    let home = fx.home.as_path();
    Command::new(program)
        .args(args)
        // Run somewhere neutral so a leg that never cds cannot accidentally
        // already be sitting in the expected directory.
        .current_dir(home)
        .env("PATH", prepend_to_path(&fx.shim))
        .env("HOME", home)
        // Windows has no $HOME: pwsh resolves the profile/home from
        // %USERPROFILE%, so both must point at the fixture home for the
        // isolation to hold on a Windows runner. Harmless on Unix.
        .env("USERPROFILE", home)
        .env("START", start)
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .env("GIT_CONFIG_GLOBAL", &fx.git_config)
        .env("GIT_CONFIG_SYSTEM", &fx.git_config)
        .output()
        .unwrap_or_else(|e| panic!("failed to spawn {program}: {e}"))
}

/// `dir` prepended to the inherited `PATH`, using the platform separator.
///
/// Why not `format!("{dir}:{path}")`: `:` is the Unix separator; Windows uses
/// `;`, so the hardcoded form produced one unusable mega-entry and the shim was
/// never found.
fn prepend_to_path(dir: &Path) -> std::ffi::OsString {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let entries = std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&inherited));
    std::env::join_paths(entries).expect("PATH entries must not contain the path separator")
}

/// Whether the POSIX-wrapper legs (bash/zsh/fish) can run on this host.
///
/// Why not run them on native Windows: the only bash there is Git Bash, whose
/// MSYS path-translation layer rewrites the paths flowing through the wrapper —
/// so the leg would exercise MSYS, not the wrapper. A POSIX shell as the primary
/// Windows-native shell is not a supported configuration; the Linux/macOS jobs
/// own that coverage.
fn posix_legs_supported() -> bool {
    if !cfg!(windows) {
        return true;
    }
    eprintln!("skipping POSIX wrapper round-trip: not supported on native Windows");
    false
}

/// The last non-empty line of stdout — every leg prints the shell's final cwd
/// last, after any wrapper chatter.
fn last_line(stdout: &str) -> &str {
    stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
}

/// Assert the leg exited 0 and that its reported cwd IS the worktree.
///
/// Both sides are canonicalized: on macOS `/tmp` is a symlink to `/private/tmp`
/// and different shells disagree about which form `pwd` reports.
fn assert_landed_in(shell: &str, out: &Output, expected: &Path) {
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(
        out.status.success(),
        "{shell} leg exited {:?}\nstdout={stdout}\nstderr={stderr}",
        out.status.code()
    );
    let reported = PathBuf::from(last_line(&stdout));
    let reported = std::fs::canonicalize(&reported).unwrap_or(reported);
    let expected = std::fs::canonicalize(expected).unwrap_or_else(|_| expected.to_path_buf());
    assert_eq!(
        reported, expected,
        "{shell} wrapper did not change the shell's cwd to the worktree\nstdout={stdout}\nstderr={stderr}"
    );
}

/// Shared fixture: (tempdir guard, shim dir, home dir guard, main, worktree).
///
/// The worktree directory name contains a literal `'`.
struct Fixture {
    _root: tempfile::TempDir,
    _home: tempfile::TempDir,
    shim: PathBuf,
    home: PathBuf,
    main: PathBuf,
    worktree: PathBuf,
    git_config: PathBuf,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let git_config = empty_git_config(root.path());
    let (main, worktree) = setup_worktrees(root.path(), "wt-it's", "quoted", &git_config);
    assert!(
        worktree.display().to_string().contains('\''),
        "fixture worktree path must contain a single quote: {worktree:?}"
    );
    let shim = shim_dir(root.path());
    let home_path = home.path().to_path_buf();
    Fixture {
        _root: root,
        _home: home,
        shim,
        home: home_path,
        main,
        worktree,
        git_config,
    }
}

/// Write `contents` into `<dir>/<name>` and return the path (for nu/pwsh, which
/// are driven by a script file rather than `-c`).
fn write_script(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

/// Capture `vibe shell-setup --shell <shell>` stdout (the wrapper text) exactly
/// as a user would when pasting it into an rc file.
fn wrapper_for(shell: &str, home: &Path) -> String {
    let out = Command::new(vibe_bin())
        .args(["shell-setup", "--shell", shell])
        .current_dir(home)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("FORCE_COLOR")
        .env("NO_COLOR", "1")
        .output()
        .expect("failed to spawn vibe shell-setup");
    assert!(out.status.success(), "shell-setup {shell} failed");
    String::from_utf8(out.stdout).unwrap()
}

// --- POSIX legs (bash / zsh / fish) ---
//
// These three consume the frozen `cd '<escaped>'` dialect (no --eval-dialect
// flag), so they are also the back-compat witness: a wrapper already sitting in
// a user's rc file must keep working unchanged.

#[test]
fn bash_wrapper_round_trip() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !posix_legs_supported() {
        return;
    }
    if !shell_available("bash") {
        return;
    }
    let fx = fixture();
    // --noprofile --norc: ignore the developer's own dotfiles so only the
    // wrapper under test defines `vibe`.
    let out = run_shell(
        "bash",
        &[
            "--noprofile",
            "--norc",
            "-c",
            r#"eval "$(vibe shell-setup --shell bash)"; cd "$START"; vibe jump quoted; pwd"#,
        ],
        &fx,
        &fx.main,
    );
    assert_landed_in("bash", &out, &fx.worktree);
}

#[test]
fn zsh_wrapper_round_trip() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !posix_legs_supported() {
        return;
    }
    if !shell_available("zsh") {
        return;
    }
    let fx = fixture();
    // -f: skip zshrc (the zsh equivalent of bash's --norc).
    let out = run_shell(
        "zsh",
        &[
            "-f",
            "-c",
            r#"eval "$(vibe shell-setup --shell zsh)"; cd "$START"; vibe jump quoted; pwd"#,
        ],
        &fx,
        &fx.main,
    );
    assert_landed_in("zsh", &out, &fx.worktree);
}

#[test]
fn fish_wrapper_round_trip() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !posix_legs_supported() {
        return;
    }
    if !shell_available("fish") {
        return;
    }
    let fx = fixture();
    // fish has no `eval "$(...)"` idiom; the documented form is `| source`.
    let out = run_shell(
        "fish",
        &[
            "--no-config",
            "-c",
            r#"vibe shell-setup --shell fish | source; cd "$START"; vibe jump quoted; pwd"#,
        ],
        &fx,
        &fx.main,
    );
    assert_landed_in("fish", &out, &fx.worktree);
}

// --- nushell leg ---

/// The first live proof of the nushell wrapper: nu has no `eval`, so the
/// wrapper reads `__VIBE_CD__<raw path>` off the binary's stdout and calls
/// `cd` with the remainder as DATA. If the sentinel protocol were wrong (or if
/// nu tried to parse the path as source) the `'` in the directory name would
/// break it — which is exactly why the fixture has one.
#[test]
fn nushell_wrapper_round_trip() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !shell_available("nu") {
        return;
    }
    let fx = fixture();
    let wrapper = wrapper_for("nushell", &fx.home);
    // Build the script in Rust rather than piping the wrapper through nu's
    // stdin: `def --env` must be evaluated in the same scope that later calls
    // `vibe`, and a script file is the way nu users actually get there.
    let script = format!("{wrapper}cd $env.START\nvibe jump quoted\nprint $env.PWD\n");
    let path = write_script(&fx.home, "round_trip.nu", &script);

    let out = run_shell(
        "nu",
        &["--no-config-file", path.to_str().unwrap()],
        &fx,
        &fx.main,
    );
    assert_landed_in("nu", &out, &fx.worktree);
}

/// The nushell wrapper's OTHER branch: a stdout line that is not a `__VIBE_CD__`
/// sentinel must be re-printed verbatim. Without this, `vibe shell-setup`
/// (whose whole payload is text a user pipes somewhere) would be swallowed by
/// the wrapper that is supposed to be transparent to it.
#[test]
fn nushell_wrapper_passes_non_cd_stdout_through_verbatim() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !shell_available("nu") {
        return;
    }
    let fx = fixture();
    let wrapper = wrapper_for("nushell", &fx.home);
    let bash_wrapper = wrapper_for("bash", &fx.home);

    // Ask the wrapped `vibe` for the BASH wrapper: a pure stdout payload with no
    // cd line, so every byte must survive the nu wrapper's line loop.
    let script = format!("{wrapper}vibe shell-setup --shell bash\n");
    let path = write_script(&fx.home, "passthrough.nu", &script);

    let out = run_shell(
        "nu",
        &["--no-config-file", path.to_str().unwrap()],
        &fx,
        &fx.main,
    );
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    assert!(
        out.status.success(),
        "nu passthrough exited {:?}\nstdout={stdout}\nstderr={stderr}",
        out.status.code()
    );
    assert!(
        stdout.contains(bash_wrapper.trim_end()),
        "nu wrapper must re-print non-cd stdout verbatim.\nexpected: {bash_wrapper:?}\ngot: {stdout:?}"
    );
    assert!(
        !stdout.contains("__VIBE_CD__"),
        "the sentinel must never reach the user's terminal: {stdout:?}"
    );
}

// --- PowerShell leg ---

/// PowerShell's wrapper evals `Set-Location -LiteralPath '<doubled>'`. The
/// fixture's `'` proves the doubling, and `-LiteralPath` (rather than `-Path`)
/// is what keeps a path with wildcard characters resolvable.
#[test]
fn powershell_wrapper_round_trip() {
    if !git_available() {
        eprintln!("skipping: git unavailable");
        return;
    }
    if !shell_available("pwsh") {
        return;
    }
    let fx = fixture();
    let wrapper = wrapper_for("powershell", &fx.home);
    let script = format!(
        "{wrapper}Set-Location -LiteralPath $env:START\nvibe jump quoted\n(Get-Location).Path\n"
    );
    let path = write_script(&fx.home, "round_trip.ps1", &script);

    let out = run_shell(
        "pwsh",
        &["-NoProfile", "-NoLogo", "-File", path.to_str().unwrap()],
        &fx,
        &fx.main,
    );
    assert_landed_in("pwsh", &out, &fx.worktree);
}
