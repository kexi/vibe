# Git Workflow Rules

## Branch Strategy

GitHub Flow: `main` is the only long-lived branch.

- Topic branches are created from `main` and deleted when their PR merges
- PRs must always target `main`
- **IMPORTANT**: Never push directly to `main`
- A release is a tag on `main`, created by the Release workflow — never a
  long-lived branch. The version bump rides in on a `release/vX.Y.Z` topic
  branch like any other PR.
- The heavy CI matrix (Linux, Windows, binaries, `.deb`, e2e, npm) runs on the
  push to `main` after a merge, not on the PR. Add the `ci-full` label to a PR
  to run the Windows leg before merging.

## Merging

- Merge with `gh pr merge <pr> --auto --merge`. Auto-merge lands the PR the
  moment its required checks go green, so there is no need to sit on a run.
- `mergeStateStatus: BLOCKED` while checks are still pending is normal; it does
  not mean auto-merge failed.
- `--admin` is a last resort, not the routine path. `main` requires a PR and
  seven passing checks but **no approving review**, precisely so a single
  maintainer can use auto-merge instead of overriding protection on every merge.
- The required checks are the seven that actually run on a PR: `build`, `lint`,
  `rust-macos`, `docs`, `pinact-verify`, `gitleaks`, `nix-build (ubuntu-latest)`.
  Never add a push-only job (`rust-linux`, `rust-windows`, `e2e-test`,
  `build-rust-binaries`, `build-deb`, `npm-install-matrix`) to that list — it
  never reports on a PR, so every PR would block forever.

## PR/Commit Guidelines

- **IMPORTANT**: Before creating a PR, always run `pnpm run check:all` and ensure all checks pass
- **Title format**: `<type>: <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- Write in English
- Follow GNU Coding Standards
