# vibe

A CLI tool for easy Git Worktree management.

[日本語](README.ja.md)

## Documentation

📚 Full documentation is available at [vibe.kexi.dev](https://vibe.kexi.dev)

## Usage

| Command                      | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `vibe start <branch> [--base <ref>]` | Create a worktree with a new or existing branch (idempotent) |
| `vibe clean`                 | Delete current worktree and return to main (prompts if uncommitted changes exist) |
| `vibe trust`                 | Trust `.vibe.toml` and `.vibe.local.toml` files     |
| `vibe untrust`               | Untrust `.vibe.toml` and `.vibe.local.toml` files   |

### Examples

```bash
# Create a worktree with a new branch
vibe start feat/new-feature

# Use an existing branch (or re-run if worktree already exists)
vibe start feat/existing-branch

# Create a worktree from a specific base branch
vibe start feat/new-feature --base main

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

### Base Branch Option

The `--base` option specifies the starting point for a new branch:

- **New branch**: Creates the branch from the specified base (branch, tag, or commit)
- **Existing branch**: The `--base` option is ignored with a warning
- **Invalid base**: Exits with an error if the specified ref doesn't exist

### Cleanup Behavior

`vibe clean` uses a fast removal strategy that moves the worktree directory instead of deleting it synchronously:

- **macOS**: Items are moved to the system Trash via Finder (can be recovered if needed)
- **Linux**: Items are moved to XDG Trash when using Node.js runtime (recoverable from file manager). Falls back to temporary directory on Deno.
- **Windows**: Items are moved to a temporary directory and deleted in the background

This approach allows `vibe clean` to complete instantly regardless of worktree size.

### Global Options

| Option            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `-h`, `--help`    | Show help message                                  |
| `-v`, `--version` | Show version information                           |
| `-V`, `--verbose` | Show detailed output                               |
| `-q`, `--quiet`   | Suppress non-essential output                      |
| `-n`, `--dry-run` | Preview operations without executing (start only)  |

## Installation

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### npm (Node.js 18+)

```bash
# Global install
npm install -g @kexi/vibe

# Or run directly with npx
npx @kexi/vibe start feat/my-feature
```

> Note: The npm package includes optional native bindings (`@kexi/vibe-native`) for optimized Copy-on-Write file cloning on macOS (APFS) and Linux (Btrfs/XFS). These are automatically used when available.

### Bun (1.2.0+)

```bash
# Global install
bun add -g @kexi/vibe

# Or run directly with bunx
bunx @kexi/vibe start feat/my-feature
```

> Note: Bun uses the same npm package as Node.js. Native bindings for Copy-on-Write file cloning are automatically used when available.

### Deno (JSR)

```bash
deno install -A --global jsr:@kexi/vibe
```

**Permissions**: For more security, you can specify exact permissions instead of `-A`:

```bash
deno install --global --allow-run --allow-read --allow-write --allow-env jsr:@kexi/vibe
```

> Note: Copy-on-Write file cloning on macOS (APFS) and Linux (Btrfs/XFS) is enabled automatically via the N-API native module when available.

### mise

Add to your `.mise.toml`:

```toml
[plugins]
vibe = "https://github.com/kexi/mise-vibe"

[tools]
vibe = "latest"
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

#### Copy Performance Optimization

Vibe automatically selects the best copy strategy based on your system:

| Strategy | When Used | Platform |
|----------|-----------|----------|
| Clone (CoW) | Directory copy on APFS | macOS |
| Clone (reflink) | Directory copy on Btrfs/XFS | Linux |
| rsync | Directory copy when clone unavailable | macOS/Linux |
| Standard | File copy, or fallback | All |

**How it works:**
- **File copy**: Always uses Deno's native `copyFile()` for best single-file performance
- **Directory copy**: Automatically uses the fastest available method:
  - On macOS with APFS: Uses `cp -cR` for Copy-on-Write cloning (near-instant)
  - On Linux with Btrfs/XFS: Uses `cp --reflink=auto` for CoW cloning
  - Falls back to rsync or standard copy if CoW is unavailable

**Benefits:**
- Copy-on-Write is extremely fast as it only copies metadata, not actual data
- No configuration needed - the best strategy is auto-detected
- Automatic fallback ensures copying always works

For detailed information about copy strategies and implementation, see [Copy Strategies](docs/specifications/copy-strategies.md).

### Worktree Path Configuration

Customize the worktree directory path using an external script:

```toml
[worktree]
path_script = "~/.config/vibe/worktree-path.sh"
```

The script receives these environment variables and should output an absolute path:

| Variable | Description | Example |
|----------|-------------|---------|
| `VIBE_REPO_NAME` | Repository name | `my-project` |
| `VIBE_BRANCH_NAME` | Branch name | `feat/new-feature` |
| `VIBE_SANITIZED_BRANCH` | Sanitized branch name (`/` → `-`) | `feat-new-feature` |
| `VIBE_REPO_ROOT` | Repository root path | `/path/to/repo` |

**Example script:**

```bash
#!/bin/bash
echo "${HOME}/worktrees/${VIBE_REPO_NAME}-${VIBE_SANITIZED_BRANCH}"
```

### Editor Support (JSON Schema)

Vibe provides JSON Schema for `settings.json` with autocompletion and validation. The `$schema` property is **automatically added** when vibe saves the settings file. Most modern editors (VS Code, IntelliJ, etc.) will automatically provide autocompletion.

For manual VS Code configuration, see the [settings.json documentation](https://vibe.kexi.dev/configuration/settings/#json-schema).

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

#### Security Considerations

The trust mechanism verifies that configuration files haven't been modified since you trusted them. However, please note:

- **Trust is a declaration of intent**: When you run `vibe trust`, you are declaring that you have reviewed and approved the configuration files, including any hook commands they contain.
- **Hooks execute arbitrary commands**: Commands defined in `hooks.pre_start`, `hooks.post_start`, etc. are executed in your shell. Vibe does not sandbox or restrict what these commands can do.
- **Review before trusting**: Always review `.vibe.toml` and `.vibe.local.toml` files before running `vibe trust`, especially in repositories you don't control.
- **Hash verification is not malware protection**: The hash check only detects changes to files you've already trusted. It does not evaluate whether the commands themselves are safe.

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
