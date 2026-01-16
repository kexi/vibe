# vibe

Git Worktreeを簡単に管理するCLIツール。

[English](README.md)

## ドキュメント

📚 完全なドキュメントは [vibe.kexi.dev](https://vibe.kexi.dev) で閲覧できます

## 使い方

| コマンド                       | 説明                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `vibe start <branch>`          | 新規または既存ブランチでworktreeを作成（冪等）        |
| `vibe clean`                   | 現在のworktreeを削除してメインに戻る（未コミットの変更がある場合は確認）                  |
| `vibe trust`                   | `.vibe.toml`と`.vibe.local.toml`ファイルを信頼登録    |
| `vibe untrust`                 | `.vibe.toml`と`.vibe.local.toml`ファイルの信頼を解除  |

### 例

```bash
# 新しいブランチでworktreeを作成
vibe start feat/new-feature

# 既存ブランチを使用（またはworktreeが既に存在する場合も再実行可能）
vibe start feat/existing-branch

# 作業完了後、worktreeを削除
vibe clean
```

### インタラクティブプロンプト

`vibe start`は以下の状況に対応します：

- **ブランチが既に他のworktreeで使用中の場合**: 既存のworktreeに移動するか確認します
- **同じworktreeが既に存在する場合**: 自動的に再利用します（冪等）
- **異なるブランチのディレクトリが存在する場合**: 以下の選択肢から選べます
  - 上書き（削除して再作成）
  - 再利用（既存ディレクトリを使用）
  - キャンセル

```bash
# ブランチが既に使用中の場合の例
$ vibe start feat/new-feature
ブランチ 'feat/new-feature' は既にworktree '/path/to/repo-feat-new-feature' で使用中です。
既存のworktreeに移動しますか? (Y/n)
```

### グローバルオプション

| オプション        | 説明                                     |
| ----------------- | ---------------------------------------- |
| `-h`, `--help`    | ヘルプメッセージを表示                   |
| `-v`, `--version` | バージョン情報を表示                     |
| `-V`, `--verbose` | 詳細な出力を表示                         |
| `-q`, `--quiet`   | 不要な出力を抑制                         |
| `-n`, `--dry-run` | 実行せずに操作内容をプレビュー（startのみ） |

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
deno install --global --allow-run --allow-read --allow-write --allow-env --allow-ffi jsr:@kexi/vibe
```

> 注意: `--allow-ffi`はmacOS (APFS)とLinux (Btrfs/XFS)で最適化されたCopy-on-Writeファイルクローニングを有効にします。このフラグがなくても動作しますが、ディレクトリコピーが若干遅くなる可能性があります。

### mise

まず、vibeプラグインをインストール:

```bash
mise plugin install vibe https://github.com/kexi/vibe.git#mise-plugin
```

`.mise.toml`に追加:

```toml
[tools]
vibe = "latest"
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
deno compile --allow-run --allow-read --allow-write --allow-env --allow-ffi --output vibe main.ts
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
# ファイルとディレクトリを元リポジトリからworktreeへコピー
[copy]
files = [".env"]
dirs = ["node_modules", ".cache"]

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

#### ディレクトリコピー設定

`dirs`配列でディレクトリ全体を再帰的にコピーできます：

```toml
[copy]
dirs = [
  "node_modules",      # 厳密なディレクトリパス
  ".cache",            # 隠しディレクトリ
  "packages/*"         # 複数ディレクトリにマッチするGlobパターン
]
```

**注意:**
- ディレクトリは完全コピーされます（差分同期ではありません）
- Globパターンはファイルパターンと同様に動作します
- `node_modules`のような大きなディレクトリはコピーに時間がかかる場合があります

#### コピーパフォーマンスの最適化

Vibeはシステムに応じて最適なコピー戦略を自動選択します:

| 戦略 | 使用条件 | プラットフォーム |
|------|----------|------------------|
| Clone (CoW) | APFSでのディレクトリコピー | macOS |
| Clone (reflink) | Btrfs/XFSでのディレクトリコピー | Linux |
| rsync | cloneが利用できない場合のディレクトリコピー | macOS/Linux |
| Standard | ファイルコピー、またはフォールバック | 全て |

**仕組み:**
- **ファイルコピー**: 単一ファイルの最高パフォーマンスのため、常にDenoネイティブの`copyFile()`を使用
- **ディレクトリコピー**: 利用可能な最速の方法を自動使用:
  - APFSを使用したmacOS: Copy-on-Writeクローニングに`cp -cR`を使用（ほぼ瞬時）
  - Btrfs/XFSを使用したLinux: CoWクローニングに`cp --reflink=auto`を使用
  - CoWが利用できない場合はrsyncまたは標準コピーにフォールバック

**メリット:**
- Copy-on-Writeは実際のデータではなくメタデータのみをコピーするため非常に高速
- 設定不要 - 最適な戦略が自動検出されます
- 自動フォールバックによりコピーは常に動作します

### Worktreeパス設定

外部スクリプトを使用してWorktreeディレクトリパスをカスタマイズできます：

```toml
[worktree]
path_script = "~/.config/vibe/worktree-path.sh"
```

スクリプトは以下の環境変数を受け取り、絶対パスを出力する必要があります：

| 環境変数 | 説明 | 例 |
|----------|------|-----|
| `VIBE_REPO_NAME` | リポジトリ名 | `my-project` |
| `VIBE_BRANCH_NAME` | ブランチ名 | `feat/new-feature` |
| `VIBE_SANITIZED_BRANCH` | サニタイズ済みブランチ名（`/`→`-`） | `feat-new-feature` |
| `VIBE_REPO_ROOT` | リポジトリルートパス | `/path/to/repo` |

**スクリプト例:**

```bash
#!/bin/bash
echo "${HOME}/worktrees/${VIBE_REPO_NAME}-${VIBE_SANITIZED_BRANCH}"
```

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

#### セキュリティ上の考慮事項

trust機構は、信頼した設定ファイルが変更されていないことを検証します。ただし、以下の点に注意してください：

- **trustは意思表示**: `vibe trust`を実行すると、設定ファイル（含まれるフックコマンドを含む）をレビューし承認したことを宣言することになります。
- **フックは任意のコマンドを実行**: `hooks.pre_start`、`hooks.post_start`などで定義されたコマンドは、あなたのシェルで実行されます。Vibeはこれらのコマンドをサンドボックス化したり制限したりしません。
- **信頼する前にレビュー**: 特に自分が管理していないリポジトリでは、`vibe trust`を実行する前に`.vibe.toml`と`.vibe.local.toml`ファイルを必ずレビューしてください。
- **ハッシュ検証はマルウェア対策ではない**: ハッシュチェックは、既に信頼したファイルへの変更を検出するだけです。コマンド自体が安全かどうかは評価しません。

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

### フック実行時の出力動作

Vibeはフック実行中にタスクの状態を表示するリアルタイム進捗ツリーを表示します。フックの出力は状況に応じて以下のように処理されます：

- **進捗表示が有効な場合**: フックの標準出力は抑制され、進捗ツリーのみが表示されます。これにより視覚的に見やすくなります。
- **進捗表示が無効な場合**: フックの標準出力は標準エラー出力に書き込まれます（シェルラッパーの`eval`との干渉を避けるため）。
- **失敗したフック**: 進捗表示の有無にかかわらず、常に標準エラー出力が表示されます。これはデバッグを支援するためです。

進捗表示の例：
```
✶ Setting up worktree feature/new-ui…
┗ ☒ Pre-start hooks
   ┗ ☒ npm install
     ☒ cargo build --release
  ⠋ Copying files
   ┗ ⠋ .env.local
     ☐ node_modules/
```

**注意**: 進捗表示は非TTY環境（CI/CDなど）では自動的に無効になり、フックの出力が通常通り表示されます。

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
