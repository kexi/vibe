---
description: Release a new version of vibe. Use for ANY release work — version bump, release preparation, develop→main release PR, dispatching release.yml, release notes / announcement tweet, or post-release follow-ups (flake.nix hashes). Trigger on "release", "リリース", "version bump", "vX.Y.Z を出す", or a request to publish/announce a new version. Read this BEFORE starting any release step, even a partial one.
argument-hint: "[patch|minor|major|X.Y.Z]"
allowed-tools: Bash(git *), Bash(gh *), Bash(pnpm *), Bash(bun *), Read, Edit, AskUserQuestion
context: fork
---

# vibe Release Workflow

A guided workflow for releasing a new version of the vibe project.

**Argument**: $ARGUMENTS (optional - auto-suggests based on commit history when omitted)

---

## Step 1: Precondition Checks

Run the following checks:

### 1.1 Clean Working Directory

```bash
git status --porcelain
```

- If output exists: There are uncommitted changes. Commit or stash before continuing.
- If output is empty: OK to proceed

### 1.2 Correct Branch

```bash
git branch --show-current
```

- Must be on the `develop` branch
- If on a different branch, use `AskUserQuestion` to warn and confirm:
  - `question`: "Current branch is `<branch>`, not `develop`. Continue anyway?"
  - `header`: "Branch check"
  - `options`:
    - `Switch to develop` (Recommended) — abort and have the user run `git checkout develop`
    - `Continue on this branch` — proceed with the release on the current branch

### 1.3 Remote Sync

```bash
git fetch origin
git log HEAD..origin/develop --oneline
```

- If output exists: Remote has newer commits. Use `AskUserQuestion` to decide:
  - `question`: "origin/develop has newer commits. Pull before continuing?"
  - `header`: "Remote sync"
  - `options`:
    - `Pull and continue` (Recommended) — run `git pull` then proceed
    - `Continue without pulling` — proceed against the local HEAD (release may miss remote changes)
- If output is empty: In sync

> **Note**: Tag duplicate verification is intentionally **not** in Step 1 — see [Step 2.4](#step-24-tag-duplicate-check) (it cannot run until the version is resolved).

---

## Step 2: Version Calculation

### 2.1 Get Current Version

```bash
pnpm run get-version
```

### 2.2 Calculate New Version

#### When argument is provided

Calculate the new version based on the argument:

| Argument | Current → New   | Description              |
| -------- | --------------- | ------------------------ |
| `patch`  | 0.12.7 → 0.12.8 | Bug fix                  |
| `minor`  | 0.12.7 → 0.13.0 | New feature (compatible) |
| `major`  | 0.12.7 → 1.0.0  | Breaking change          |
| `X.Y.Z`  | → X.Y.Z         | Explicit version         |

#### When argument is omitted (auto-suggest)

Analyze commit history since the last release and suggest an appropriate version.

**1. Get commit history**

```bash
git log $(gh release list --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

**2. Analysis based on Conventional Commits**

Analyze commit messages and determine version type using these rules:

| Pattern                                                         | Version Type | Priority |
| --------------------------------------------------------------- | ------------ | -------- |
| `BREAKING CHANGE:` or `!:` (e.g., `feat!:`)                     | **major**    | Highest  |
| `feat:` or `feat(...):`                                         | **minor**    | Medium   |
| `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:` | **patch**    | Low      |

**3. Suggestion format**

Summarize changes and suggest in the following format:

```
## Version Suggestion

**Current version**: 0.12.7
**Suggested version**: 0.13.0 (minor)

### Reason

Changes since last release (v0.12.7):

- 🚀 **Features (2)**: Requires minor version bump
  - feat: add new command for worktree listing
  - feat(config): support custom templates

- 🐛 **Bug Fixes (1)**:
  - fix: resolve path handling on Windows

- 📦 **Other (3)**:
  - chore: update dependencies
  - docs: improve README
  - refactor: simplify error handling

**Rationale**: Suggests minor version bump because `feat:` commits are present.
```

**4. Confirm with user**

Display the suggestion summary in a text message, then call `AskUserQuestion` to capture the choice.

**Build the `options` list dynamically to avoid duplicates with the recommended suggestion:**

1. **Always** include the recommended option first: `Use <suggested> (<bumpType>)` with `(Recommended)` suffix.
2. For each bump type in `[patch, minor, major]`, append `Bump as <type> → <computedVersion>` **only when `<type>` differs from `<bumpType>`** (i.e., skip the alternative that would compute the same version as the suggestion).
3. The resulting list is **2–4 options total**: 1 recommended + the 2 alternatives that differ from the suggestion (and, if the explicit-version path is meaningful, you may surface it as a 4th hint instead — see step 4 below).

Worked examples (suggested = `0.13.0 (minor)` from current `0.12.7`):

| Suggestion       | Final options                                                                           |
| ---------------- | --------------------------------------------------------------------------------------- |
| `0.13.0 (minor)` | `Use 0.13.0 (minor)` (Recommended) / `Bump as patch → 0.12.8` / `Bump as major → 1.0.0` |
| `1.0.0 (major)`  | `Use 1.0.0 (major)` (Recommended) / `Bump as patch → 0.12.8` / `Bump as minor → 0.13.0` |
| `0.12.8 (patch)` | `Use 0.12.8 (patch)` (Recommended) / `Bump as minor → 0.13.0` / `Bump as major → 1.0.0` |

**Call payload**:

- `question`: "Use the suggested version `<suggested>` (<bumpType>) for this release?"
- `header`: "Version bump"
- `options`: built per the rules above (no duplicates of the recommended)

4. **Free-text fallback**: `AskUserQuestion` always exposes an implicit "Other" entry that accepts free text. If the user picks "Other", treat the response as an explicit `X.Y.Z` and validate it against the semver pattern `^\d+\.\d+\.\d+$` before proceeding. Reject anything else and re-ask. (The "Other" entry is provided by the tool — do not list it explicitly in `options`.)

### 2.3 User Confirmation

When the user provided an explicit argument in Step 2.2 (so the auto-suggest flow above did not run), still confirm the resolved version with `AskUserQuestion` before mutating files:

- `question`: "Proceed with releasing `v<resolvedVersion>` (current: `v<currentVersion>`)?"
- `header`: "Confirm version"
- `options`:
  - `Proceed with v<resolvedVersion>` (Recommended) — continue to Step 3
  - `Pick a different version` — abort and let the user re-run the skill with a corrected argument

If the auto-suggest `AskUserQuestion` from Step 2.2 already captured the user's choice, skip this step.

### 2.4 Tag Duplicate Check

Run **after** the version is resolved (i.e., after Step 2.2 #4 for the auto-suggest path or after Step 2.3 for the explicit-argument path) and **before** Step 3.1 creates the release branch. Do not pre-check `patch` / `minor` / `major` candidates earlier.

```bash
git tag -l "v<resolvedVersion>"
```

- If output is empty: OK to proceed to Step 3.
- If output is non-empty: **Abort** (per the Safety Checks table). Tell the user `v<resolvedVersion>` already exists and have them re-run with a different version.

---

## Step 3: Version Update

### 3.1 Create Release Branch

```bash
git checkout -b release/vX.Y.Z
```

### 3.2 Bump the version (bmp)

`.bmp.yml` is the single source of truth for the release version. Bump it with
[kt3k/bmp](https://jsr.io/@kt3k/bmp) via the `bmp` pnpm script — **primary path**:

```bash
pnpm run bmp -p   # patch
pnpm run bmp -m   # minor
pnpm run bmp -j   # major
```

(Prereleases: add `--preid <label>`; finalize a prerelease with `-r`.)

**After the bump, restore `.bmp.yml`'s formatting.** bmp re-serializes its own
config on every bump, stripping all comments and normalizing YAML styles, which
`packages/npm/test/bmp-manifest-registration.test.ts` rejects. Restore the file
and re-apply only the version line:

```bash
git checkout HEAD -- .bmp.yml
# then edit the single `version:` line to the new version
```

A single bump rewrites, from the one `version:` in `.bmp.yml`, every registered
manifest: the root `package.json`, `packages/npm/package.json`, the five
per-platform `packages/vibe-{linux,darwin,win32}-*/package.json`, `@kexi/vibe`'s
five `optionalDependency` pins, the three Cargo crates
(`rust/crates/{vibe,vibe-core,vibe-test-support}/Cargo.toml`), AND — critically —
the five `pnpm-lock.yaml` importer `specifier:` lines. The lockfile edit is a
literal replace with no dependency re-resolution, so `pnpm install
--frozen-lockfile` stays valid; this fixes the v2.1.0/v2.1.1 releases that broke
because the manual lockfile edit was missed. The `vibe-native` crate is
intentionally NOT a target — it carries an independent version.

**Explicit / non-adjacent version:** bmp has no "set X.Y.Z" command. Chain bumps
to reach a non-adjacent target (e.g. two `-m` to go 2.1.1 → 2.3.0). As a last
resort, hand-edit the `version:` line in `.bmp.yml` plus each target's version
occurrence, then validate with `pnpm run bmp` (see Step 3.4).

**First-run note:** `pnpm run bmp` uses `--frozen` against the committed
`deno.lock` (maintained via `deno.json`). If `deno.lock` does not yet exist
(initial adoption of bmp), run `deno cache jsr:@kt3k/bmp@0.3.3` once at the repo
root to create it and commit it BEFORE the first release.

**Failure recovery:** bmp's multi-file rewrite is not atomic. The Step 1.1
clean-working-tree precondition guarantees `git checkout .` loses no other work,
so on any bmp error or validation failure run `git checkout .` and abort.

### 3.3 Refresh Cargo.lock

A release bump always changes the Cargo manifest targets, so refresh the lockfile
metadata:

```bash
cargo metadata --manifest-path rust/Cargo.toml --format-version 1 >/dev/null
```

This updates the workspace package versions recorded in `rust/Cargo.lock`.

**Third-party license notices:** the bump itself never changes
`THIRD-PARTY-LICENSES.md` (the generator excludes the workspace's own crates),
but if dependency bumps landed since the last release, confirm the committed
file is fresh:

```bash
pnpm run check:licenses
```

If it reports stale, regenerate locally with
`bun run scripts/generate-third-party-licenses.ts` and include the diff in the
release branch. Regeneration is ALWAYS a local step: by policy this repo stores
no push-capable tokens in secrets, so there is no CI auto-commit — CI
(`check:licenses` in `check:all`) only fails on staleness, it never rewrites.

### 3.4 Verify Sync

```bash
pnpm run bmp
```

No-arg `bmp` validates: it substitutes `.bmp.yml`'s version into every configured
pattern and exits 1 on any drift or missing target file.

### 3.5 Update Changelog

Update the following file:

- `packages/docs/src/content/docs/changelog.mdx`

**Format:**

```markdown
## vX.Y.Z

**Released:** YYYY-MM-DD

### Added

- New feature description

### Changed

- Change description

### Fixed

- Bug fix description

---
```

**Notes:**

- Add the new version section at the top of the file (after frontmatter)
- Categorize based on Conventional Commits (feat→Added, fix→Fixed, others→Changed)
- Follow the format of existing entries

**Important: Only include end-user-facing changes**

Exclude the following from the changelog:

- CI/CD workflow changes (GitHub Actions, etc.)
- Developer tooling (Claude Code commands, release scripts, etc.)
- Internal refactoring (when no user-visible behavior changes)
- Developer documentation updates (CLAUDE.md, CONTRIBUTING.md, etc.)
- Test additions/fixes
- Code formatting fixes
- Dependency updates (except security fixes or user-impacting changes)

Examples of changes to include:

- New CLI commands or options
- User-visible bug fixes
- Performance improvements
- Breaking changes
- Fixes affecting installation methods (npx/brew, etc.)

---

## Step 4: Commit & Push

### 4.1 Stage Changes

Stage `.bmp.yml` (the SSoT), everything `bmp` rewrote (the five npm manifests,
the three Cargo crates, and `pnpm-lock.yaml`), the `rust/Cargo.lock` refreshed by
Cargo, and both changelog files. Review `git status` first, then stage the
release-related files:

```bash
git add .bmp.yml \
  package.json \
  packages/npm/package.json \
  packages/vibe-linux-x64/package.json packages/vibe-linux-arm64/package.json \
  packages/vibe-darwin-x64/package.json packages/vibe-darwin-arm64/package.json \
  packages/vibe-win32-x64/package.json \
  rust/crates/vibe/Cargo.toml rust/crates/vibe-core/Cargo.toml rust/crates/vibe-test-support/Cargo.toml \
  rust/Cargo.lock \
  pnpm-lock.yaml \
  packages/docs/src/content/docs/changelog.mdx packages/docs/src/content/docs/ja/changelog.mdx
```

**First bmp adoption only:** if this release created `deno.lock` for the first
time (see the first-run note in Step 3.2), also `git add deno.json deno.lock` —
CI's `pnpm run bmp` runs with `--frozen` and fails without the committed lock.

### 4.2 Create Commit

```bash
git commit -m "chore: release vX.Y.Z"
```

### 4.3 Push

```bash
git push -u origin release/vX.Y.Z
```

---

## Step 5: Create PR (release → develop)

### 5.1 Create PR

```bash
gh pr create --base develop --title "chore: release vX.Y.Z" --body "$(cat <<'EOF'
## Summary

- Release version X.Y.Z

## Checklist

- [ ] Version updated in package.json
- [ ] Version synced to all package.json files
- [ ] Changelog updated (packages/docs/src/content/docs/changelog.mdx)
- [ ] CI checks passing

---

After merging this PR:
1. Create a PR from `develop` to `main`
2. Merge the `develop` → `main` PR
3. Run the Release workflow (`gh workflow run release.yml --ref main`)
4. The workflow builds the binaries, publishes the GitHub Release (tag `vX.Y.Z`), and npm publish follows automatically
EOF
)"
```

### 5.2 Guide User

Display the PR URL and inform the user:

1. Review and merge the PR
2. After merging, Step 6 will create the `develop` → `main` PR

**Note**: Wait until the PR is merged. After merging, invoke `/vibe-release-new-version` again or manually execute Step 6.

---

## Step 6: Create develop → main PR (after release PR merge)

After the release PR is merged into develop, execute the following:

### 6.1 Switch to develop branch

```bash
git checkout develop
git pull origin develop
```

### 6.2 Create PR

```bash
gh pr create --base main --head develop --title "chore: merge develop into main for vX.Y.Z" --body "$(cat <<'EOF'
## Summary

- Merge develop into main for release vX.Y.Z

---

After merging this PR:
1. Run the Release workflow (`gh workflow run release.yml --ref main`)
2. The workflow builds the binaries, publishes the GitHub Release (tag `vX.Y.Z`), and npm publish follows automatically
EOF
)"
```

### 6.3 Enable auto-merge, with the admin fallback for BEHIND

```bash
gh pr merge <pr> --auto --merge
```

**Known gotcha (hit in v3.0.0):** this PR's head (develop) is always BEHIND main
— main carries the previous releases' merge commits that develop does not have —
and with "require branches to be up to date" protection, auto-merge then never
fires even with every check green. Check `gh pr view <pr> --json
mergeStateStatus`; if it reports `BEHIND` and all checks pass, merge with the
documented fallback:

```bash
gh pr merge <pr> --admin --merge
```

Do NOT "update branch" (merging main back into develop) to clear BEHIND — it
pollutes develop with main's merge commits for no benefit.

### 6.4 Guide User

Display the PR URL and inform the user:

1. Review and merge the PR (or let auto-merge / the admin fallback complete)
2. After merging, execute Step 7 to finalize the release

**Note**: Wait until the PR is merged. After merging, invoke `/vibe-release-new-version` again or manually execute Step 7.

---

## Step 7: Run the Release Workflow (after develop → main PR merge)

After the PR is merged, execute the following:

### 7.1 Switch to main branch

```bash
git checkout main
git pull origin main
```

### 7.2 Generate Release Notes

Get changes since the last release:

```bash
git log $(gh release list --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName')..HEAD --pretty=format:"- %s"
```

**Important: Only include end-user-facing changes**

Release notes should only contain changes that users actually experience. Exclude development process improvements, internal refactoring, and CI/CD changes.

Categorize based on Conventional Commits (user-facing changes only):

```markdown
## What's Changed

### Features

- Description of new CLI commands or options

### Bug Fixes

- Description of user-facing bug fixes

## Contributors

Thanks to all contributors for this release! 🎉

- @contributor (#PR_NUMBER)

---

## About vibe

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

- [Release vX.Y.Z](https://github.com/kexi/vibe/releases/tag/vX.Y.Z)
- [Website](https://vibe.kexi.dev)
```

**Release notes required checklist:**

- [ ] `## What's Changed` section
- [ ] `### Features` or `### Bug Fixes` (when applicable)
- [ ] `## Contributors` section (when applicable)
- [ ] `---` separator
- [ ] `## About vibe` section (required)
- [ ] Release link
- [ ] Website link

### 7.3 Run the Release Workflow

**Do NOT run `gh release create` by hand.** The Release workflow builds the
binaries first and only then creates and publishes the GitHub Release with
every asset attached — the order Immutable Releases requires (a published
release's tag and assets are frozen, so assets can never be added afterwards).

Save the release notes generated in Step 7.2 to a file, then dispatch the
workflow on main:

```bash
cat > /tmp/release-notes.md <<'EOF'
## What's Changed

### Features
- feat: feature description

### Bug Fixes
- fix: bug fix description

## Contributors

Thanks to all contributors for this release! 🎉

* @contributor (#PR_NUMBER)

---

## About vibe

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

- [Release vX.Y.Z](https://github.com/kexi/vibe/releases/tag/vX.Y.Z)
- [Website](https://vibe.kexi.dev)
EOF

gh workflow run release.yml --ref main -F notes=@/tmp/release-notes.md
```

**Note:** Replace the notes content above with the release notes generated in Step 7.2.

**Rehearse first (recommended, mandatory for majors):** the workflow's
`dry_run` input builds everything, verifies a draft release, then deletes it
without publishing — the tag is never burned. Immutable Releases means a failed
real run cannot be retried under the same version, so the rehearsal is cheap
insurance (used successfully for v3.0.0):

```bash
gh workflow run release.yml --ref main -f dry_run=true
# wait for success, then dispatch the real run as above
```

Watch the run until it finishes, then confirm the release is published. Wait
(max ~3 minutes) for the fresh (not yet completed) run so a stale earlier run
is never watched:

```bash
tries=0
until RUN_ID=$(gh run list --workflow=release.yml --limit 1 \
  --json databaseId,status --jq '.[0] | select(.status != "completed") | .databaseId') \
  && [ -n "$RUN_ID" ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "error: no new release.yml run appeared" >&2; exit 1; }
  sleep 3
done
gh run watch "$RUN_ID" --exit-status
gh release view vX.Y.Z --json tagName,isDraft,isPrerelease
```

The workflow reads the version from `package.json` on main (no version
argument). It refuses to run off main, on a non-stable version, or when the
tag already exists without a release. Re-running a failed run is safe: an
already-published release short-circuits, and npm publish (publish-npm.yml)
re-fires with its own idempotency guards.

To heal a post-publish mirror failure (e.g. update-homebrew), **re-run the
original run** — either "Re-run failed jobs" or "Re-run all jobs" works. Once
the release is published, `prepare` reports `should_release=false`, which now
resumes instead of skipping: the `release` job's re-check exits before touching
the release, its verify step re-asserts the full published asset set, and
`update-homebrew` downloads the published binaries and converges the tap
(idempotent — it commits only when the formula content actually differs).

Re-run promptly, though: `update-homebrew` skips with a `::warning::` once the
release is no longer the latest stable, so re-running an old run after a newer
release shipped will not roll `Formula/vibe.rb` back — but it also will not
repair that old release's tap entry. Fix the tap by hand in that case.

**Do not dispatch a fresh run to recover.** `prepare` binds a resume to the
commit the published release targets: if main has moved past that commit, a
fresh dispatch fails with `::error::Release vX.Y.Z targets <sha> but this run
is on <sha>` and exits 1, because hashing the old released binaries into a
formula built from a newer tree would silently corrupt the tap.

**A run that never published cannot be resurrected later.** `prepare` also
refuses any version older than the newest existing stable release
(`::error::refusing to release X: Y is already released`), and the `release`
job re-asserts that immediately before `gh release edit --draft=false --latest`
moves the pointer. Without it, re-running an old unpublished run would publish
that old version as latest, and `update-homebrew`'s `isLatest` check — which
reads GitHub's pointer *after* that edit — would happily mirror it. Nothing is
built or tagged when this fires; dispatch a fresh release for the current
version instead.

`publish-npm.yml` publishes with an explicit `--tag`: `latest` only when the
version is at least the registry's current `latest`, otherwise `previous`. A
re-fired `workflow_run` for an old release therefore leaves `npm install
@kexi/vibe` resolving the newest version, while the older bytes stay
installable by exact version.

### 7.4 Generate Twitter Post Text

Generate Twitter post text for the release announcement. Include Twitter mentions to thank contributors.

#### 7.4.1 Get Contributor Information

Get contributors since the last release:

```bash
# Get previous tag
PREV_TAG=$(gh release list --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName')

# Get repository owner
REPO_OWNER=$(gh repo view --json owner --jq '.owner.login')

# Get contributors (excluding owner and bots — dependabot[bot] etc. get no thanks mention)
gh api "repos/kexi/vibe/compare/${PREV_TAG}...HEAD" \
  --jq "[.commits[].author.login] | unique | map(select(. != \"${REPO_OWNER}\" and (endswith(\"[bot]\") | not))) | .[]"
```

#### 7.4.2 Extract Twitter User IDs

Get each contributor's Twitter account in the following priority order:

**1. From GitHub API (preferred):**

```bash
# Execute for each contributor
gh api "users/{username}" --jq '.twitter_username // empty'
```

**2. Fallback to CLAUDE.md People section:**

If `twitter_username` is not available from the GitHub API, check the `## People` section in the project's `CLAUDE.md` and `~/.claude/CLAUDE.md`.

Mapping format: `GitHub: {username} → Twitter: @{handle}`

Example: `GitHub: 7tsuno → Twitter: @7_tsuno` → Use `@7_tsuno` for GitHub user `7tsuno`

**Error handling:**

| Scenario                                         | Action                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| No previous tag exists                           | Skip mention feature                                                           |
| GitHub API call fails                            | Try CLAUDE.md fallback; if that also fails, warn and continue without mentions |
| 0 contributors                                   | Continue without mentions                                                      |
| No Twitter username from either API or CLAUDE.md | Use template without mentions                                                  |

#### 7.4.3 Generate Twitter Post Template

**Mention handling rules:**

| Number of mentions      | Action                        |
| ----------------------- | ----------------------------- |
| 0                       | Use template without mentions |
| 1-2 (~50 chars or less) | Include in main tweet         |
| 3 or more               | Separate as a reply tweet     |

**Required elements:**

- vibe description (super fast Git worktree management tool with Copy-on-Write optimization)
- Key changes
- Thanks to contributors (when applicable)
- Link to release page
- Hashtags

**Do not include:**

- Installation instructions (omit)
- Website link (omit)

**English version (main, with mentions):**

```
🎉 vibe vX.Y.Z released!

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

✨ Highlights:
- Summary of new features/fixes (1-3 lines)

🙏 Thanks to @contributor!

🔗 https://github.com/kexi/vibe/releases/tag/vX.Y.Z

#vibe #git #worktree #devtools
```

**When 3 or more contributors (reply tweet):**

Do not include mentions in the main tweet. Post the following as a reply:

```
🙏 Special thanks to our contributors:
@contributor1 @contributor2 @contributor3 @contributor4

Your contributions make vibe better! 🎉
```

**Note:** Be mindful of the 280 character limit. Adjust the summary as needed.

### 7.5 Refresh flake.nix binary hashes (post-release PR)

The four `platforms.*.hash` fixed-output hashes in `flake.nix` live OUTSIDE
`flake.lock` and must be bumped by hand after every release (the version itself
derives from `package.json` and needs no edit; there is no automation in
release.yml despite an old comment in `flake.nix` suggesting otherwise). Added
after v3.0.0, where this was done as PR #576.

```bash
git checkout -b chore/flake-hashes-vX.Y.Z origin/develop
for a in vibe-linux-x64 vibe-linux-arm64 vibe-darwin-x64 vibe-darwin-arm64; do
  nix store prefetch-file --json \
    "https://github.com/kexi/vibe/releases/download/vX.Y.Z/$a" | jq -r "\"$a \" + .hash"
done
# Edit the four platforms.*.hash values in flake.nix, then verify for real:
nix build .#binary --no-link   # must exit 0
```

Commit, open a PR to develop, and merge it like any other change.

### 7.6 Cleanup

Delete the release branch:

```bash
git branch -d release/vX.Y.Z
git push origin --delete release/vX.Y.Z
```

---

## Safety Checks

| Check              | Condition                     | On Failure     |
| ------------------ | ----------------------------- | -------------- |
| Clean working tree | No uncommitted changes        | **Abort**      |
| Correct branch     | On develop branch             | Warn & confirm |
| Remote sync        | In sync with origin/develop   | Warn & confirm |
| Version format     | Semantic versioning compliant | **Abort**      |
| Tag duplicate      | Tag does not already exist    | **Abort**      |

The tag-duplicate and version-format checks are re-enforced by the Release
workflow's `prepare` job, so a stale local check cannot slip through.

---

## Automated CI

Releasing is workflow-first (Immutable Releases-safe): a GitHub Release is
never a trigger, it is the *output* of the Release workflow.

- `release.yml` (dispatched via Step 7.3): builds the binaries and `.deb`s,
  then creates the GitHub Release as a **draft** with all assets attached,
  verifies it, and only then publishes with `gh release edit --draft=false`
  (the tag is burned only after verification passes — a failed check leaves
  nothing published). Since PR #582 the assets also include `LICENSE` and
  `THIRD-PARTY-LICENSES.md` taken from the release commit (9 assets total:
  5 binaries + 2 `.deb` + 2 license documents), and
  `scripts/verify-release-assets.ts` asserts they are present, non-empty, and
  fully uploaded — a missing license document fails the run instead of
  shipping a bare-binary release
- `publish-npm.yml` (fires automatically via `workflow_run` after `release.yml`
  succeeds): npm publish (the launcher shim + the per-platform binary packages)

JSR publishing was removed with the dead TypeScript distribution in Phase 6.

---

## Known Limitations

Areas the skill intentionally leaves to executor judgement (do not silently auto-decide):

- **BREAKING change placement in changelog**: Keep a Changelog interpretation varies. When a `feat!:` / `BREAKING CHANGE:` exists, the executor may place it under `### Changed` (with a `**BREAKING:**` prefix), `### Removed`, or `### Deprecated` based on what changed. Pick one consistently within a single release entry.
- **Changelog i18n sync**: This skill only edits `packages/docs/src/content/docs/changelog.mdx`. The Japanese and Simplified Chinese counterparts (`ja/changelog.mdx`, `zh/changelog.mdx`) must be kept in sync per `.claude/rules/docs-i18n.md` — `pnpm run check:i18n` (wired into `check:all`) fails on a missing counterpart. Handle them as separate edits before staging in Step 4.1 (and add them to the `git add` list).
