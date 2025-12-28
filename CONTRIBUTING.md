# Contributing

Thank you for your interest in contributing to vibe!

## Development Setup

```bash
mise install
```

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
