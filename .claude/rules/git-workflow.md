# Git Workflow Rules

## Branch Strategy

- `main`: Release versions only
- `develop`: Main development branch
- Topic branches should be created from `develop`
- **IMPORTANT**: Never push directly to `main` or `develop` branches
- PRs must always target the `develop` branch

## PR/Commit Guidelines

- **IMPORTANT**: Before creating a PR, always run `pnpm run check:all` and ensure all checks pass
- **Title format**: `<type>: <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- Write in English
- Follow GNU Coding Standards
