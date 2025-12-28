# vibe

A CLI tool for easy Git Worktree management.

[日本語](README.ja.md)

## Installation

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### Linux

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

| Command                      | Description                                |
| ---------------------------- | ------------------------------------------ |
| `vibe start <branch>`        | Create a new worktree with a new branch    |
| `vibe start <branch> --reuse`| Create a worktree using an existing branch |
| `vibe clean`                 | Delete current worktree and return to main |
| `vibe trust`                 | Trust the `.vibe.toml` file                |

### Examples

```bash
# Create a worktree with a new branch
vibe start feat/new-feature

# Use an existing branch
vibe start feat/existing-branch --reuse

# After work is done, delete the worktree
vibe clean
```

## .vibe.toml

Place a `.vibe.toml` file in the repository root to automatically run tasks on
`vibe start`.

```toml
# Spawn user's $SHELL in worktree (no eval wrapper needed)
shell = true

# Copy files from origin repository to worktree
[copy]
files = [".env", ".env.local"]

# Commands to run after worktree creation
[hooks]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
```

Trust registration is required on first use with `vibe trust`.

### Configuration Options

| Option  | Type    | Description                                      |
| ------- | ------- | ------------------------------------------------ |
| `shell` | boolean | If `true`, spawns `$SHELL` in the worktree directory |

### Available Environment Variables

The following environment variables are available in `hooks.post_start`
commands:

| Variable             | Description                              |
| -------------------- | ---------------------------------------- |
| `VIBE_WORKTREE_PATH` | Absolute path to the created worktree    |
| `VIBE_ORIGIN_PATH`   | Absolute path to the original repository |

## License

Apache-2.0
