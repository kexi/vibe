# vibe

Git Worktreeを簡単に管理するCLIツール。

[English](README.md)

## インストール

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
# ダウンロード
Invoke-WebRequest -Uri "https://github.com/kexi/vibe/releases/latest/download/vibe-windows-x64.exe" -OutFile "$env:LOCALAPPDATA\vibe.exe"

# PATHに追加（初回のみ）
$path = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$path;$env:LOCALAPPDATA", "User")
```

### 手動ビルド

```bash
deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts
```

## セットアップ

### 方法A: `shell = true` を使用（推奨）

`.vibe.toml` に `shell = true` を追加:

```toml
shell = true
```

worktreeディレクトリで `$SHELL` を直接起動します。シェル設定は不要です。

### 方法B: シェルラッパーを使用

`shell = true` を使わない場合、シェルに以下を追加:

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

## 使い方

| コマンド                       | 説明                                       |
| ------------------------------ | ------------------------------------------ |
| `vibe start <branch>`          | 新しいブランチでworktreeを作成             |
| `vibe start <branch> --reuse`  | 既存ブランチを使用してworktreeを作成       |
| `vibe clean`                   | 現在のworktreeを削除してメインに戻る       |
| `vibe trust`                   | `.vibe.toml`ファイルを信頼登録             |

### 例

```bash
# 新しいブランチでworktreeを作成
vibe start feat/new-feature

# 既存ブランチを使用
vibe start feat/existing-branch --reuse

# 作業完了後、worktreeを削除
vibe clean
```

## .vibe.toml

リポジトリルートに`.vibe.toml`ファイルを配置すると、`vibe start`時に自動実行されます。

```toml
# worktreeで$SHELLを起動（evalラッパー不要）
shell = true

# ファイルを元リポジトリからworktreeへコピー
[copy]
files = [".env", ".env.local"]

# worktree作成後に実行するコマンド
[hooks]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
```

初回は`vibe trust`で信頼登録が必要です。

### 設定オプション

| オプション | 型      | 説明                                           |
| ---------- | ------- | ---------------------------------------------- |
| `shell`    | boolean | `true`の場合、worktreeで`$SHELL`を起動         |

### 利用可能な環境変数

`hooks.post_start`のコマンド内で以下の環境変数が使えます：

| 変数名               | 説明                         |
| -------------------- | ---------------------------- |
| `VIBE_WORKTREE_PATH` | 作成されたworktreeの絶対パス |
| `VIBE_ORIGIN_PATH`   | 元リポジトリの絶対パス       |

## ライセンス

MIT
