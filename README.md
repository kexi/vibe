# vibe

Git Worktreeを簡単に管理するCLIツール。

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

### Zsh (.zshrc)

```bash
vibe() { eval "$(command vibe "$@")" }
```

### Bash (.bashrc)

```bash
vibe() { eval "$(command vibe "$@")"; }
```

### PowerShell ($PROFILE)

```powershell
function vibe { Invoke-Expression (& vibe.exe $args) }
```

## 使い方

| コマンド | 説明 |
|---------|------|
| `vibe start <branch>` | 新しいワーカーツリーを作成 |
| `vibe clean` | 現在のワーカーツリーを削除してメインに戻る |
| `vibe trust` | `.vibe`ファイルを信頼登録 |

### 例

```bash
# 新しいブランチでワーカーツリーを作成
vibe start feat/new-feature

# 作業完了後、ワーカーツリーを削除
vibe clean
```

## .vibeファイル

リポジトリルートに`.vibe`ファイルを配置すると、`vibe start`時に自動実行されます。

```bash
# .vibe の例
pnpm install
```

初回は`vibe trust`で信頼登録が必要です。

## ライセンス

MIT
