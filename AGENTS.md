# AGENTS.md

## Branch Strategy

| Branch    | Purpose                                        |
| --------- | ---------------------------------------------- |
| `main`    | For releases. Stable versions only.            |
| `develop` | For development. Merge target for topic branches. |

### Workflow

1. Create a topic branch from `develop`
2. After completing work, merge into `develop`
3. When releasing, merge `develop` into `main`

```
main ────●─────────────────●────
         │                 ↑
develop ─┴──●──●──●──●─────┴────
             ↑  ↑
            feat/a feat/b
```

## Development Environment

- Runtime: Deno v2.x (setup with `mise install`)
- Run: `deno run --allow-run --allow-read --allow-write --allow-env main.ts`
- Compile:
  `deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts`

## Testing

- Lint check: `deno task lint` or `deno lint`
- Format check: `deno task fmt:check` or `deno fmt --check`
- Type check: `deno task check` or `deno check main.ts`
- Run tests: `deno task test`
- Run all checks: `deno task ci` (runs fmt:check, lint, check, and test)
- All checks must pass before committing

## Documentation

- Source code comments and documentation: English
- `*.ja.md` files: Japanese

## PR Guidelines

- Title format: `<type>: <description>`
  - type: feat, fix, docs, refactor, test, chore
- PR title and description must be written in English
- Must pass `deno lint` and `deno fmt --check`
- Add or update tests for changed code

## Release

- After merging to `main`, create and publish a release on GitHub to trigger
  GitHub Actions build
- Steps:
  1. GitHub → Releases → Draft a new release
  2. Create a tag (e.g., `v0.1.0`)
  3. Write release notes and click "Publish release"
