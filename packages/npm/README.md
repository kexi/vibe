# vibe

A CLI tool for easy Git Worktree management.

## Installation

```bash
# Global install
npm install -g @kexi/vibe

# Or run directly with npx
npx @kexi/vibe start feat/my-feature
```

> **Note**: The npm package includes optional native bindings (`@kexi/vibe-native`) for optimized Copy-on-Write file cloning on macOS (APFS) and Linux (Btrfs/XFS). These are automatically used when available.

### Other Installation Methods

For alternative installation options (Homebrew, Deno, mise, Linux packages, Windows), see the [GitHub repository](https://github.com/kexi/vibe#installation).

## Documentation

Full documentation is available at [vibe.kexi.dev](https://vibe.kexi.dev)

## Usage

| Command                      | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `vibe start <branch>`        | Create a worktree with a new or existing branch (idempotent) |
| `vibe clean`                 | Delete current worktree and return to main (prompts if uncommitted changes exist) |
| `vibe trust`                 | Trust `.vibe.toml` and `.vibe.local.toml` files     |
| `vibe untrust`               | Untrust `.vibe.toml` and `.vibe.local.toml` files   |

### Examples

```bash
# Create a worktree with a new branch
vibe start feat/new-feature

# Use an existing branch (or re-run if worktree already exists)
vibe start feat/existing-branch

# After work is done, delete the worktree
vibe clean
```

### Global Options

| Option            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `-h`, `--help`    | Show help message                                  |
| `-v`, `--version` | Show version information                           |
| `-V`, `--verbose` | Show detailed output                               |
| `-q`, `--quiet`   | Suppress non-essential output                      |
| `-n`, `--dry-run` | Preview operations without executing (start only)  |

## Setup

Add the following to your shell configuration:

<details>
<summary>Zsh (.zshrc)</summary>

```bash
vibe() { eval "$(command vibe "$@")" }
```
</details>

<details>
<summary>Bash (.bashrc)</summary>

```bash
vibe() { eval "$(command vibe "$@")"; }
```
</details>

<details>
<summary>Fish (~/.config/fish/config.fish)</summary>

```fish
function vibe
    eval (command vibe $argv)
end
```
</details>

<details>
<summary>PowerShell ($PROFILE)</summary>

```powershell
function vibe { Invoke-Expression (& vibe.exe $args) }
```
</details>

## Configuration

Place a `.vibe.toml` file in the repository root to automatically run tasks on `vibe start`:

```toml
# Copy files and directories from origin repository to worktree
[copy]
files = [".env"]
dirs = ["node_modules", ".cache"]

# Commands to run after worktree creation
[hooks]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
```

Trust registration is required on first use with `vibe trust`.

For detailed configuration options including:
- Glob patterns for file copying
- Copy performance optimization (Copy-on-Write)
- Worktree path customization
- Security and hash verification
- Local configuration overrides

See the [full documentation](https://vibe.kexi.dev).

## License

Apache-2.0
