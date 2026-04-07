---
globs:
  - ".github/workflows/**/*.yml"
  - ".github/actions/**/*.yml"
---

# GitHub Actions SHA Pinning

- サードパーティアクションは必ずコミットハッシュで固定すること（`action@<full-sha> # vX.Y.Z` 形式）
- タグのみの指定（`@v4`, `@v3` 等）は禁止
- ローカル/compositeアクション（`uses: ./.github/actions/setup`）は対象外
- 新規アクション追加時はタグで記述後、`pinact run` でSHA固定に変換すること
- `pinact` は mise 経由でインストール済み（`.mise.toml` 参照）
- CIの `pinact-verify` ジョブ（`pinact run --check`）で未固定アクションを自動検知する
