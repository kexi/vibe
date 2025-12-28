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

シェルに以下を追加:

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

### セキュリティ: ハッシュ検証

Vibeは`.vibe.toml`と`.vibe.local.toml`ファイルの整合性をSHA-256ハッシュを使って自動的に検証します。これにより、設定ファイルへの不正な変更を防ぎます。

#### 仕組み
- `vibe trust`を実行すると、Vibeは設定ファイルのSHA-256ハッシュを計算して保存します
- `vibe start`を実行すると、Vibeはハッシュをチェックしてファイルが変更されていないか検証します
- ハッシュが一致しない場合、Vibeはエラーで終了し、再度`vibe trust`を実行するよう求めます

#### ハッシュチェックのスキップ（開発用）
設定ファイル（`~/.config/vibe/settings.json`）でハッシュ検証を無効化できます:

**グローバル設定:**
```json
{
  "version": 2,
  "skipHashCheck": true,
  "permissions": { "allow": [], "deny": [] }
}
```

**ファイルごとの設定:**
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

#### ブランチ切り替え
Vibeはファイルごとに複数のハッシュ（最大100個）を保存するため、各ブランチのバージョンを一度信頼すれば、ブランチを切り替えても再度信頼登録する必要はありません。

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
post_start = ["npm install", "npm run build"]

# .vibe.local.toml（ローカル）
[hooks]
post_start_prepend = ["echo 'ローカルセットアップ'"]
post_start_append = ["npm run dev"]

# 結果: ["echo 'ローカルセットアップ'", "npm install", "npm run build", "npm run dev"]
```

### 利用可能なフック

| フック       | 実行タイミング                              | 利用可能な環境変数                           |
| ------------ | ------------------------------------------- | -------------------------------------------- |
| `pre_start`  | worktree作成前                              | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `post_start` | worktree作成後                              | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `pre_clean`  | worktree削除前（現在のworktreeで実行）      | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |
| `post_clean` | worktree削除後（メインリポジトリで実行）    | `VIBE_WORKTREE_PATH`, `VIBE_ORIGIN_PATH`     |

**注意**: `post_clean`フックは削除コマンドに`&&`で連結され、`git worktree remove`コマンド完了後にメインリポジトリディレクトリで実行されます。

### 環境変数

すべてのフックコマンド内で以下の環境変数が使えます：

| 変数名               | 説明                         |
| -------------------- | ---------------------------- |
| `VIBE_WORKTREE_PATH` | 作成されたworktreeの絶対パス |
| `VIBE_ORIGIN_PATH`   | 元リポジトリの絶対パス       |

## 開発

### 利用可能なタスク

すべてのタスクは`deno.json`に定義されており、ローカル開発とCIで同じチェックを実行できます：

```bash
# CIと同じチェックを実行
deno task ci

# 個別のチェック
deno task fmt:check    # コードフォーマットをチェック
deno task lint         # Linterを実行
deno task check        # 型チェック
deno task test         # テスト実行

# フォーマット自動修正
deno task fmt

# 開発
deno task dev          # 開発モードで実行
deno task compile      # 全プラットフォーム向けにビルド
```

### ローカルでCIチェックを実行

プッシュ前に、CIと同じチェックを実行できます：

```bash
deno task ci
```

以下を実行します：
1. フォーマットチェック (`deno task fmt:check`)
2. Linter (`deno task lint`)
3. 型チェック (`deno task check`)
4. テスト (`deno task test`)

## ライセンス

Apache-2.0
