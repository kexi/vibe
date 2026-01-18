> 🇺🇸 [English](./clean-strategies.md)

# Clean Strategies

vibe は `vibe clean` コマンドにおいて、「Trash Strategy（ゴミ箱戦略）」と呼ばれる高速削除戦略を使用し、即座に応答を返すことでユーザー体験を向上させています。

## Trash Strategy とは？

Trash Strategy は、ディレクトリを即座に削除するのではなく、一時的な場所に移動します。実際の削除はバックグラウンドで行われるため、CLI は即座にユーザーに制御を返すことができます。

**メリット：**

- ほぼ瞬時の応答（rename 操作のみ）
- より良いユーザー体験（大きなディレクトリの削除を待つ必要がない）
- 高速削除が失敗した場合は標準削除への安全なフォールバック

## Strategy 概要

| Strategy     | 実装方式                     | macOS              | Linux                 | Windows               |
| ------------ | ---------------------------- | ------------------ | --------------------- | --------------------- |
| **Trash**    | ネイティブゴミ箱 + fallback  | Finder Trash       | XDG Trash / /tmp      | %TEMP% + background   |
| **Standard** | git worktree remove          | サポート           | サポート              | サポート              |

### ネイティブゴミ箱サポート

vibe は [trash crate](https://lib.rs/crates/trash) (`@kexi/vibe-native` 経由) を使用してクロスプラットフォームのゴミ箱機能を提供します：

- **macOS**: Finder Trash（従来と同じ）
- **Linux**: XDG Trash (`~/.local/share/Trash`) [FreeDesktop.org 仕様](https://specifications.freedesktop.org/trash-spec/trashspec-latest.html)準拠
- **Windows**: ごみ箱（現在ビルド対象外）

XDG Trash に移動されたファイルは、デスクトップ環境のゴミ箱フォルダ（GNOME Files、Dolphin、Nautilus など）に表示され、復元可能です。

## プラットフォーム固有の動作

### macOS

1. **主要 (Node.js)**: ネイティブモジュール (`@kexi/vibe-native`) 経由で Finder Trash に移動
   - 内部的に Rust の `trash` crate を使用
   - Finder のゴミ箱フォルダに表示される
2. **フォールバック (Deno)**: AppleScript (`osascript`) 経由で Finder Trash に移動
3. **フォールバック**: 両方とも失敗した場合（例：SSH セッション）、/tmp + バックグラウンド削除にフォールバック

### Linux

1. **主要 (Node.js)**: ネイティブモジュール (`@kexi/vibe-native`) 経由で XDG Trash に移動
   - [XDG Trash 仕様](https://specifications.freedesktop.org/trash-spec/trashspec-latest.html)を実装した Rust の `trash` crate を使用
   - ファイルは `~/.local/share/Trash/files/` に移動
   - メタデータは `~/.local/share/Trash/info/` に保存
   - デスクトップファイルマネージャーのゴミ箱に表示（GNOME Files、Dolphin、Nautilus など）
   - ファイルマネージャーから復元可能
2. **フォールバック**: ネイティブゴミ箱が失敗した場合（SSH セッション、デスクトップ環境なし）：
   - `/tmp/.vibe-trash-{timestamp}-{uuid}` へ rename + `nohup rm -rf`
   - `/tmp` は再起動時にクリーンアップされる
   - `nohup` により親プロセス終了後も削除が継続される
3. **フォールバック**: クロスデバイスエラー（EXDEV）発生時は、代わりに親ディレクトリへ rename

### Windows

1. **主要**: `%TEMP%` ディレクトリへ移動 + `cmd /c start /b rd /s /q` によるバックグラウンド削除

## Strategy 詳細

### Trash Strategy

Trash Strategy は、対象ディレクトリを一時的な場所に rename し、その後デタッチされたバックグラウンドプロセスを起動して実際の削除を実行します。

**命名規則:** `.vibe-trash-{timestamp}-{uuid}`

例: `.vibe-trash-1705123456789-a1b2c3d4`

**処理フロー:**

1. worktree から `.git` ファイルの内容を読み取る（git worktree クリーンアップに必要）
2. ディレクトリをゴミ箱の場所に移動（瞬時の rename 操作）
3. 元の `.git` ファイルを持つ空のディレクトリを再作成
4. 空のディレクトリに対して `git worktree remove --force` を実行（非常に高速）
5. ゴミ箱のディレクトリを削除するデタッチされたバックグラウンドプロセスを起動

**クリーンアップ機構:**

`cleanupStaleTrash()` 関数は、残存する `.vibe-trash-*` ディレクトリをスキャンして削除します：
- 削除された worktree の親ディレクトリ
- システムの temp ディレクトリ

このクリーンアップは各 clean 操作後に自動的に実行されます。

**実装ファイル:** `packages/core/src/utils/fast-remove.ts`

### Standard Strategy

標準の `git worktree remove` コマンドを使用します。Trash Strategy が失敗した場合や無効化されている場合のフォールバックとして使用されます。

**実装ファイル:** `packages/core/src/commands/clean.ts`

## 設定

### User Settings (~/.config/vibe/settings.json)

```json
{
  "clean": {
    "fast_remove": true
  }
}
```

| 設定                 | 型      | デフォルト | 説明                        |
| -------------------- | ------- | ---------- | --------------------------- |
| `clean.fast_remove`  | boolean | `true`     | Trash Strategy の有効/無効  |

### Project Config (vibe.toml)

```toml
[clean]
delete_branch = false

[hooks]
pre_clean = ["npm run clean"]
post_clean = ["echo 'Cleanup complete'"]
```

| 設定                   | 型       | デフォルト | 説明                                    |
| ---------------------- | -------- | ---------- | --------------------------------------- |
| `clean.delete_branch`  | boolean  | `false`    | worktree 削除後にブランチも削除する     |
| `hooks.pre_clean`      | string[] | `[]`       | クリーン前に実行するコマンド            |
| `hooks.post_clean`     | string[] | `[]`       | クリーン後に実行するコマンド            |

## ファイル構造

```
packages/
├── native/
│   ├── Cargo.toml        # Rust 依存関係（trash crate を含む）
│   ├── src/lib.rs        # ネイティブモジュール（moveToTrash, moveToTrashAsync）
│   └── index.d.ts        # TypeScript 型定義
└── core/src/
    ├── native/
    │   └── index.ts      # NativeTrashAdapter インターフェース
    ├── runtime/node/
    │   └── native.ts     # NodeNativeTrash 実装
    ├── utils/
    │   └── fast-remove.ts    # Trash Strategy 実装
    │       ├── isFastRemoveSupported()
    │       ├── generateTrashName()
    │       ├── moveToSystemTrash()
    │       ├── moveToMacOSTrashViaAppleScript()
    │       ├── spawnBackgroundDelete()
    │       ├── fastRemoveDirectory()
    │       └── cleanupStaleTrash()
    └── commands/
        └── clean.ts          # Clean command 実装
```

**関数の説明:**

| 関数 | 説明 |
| ---- | ---- |
| `isFastRemoveSupported()` | プラットフォームサポートの確認 |
| `generateTrashName()` | 一意のゴミ箱ディレクトリ名を生成 |
| `moveToSystemTrash()` | ネイティブゴミ箱 + プラットフォーム固有フォールバック |
| `moveToMacOSTrashViaAppleScript()` | Deno macOS フォールバック |
| `spawnBackgroundDelete()` | デタッチされたバックグラウンド削除 |
| `fastRemoveDirectory()` | メインの高速削除関数 |
| `cleanupStaleTrash()` | 残存ゴミ箱ディレクトリのクリーンアップ |

## Strategy 選択機構

clean コマンドはユーザー設定に基づいて適切な strategy を自動選択します：

```typescript
// packages/core/src/commands/clean.ts より
const settings = await loadUserSettings(ctx);
const useFastRemove = settings.clean?.fast_remove ?? true; // デフォルト: true

if (useFastRemove && isFastRemoveSupported()) {
  // Trash Strategy を試行
  const result = await fastRemoveDirectory(worktreePath, ctx);
  if (result.success) {
    // 成功 - git worktree クリーンアップを実行
    return;
  }
  // Standard Strategy にフォールスルー
}

// Standard Strategy: git worktree remove
```

Trash Strategy が何らかの理由（権限、クロスデバイスエラーなど）で失敗した場合、システムは自動的に Standard Strategy にフォールバックします。
