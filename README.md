# vibe

A CLI tool for easy Git Worktree management.

[日本語](README.ja.md)

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

### Interactive Prompts

`vibe start` handles the following situations:

- **When a branch is already in use by another worktree**: Confirms whether to navigate to the existing worktree
- **When the same worktree already exists**: Automatically re-uses it (idempotent)
- **When a directory exists with a different branch**: You can choose from the following options
  - Overwrite (delete and recreate)
  - Reuse (use existing directory)
  - Cancel

```bash
# Example when branch is already in use
$ vibe start feat/new-feature
Branch 'feat/new-feature' is already in use by worktree '/path/to/repo-feat-new-feature'.
Navigate to the existing worktree? (Y/n)
```

## Installation

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### Deno (JSR)

```bash
deno install -A --global jsr:@kexi/vibe
```

**Permissions**: For more security, you can specify exact permissions instead of `-A`:

```bash
deno install --global --allow-run --allow-read --allow-write --allow-env jsr:@kexi/vibe
```

**Using with mise**: Add to your `.mise.toml`:

```toml
[tools]
"jsr:@kexi/vibe" = "latest"
```

Then run:

```bash
mise install
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

### Windows (PowerShell)

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

## Configuration

### .vibe.toml

Place a `.vibe.toml` file in the repository root to automatically run tasks on
`vibe start`. This file is typically committed to git and shared with the team.

```toml
# Copy files and directories from origin repository to worktree
[copy]
files = [".env"]
dirs = ["node_modules", ".cache"]

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

#### Glob Patterns in Copy Configuration

The `files` array supports glob patterns for flexible file selection:

```toml
[copy]
files = [
  "*.env",              # All .env files in root
  "**/*.json",          # All JSON files recursively
  "config/*.txt",       # All .txt files in config/
  ".env.production"     # Exact paths still work
]
```

**Supported patterns:**
- `*` - Matches any characters except `/`
- `**` - Matches any characters including `/` (recursive)
- `?` - Matches any single character
- `[abc]` - Matches any character in brackets

**Notes:**
- Directory structure is preserved when copying matched files
- Recursive patterns (`**/*`) may be slower in large repositories
  - Use specific patterns when possible (e.g., `config/**/*.json` instead of `**/*.json`)
  - Pattern expansion happens once during worktree creation, not on every command

#### Directory Copy Configuration

The `dirs` array copies entire directories recursively:

```toml
[copy]
dirs = [
  "node_modules",      # Exact directory path
  ".cache",            # Hidden directories
  "packages/*"         # Glob pattern for multiple directories
]
```

**Notes:**
- Directories are fully copied (not incrementally synced)
- Glob patterns work the same as file patterns
- Large directories like `node_modules` may take time to copy

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
  "version": 3,
  "skipHashCheck": true,
  "permissions": { "allow": [], "deny": [] }
}
```

**Per-file setting:**
```json
{
  "version": 3,
  "permissions": {
    "allow": [
      {
        "repoId": {
          "remoteUrl": "github.com/user/repo",
          "repoRoot": "/path/to/repo"
        },
        "relativePath": ".vibe.toml",
        "hashes": ["abc123..."],
        "skipHashCheck": true
      }
    ],
    "deny": []
  }
}
```

> **Note**: Version 3 uses repository-based trust identification. Settings are automatically migrated from v2 to v3 on first load. Trust is shared across all worktrees of the same repository.

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

### Available Hooks

| Hook         | When                                              | Environment Variables Available           |
| ------------ | ------------------------------------------------- | ----------------------------------------- |
| `pre_start`  | Before worktree creation                          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `post_start` | After worktree creation                           | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `pre_clean`  | Before worktree removal (in current worktree)     | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |
| `post_clean` | After worktree removal (in main repository)       | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`  |

**Note**: `post_clean` hooks are appended to the removal command with `&&`, executing in the main repository directory after the `git worktree remove` command completes.

### Hook Output Behavior

Vibe displays a real-time progress tree during hook execution to show task status. Hook output is handled differently depending on the context:

- **When progress display is active**: Hook stdout is suppressed to keep the progress tree clean and avoid visual clutter. Only the progress tree is shown.
- **When progress display is not active**: Hook stdout is written to stderr (to avoid interfering with shell wrapper `eval`).
- **Failed hooks**: stderr output is ALWAYS shown regardless of progress display, to help with debugging.

Example progress display:
```
✶ Setting up worktree feature/new-ui…
┗ ☒ Pre-start hooks
   ┗ ☒ npm install
     ☒ cargo build --release
  ⠋ Copying files
   ┗ ⠋ .env.local
     ☐ node_modules/
```

**Note**: Progress display auto-disables in non-TTY environments (e.g., CI/CD), and hook output will be shown normally.

### Environment Variables

The following environment variables are available in all hook commands:

| Variable             | Description                              |
| -------------------- | ---------------------------------------- |
| `VIBE_WORKTREE_PATH` | Absolute path to the created worktree    |
| `VIBE_ORIGIN_PATH`   | Absolute path to the original repository |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

Apache-2.0
