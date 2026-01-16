# mise-vibe

[mise](https://mise.jdx.dev/) plugin for [vibe](https://github.com/kexi/vibe) - A CLI tool for easy Git Worktree management.

## Installation

```bash
mise plugin install vibe https://github.com/kexi/vibe.git#mise-plugin
```

## Usage

```bash
# Install latest version
mise install vibe@latest

# Install specific version
mise install vibe@0.8.0

# List available versions
mise ls-remote vibe

# Set global version
mise use -g vibe@latest

# Set local version (in current directory)
mise use vibe@0.8.0
```

### Using with mise.toml

Add to your project's `mise.toml`:

```toml
[tools]
vibe = "latest"
```

Or specify a version:

```toml
[tools]
vibe = "0.8.0"
```

Then run:

```bash
mise install
```

## Shell Setup

After installing vibe via mise, add the following to your shell configuration:

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

## Supported Platforms

| OS      | Architecture | Status |
|---------|-------------|--------|
| macOS   | x64 (Intel) | Supported |
| macOS   | arm64 (Apple Silicon) | Supported |
| Linux   | x64 | Supported |
| Linux   | arm64 | Supported |
| Windows | x64 | Supported |

## License

Apache-2.0
