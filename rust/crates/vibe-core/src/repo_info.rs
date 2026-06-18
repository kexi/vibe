//! Resolve a file path to its repository identity (`RepoInfo`).
//!
//! Ported from `getRepoInfoFromPath` in `packages/core/src/utils/git.ts`. This
//! is security-critical: it decides which repository a `.vibe.toml` belongs to,
//! which feeds the trust store. The containment check below is deliberately
//! stricter than the TS original (see the `// Why not` note).

use crate::git::{normalize_remote_url, GitRunner, RepoInfo};
use crate::hash;
use crate::settings::RepoResolver;
use std::path::Path;

/// Repository info for `path`, or `None` if it is not inside a git repo (or any
/// resolution step fails — matching the TS `try/catch → null`).
///
/// Security invariant: BOTH the real file path and the git repo root are
/// canonicalized, then containment is checked with `Path::starts_with`.
///
/// Why not the TS `startsWith(root + SEPARATOR)` byte hack: a textual prefix
/// check treats `/repo-evil` as "inside" `/repo` because `/repo` is a string
/// prefix of `/repo-evil/...` only after appending the separator — and the TS
/// guards that with `+ SEPARATOR`, but that still depends on exact byte forms
/// and is easy to get subtly wrong across platforms. Rust's `Path::starts_with`
/// is component-wise, so `/repo-evil` is correctly rejected as not under
/// `/repo`. Canonicalizing both sides removes symlink/`.`/`..` ambiguity before
/// the comparison, so the check operates on real, normalized paths.
pub fn get_repo_info_from_path(runner: &impl GitRunner, path: &str) -> Option<RepoInfo> {
    // Resolve symlinks / `.` / `..` to a real absolute path.
    let real = std::fs::canonicalize(path).ok()?;
    let file_dir = real.parent()?;
    let file_dir_str = file_dir.to_str()?;

    // Use `git -C <dir>` so we never change the process CWD (avoids races when
    // multiple resolutions run concurrently), exactly as the TS did.
    let repo_root_raw = runner
        .run(&["-C", file_dir_str, "rev-parse", "--show-toplevel"])
        .ok()?;

    // The git root must be absolute (TS threw otherwise).
    let repo_root_path = Path::new(&repo_root_raw);
    if !repo_root_path.is_absolute() {
        return None;
    }

    // Canonicalize the root too: BOTH sides canonical is the invariant.
    let root = std::fs::canonicalize(repo_root_path).ok()?;

    // Containment: real must equal root or be strictly under it (component-wise).
    let is_inside = real == root || real.starts_with(&root);
    if !is_inside {
        return None;
    }

    // Relative path from the root. With a verified containment this cannot
    // escape, but the `..` guard below is kept as defense-in-depth.
    let rel = real.strip_prefix(&root).ok()?;
    let has_parent_ref = rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir));
    if has_parent_ref {
        return None;
    }
    let relative_path = rel.to_str()?.to_string();

    // Remote URL is optional (local-only repos have none).
    let remote_url = remote_url_for(runner, file_dir_str);

    Some(RepoInfo {
        remote_url,
        repo_root: root.to_str()?.to_string(),
        relative_path,
    })
}

/// Read & normalize `remote.origin.url`, or `None` if absent/empty.
///
/// Why the empty-string → None guard: `git config --get` of a missing remote
/// can yield an empty line, which `normalize_remote_url` would pass through as
/// `""`. Storing an empty remote URL would make trust matching ambiguous, so we
/// treat empty as "no remote".
fn remote_url_for(runner: &impl GitRunner, file_dir: &str) -> Option<String> {
    let raw = runner
        .run(&["-C", file_dir, "config", "--get", "remote.origin.url"])
        .ok()?;
    let normalized = normalize_remote_url(&raw);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

/// Production [`RepoResolver`]: delegates to [`get_repo_info_from_path`] and the
/// real SHA-256 file hasher. Used by the settings migrations.
pub struct RealRepoResolver<'a, G: GitRunner> {
    pub runner: &'a G,
}

impl<'a, G: GitRunner> RealRepoResolver<'a, G> {
    pub fn new(runner: &'a G) -> Self {
        RealRepoResolver { runner }
    }
}

impl<G: GitRunner> RepoResolver for RealRepoResolver<'_, G> {
    fn repo_info(&self, path: &str) -> Option<RepoInfo> {
        get_repo_info_from_path(self.runner, path)
    }

    fn hash_file(&self, path: &str) -> std::result::Result<String, String> {
        hash::hash_file(path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Result;
    use std::cell::RefCell;
    use vibe_test_support::Fixture;

    /// A git runner scripted by exact arg-vector match.
    ///
    /// `rev-parse --show-toplevel` returns the configured root; `config --get`
    /// returns the configured remote (or errors if `None`).
    struct ScriptedGit {
        repo_root: String,
        remote: Option<String>,
        calls: RefCell<Vec<Vec<String>>>,
    }
    impl ScriptedGit {
        fn new(repo_root: &str, remote: Option<&str>) -> Self {
            ScriptedGit {
                repo_root: repo_root.to_string(),
                remote: remote.map(|s| s.to_string()),
                calls: RefCell::new(vec![]),
            }
        }
    }
    impl GitRunner for ScriptedGit {
        fn run(&self, args: &[&str]) -> Result<String> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if args.contains(&"--show-toplevel") {
                return Ok(self.repo_root.clone());
            }
            if args.contains(&"--get") {
                return match &self.remote {
                    Some(url) => Ok(url.clone()),
                    None => Err(crate::error::VibeError::GitOperation {
                        command: args.join(" "),
                        message: "no remote".into(),
                    }),
                };
            }
            Ok(String::new())
        }
    }

    #[test]
    fn resolves_repo_info_for_file_in_repo() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let file = fx.write("repo/.vibe.toml", "x");
        // canonicalize the root the same way the resolver will.
        let root = std::fs::canonicalize(&repo).unwrap();
        let git = ScriptedGit::new(root.to_str().unwrap(), Some("git@github.com:u/r.git"));

        let info = get_repo_info_from_path(&git, file.to_str().unwrap()).unwrap();
        assert_eq!(info.relative_path, ".vibe.toml");
        assert_eq!(info.repo_root, root.to_str().unwrap());
        assert_eq!(info.remote_url.as_deref(), Some("github.com/u/r"));
    }

    #[test]
    fn empty_remote_becomes_none() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let file = fx.write("repo/.vibe.toml", "x");
        let root = std::fs::canonicalize(&repo).unwrap();
        // git config returns an empty line for a missing remote.
        let git = ScriptedGit::new(root.to_str().unwrap(), Some("   "));

        let info = get_repo_info_from_path(&git, file.to_str().unwrap()).unwrap();
        assert_eq!(info.remote_url, None);
    }

    #[test]
    fn none_when_remote_command_errors() {
        let fx = Fixture::new();
        let repo = fx.mkdir("repo");
        let file = fx.write("repo/.vibe.toml", "x");
        let root = std::fs::canonicalize(&repo).unwrap();
        let git = ScriptedGit::new(root.to_str().unwrap(), None);

        let info = get_repo_info_from_path(&git, file.to_str().unwrap()).unwrap();
        assert_eq!(info.remote_url, None);
    }

    #[test]
    fn none_when_path_does_not_exist() {
        let git = ScriptedGit::new("/repo", None);
        // canonicalize fails for a nonexistent path → None.
        assert!(get_repo_info_from_path(&git, "/no/such/file").is_none());
    }

    #[test]
    fn rejects_sibling_prefix_repo_repo_evil() {
        // ADVERSARIAL: a file under `/repo-evil` must NOT be considered inside
        // `/repo`, even though `/repo` is a textual prefix of `/repo-evil`.
        let fx = Fixture::new();
        let evil_dir = fx.mkdir("repo-evil");
        let file = fx.write("repo-evil/.vibe.toml", "x");
        // git claims the toplevel is the sibling `repo` dir (the prefix victim).
        let victim_root = fx.mkdir("repo");
        let victim_canon = std::fs::canonicalize(&victim_root).unwrap();
        let _ = evil_dir;
        let git = ScriptedGit::new(victim_canon.to_str().unwrap(), None);

        // real path is under repo-evil; root is repo → containment fails → None.
        assert!(get_repo_info_from_path(&git, file.to_str().unwrap()).is_none());
    }

    #[test]
    fn none_when_repo_root_not_absolute() {
        let fx = Fixture::new();
        let _ = fx.mkdir("repo");
        let file = fx.write("repo/.vibe.toml", "x");
        let git = ScriptedGit::new("relative-root", None);
        assert!(get_repo_info_from_path(&git, file.to_str().unwrap()).is_none());
    }
}
