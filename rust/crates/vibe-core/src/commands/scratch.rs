//! `vibe scratch`: create a worktree with an auto-named `scratch/<timestamp>`.
//!
//! Ported from `packages/core/src/commands/scratch.ts`. Generates
//! `scratch/<YYYYMMDD-HHMMSS>` from the injected [`Clock`], retrying with `-2`,
//! `-3`, … on a collision (up to 100). The used-name set is fetched ONCE (the
//! worktree list + `git for-each-ref refs/heads/scratch/`), so the retry loop
//! spawns no per-iteration git. It then delegates to [`start_command`] and prints
//! the promote hint.

use crate::clock::Clock;
use crate::commands::start::{start_command, StartDeps, StartFlags};
use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::git::{get_worktree_list, GitRunner};
use crate::io::Io;
use crate::output::{log, OutputOptions};
use crate::prompt::Prompt;
use crate::settings::RepoResolver;
use crate::stdin::StdinReader;
use crate::timestamp::format_local_timestamp;
use crate::worktree_path::ScriptRunner;
use std::collections::HashSet;

const MAX_COLLISION_RETRIES: u32 = 100;

/// Branch-name prefix for auto-named scratch worktrees.
pub const SCRATCH_PREFIX: &str = "scratch/";

/// Run `vibe scratch`.
pub fn scratch_command<I, G, R, S, P, Sr>(
    deps: &StartDeps<I, G, R, S, P, Sr>,
    clock: &impl Clock,
    flags: &StartFlags,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    R: RepoResolver,
    S: ScriptRunner,
    P: Prompt,
    Sr: StdinReader,
{
    let branch_name = generate_scratch_name(deps.git, clock)?;
    let outcome = start_command(deps, &branch_name, flags, opts)?;
    log(deps.io, "Promote with: vibe rename <new-name>", opts);
    Ok(outcome)
}

/// Generate a unique `scratch/<timestamp>` name, retrying `-2`/`-3`/… on a
/// collision. The used-name set is fetched once (worktree branches + existing
/// `scratch/` refs).
fn generate_scratch_name(git: &impl GitRunner, clock: &impl Clock) -> Result<String> {
    let ts = format_local_timestamp(clock.local_time());
    let base_name = format!("{SCRATCH_PREFIX}{ts}");

    let mut used: HashSet<String> = HashSet::new();
    for w in get_worktree_list(git)? {
        used.insert(w.branch);
    }
    // Existing scratch branch refs (best-effort: ignore a git error → empty).
    let refs = git
        .run(&[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/heads/{SCRATCH_PREFIX}"),
        ])
        .unwrap_or_default();
    for line in refs.split('\n') {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            used.insert(trimmed.to_string());
        }
    }

    for i in 1..=MAX_COLLISION_RETRIES {
        let candidate = if i == 1 {
            base_name.clone()
        } else {
            format!("{base_name}-{i}")
        };
        if !used.contains(&candidate) {
            return Ok(candidate);
        }
    }

    Err(VibeError::Worktree(format!(
        "Could not generate unique scratch name after {MAX_COLLISION_RETRIES} attempts"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::copy::strategies::FakeCopyExecutor;
    use crate::copy::types::CopyStrategyKind;
    use crate::error::VibeError;
    use crate::git::RepoInfo;
    use crate::hooks::FakeHookRunner;
    use crate::io::FakeIo;
    use crate::progress::NullTracker;
    use crate::stdin::FakeStdin;
    use crate::timestamp::LocalTime;
    use crate::worktree_path::ScriptOutput;
    use std::cell::RefCell;
    use vibe_test_support::Fixture;

    const V: &str = "1.8.1+test";

    struct MockGit {
        repo_root: String,
        worktree_list: String,
        scratch_refs: String,
        pub calls: RefCell<Vec<Vec<String>>>,
    }
    impl MockGit {
        fn new(repo_root: &str, worktree_list: &str, scratch_refs: &str) -> Self {
            MockGit {
                repo_root: repo_root.to_string(),
                worktree_list: worktree_list.to_string(),
                scratch_refs: scratch_refs.to_string(),
                calls: RefCell::new(vec![]),
            }
        }
        fn add_calls(&self) -> Vec<Vec<String>> {
            self.calls
                .borrow()
                .iter()
                .filter(|c| c.len() >= 2 && c[0] == "worktree" && c[1] == "add")
                .cloned()
                .collect()
        }
    }
    impl GitRunner for MockGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if args.contains(&"--show-toplevel") {
                return Ok(self.repo_root.clone());
            }
            if args.first() == Some(&"for-each-ref") {
                return Ok(self.scratch_refs.clone());
            }
            if args.contains(&"list") && args.contains(&"worktree") {
                return Ok(self.worktree_list.clone());
            }
            if args.contains(&"show-ref") {
                return Err(VibeError::GitOperation {
                    command: args.join(" "),
                    message: "failed: no ref".into(),
                });
            }
            Ok(String::new())
        }
    }

    #[derive(Default)]
    struct NoResolver;
    impl RepoResolver for NoResolver {
        fn repo_info(&self, _p: &str) -> Option<RepoInfo> {
            None
        }
        fn hash_file(&self, _p: &str) -> std::result::Result<String, String> {
            Err("unused".into())
        }
    }
    struct NoScript;
    impl ScriptRunner for NoScript {
        fn run_script(&self, _c: &str, _e: &[(&str, &str)]) -> Result<ScriptOutput> {
            panic!("no script");
        }
    }
    struct YesPrompt;
    impl Prompt for YesPrompt {
        fn confirm(&self, _m: &str) -> bool {
            true
        }
        fn select(&self, _m: &str, _c: &[String]) -> Result<usize> {
            Ok(0)
        }
    }

    fn lt() -> LocalTime {
        LocalTime {
            year: 2026,
            month: 6,
            day: 6,
            hour: 9,
            minute: 5,
            second: 3,
        }
    }

    fn io_with_home() -> (Fixture, FakeIo) {
        let fx = Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        (fx, io)
    }

    #[test]
    fn generates_scratch_name_from_clock() {
        let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n", "");
        let clock = FakeClock::new(0, lt());
        let name = generate_scratch_name(&git, &clock).unwrap();
        assert_eq!(name, "scratch/20260606-090503");
    }

    #[test]
    fn collision_retry_appends_suffix() {
        // The base timestamp name AND -2 are taken (one as a worktree branch, one
        // as a for-each-ref entry) → -3 is the first free candidate.
        let wt = "worktree /repo\nbranch refs/heads/main\n\nworktree /wt/s\nbranch refs/heads/scratch/20260606-090503\n\n";
        let refs = "scratch/20260606-090503-2";
        let git = MockGit::new("/repo", wt, refs);
        let clock = FakeClock::new(0, lt());
        let name = generate_scratch_name(&git, &clock).unwrap();
        assert_eq!(name, "scratch/20260606-090503-3");
    }

    #[test]
    fn collision_retry_walks_past_multiple_taken_suffixes() {
        // G-19: base, -2, -3, -4 are all taken (via for-each-ref) → -5 is first free.
        let refs = "scratch/20260606-090503\nscratch/20260606-090503-2\nscratch/20260606-090503-3\nscratch/20260606-090503-4";
        let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n", refs);
        let clock = FakeClock::new(0, lt());
        let name = generate_scratch_name(&git, &clock).unwrap();
        assert_eq!(name, "scratch/20260606-090503-5");
    }

    #[test]
    fn collision_upper_bound_errors_after_100_attempts() {
        // G-19: when the base name and -2..-100 are ALL taken (100 candidates),
        // generation gives up with an error rather than looping forever.
        let base = "scratch/20260606-090503";
        let mut taken = vec![base.to_string()];
        for i in 2..=MAX_COLLISION_RETRIES {
            taken.push(format!("{base}-{i}"));
        }
        let refs = taken.join("\n");
        let git = MockGit::new("/repo", "worktree /repo\nbranch refs/heads/main\n\n", &refs);
        let clock = FakeClock::new(0, lt());
        let err = generate_scratch_name(&git, &clock).unwrap_err();
        assert!(matches!(err, VibeError::Worktree(_)));
        assert!(err
            .to_string()
            .contains("Could not generate unique scratch name after 100 attempts"));
    }

    #[test]
    fn delegates_to_start_and_prints_promote_hint() {
        let (_fx, io) = io_with_home();
        let git = MockGit::new(
            "/home/u/repo",
            "worktree /home/u/repo\nbranch refs/heads/main\n\n",
            "",
        );
        let clock = FakeClock::new(0, lt());
        let (r, s, p, sin) = (NoResolver, NoScript, YesPrompt, FakeStdin::none());
        let hooks = FakeHookRunner::ok();
        let exec = FakeCopyExecutor::new(CopyStrategyKind::Standard);
        let tracker = NullTracker;
        let d = StartDeps {
            io: &io,
            git: &git,
            resolver: &r,
            script_runner: &s,
            prompt: &p,
            stdin: &sin,
            hook_runner: &hooks,
            executor: &exec,
            tracker: &tracker,
            version: V,
        };
        let outcome =
            scratch_command(&d, &clock, &StartFlags::default(), OutputOptions::default()).unwrap();
        // Created a worktree for the scratch branch and cd'd into it.
        assert_eq!(outcome, Outcome::cd("/home/u/repo-scratch-20260606-090503"));
        // The branch name carries the scratch prefix.
        let adds = git.add_calls();
        assert!(adds
            .iter()
            .any(|c| c.contains(&"scratch/20260606-090503".to_string())));
        assert!(io
            .stderr_text()
            .contains("Promote with: vibe rename <new-name>"));
    }
}
