# AGENTS.md

## ブランチ戦略

| ブランチ  | 用途                                 |
| --------- | ------------------------------------ |
| `main`    | リリース用。安定版のみ。             |
| `develop` | 開発用。トピックブランチのマージ先。 |

### ワークフロー

1. `develop`からトピックブランチを作成
2. 作業完了後、`develop`にマージ
3. リリース時に`develop`を`main`にマージ

```
main ────●─────────────────●────
         │                 ↑
develop ─┴──●──●──●──●─────┴────
             ↑  ↑
            feat/a feat/b
```

## 開発環境

- ランタイム: Deno v2.x（`mise install`でセットアップ）
- 実行: `deno run --allow-run --allow-read --allow-write --allow-env main.ts`
- コンパイル:
  `deno compile --allow-run --allow-read --allow-write --allow-env --output vibe main.ts`

## テスト

- リントチェック: `deno lint`
- フォーマットチェック: `deno fmt --check`
- 型チェック: `deno check main.ts`
- コミット前に上記をすべてパスすること

## ドキュメント

- README.md: 英語
- README.ja.md: 日本語

## PR規約

- タイトル形式: `<type>: <description>`
  - type: feat, fix, docs, refactor, test, chore
- `deno lint`と`deno fmt --check`を通すこと
- 変更したコードにはテストを追加・更新すること

## リリース

- `main`にマージ後、GitHubでリリースを作成・公開するとGitHub
  Actionsでビルドされる
- 手順:
  1. GitHub → Releases → Draft a new release
  2. タグを作成（例: `v0.1.0`）
  3. リリースノートを記入し「Publish release」
