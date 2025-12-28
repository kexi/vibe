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

### Fish (~/.config/fish/config.fish)

```fish
function vibe
    eval (command vibe $argv)
end
```

### Nushell (~/.config/nushell/config.nu)

```nu
def --env vibe [...args] {
    ^vibe ...$args | lines | each { |line| nu -c $line }
}
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
# 元リポジトリから.envをコピー
cp "$VIBE_ORIGIN_PATH/.env" "$VIBE_WORKTREE_PATH/" 2>/dev/null || true
pnpm install
```

初回は`vibe trust`で信頼登録が必要です。

### 利用可能な環境変数

| 変数名 | 説明 |
|--------|------|
| `VIBE_WORKTREE_PATH` | 作成されたworktreeの絶対パス |
| `VIBE_ORIGIN_PATH` | 元リポジトリの絶対パス |

## ライセンス

MIT
