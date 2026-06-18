//! `vibe home`: return to the main worktree (without removing the current one).
//!
//! Ported from `packages/core/src/commands/home.ts`. Emits a `cd` to the main
//! worktree path via [`Outcome`]; the binary performs the single stdout write.
//! Not being inside a git repo is a fatal error; already being in main is a
//! no-op success.

use crate::commands::Outcome;
use crate::error::{Result, VibeError};
use crate::git::{get_main_worktree_path, is_inside_worktree, is_main_worktree, GitRunner};
use crate::io::Io;
use crate::output::{log, verbose_log, OutputOptions};

/// Run `vibe home`.
pub fn home_command(io: &impl Io, git: &impl GitRunner, opts: OutputOptions) -> Result<Outcome> {
    let inside = is_inside_worktree(git);
    if !inside {
        // TS errorLog + exit(1); we surface a fatal error the binary maps.
        return Err(VibeError::Worktree(
            "Not inside a git repository.".to_string(),
        ));
    }

    let is_main = is_main_worktree(git)?;
    if is_main {
        log(io, "Already in the main worktree.", opts);
        return Ok(Outcome::none());
    }

    let main_path = get_main_worktree_path(git)?;
    verbose_log(io, &format!("Main worktree path: {main_path}"), opts);
    log(
        io,
        &format!("Returning to main worktree: {main_path}"),
        opts,
    );

    Ok(Outcome::cd(main_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Result as VResult;
    use crate::io::FakeIo;

    /// Scriptable git: configurable inside-worktree, repo root and worktree list.
    struct FakeGit {
        inside: bool,
        repo_root: String,
        worktrees: String, // porcelain output
        fail_inside: bool,
    }
    impl GitRunner for FakeGit {
        fn run(&self, args: &[&str]) -> VResult<String> {
            if args.contains(&"--is-inside-work-tree") {
                if self.fail_inside {
                    return Err(VibeError::GitOperation {
                        command: args.join(" "),
                        message: "not a repo".into(),
                    });
                }
                return Ok(if self.inside { "true" } else { "false" }.to_string());
            }
            if args.contains(&"--show-toplevel") {
                return Ok(self.repo_root.clone());
            }
            if args.contains(&"worktree") {
                return Ok(self.worktrees.clone());
            }
            Ok(String::new())
        }
    }

    fn wt_list(main: &str, feature: Option<&str>) -> String {
        let mut s = format!("worktree {main}\nHEAD abc\nbranch refs/heads/main\n\n");
        if let Some(f) = feature {
            s.push_str(&format!(
                "worktree {f}\nHEAD def\nbranch refs/heads/feat\n\n"
            ));
        }
        s
    }

    #[test]
    fn errors_when_not_inside_repo() {
        let git = FakeGit {
            inside: false,
            repo_root: String::new(),
            worktrees: String::new(),
            fail_inside: false,
        };
        let io = FakeIo::new();
        assert!(home_command(&io, &git, OutputOptions::default()).is_err());
    }

    #[test]
    fn git_failure_on_inside_check_is_treated_as_not_inside() {
        let git = FakeGit {
            inside: true,
            repo_root: String::new(),
            worktrees: String::new(),
            fail_inside: true,
        };
        let io = FakeIo::new();
        assert!(home_command(&io, &git, OutputOptions::default()).is_err());
    }

    #[test]
    fn noop_when_already_in_main() {
        let git = FakeGit {
            inside: true,
            repo_root: "/repo/main".into(),
            worktrees: wt_list("/repo/main", None),
            fail_inside: false,
        };
        let io = FakeIo::new();
        let outcome = home_command(&io, &git, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::none());
        assert!(io.stderr_text().contains("Already in the main worktree."));
    }

    #[test]
    fn returns_cd_to_main_when_in_secondary() {
        let git = FakeGit {
            inside: true,
            repo_root: "/repo/feat".into(), // current is the feature worktree
            worktrees: wt_list("/repo/main", Some("/repo/feat")),
            fail_inside: false,
        };
        let io = FakeIo::new();
        let outcome = home_command(&io, &git, OutputOptions::default()).unwrap();
        assert_eq!(outcome, Outcome::cd("/repo/main"));
        assert!(io
            .stderr_text()
            .contains("Returning to main worktree: /repo/main"));
    }
}
