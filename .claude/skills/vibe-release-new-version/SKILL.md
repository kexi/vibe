---
description: Release a new version of vibe (version bump, sync, PR creation)
argument-hint: "[patch|minor|major|X.Y.Z]"
allowed-tools: Bash(git *), Bash(gh *), Bash(pnpm *), Bash(bun *), Read, Edit, AskUserQuestion
context: fork
disable-model-invocation: true
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

### 3.2 Update package.json

Use the Edit tool to update the `"version"` field in the root `package.json`:

```json
"version": "X.Y.Z"
```

### 3.3 Sync Versions

```bash
bun run scripts/sync-version.ts
```

Sync targets:

- `packages/npm/package.json`
- `packages/core/package.json`
- `packages/native/package.json`
- `jsr.json`

### 3.4 Verify Sync

```bash
bun run scripts/sync-version.ts --check
```

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

```bash
git add package.json packages/npm/package.json packages/core/package.json packages/native/package.json jsr.json packages/docs/src/content/docs/changelog.mdx
```

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
3. Create a GitHub Release with tag `vX.Y.Z`
4. CI will automatically publish to npm and JSR
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
1. Create a GitHub Release with tag `vX.Y.Z`
2. CI will automatically publish to npm and JSR
EOF
)"
```

### 6.3 Guide User

Display the PR URL and inform the user:

1. Review and merge the PR
2. After merging, execute Step 7 to finalize the release

**Note**: Wait until the PR is merged. After merging, invoke `/vibe-release-new-version` again or manually execute Step 7.

---

## Step 7: Create Release (after develop → main PR merge)

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

### 7.3 Create GitHub Release

Create a release using the generated release notes:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
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
)" --target main
```

**Note:** Replace the `--notes` content above with the release notes generated in Step 7.2.

### 7.4 Generate Twitter Post Text

Generate Twitter post text for the release announcement. Include Twitter mentions to thank contributors.

#### 7.4.1 Get Contributor Information

Get contributors since the last release:

```bash
# Get previous tag
PREV_TAG=$(gh release list --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName')

# Get repository owner
REPO_OWNER=$(gh repo view --json owner --jq '.owner.login')

# Get contributors (excluding owner)
gh api "repos/kexi/vibe/compare/${PREV_TAG}...HEAD" \
  --jq "[.commits[].author.login] | unique | map(select(. != \"${REPO_OWNER}\")) | .[]"
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

### 7.5 Cleanup

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

---

## Automated CI

After PR merge, the following CI workflows run automatically:

- `release.yml`: Binary build & release asset upload
- `publish-npm.yml`: npm publish
- `publish-jsr.yml`: JSR publish

---

## Known Limitations

Areas the skill intentionally leaves to executor judgement (do not silently auto-decide):

- **BREAKING change placement in changelog**: Keep a Changelog interpretation varies. When a `feat!:` / `BREAKING CHANGE:` exists, the executor may place it under `### Changed` (with a `**BREAKING:**` prefix), `### Removed`, or `### Deprecated` based on what changed. Pick one consistently within a single release entry.
- **Changelog i18n sync**: This skill only edits `packages/docs/src/content/docs/changelog.mdx`. The Japanese counterpart `packages/docs/src/content/docs/ja/changelog.mdx` must be kept in sync per `.claude/rules/docs-i18n.md` — handle that as a separate edit before staging in Step 4.1 (and add it to the `git add` list when present).
