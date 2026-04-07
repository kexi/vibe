---
globs:
  - ".github/workflows/**/*.yml"
  - ".github/actions/**/*.yml"
---

# GitHub Actions SHA Pinning

- Third-party actions must be pinned to a full commit SHA (`action@<full-sha> # vX.Y.Z` format)
- Tag-only references (`@v4`, `@v3`, etc.) are prohibited
- Local/composite actions (`uses: ./.github/actions/setup`) are exempt
- When adding a new action, write the tag first, then convert to SHA via `pinact run`
- `pinact` is installed via mise (see `.mise.toml`)
- The `pinact-verify` CI job (`pinact run --check`) automatically detects unpinned actions
