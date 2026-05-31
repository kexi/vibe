> [!NOTE]
> :us: [English](./SECURITY_CHECKLIST.md)

# CLI セキュリティチェックリスト

vibe CLIツールの包括的なセキュリティチェックリストです。各カテゴリにはプロジェクトで使用している対策を記載しています。

## 1. コマンドインジェクション

- **リスク**: サニタイズされていないユーザー入力による任意コマンド実行
- **対策**: `spawn()` を配列引数で使用（シェル文字列結合は禁止）
- **適用**: ESLint `security/detect-child-process` + カスタムセキュリティチェックスクリプト

## 2. パストラバーサル

- **リスク**: `../` シーケンスによる意図しないディレクトリ外のファイルアクセス
- **対策**: `validatePath()` によるパス境界の検証
- **適用**: コードレビュー + ランタイムバリデーション

## 3. シンボリックリンク攻撃

- **リスク**: シンボリックリンクを経由した意図しないファイルのアクセス・変更
- **対策**: `realPath()` による解決 + 境界チェック
- **適用**: ファイル操作前のランタイムバリデーション

## 4. TOCTOU（チェック時と使用時の競合）

- **リスク**: セキュリティチェックと使用の間にファイル状態が変更される
- **対策**: `verifyTrustAndRead()` によるアトミックなチェック＆読み取り
- **適用**: 信頼検証のアーキテクチャパターン

## 5. 環境変数インジェクション

- **リスク**: 悪意のある環境変数値による動作への影響
- **対策**: 明示的な許可リストによる環境変数マージの制御
- **適用**: コードレビュー

## 6. ターミナルエスケープシーケンスインジェクション

- **リスク**: 出力内の悪意のあるエスケープシーケンスによるターミナル表示の操作
- **対策**: ユーザー向け出力での制御文字フィルタリング
- **適用**: 出力サニタイズユーティリティ

## 7. 引数インジェクション（`--` オプション注入）

- **リスク**: ユーザー入力がコマンドラインオプションとして解釈される（例: `--exec`）
- **対策**: 明示的な引数配列（文字列結合ではない）
- **適用**: `spawn()` 配列パターン + コードレビュー

## 8. サプライチェーン攻撃

- **リスク**: 上流パッケージの侵害、悪意あるライフサイクルスクリプト、ビルドランナーからの情報窃取、publish トークンの奪取など — 例: [TanStack npm 侵害事例 (2026-05-11)](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)
- **対策** (多層防御):
  - **レジストリ強化**: Takumi Guard プロキシ (`.github/actions/setup-takumi-guard`) が既知マルウェアを遮断。`pnpm-workspace.yaml` の `minimumReleaseAge: 4320` (72 時間) で新規公開直後のバージョンを隔離
  - **非標準ソース禁止**: `blockExoticSubdeps: true` で `github:user/repo`・`file:`・`http:` などレジストリ外依存を依存グラフ全域で拒否（自己伝播ペイロード `optionalDependencies: github:<sha>` を無効化）
  - **ライフサイクルスクリプト既定オフ**: `strictDepBuilds: true` + 明示的な `only-built-dependencies` 許可リスト（現在 `node-pty` のみ、`.npmrc` を参照）。CI の全 `pnpm install` / `pnpm publish` に `--ignore-scripts`
  - **信頼レベル単調性**: `trustPolicy: no-downgrade` でパッケージが低信頼状態に遷移した場合にインストールを中断
  - **ロックファイル固定**: 全 CI install ステップで `--frozen-lockfile`
  - **ワークフロー完全性**: サードパーティ Actions は完全コミット SHA に固定 (`pinact-verify` job が未固定参照をブロック)。ツールチェーンは `flake.lock` (Rust は `rust-toolchain.toml`) で再現的に固定
  - **ランナー egress 可視化**: 全 job に `step-security/harden-runner` (audit モード) を配置し、外向き通信と `/proc` アクセスを記録。Shai-Hulud 系マルウェアが用いる `*.getsession.org` などの C2 を検知可能に
  - **公開時の出所証明**: 全リリースで `npm publish --provenance` を有効化し OIDC 署名された attestation を付与
- **適用**: CI の `pinact-verify` job + 全 CI install で `pnpm install --frozen-lockfile --ignore-scripts` + `pnpm publish ... --ignore-scripts` + 各リリース後の Harden-Runner Insights レビュー

## 9. 安全でない一時ファイル作成

- **リスク**: 予測可能な一時ファイル名によるシンボリックリンク攻撃
- **対策**: UUIDベースの命名 + アトミックリネーム操作
- **適用**: コードレビュー + fast-remove実装

## 10. シェル出力インジェクション

- **リスク**: 特殊文字（シングルクォートなど）を含むパスが `eval` 時にシェルインジェクションを引き起こす
- **対策**: `escapeShellPath()` による全 `cd` 出力でのシングルクォートエスケープ
- **適用**: カスタムセキュリティチェックスクリプトがエスケープなしの `cd` パターンを検出

## 11. 設定ファイルポイズニング

- **リスク**: 悪意のある `.vibe.toml` がフック経由で任意コマンドを実行
- **対策**: SHA-256信頼メカニズム — フック実行前に設定を明示的に信頼する必要がある
- **適用**: `trust`/`untrust`/`verify` コマンド + ハッシュ検証

## 12. 安全でない正規表現（ReDoS）

- **リスク**: 壊滅的なバックトラッキングを持つ正規表現によるサービス拒否
- **対策**: ESLint `security/detect-unsafe-regex` ルール
- **適用**: CIでのESLint + pre-commitチェック

## 13. eval / 動的コード実行

- **リスク**: 動的に構築されたコードの実行による任意コード実行
- **対策**: プロダクションコードでの `eval()` や `new Function()` の禁止
- **適用**: ESLint `security/detect-eval-with-expression` + カスタムセキュリティチェックスクリプト
- **例外**: `.vibedev` は開発利便性のために `eval` を使用（警告付きで文書化）

---

## 自動適用

| ツール                         | スコープ           | タイミング                |
| ------------------------------ | ------------------ | ------------------------- |
| ESLint セキュリティプラグイン  | 静的解析           | `pnpm run lint`           |
| カスタムセキュリティスクリプト | パターンマッチング | `pnpm run security:check` |
| Claude Code フック             | 編集時チェック     | PostToolUse (Write/Edit)  |
| CI security-check ジョブ       | PR ゲート          | プッシュ/PR ごと          |
