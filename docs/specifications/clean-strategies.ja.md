> 🇺🇸 [English](./clean-strategies.md) | 🇨🇳 [简体中文](./clean-strategies.zh.md)

# Clean Strategies

> **歴史的な注記:** ここで説明している TypeScript 実装（`packages/core` の `fast-remove.ts` など）は、Rust 移植の Phase 6 で削除されました。vibe は現在単一の Rust バイナリであり、clean のロジックは `rust/crates/vibe-core`（ネイティブのゴミ箱サポートは `rust/crates/vibe-native`）にあります。このドキュメントは設計の歴史として残しています。

vibe は `vibe clean` コマンドにおいて、「Trash Strategy（ゴミ箱戦略）」と呼ばれる高速削除戦略を使用し、即座に応答を返すことでユーザー体験を向上させています。

## Trash Strategy とは？

Trash Strategy は、ディレクトリを即座に削除するのではなく、一時的な場所に移動します。実際の削除はバックグラウンドで行われるため、CLI は即座にユーザーに制御を返すことができます。

**メリット：**

- ほぼ瞬時の応答（rename 操作のみ）
- より良いユーザー体験（大きなディレクトリの削除を待つ必要がない）
- 高速削除が失敗した場合は標準削除への安全なフォールバック

## Strategy 概要

| Strategy     | 実装方式                    | macOS        | Linux            | Windows              |
| ------------ | --------------------------- | ------------ | ---------------- | -------------------- |
| **Trash**    | ネイティブゴミ箱 + fallback | Finder Trash | XDG Trash / /tmp | ごみ箱 / %TEMP%      |
| **Standard** | git worktree remove         | サポート     | サポート         | サポート             |

### ネイティブゴミ箱サポート

vibe は Rust バイナリから [trash crate](https://lib.rs/crates/trash) を使用してクロスプラットフォームのゴミ箱機能を提供します：

- **macOS**: Finder Trash（従来と同じ）
- **Linux**: XDG Trash (`~/.local/share/Trash`) [FreeDesktop.org 仕様](https://specifications.freedesktop.org/trash-spec/trashspec-latest.html)準拠
- **Windows**: ごみ箱

XDG Trash に移動されたファイルは、デスクトップ環境のゴミ箱フォルダ（GNOME Files、Dolphin、Nautilus など）に表示され、復元可能です。

## プラットフォーム固有の動作

### macOS

1. **主要 (Rust)**: `trash` crate 経由で Finder Trash に移動
   - 内部的に Rust の `trash` crate を使用
   - Finder のゴミ箱フォルダに表示される
2. **フォールバック (Rust/macOS)**: AppleScript (`osascript`) 経由で Finder Trash に移動
3. **フォールバック**: 両方とも失敗した場合（例：SSH セッション）、/tmp + バックグラウンド削除にフォールバック

### Linux

1. **主要 (Rust)**: `trash` crate 経由で XDG Trash に移動
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

1. **主要**: Rust の `trash` crate 経由でごみ箱に移動
2. **フォールバック**: `%TEMP%` ディレクトリへ移動 + `cmd /c rmdir /s /q` によるバックグラウンド削除

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

`cleanup_stale_trash()` 関数は、残存する `.vibe-trash-*` ディレクトリをスキャンして削除します：

- 削除された worktree の親ディレクトリ
- システムの temp ディレクトリ

このクリーンアップは各 clean 操作後に自動的に実行されます。

**実装ファイル:** `rust/crates/vibe-core/src/fast_remove.rs`

### Standard Strategy

標準の `git worktree remove` コマンドを使用します。Trash Strategy が失敗した場合や無効化されている場合のフォールバックとして使用されます。

**実装ファイル:** `rust/crates/vibe-core/src/commands/clean.rs`

## 設定

### User Settings (~/.config/vibe/settings.json)

```json
{
  "clean": {
    "fast_remove": true
  }
}
```

| 設定                | 型      | デフォルト | 説明                       |
| ------------------- | ------- | ---------- | -------------------------- |
| `clean.fast_remove` | boolean | `true`     | Trash Strategy の有効/無効 |

### Project Config (vibe.toml)

```toml
[clean]
delete_branch = false

[hooks]
pre_clean = ["npm run clean"]
post_clean = ["echo 'Cleanup complete'"]
```

| 設定                  | 型       | デフォルト | 説明                                |
| --------------------- | -------- | ---------- | ----------------------------------- |
| `clean.delete_branch` | boolean  | `false`    | worktree 削除後にブランチも削除する |
| `hooks.pre_clean`     | string[] | `[]`       | クリーン前に実行するコマンド        |
| `hooks.post_clean`    | string[] | `[]`       | クリーン後に実行するコマンド        |

## ファイル構造

```
rust/crates/
├── vibe-native/
│   └── src/lib.rs        # trash crate 経由のクロスプラットフォームゴミ箱連携
└── vibe-core/src/
    ├── fast_remove.rs    # Trash Strategy 実装
    │   ├── is_fast_remove_supported()
    │   ├── trash_name()
    │   ├── move_to_system_trash()
    │   ├── move_to_macos_trash_via_osascript()
    │   ├── spawn_background_delete()
    │   ├── fast_remove_directory()
    │   └── cleanup_stale_trash()
    └── commands/
        └── clean.rs      # Clean command 実装
```

**関数の説明:**

| 関数                                    | 説明                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `is_fast_remove_supported()`            | 高速削除サポートの確認                                |
| `trash_name()`                          | 一意のゴミ箱ディレクトリ名を生成                      |
| `move_to_system_trash()`                | ネイティブゴミ箱 + プラットフォーム固有フォールバック |
| `move_to_macos_trash_via_osascript()`   | Rust macOS Finder Trash フォールバック                |
| `spawn_background_delete()`             | デタッチされたバックグラウンド削除                    |
| `fast_remove_directory()`               | メインの高速削除関数                                  |
| `cleanup_stale_trash()`                 | 残存ゴミ箱ディレクトリのクリーンアップ                |

## Strategy 選択機構

clean コマンドはユーザー設定に基づいて適切な strategy を自動選択します：

```rust
// rust/crates/vibe-core/src/commands/clean.rs より
let should_fast = use_fast_remove && is_fast_remove_supported();

if should_fast {
    let result = fast_remove_directory(
        deps.io,
        &deps.native,
        &deps.spawner,
        &deps.clock,
        &deps.random,
        worktree_path,
        opts,
    );

    if result.success {
        // 空の worktree marker を再作成し、Git に登録解除させる。
        cleanup_stale_trash(deps.io, &deps.spawner, &parent);
        return Ok(());
    }

    // Standard Strategy にフォールスルー
}

// Standard Strategy: git worktree remove
```

Trash Strategy が何らかの理由（権限、クロスデバイスエラーなど）で失敗した場合、システムは自動的に Standard Strategy にフォールバックします。
