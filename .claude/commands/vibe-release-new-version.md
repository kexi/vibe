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
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
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
- `packages/npm/package.json`
- `packages/native/package.json`

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

- New feature description

### Changed

- Change description

### Fixed

- Bug fix description

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

**重要: エンドユーザーに関係のない変更は含めない**

以下の変更はchangelogから除外すること：
- CI/CDワークフローの変更（GitHub Actions等）
- 開発者向けツール（Claude Codeコマンド、リリーススクリプト等）
- 内部リファクタリング（ユーザーに見える動作変更がない場合）
- 開発ドキュメントの更新（CLAUDE.md、CONTRIBUTING.md等）
- テストの追加/修正
- コードフォーマット修正
- 依存関係の更新（セキュリティ修正やユーザーに影響がある場合は除く）

含めるべき変更の例：
- 新しいCLIコマンドやオプション
- ユーザーに見えるバグ修正
- パフォーマンス改善
- 破壊的変更
- npx/brew等のインストール方法に影響する修正

---

## Step 4: コミット＆プッシュ

### 4.1 変更をステージング

```bash
git add deno.json packages/npm/package.json packages/native/package.json docs/src/content/docs/changelog.mdx docs/src/content/docs/ja/changelog.mdx
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

## Step 5: PR作成（release → develop）

### 5.1 PR作成

```bash
gh pr create --base develop --title "chore: release vX.Y.Z" --body "$(cat <<'EOF'
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
1. Create a PR from `develop` to `main`
2. Merge the `develop` → `main` PR
3. Create a GitHub Release with tag `vX.Y.Z`
4. CI will automatically publish to npm and JSR
EOF
)"
```

### 5.2 ユーザーに案内

PR URLを表示し、以下を伝えてください：

1. PR をレビューしてマージしてください
2. マージ後、Step 6 で `develop` → `main` のPRを作成します

**注意**: PRがマージされるまで待機してください。マージ後に `/vibe-release-new-version` を再度呼び出すか、Step 6 を手動で実行してください。

---

## Step 6: develop → main のPR作成（release PR マージ後）

release PRがdevelopにマージされた後、以下を実行：

### 6.1 developブランチに切り替え

```bash
git checkout develop
git pull origin develop
```

### 6.2 PR作成

```bash
gh pr create --base main --head develop --title "chore: merge develop into main for vX.Y.Z" --body "$(cat <<'EOF'
## Summary

- Merge develop into main for release vX.Y.Z

---

After merging this PR:
1. Create a GitHub Release with tag `vX.Y.Z`
2. CI will automatically publish to npm and JSR
EOF
)"
```

### 6.3 ユーザーに案内

PR URLを表示し、以下を伝えてください：

1. PR をレビューしてマージしてください
2. マージ後、Step 7 を実行してリリースを完了します

**注意**: PRがマージされるまで待機してください。マージ後に `/vibe-release-new-version` を再度呼び出すか、Step 7 を手動で実行してください。

---

## Step 7: リリース作成（develop → main PR マージ後）

PRがマージされた後、以下を実行：

### 7.1 mainブランチに切り替え

```bash
git checkout main
git pull origin main
```

### 7.2 リリースノート生成

前回リリースからの変更を取得：

```bash
git log $(git describe --tags --abbrev=0)..HEAD --pretty=format:"- %s"
```

**重要: エンドユーザーに関係のある変更のみ含める**

リリースノートには、ユーザーが実際に体験する変更のみを記載する。開発プロセスの改善、内部的なリファクタリング、CI/CD変更などは除外すること。

Conventional Commitsに基づいてカテゴリ分け（ユーザー向け変更のみ）：

```markdown
## What's Changed

### Features
- 新しいCLIコマンドやオプションの説明

### Bug Fixes
- ユーザーに影響するバグ修正の説明

---

## About vibe

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

- [Release vX.Y.Z](https://github.com/kexi/vibe/releases/tag/vX.Y.Z)
- [Website](https://vibe.kexi.dev)
```

**リリースノート必須チェックリスト:**

- [ ] `## What's Changed` セクション
- [ ] `### Features` または `### Bug Fixes`（該当する変更がある場合）
- [ ] `---` 区切り線
- [ ] `## About vibe` セクション（必須）
- [ ] Release リンク
- [ ] Website リンク

### 7.3 GitHub Release作成

リリースノートの内容を使用してリリースを作成：

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
## What's Changed

### Features
- feat: feature description

### Bug Fixes
- fix: bug fix description

---

## About vibe

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

- [Release vX.Y.Z](https://github.com/kexi/vibe/releases/tag/vX.Y.Z)
- [Website](https://vibe.kexi.dev)
EOF
)" --target main
```

**Note:** 上記の `--notes` 内容は Step 7.2 で生成したリリースノートに置き換えてください。

### 7.4 Twitter投稿用テキスト生成

リリース告知用のTwitter投稿テキストを生成して出力します。コントリビューターへの感謝を込めてTwitterメンションを含めます。

#### 7.4.1 コントリビューター情報の取得

前回リリースからのコントリビューターを取得：

```bash
# 前回タグを取得
PREV_TAG=$(git describe --tags --abbrev=0)

# リポジトリオーナーを取得
REPO_OWNER=$(gh repo view --json owner --jq '.owner.login')

# コントリビューターを取得（オーナー除外）
gh api "repos/kexi/vibe/compare/${PREV_TAG}...HEAD" \
  --jq "[.commits[].author.login] | unique | map(select(. != \"${REPO_OWNER}\")) | .[]"
```

#### 7.4.2 TwitterユーザーIDの抽出

各コントリビューターのTwitterアカウントを取得：

```bash
# 各コントリビューターに対して実行
gh api "users/{username}" --jq '.twitter_username // empty'
```

**エラーハンドリング:**

| シナリオ | 対応 |
|---------|------|
| 前回タグが存在しない | メンション機能をスキップ |
| GitHub API呼び出し失敗 | 警告を表示し、メンションなしで続行 |
| コントリビューターが0名 | メンションなしで続行 |
| 全員Twitterユーザー名なし | メンションなしのテンプレートを使用 |

#### 7.4.3 Twitter投稿テンプレート生成

**メンションの処理ルール:**

| メンション数 | 対応 |
|-------------|------|
| 0名 | メンションなしのテンプレート |
| 1-2名（約50文字以内） | メインツイートに含める |
| 3名以上 | 別ツイート（リプライ）として分離 |

**必須要素:**
- vibeの説明（super fast Git worktree management tool with Copy-on-Write optimization）
- 主な変更点
- コントリビューターへの感謝（該当者がいる場合）
- リリースページへのリンク
- ハッシュタグ

**含めない:**
- インストール方法（省略する）
- Websiteへのリンク（省略する）

**日本語版（メンションあり）:**

```
🎉 vibe vX.Y.Z をリリースしました！

vibeはCopy-on-Write最適化による超高速なGit worktree管理ツールです。

✨ 主な変更点:
- 新機能や修正の要約（1-3行）

🙏 Thanks to @contributor!

🔗 https://github.com/kexi/vibe/releases/tag/vX.Y.Z

#vibe #git #worktree #開発ツール
```

**英語版（メンションあり）:**

```
🎉 vibe vX.Y.Z released!

vibe is a super fast Git worktree management tool with Copy-on-Write optimization.

✨ Highlights:
- Summary of new features/fixes (1-3 lines)

🙏 Thanks to @contributor!

🔗 https://github.com/kexi/vibe/releases/tag/vX.Y.Z

#vibe #git #worktree #devtools
```

**3名以上のコントリビューターがいる場合（リプライ用）:**

メインツイートにはメンションを含めず、リプライとして以下を投稿：

```
🙏 Special thanks to our contributors:
@contributor1 @contributor2 @contributor3 @contributor4

Your contributions make vibe better! 🎉
```

**Note:** 280文字制限に注意。必要に応じて要約を調整してください。

### 7.5 クリーンアップ

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
