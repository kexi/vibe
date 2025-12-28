# Contributing

## Development Setup

```bash
mise install
```

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
