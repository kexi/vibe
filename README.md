# vibe

Git Worktreeを簡単に管理するCLIツール。

## インストール

### Homebrew

```bash
brew install kexi/tap/vibe
```

### 手動

```bash
deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts
```

## セットアップ

`.zshrc`に以下を追加:

```bash
vibe() { eval "$(command vibe "$@")" }
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
