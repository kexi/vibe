# Contributing

Thank you for your interest in contributing to vibe!

## Development Setup

```bash
mise install
```

## Running vibe in Development

Source the development helper to use `vibe` command directly:

```bash
source .vibedev
vibe start feat/my-feature
vibe clean
```

Or run via deno task:

```bash
deno task dev start feat/my-feature
```

Note: The shell function uses `eval` because `vibe start` outputs shell commands for directory navigation.

## Available Tasks

All tasks are defined in `deno.json` to ensure consistency between local development and CI:

```bash
# Run all CI checks (same as CI runs)
deno task ci

# Individual checks
deno task fmt:check    # Check code formatting
deno task lint         # Run linter
deno task check        # Type check
deno task test         # Run tests

# Auto-fix formatting
deno task fmt

# Development
deno task dev          # Run in development mode
deno task compile      # Build binaries for all platforms
```

## Running CI Checks Locally

Before pushing, run the same checks that CI will run:

```bash
deno task ci
```

This runs:
1. Format check (`deno task fmt:check`)
2. Linter (`deno task lint`)
3. Type check (`deno task check`)
4. Tests (`deno task test`)

## Release Process

### Branching Model

This project follows the git-flow branching model:

- `develop` - Active development branch. All feature branches merge here.
- `main` - Stable release branch. Only receives merges from develop during releases.

See [AGENTS.md](./AGENTS.md) for detailed branching workflow.

### Releasing a New Version

1. **Prepare the release on develop:**
   ```bash
   # Ensure you're on develop and up to date
   git checkout develop
   git pull origin develop

   # Update version in deno.json
   # Update CHANGELOG if you maintain one

   # Commit version bump
   git add deno.json
   git commit -m "chore: Bump version to vX.X.X"
   git push origin develop
   ```

2. **Sync main with develop:**

   Since main branch has protection rules, you must create a pull request:

   ```bash
   # Create a sync branch from develop
   git checkout -b chore/release-vX.X.X
   git push origin chore/release-vX.X.X

   # Create PR targeting main
   gh pr create --base main --title "chore: Release vX.X.X" \
     --body "Sync main with develop for vX.X.X release"
   ```

   After the PR is merged:

3. **Create and push the tag:**
   ```bash
   # Checkout main and pull the merged changes
   git checkout main
   git pull origin main

   # Create and push the tag
   git tag vX.X.X
   git push origin vX.X.X

   # Return to develop
   git checkout develop
   ```

4. **Create the GitHub release:**
   ```bash
   gh release create vX.X.X --generate-notes
   ```

### Automated Release Tasks

When a release is created, GitHub Actions automatically:

1. Builds binaries for each platform
2. Uploads binaries to the release
3. Updates the homebrew-tap formula

### Required Secrets

The release workflow requires the `HOMEBREW_TAP_TOKEN` secret.

#### Creating a Fine-grained Personal Access Token

1. Go to https://github.com/settings/personal-access-tokens/new

2. Configure the following:
   - **Token name:** `homebrew-tap-updater`
   - **Expiration:** 90 days (or your preference)
   - **Repository access:** `Only select repositories` → `kexi/homebrew-tap`
   - **Permissions:**
     - **Contents:** Read and write

3. Click `Generate token` and copy the token

#### Setting the Secret

```bash
gh secret set HOMEBREW_TAP_TOKEN
# Paste the token when prompted
```

### Creating a Release

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --generate-notes
```

## Security Guidelines

When contributing to vibe, please keep these security considerations in mind:

### Input Validation

- Always validate user inputs, especially file paths and branch names
- Use `validatePath()` from `src/utils/copy/validation.ts` for path validation
- Check for null bytes, newlines, and shell command substitution patterns

### External Command Execution

- Use `Deno.Command` with argument arrays, not shell strings, to prevent injection
- Never pass untrusted input directly to shell commands
- The `runHooks()` function in `src/utils/hooks.ts` executes user-defined commands - this is intentional, but the trust mechanism must be respected

### Trust Mechanism

- The trust system (`src/utils/settings.ts`) uses SHA-256 hashes to verify configuration file integrity
- Trust is repository-based (identified by remote URL or repo root)
- Always require explicit user consent before executing hook commands from untrusted sources

### File Operations

- Use atomic file operations (temp file + rename) for settings to prevent corruption
- Validate paths before copy operations to prevent directory traversal
- The `TOCTOU` (time-of-check to time-of-use) pattern is addressed in `verifyTrustAndRead()`

### Reporting Security Issues

If you discover a security vulnerability, please report it by creating a private security advisory on GitHub rather than opening a public issue.
