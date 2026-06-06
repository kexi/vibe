//! `vibe jump`: navigate to an existing worktree by (possibly partial) name.
//!
//! Ported from `packages/core/src/commands/jump.ts`. Matching is tried in
//! descending specificity: exact (CS, then CI), word-boundary (CS, CI),
//! substring (CS, CI), then fuzzy (≥3 chars). Scratch worktrees are excluded
//! from non-exact matching unless the query itself starts with `scratch/`. A
//! single match jumps (and records MRU); multiple matches prompt a selection
//! sorted by MRU with a trailing Cancel. No match falls through to the
//! `start`-create path (a Phase-4 hook).

use crate::commands::{Outcome, StartCommand};
use crate::error::{Result, VibeError};
use crate::fuzzy::{fuzzy_match, FUZZY_MATCH_MIN_LENGTH};
use crate::git::{get_worktree_list, GitRunner, Worktree};
use crate::io::Io;
use crate::mru::{load_mru_data, record_mru_entry, sort_by_mru, HasPath, MruEntry};
use crate::output::{log, verbose_log, OutputOptions};
use crate::prompt::Prompt;

/// Branch-name prefix marking auto-generated scratch worktrees.
pub const SCRATCH_PREFIX: &str = "scratch/";

const WORD_BOUNDARY_CHARS: [char; 3] = ['/', '-', '_'];

impl HasPath for Worktree {
    fn path(&self) -> &str {
        &self.path
    }
}

/// Inputs the jump command pulls from the binary (so the clock stays injected).
pub struct JumpDeps<'a, I, G, P, S>
where
    I: Io,
    G: GitRunner,
    P: Prompt,
    S: StartCommand,
{
    pub io: &'a I,
    pub git: &'a G,
    pub prompt: &'a P,
    pub start: &'a S,
    /// Current wall-clock in epoch milliseconds, for MRU recording.
    pub now_ms: i64,
}

/// Run `vibe jump <branch_name>`.
pub fn jump_command<I, G, P, S>(
    deps: &JumpDeps<I, G, P, S>,
    branch_name: &str,
    opts: OutputOptions,
) -> Result<Outcome>
where
    I: Io,
    G: GitRunner,
    P: Prompt,
    S: StartCommand,
{
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        // TS `console.error(...)` + `exit(1)`; use a fatal (exit-1) error, not
        // `Argument` (exit-2). The binary's `report_error` prints `Error: <msg>`.
        return Err(VibeError::Worktree("Branch name is required".to_string()));
    }

    let worktrees = get_worktree_list(deps.git)?;
    verbose_log(
        deps.io,
        &format!("Found {} worktree(s)", worktrees.len()),
        opts,
    );

    // MRU is best-effort: a load failure must not break jump. `load_mru_data`
    // already swallows errors and returns an empty list.
    let mru_entries = load_mru_data(deps.io);

    let lower_query = trimmed.to_lowercase();

    // 1. Exact match (case-sensitive).
    if let Some(wt) = worktrees.iter().find(|w| w.branch == trimmed) {
        verbose_log(
            deps.io,
            &format!("Exact match found: {} -> {}", wt.branch, wt.path),
            opts,
        );
        return Ok(jump_to(deps, &wt.branch, &wt.path));
    }

    // 2. Exact match (case-insensitive).
    if let Some(wt) = worktrees
        .iter()
        .find(|w| w.branch.to_lowercase() == lower_query)
    {
        verbose_log(
            deps.io,
            &format!(
                "Exact match found (case-insensitive): {} -> {}",
                wt.branch, wt.path
            ),
            opts,
        );
        log(deps.io, &format!("Matched: {}", wt.branch), opts);
        return Ok(jump_to(deps, &wt.branch, &wt.path));
    }

    // For non-exact matching, optionally drop scratch worktrees.
    let pool: Vec<&Worktree> = if should_filter_out_scratch(trimmed) {
        worktrees
            .iter()
            .filter(|w| !is_scratch(&w.branch))
            .collect()
    } else {
        worktrees.iter().collect()
    };

    // 3. Word boundary (CS).
    let wb_cs: Vec<Worktree> = pool
        .iter()
        .filter(|w| is_word_boundary_match(&w.branch, trimmed))
        .map(|w| (*w).clone())
        .collect();
    if let Some(outcome) = handle_partial(deps, &wb_cs, trimmed, &mru_entries, opts)? {
        return Ok(outcome);
    }

    // 4. Word boundary (CI).
    let wb_ci: Vec<Worktree> = pool
        .iter()
        .filter(|w| is_word_boundary_match(&w.branch.to_lowercase(), &lower_query))
        .map(|w| (*w).clone())
        .collect();
    if let Some(outcome) = handle_partial(deps, &wb_ci, trimmed, &mru_entries, opts)? {
        return Ok(outcome);
    }

    // 5. Substring (CS).
    let sub_cs: Vec<Worktree> = pool
        .iter()
        .filter(|w| w.branch.contains(trimmed))
        .map(|w| (*w).clone())
        .collect();
    if let Some(outcome) = handle_partial(deps, &sub_cs, trimmed, &mru_entries, opts)? {
        return Ok(outcome);
    }

    // 6. Substring (CI).
    let sub_ci: Vec<Worktree> = pool
        .iter()
        .filter(|w| w.branch.to_lowercase().contains(&lower_query))
        .map(|w| (*w).clone())
        .collect();
    if let Some(outcome) = handle_partial(deps, &sub_ci, trimmed, &mru_entries, opts)? {
        return Ok(outcome);
    }

    // 7. Fuzzy (≥ 3 chars), sorted by score descending (stable).
    let has_enough = trimmed.chars().count() >= FUZZY_MATCH_MIN_LENGTH;
    if has_enough {
        let mut scored: Vec<(Worktree, f64)> = pool
            .iter()
            .filter_map(|w| fuzzy_match(&w.branch, trimmed).map(|r| ((*w).clone(), r.score)))
            .collect();
        // Stable sort by score descending (TS `b.score - a.score`).
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let fuzzy: Vec<Worktree> = scored.into_iter().map(|(w, _)| w).collect();
        if let Some(outcome) = handle_partial(deps, &fuzzy, trimmed, &mru_entries, opts)? {
            return Ok(outcome);
        }
    }

    // 8. No match → offer to create via `vibe start` (Phase-4 hook).
    log(deps.io, &format!("No worktree found for '{trimmed}'"), opts);

    let should_create = deps.prompt.confirm(&format!(
        "No worktree found for '{trimmed}'. Create one with 'vibe start'? (Y/n)"
    ));
    if should_create {
        return deps.start.run(trimmed);
    }

    deps.io.writeln_stderr("Cancelled");
    Ok(Outcome::none())
}

/// Handle a candidate set: single → jump; multiple → prompt; empty → `None`.
fn handle_partial<I, G, P, S>(
    deps: &JumpDeps<I, G, P, S>,
    matches: &[Worktree],
    query: &str,
    mru_entries: &[MruEntry],
    opts: OutputOptions,
) -> Result<Option<Outcome>>
where
    I: Io,
    G: GitRunner,
    P: Prompt,
    S: StartCommand,
{
    if matches.len() == 1 {
        let wt = &matches[0];
        verbose_log(
            deps.io,
            &format!("Partial match found: {} -> {}", wt.branch, wt.path),
            opts,
        );
        log(deps.io, &format!("Matched: {}", wt.branch), opts);
        return Ok(Some(jump_to(deps, &wt.branch, &wt.path)));
    }

    if matches.len() > 1 {
        verbose_log(
            deps.io,
            &format!("Multiple partial matches found: {}", matches.len()),
            opts,
        );

        let sorted = sort_by_mru(matches, mru_entries);
        let mut choices: Vec<String> = sorted
            .iter()
            .map(|w| format!("{} ({})", w.branch, w.path))
            .collect();
        choices.push("Cancel".to_string());

        let selected = deps
            .prompt
            .select(&format!("Multiple worktrees match '{query}':"), &choices)?;

        let is_cancel = selected == choices.len() - 1;
        if is_cancel {
            deps.io.writeln_stderr("Cancelled");
            return Ok(Some(Outcome::none()));
        }

        let wt = &sorted[selected];
        return Ok(Some(jump_to(deps, &wt.branch, &wt.path)));
    }

    Ok(None)
}

/// Emit a `cd` to `path` and record the MRU entry (best-effort).
///
/// The `Matched:` line (when shown) is printed by the caller before this, so
/// `jump_to` only records MRU and returns the `cd`. MRU recording failures are
/// swallowed so they never break the jump, matching the TS try/catch.
fn jump_to<I, G, P, S>(deps: &JumpDeps<I, G, P, S>, branch: &str, path: &str) -> Outcome
where
    I: Io,
    G: GitRunner,
    P: Prompt,
    S: StartCommand,
{
    let _ = record_mru_entry(deps.io, branch, path, deps.now_ms);
    Outcome::cd(path.to_string())
}

/// Whether scratch worktrees should be excluded for this query.
fn should_filter_out_scratch(query: &str) -> bool {
    !query.to_lowercase().starts_with(SCRATCH_PREFIX)
}

fn is_scratch(branch: &str) -> bool {
    branch.starts_with(SCRATCH_PREFIX)
}

/// Whether `search` appears at a word boundary in `branch` (start, or after
/// `/`, `-`, `_`).
fn is_word_boundary_match(branch: &str, search: &str) -> bool {
    let Some(index) = branch.find(search) else {
        return false;
    };
    if index == 0 {
        return true;
    }
    // Char immediately before the match must be a boundary character.
    let char_before = branch[..index].chars().next_back();
    char_before.is_some_and(|c| WORD_BOUNDARY_CHARS.contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::UnimplementedStart;
    use crate::io::FakeIo;
    use std::cell::RefCell;

    /// Git returning a fixed worktree-list porcelain.
    struct ListGit {
        porcelain: String,
    }
    impl GitRunner for ListGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            if args.contains(&"worktree") {
                return Ok(self.porcelain.clone());
            }
            Ok(String::new())
        }
    }

    /// Prompt scripted with a confirm answer and a select index.
    struct ScriptPrompt {
        confirm: bool,
        select: RefCell<Vec<usize>>,
    }
    impl ScriptPrompt {
        fn new(confirm: bool, selects: &[usize]) -> Self {
            ScriptPrompt {
                confirm,
                select: RefCell::new(selects.to_vec()),
            }
        }
    }
    impl Prompt for ScriptPrompt {
        fn confirm(&self, _message: &str) -> bool {
            self.confirm
        }
        fn select(&self, _message: &str, _choices: &[String]) -> Result<usize> {
            Ok(self.select.borrow_mut().remove(0))
        }
    }

    fn porcelain(entries: &[(&str, &str)]) -> String {
        let mut s = String::new();
        for (path, branch) in entries {
            s.push_str(&format!(
                "worktree {path}\nHEAD abc\nbranch refs/heads/{branch}\n\n"
            ));
        }
        s
    }

    fn deps<'a>(
        io: &'a FakeIo,
        git: &'a ListGit,
        prompt: &'a ScriptPrompt,
        start: &'a UnimplementedStart,
    ) -> JumpDeps<'a, FakeIo, ListGit, ScriptPrompt, UnimplementedStart> {
        JumpDeps {
            io,
            git,
            prompt,
            start,
            now_ms: 1000,
        }
    }

    #[test]
    fn empty_branch_errors() {
        let io = FakeIo::new();
        let git = ListGit {
            porcelain: String::new(),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        assert!(jump_command(&d, "   ", OutputOptions::default()).is_err());
    }

    #[test]
    fn exact_match_jumps() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/main", "main"), ("/wt/feat", "feature")]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "feature", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/feat"));
    }

    #[test]
    fn case_insensitive_exact_match_prints_matched() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/feat", "Feature")]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "feature", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/feat"));
        assert!(io.stderr_text().contains("Matched: Feature"));
    }

    #[test]
    fn single_substring_match_jumps() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/login", "feat/login-page")]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/login"));
    }

    #[test]
    fn multiple_matches_select_then_jump() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/a", "feat/login"), ("/wt/b", "fix/login")]),
        };
        // select index 1 → second sorted candidate.
        let prompt = ScriptPrompt::new(false, &[1]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        // Both match "login" by word boundary; selection picks one of the paths.
        assert!(matches!(
            outcome.cd_path.as_deref(),
            Some("/wt/a") | Some("/wt/b")
        ));
    }

    #[test]
    fn multiple_matches_cancel_returns_none() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/a", "feat/login"), ("/wt/b", "fix/login")]),
        };
        // select the last choice (Cancel): index 2 (2 matches + Cancel).
        let prompt = ScriptPrompt::new(false, &[2]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io.stderr_text().contains("Cancelled"));
    }

    #[test]
    fn scratch_excluded_unless_prefixed() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/s", "scratch/123login")]),
        };
        // query "login" should NOT match the scratch branch → no match → confirm.
        let prompt = ScriptPrompt::new(false, &[]); // decline create
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io.stderr_text().contains("No worktree found for 'login'"));
    }

    #[test]
    fn scratch_included_when_query_has_prefix() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/s", "scratch/123")]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "scratch/123", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/s"));
    }

    #[test]
    fn no_match_confirm_create_hits_phase4_stub() {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/main", "main")]),
        };
        let prompt = ScriptPrompt::new(true, &[]); // accept create
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        // create path is unimplemented in Phase 2 → error.
        assert!(jump_command(&d, "zzz-new-branch", OutputOptions::default()).is_err());
    }

    #[test]
    fn word_boundary_helper() {
        assert!(is_word_boundary_match("feat/login", "login"));
        assert!(is_word_boundary_match("login", "login"));
        assert!(!is_word_boundary_match("relogin", "login"));
        assert!(is_word_boundary_match("a-login", "login"));
    }

    // --- Cascade-tier isolation ---------------------------------------------
    //
    // Each test constructs a worktree list where the query matches for the FIRST
    // time at exactly one tier, proving the cascade reaches that tier (and not an
    // earlier one). Helper to jump a single-branch list and assert the cd path.

    /// Jump `query` against a single non-main branch `branch` at `path`, asserting
    /// the result `cd`s to `path` (i.e. the cascade reached the branch).
    fn assert_tier_match(branch: &str, query: &str, path: &str) -> FakeIo {
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/main", "main"), (path, branch)]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, query, OutputOptions::default()).unwrap();
        assert_eq!(
            outcome,
            Outcome::cd(path),
            "query {query:?} should match {branch:?}"
        );
        io
    }

    #[test]
    fn tier_word_boundary_case_sensitive_only() {
        // "feat/login" matches "login" at a `/` boundary, same case. Exact CS/CI
        // don't match (branch != "login"); word-boundary CS is the first hit.
        assert_tier_match("feat/login", "login", "/wt/wb-cs");
    }

    #[test]
    fn tier_word_boundary_case_insensitive_only() {
        // "feat/Login" does NOT contain "login" (capital L) → WB CS misses; the
        // lowercased "feat/login" matches at a boundary → WB CI is the first hit.
        assert_tier_match("feat/Login", "login", "/wt/wb-ci");
    }

    #[test]
    fn tier_substring_case_sensitive_only() {
        // "relogin" contains "login" but NOT at a boundary (preceded by 'e') →
        // both word-boundary tiers miss; substring CS is the first hit.
        assert_tier_match("relogin", "login", "/wt/sub-cs");
    }

    #[test]
    fn tier_substring_case_insensitive_only() {
        // "reLogin": substring CS misses ("login" not present with that case);
        // lowercased "relogin" contains "login" not at a boundary → WB CI misses
        // too; substring CI is the first hit.
        assert_tier_match("reLogin", "login", "/wt/sub-ci");
    }

    #[test]
    fn fuzzy_skipped_below_min_length() {
        // A 2-char query is below FUZZY_MATCH_MIN_LENGTH (3): even though "ab" is
        // a fuzzy subsequence of "xaxbx", fuzzy is NOT attempted, so there is no
        // match and jump falls through to the create prompt (declined here).
        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[("/wt/x", "xaxbx")]),
        };
        let prompt = ScriptPrompt::new(false, &[]); // decline create
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "ab", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io.stderr_text().contains("No worktree found for 'ab'"));
    }

    #[test]
    fn fuzzy_matches_at_min_length_sorted_by_score_desc() {
        // A 3-char query "abc" reaches the fuzzy tier (no substring match) and
        // matches BOTH candidates as subsequences. The multi-match prompt list is
        // ordered by fuzzy score descending; derive the expected winner from the
        // scorer itself rather than guessing, then assert choice index 0 jumps to
        // the higher-scoring branch (proving the score-desc ordering).
        // Both branches are SCATTERED (no contiguous "abc"), so the substring
        // tiers miss and the fuzzy tier is the one that matches both.
        let branch_a = "axbxc";
        let branch_b = "a-zz-b-zz-c";
        let path_a = "/wt/a";
        let path_b = "/wt/b";
        assert!(!branch_a.contains("abc") && !branch_b.contains("abc"));

        // Derive the expected score-desc ordering from the scorer itself, so the
        // test asserts the ORDERING property without hardcoding which fixture wins.
        let score_a = crate::fuzzy::fuzzy_match(branch_a, "abc").unwrap().score;
        let score_b = crate::fuzzy::fuzzy_match(branch_b, "abc").unwrap().score;
        assert_ne!(score_a, score_b, "fixture needs distinct scores");
        let expected_top_path = if score_a > score_b { path_a } else { path_b };

        let io = FakeIo::new().with_env("HOME", "/nonexistent-home");
        let git = ListGit {
            porcelain: porcelain(&[(path_a, branch_a), (path_b, branch_b)]),
        };
        // Choice index 0 is the highest-scoring candidate (score-desc ordering).
        let prompt = ScriptPrompt::new(false, &[0]);
        let start = UnimplementedStart;
        let d = deps(&io, &git, &prompt, &start);
        let outcome = jump_command(&d, "abc", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd(expected_top_path));
    }

    #[test]
    fn single_match_records_mru_entry() {
        // A single substring match jumps AND records an MRU entry as a side
        // effect; assert the mru.json write is observable via a follow-up load.
        let fx = vibe_test_support::Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = ListGit {
            porcelain: porcelain(&[("/wt/login", "feat/login-page")]),
        };
        let prompt = ScriptPrompt::new(false, &[]);
        let start = UnimplementedStart;
        let d = JumpDeps {
            io: &io,
            git: &git,
            prompt: &prompt,
            start: &start,
            now_ms: 4242,
        };
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/wt/login"));

        // The MRU file now records the jumped worktree at the injected timestamp.
        let entries = crate::mru::load_mru_data(&io);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/wt/login");
        assert_eq!(entries[0].branch, "feat/login-page");
        assert_eq!(entries[0].timestamp, 4242);
    }

    #[test]
    fn multiple_matches_select_list_is_mru_ordered() {
        // Two branches match "login". Pre-seed MRU so "/wt/b" is most-recent; the
        // prompt list must then be ordered most-recent-first, so choice index 0
        // is "/wt/b". Picking index 0 jumps there, proving MRU ordering.
        let fx = vibe_test_support::Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        // Record /wt/a first (older), then /wt/b (newer) → b is most-recent.
        crate::mru::record_mru_entry(&io, "feat/login", "/wt/a", 100).unwrap();
        crate::mru::record_mru_entry(&io, "fix/login", "/wt/b", 200).unwrap();

        let git = ListGit {
            porcelain: porcelain(&[("/wt/a", "feat/login"), ("/wt/b", "fix/login")]),
        };
        let prompt = ScriptPrompt::new(false, &[0]); // pick the most-recent
        let start = UnimplementedStart;
        let d = JumpDeps {
            io: &io,
            git: &git,
            prompt: &prompt,
            start: &start,
            now_ms: 999,
        };
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        // MRU-first ordering puts /wt/b at index 0.
        assert_eq!(outcome, Outcome::cd("/wt/b"));
    }

    #[test]
    fn multiple_matches_cancel_does_not_cd_and_returns_ok() {
        let fx = vibe_test_support::Fixture::new();
        let io = FakeIo::new().with_env("HOME", fx.path().to_str().unwrap());
        let git = ListGit {
            porcelain: porcelain(&[("/wt/a", "feat/login"), ("/wt/b", "fix/login")]),
        };
        // 2 matches + Cancel → Cancel is index 2.
        let prompt = ScriptPrompt::new(false, &[2]);
        let start = UnimplementedStart;
        let d = JumpDeps {
            io: &io,
            git: &git,
            prompt: &prompt,
            start: &start,
            now_ms: 1,
        };
        let outcome = jump_command(&d, "login", OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io.stderr_text().contains("Cancelled"));
        // Cancel records no MRU entry.
        assert!(crate::mru::load_mru_data(&io).is_empty());
    }
}
