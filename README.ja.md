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

| コマンド                       | 説明                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `vibe start <branch>`          | 新しいブランチでworktreeを作成                        |
| `vibe start <branch> --reuse`  | 既存ブランチを使用してworktreeを作成                  |
| `vibe clean`                   | 現在のworktreeを削除してメインに戻る                  |
| `vibe trust`                   | `.vibe.toml`と`.vibe.local.toml`ファイルを信頼登録    |
| `vibe untrust`                 | `.vibe.toml`と`.vibe.local.toml`ファイルの信頼を解除  |

### 例

```bash
# 新しいブランチでworktreeを作成
vibe start feat/new-feature

# 既存ブランチを使用
vibe start feat/existing-branch --reuse

# 作業完了後、worktreeを削除
vibe clean
```

## 設定

### .vibe.toml

リポジトリルートに`.vibe.toml`ファイルを配置すると、`vibe start`時に自動実行されます。
このファイルは通常Gitにコミットされ、チームで共有されます。

```toml
# worktreeで$SHELLを起動（evalラッパー不要）
shell = true

# ファイルを元リポジトリからworktreeへコピー
[copy]
files = [".env"]

# 実行するコマンド
[hooks]
pre_start = ["echo 'Worktreeを準備中...'"]
post_start = [
  "pnpm install",
  "pnpm db:migrate"
]
pre_clean = ["git stash"]
post_clean = ["echo 'クリーンアップ完了'"]
```

初回は`vibe trust`で信頼登録が必要です。

### .vibe.local.toml

`.vibe.local.toml`ファイルを作成すると、Gitにコミットされないローカル専用の設定上書きができます（自動的にgitignoreされます）。
開発者固有の設定に便利です。

```toml
# 共有フックをローカルコマンドで上書き・拡張
[hooks]
post_start_prepend = ["echo 'ローカルセットアップ開始'"]
post_start_append = ["npm run dev"]

# コピーするファイルを上書き
[copy]
files = [".env.local", ".secrets"]
```

### 設定のマージ

`.vibe.toml`と`.vibe.local.toml`の両方が存在する場合：

- **完全上書き**: フィールド名を直接使用（例: `post_start = [...]`）
- **先頭に追加**: `_prepend`サフィックスを使用（例: `post_start_prepend = [...]`）
- **末尾に追加**: `_append`サフィックスを使用（例: `post_start_append = [...]`）

**例:**

```toml
# .vibe.toml（共有）
[hooks]
post_start = ["mise trust", "mise install"]

# .vibe.local.toml（ローカル）
[hooks]
post_start_prepend = ["echo 'ローカルセットアップ'"]
post_start_append = ["npm run dev"]

# 結果: ["echo 'ローカルセットアップ'", "mise trust", "mise install", "npm run dev"]
```

### 設定オプション

| オプション | 型      | 説明                                           |
| ---------- | ------- | ---------------------------------------------- |
| `shell`    | boolean | `true`の場合、worktreeで`$SHELL`を起動         |

### 利用可能なフック

| フック       | 実行タイミング          | 利用可能な環境変数                           |
| ------------ | ----------------------- | -------------------------------------------- |
| `pre_start`  | worktree作成前          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `post_start` | worktree作成後          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `pre_clean`  | worktree削除前          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `post_clean` | worktree削除後          | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |

### 環境変数

すべてのフックコマンド内で以下の環境変数が使えます：

| 変数名               | 説明                         |
| -------------------- | ---------------------------- |
| `VIBE_WORKTREE_PATH` | 作成されたworktreeの絶対パス |
| `VIBE_ORIGIN_PATH`   | 元リポジトリの絶対パス       |

## ライセンス

Apache-2.0
