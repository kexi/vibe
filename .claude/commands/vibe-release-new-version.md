---
description: vibeの新バージョンをリリース（バージョンバンプ、同期、PR作成）
argument-hint: "[patch|minor|major|X.Y.Z]"
allowed-tools: Bash(git *), Bash(gh *), Bash(deno *), Read, Edit
---

# vibe Release Workflow

vibeプロジェクトの新バージョンをリリースするためのガイド付きワークフローです。

**引数**: $ARGUMENTS（省略可能 - 省略時は変更履歴から自動提案）

---

## Step 1: 前提条件チェック

以下のチェックを実行してください：

### 1.1 クリーンなワーキングディレクトリ確認

```bash
git status --porcelain
```

- 出力がある場合：未コミットの変更があります。続行前にコミットまたはスタッシュしてください。
- 出力が空の場合：続行可能

### 1.2 正しいブランチ確認

```bash
git branch --show-current
```

- `develop` ブランチであること
- 異なる場合は警告し、ユーザーに確認

### 1.3 リモートと同期確認

```bash
git fetch origin
git log HEAD..origin/develop --oneline
```

- 出力がある場合：リモートに新しいコミットがあります。`git pull` を推奨
- 出力が空の場合：同期済み

### 1.4 タグ重複チェック

新しいバージョンのタグが既に存在しないことを確認：

```bash
git tag -l "vX.Y.Z"
```

---

## Step 2: バージョン計算

### 2.1 現在のバージョン取得

```bash
deno task get-version
```

### 2.2 新バージョン計算

#### 引数が指定された場合

引数に基づいて新バージョンを計算：

| 引数 | 現在 → 新 | 説明 |
|------|-----------|------|
| `patch` | 0.12.7 → 0.12.8 | バグ修正 |
| `minor` | 0.12.7 → 0.13.0 | 新機能（後方互換） |
| `major` | 0.12.7 → 1.0.0 | 破壊的変更 |
| `X.Y.Z` | → X.Y.Z | 明示的指定 |

#### 引数が指定されなかった場合（自動提案）

前回リリースからの変更履歴を分析し、適切なバージョンを提案します。

**1. 変更履歴の取得**

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline
```

**2. Conventional Commitsに基づく分析**

コミットメッセージを分析し、以下のルールでバージョンタイプを判定：

| 検出パターン | バージョンタイプ | 優先度 |
|-------------|-----------------|--------|
| `BREAKING CHANGE:` または `!:` （例: `feat!:`） | **major** | 最高 |
| `feat:` または `feat(...):`  | **minor** | 中 |
| `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:` | **patch** | 低 |

**3. 提案形式**

変更内容をサマリーし、以下の形式で提案：

```
## バージョン提案

**現在のバージョン**: 0.12.7
**提案バージョン**: 0.13.0 (minor)

### 理由

前回リリース (v0.12.7) からの変更:

- 🚀 **Features (2件)**: minor バージョンアップが必要
  - feat: add new command for worktree listing
  - feat(config): support custom templates

- 🐛 **Bug Fixes (1件)**:
  - fix: resolve path handling on Windows

- 📦 **Other (3件)**:
  - chore: update dependencies
  - docs: improve README
  - refactor: simplify error handling

**判定理由**: `feat:` コミットが含まれているため、minor バージョンアップを提案します。
```

**4. ユーザーに確認**

提案を表示し、以下を確認：
- 提案されたバージョンで続行するか
- 別のバージョンタイプ（patch/minor/major）を選択するか
- 明示的なバージョン番号を指定するか

### 2.3 ユーザー確認

計算または提案されたバージョンをユーザーに表示し、続行するか確認してください。

---

## Step 3: バージョン更新

### 3.1 リリースブランチ作成

```bash
git checkout -b release/vX.Y.Z
```

### 3.2 deno.json 更新

Edit ツールを使用して `deno.json` の `"version"` フィールドを新バージョンに更新：

```json
"version": "X.Y.Z"
```

### 3.3 バージョン同期

```bash
deno task sync-version
```

同期対象：
- `npm/package.json`
- `packages/@kexi/vibe-native/package.json`

### 3.4 同期結果確認

```bash
deno task sync-version --check
```

### 3.5 ドキュメントの変更履歴を更新

以下の2ファイルを更新：

- `docs/src/content/docs/changelog.mdx`（英語版）
- `docs/src/content/docs/ja/changelog.mdx`（日本語版）

**形式（英語版）:**

```markdown
## vX.Y.Z

**Released:** YYYY-MM-DD

### Added

- 新機能の説明

### Changed

- 変更点の説明

### Fixed

- 修正点の説明

---
```

**形式（日本語版）:**

```markdown
## vX.Y.Z

**リリース日:** YYYY年M月D日

### 追加

- 新機能の説明

### 変更

- 変更点の説明

### 修正

- 修正点の説明

---
```

**注意:**
- 各changelogファイルの先頭（frontmatter直後）に新しいバージョンセクションを追加
- Conventional Commitsのカテゴリに基づいて分類（feat→Added、fix→Fixed、その他→Changed）
- 既存のエントリのフォーマットを参考にする

---

## Step 4: コミット＆プッシュ

### 4.1 変更をステージング

```bash
git add deno.json npm/package.json packages/@kexi/vibe-native/package.json docs/src/content/docs/changelog.mdx docs/src/content/docs/ja/changelog.mdx
```

### 4.2 コミット作成

```bash
git commit -m "chore: release vX.Y.Z"
```

### 4.3 プッシュ

```bash
git push -u origin release/vX.Y.Z
```

---

## Step 5: PR作成

### 5.1 PR作成

```bash
gh pr create --base main --title "chore: release vX.Y.Z" --body "$(cat <<'EOF'
## Summary

- Release version X.Y.Z

## Checklist

- [ ] Version updated in deno.json
- [ ] Version synced to all package.json files
- [ ] Changelog updated (docs/src/content/docs/changelog.mdx)
- [ ] Changelog updated (docs/src/content/docs/ja/changelog.mdx)
- [ ] CI checks passing

---

After merging this PR:
1. Create a GitHub Release with tag `vX.Y.Z`
2. CI will automatically publish to npm and JSR
EOF
)"
```

### 5.2 ユーザーに案内

PR URLを表示し、以下を伝えてください：

1. PR をレビューしてマージしてください
2. マージ後、Step 6 を実行してリリースを完了します

**注意**: PRがマージされるまで待機してください。マージ後に `/vibe-release-new-version` を再度呼び出すか、Step 6 を手動で実行してください。

---

## Step 6: リリース作成（PRマージ後）

PRがマージされた後、以下を実行：

### 6.1 mainブランチに切り替え

```bash
git checkout main
git pull origin main
```

### 6.2 リリースノート生成

前回リリースからの変更を取得：

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline --pretty=format:"- %s"
```

Conventional Commitsに基づいてカテゴリ分け：

```markdown
## What's Changed

### Features
- feat: 新機能の説明

### Bug Fixes
- fix: バグ修正の説明

### Other Changes
- chore/refactor/docs: その他の変更

---

## About vibe

vibe is a Git worktree management tool with Copy-on-Write optimization.

- [Release vX.Y.Z](https://github.com/kexi/vibe/releases/tag/vX.Y.Z)
- [Website](https://vibe.kexi.dev)
```

### 6.3 GitHub Release作成

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file RELEASE_NOTES.md --target main
```

または、リリースノートを直接指定：

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "リリースノート内容" --target main
```

### 6.4 クリーンアップ

リリースブランチを削除：

```bash
git branch -d release/vX.Y.Z
git push origin --delete release/vX.Y.Z
```

---

## 安全チェック一覧

| チェック | 条件 | 失敗時 |
|---------|------|--------|
| クリーンな作業ツリー | 未コミット変更なし | **中止** |
| 正しいブランチ | developブランチ | 警告・確認 |
| リモート同期 | origin/developと同期 | 警告・確認 |
| バージョン形式 | セマンティックバージョニング準拠 | **中止** |
| タグ重複 | 同名タグが存在しない | **中止** |

---

## CI自動実行

PRマージ後、以下のCIが自動実行されます：

- `release.yml`: バイナリビルド＆リリースアセット追加
- `publish-npm.yml`: npm公開
- `publish-jsr.yml`: JSR公開
