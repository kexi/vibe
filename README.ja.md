# vibe

Git Worktreeを簡単に管理するCLIツール。

[English](README.md)

## 使い方

| コマンド                       | 説明                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `vibe start <branch>`          | 新しいブランチでworktreeを作成                        |
| `vibe start <branch> --reuse`  | 既存ブランチを使用してworktreeを作成                  |
| `vibe clean`                   | 現在のworktreeを削除してメインに戻る（未コミットの変更がある場合は確認）                  |
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

### インタラクティブプロンプト

`vibe start`は以下の状況でインタラクティブに対応します：

- **ブランチが既に他のworktreeで使用中の場合**: 既存のworktreeに移動するか確認します
- **ディレクトリが既に存在する場合**: 以下の選択肢から選べます
  - 上書き（削除して再作成）
  - 再利用（既存を使用）
  - キャンセル

```bash
# ブランチが既に使用中の場合の例
$ vibe start feat/new-feature
ブランチ 'feat/new-feature' は既にworktree '/path/to/repo-feat-new-feature' で使用中です。
既存のworktreeに移動しますか? (Y/n)
```

## インストール

### Homebrew (macOS)

```bash
brew install kexi/tap/vibe
```

### Deno (JSR)

```bash
deno install -A --global jsr:@kexi/vibe
```

**権限設定**: より安全にするため、`-A`の代わりに必要な権限のみを指定できます:

```bash
deno install --global --allow-run --allow-read --allow-write --allow-env jsr:@kexi/vibe
```

**miseを使う場合**: `.mise.toml`に追加:

```toml
[tools]
"jsr:@kexi/vibe" = "latest"
```

その後、インストール:

```bash
mise install
```

### Linux

> **注意**: WSL2ユーザーは、使用しているディストリビューションに応じて以下のLinuxインストール方法を使用できます。

#### Ubuntu/Debian (.debパッケージ)

```bash
# x64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_amd64.deb
sudo apt install ./vibe_amd64.deb

# ARM64
curl -LO https://github.com/kexi/vibe/releases/latest/download/vibe_arm64.deb
sudo apt install ./vibe_arm64.deb

# アンインストール
sudo apt remove vibe
```

#### その他のLinuxディストリビューション

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

#### Copy設定でのGlobパターン

`files`配列はglobパターンに対応しており、柔軟なファイル選択が可能です：

```toml
[copy]
files = [
  "*.env",              # ルートディレクトリの全.envファイル
  "**/*.json",          # 全JSONファイル（再帰的）
  "config/*.txt",       # config/内の全.txtファイル
  ".env.production"     # 厳密なパスも引き続き利用可能
]
```

**サポートされるパターン:**
- `*` - `/`以外の任意の文字にマッチ
- `**` - `/`を含む任意の文字にマッチ（再帰的）
- `?` - 任意の1文字にマッチ
- `[abc]` - ブラケット内の任意の文字にマッチ

**注意:**
- マッチしたファイルをコピーする際、ディレクトリ構造は保持されます
- 再帰的パターン（`**/*`）は、大規模リポジトリでは処理に時間がかかる場合があります
  - 可能な限り具体的なパターンを使用してください（例: `**/*.json`より`config/**/*.json`）
  - パターン展開はworktree作成時に1回だけ実行され、コマンド実行毎ではありません

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
  "version": 3,
  "skipHashCheck": true,
  "permissions": { "allow": [], "deny": [] }
}
```

**ファイルごとの設定:**
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

> **注意**: バージョン3ではリポジトリベースのトラスト識別を使用します。設定は初回ロード時にv2からv3へ自動移行されます。トラストは同じリポジトリのすべてのワークツリー間で共有されます。

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

## 開発への参加

開発環境のセットアップとガイドラインについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

Apache-2.0
