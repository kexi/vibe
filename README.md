# vibe

A CLI tool for easy Git Worktree management.

[日本語](README.ja.md)

## Installation

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### Linux

> **Note**: WSL2 users can use the Linux installation methods below based on their distribution.

#### Ubuntu/Debian (.deb package)

```bash
# x64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_amd64.deb
sudo apt install ./vibe_amd64.deb

# ARM64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_arm64.deb
sudo apt install ./vibe_arm64.deb

# Uninstall
sudo apt remove vibe
```

#### Other Linux distributions

```bash
# x64
curl -L https://github.com/kexi/vibe/releases/latest/download/vibe-linux-x64 -o vibe
chmod +x vibe
sudo mv vibe /usr/local/bin/

# ARM64
curl -L https://github.com/kexi/vibe/releases/latest/download/vibe-linux-arm64 -o vibe
chmod +x vibe
sudo mv vibe /usr/local/bin/
```

### Windows

```powershell
# Download
Invoke-WebRequest -Uri "https://github.com/kexi/vibe/releases/latest/download/vibe-windows-x64.exe" -OutFile "$env:LOCALAPPDATA\vibe.exe"

# Add to PATH (first time only)
$path = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$path;$env:LOCALAPPDATA", "User")
```

### Manual Build

```bash
deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts
```

## Setup

### Option A: Using `shell = true` (Recommended)

Add `shell = true` to your `.vibe.toml`:

```toml
shell = true
```

This spawns your `$SHELL` directly in the worktree directory. No shell configuration needed.

### Option B: Using shell wrapper

If you don't use `shell = true`, add the following to your shell configuration:

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
<summary>Nushell (~/.config/nushell/config.nu)</summary>

```nu
def --env vibe [...args] {
    ^vibe ...$args | lines | each { |line| nu -c $line }
}
```
</details>

<details>
<summary>PowerShell ($PROFILE)</summary>

```powershell
function vibe { Invoke-Expression (& vibe.exe $args) }
```
</details>

## Usage

| Command                      | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `vibe start <branch>`        | Create a new worktree with a new branch             |
| `vibe start <branch> --reuse`| Create a worktree using an existing branch          |
| `vibe clean`                 | Delete current worktree and return to main          |
| `vibe trust`                 | Trust `.vibe.toml` and `.vibe.local.toml` files     |
| `vibe untrust`               | Untrust `.vibe.toml` and `.vibe.local.toml` files   |

### Examples

```bash
# Create a worktree with a new branch
vibe start feat/new-feature

# Use an existing branch
vibe start feat/existing-branch --reuse

# After work is done, delete the worktree
vibe clean
```

## Configuration

### .vibe.toml

Place a `.vibe.toml` file in the repository root to automatically run tasks on
`vibe start`. This file is typically committed to git and shared with the team.

```toml
# Spawn user's $SHELL in worktree (no eval wrapper needed)
shell = true

# Copy files from origin repository to worktree
[copy]
files = [".env"]

# Commands to run after worktree creation
[hooks]
pre_start = ["echo 'Preparing worktree...'"]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
pre_clean = ["git stash"]
post_clean = ["echo 'Cleanup complete'"]
```

Trust registration is required on first use with `vibe trust`.

### Security: Hash Verification

Vibe automatically verifies the integrity of `.vibe.toml` and `.vibe.local.toml` files using SHA-256 hashes. This prevents unauthorized modifications to configuration files.

#### How it works
- When you run `vibe trust`, Vibe calculates and stores the SHA-256 hash of the configuration files
- When you run `vibe start`, Vibe verifies the file hasn't been modified by checking the hash
- If the hash doesn't match, Vibe exits with an error and asks you to run `vibe trust` again

#### Skip hash check (for development)
You can disable hash verification in your settings file (`~/.config/vibe/settings.json`):

**Global setting:**
```json
{
  "version": 2,
  "skipHashCheck": true,
  "permissions": { "allow": [], "deny": [] }
}
```

**Per-file setting:**
```json
{
  "version": 2,
  "permissions": {
    "allow": [
      {
        "path": "/path/to/.vibe.toml",
        "hashes": ["abc123..."],
        "skipHashCheck": true
      }
    ],
    "deny": []
  }
}
```

#### Branch switching
Vibe stores multiple hashes per file (up to 100), so you can switch between branches without needing to re-trust files (as long as you've trusted each branch's version at least once).

### .vibe.local.toml

Create a `.vibe.local.toml` file for local-only configuration overrides that
won't be committed to git (automatically gitignored). This is useful for
developer-specific settings.

```toml
# Override or extend shared hooks with local commands
[hooks]
post_start_prepend = ["echo 'Local setup starting'"]
post_start_append = ["npm run dev"]

# Override files to copy
[copy]
files = [".env.local", ".secrets"]
```

### Configuration Merging

When both `.vibe.toml` and `.vibe.local.toml` exist:

- **Complete override**: Use the field name directly (e.g., `post_start = [...]`)
- **Prepend items**: Use `_prepend` suffix (e.g., `post_start_prepend = [...]`)
- **Append items**: Use `_append` suffix (e.g., `post_start_append = [...]`)

**Example:**

```toml
# .vibe.toml (shared)
[hooks]
post_start = ["npm install", "npm run build"]

# .vibe.local.toml (local)
[hooks]
post_start_prepend = ["echo 'local setup'"]
post_start_append = ["npm run dev"]

# Result: ["echo 'local setup'", "npm install", "npm run build", "npm run dev"]
```

### Configuration Options

| Option  | Type    | Description                                           |
| ------- | ------- | ----------------------------------------------------- |
| `shell` | boolean | If `true`, spawns `$SHELL` in the worktree directory  |

### Available Hooks

| Hook         | When                                              | Environment Variables Available           |
| ------------ | ------------------------------------------------- | ----------------------------------------- |
| `pre_start`  | Before worktree creation                          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `post_start` | After worktree creation                           | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `pre_clean`  | Before worktree removal (in current worktree)     | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `post_clean` | After worktree removal (in main repository)       | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |

**Note**: `post_clean` hooks are appended to the removal command with `&&`, executing in the main repository directory after the `git worktree remove` command completes.

### Environment Variables

The following environment variables are available in all hook commands:

| Variable             | Description                              |
| -------------------- | ---------------------------------------- |
| `VIBE_WORKTREE_PATH` | Absolute path to the created worktree    |
| `VIBE_ORIGIN_PATH`   | Absolute path to the original repository |

## Development

### Available Tasks

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

### Running CI Checks Locally

Before pushing, run the same checks that CI will run:

```bash
deno task ci
```

This runs:
1. Format check (`deno task fmt:check`)
2. Linter (`deno task lint`)
3. Type check (`deno task check`)
4. Tests (`deno task test`)

## License

Apache-2.0
