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

## Supported Platforms

### OS

| OS      | Architectures   | Notes                          |
| ------- | --------------- | ------------------------------ |
| macOS   | x64, ARM64      | Homebrew available             |
| Linux   | x64, ARM64      | .deb package available (Ubuntu/Debian) |
| Windows | x64             | PowerShell installation        |

WSL2 is supported via Linux binaries.

### Filesystem (Copy-on-Write Optimization)

| Filesystem | Platform | CoW Support |
| ---------- | -------- | ----------- |
| APFS       | macOS    | Yes         |
| Btrfs      | Linux    | Yes         |
| XFS        | Linux    | Yes         |
| Others     | All      | Fallback to standard copy |

### Shell

- Zsh
- Bash
- Fish
- Nushell
- PowerShell

## Development Environment

- Runtime: Deno v2.x (setup with `mise install`)
- Run: `deno run --allow-run --allow-read --allow-write --allow-env main.ts`
- Compile:
  `deno compile --allow-run --allow-read --allow-write --allow-env --allow-ffi --output vibe main.ts`

## CLI Guidelines

- Follow [GNU Coding Standards](https://www.gnu.org/prep/standards/) for command-line interface design
  - Support `--help` and `--version` options
  - Use long options with `--` prefix (e.g., `--verbose`)
  - Use short options with `-` prefix (e.g., `-v`)

## Coding Guidelines

### SOLID Principles

Code should follow SOLID principles:

- **S**ingle Responsibility Principle: A class or function should have only one
  reason to change
- **O**pen/Closed Principle: Open for extension, closed for modification
- **L**iskov Substitution Principle: Subtypes must be substitutable for their
  base types
- **I**nterface Segregation Principle: Clients should not be forced to depend on
  methods they do not use
- **D**ependency Inversion Principle: High-level modules should not depend on
  low-level modules; both should depend on abstractions

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
