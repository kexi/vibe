# コピー戦略

vibeはディレクトリコピーにCopy-on-Write (CoW) を活用し、高速でディスク効率の良い操作を実現しています。

## Copy-on-Write (CoW) とは？

CoWはファイルシステムレベルの最適化技術です。ファイルをコピーする際、実際のデータではなくメタデータのみが複製されます。データは実際に変更されたときにのみコピーされます。

**メリット:**

- ほぼゼロのコピー時間（メタデータ操作のみ）
- ディスク使用量の削減（変更されるまでデータは共有）

## 戦略の概要

| 戦略            | 実装方式        | macOS (APFS)   | Linux (Btrfs/XFS) |
| --------------- | --------------- | -------------- | ----------------- |
| **NativeClone** | 直接FFI呼び出し | ファイル/ディレクトリ | ファイルのみ      |
| **Clone**       | cpコマンド      | ファイル/ディレクトリ | ファイル/ディレクトリ |
| **Rsync**       | rsyncコマンド   | フォールバック | フォールバック    |
| **Standard**    | Deno API        | 最終フォールバック | 最終フォールバック |

## プラットフォーム別の優先順位

### macOS (APFS)

```
ディレクトリコピー: NativeClone → Clone → Rsync → Standard
ファイルコピー: Standard (Deno.copyFile)
```

### Linux (Btrfs/XFS)

```
ディレクトリコピー: Clone → Rsync → Standard
ファイルコピー: Standard (Deno.copyFile)
```

> **注意:** Linuxでは、`NativeClone`はディレクトリクローニングをサポートしていないためスキップされます。

## 戦略の詳細

### NativeClone

FFI経由でシステムコールを直接呼び出します。プロセス生成のオーバーヘッドがないため、最速のオプションです。

| プラットフォーム | システムコール  | ファイル  | ディレクトリ  |
| ---------------- | --------------- | --------- | ------------- |
| macOS            | `clonefile()`   | サポート  | サポート      |
| Linux            | `FICLONE ioctl` | サポート  | 非サポート    |

**実装ファイル:**

- `src/utils/copy/strategies/native-clone.ts`
- `src/utils/copy/ffi/darwin.ts` (macOS)
- `src/utils/copy/ffi/linux.ts` (Linux)

### Clone

`cp`コマンドを使用したCoWコピー。

| プラットフォーム | コマンド (ファイル) | コマンド (ディレクトリ) |
| ---------------- | ------------------- | ----------------------- |
| macOS            | `cp -c`             | `cp -cR`                |
| Linux            | `cp --reflink=auto` | `cp -r --reflink=auto`  |

**実装ファイル:** `src/utils/copy/strategies/clone.ts`

### Rsync

`rsync`コマンドを使用。CoWは使用しませんが、差分コピーに優れています。

**実装ファイル:** `src/utils/copy/strategies/rsync.ts`

### Standard

Denoの標準API（`Deno.copyFile`）を使用。すべてのプラットフォームで動作する最終フォールバックです。

**実装ファイル:** `src/utils/copy/strategies/standard.ts`

## ファイルシステム要件

CoWには互換性のあるファイルシステムが必要です。

| プラットフォーム | サポート   | 非サポート |
| ---------------- | ---------- | ---------- |
| macOS            | APFS       | HFS+       |
| Linux            | Btrfs, XFS | ext4       |

サポートされていないファイルシステムでは、Standard戦略が自動的にフォールバックとして使用されます。

## 権限要件

```bash
--allow-ffi   # NativeClone戦略に必要
--allow-run   # Clone/Rsync戦略に必要（cp, rsyncコマンド）
```

## ファイル構成

```
src/utils/copy/
├── index.ts           # CopyServiceメインクラス
├── types.ts           # インターフェース定義
├── detector.ts        # 機能検出
├── validation.ts      # パス検証（コマンドインジェクション対策）
├── ffi/
│   ├── types.ts       # FFI型定義とエラーコード
│   ├── darwin.ts      # macOS clonefile FFI
│   ├── linux.ts       # Linux FICLONE FFI
│   └── detector.ts    # FFI利用可能性チェック
└── strategies/
    ├── native-clone.ts  # NativeClone戦略
    ├── clone.ts         # Clone戦略
    ├── rsync.ts         # Rsync戦略
    ├── standard.ts      # Standard戦略
    └── index.ts         # エクスポート
```

## 戦略選択メカニズム

`CopyService`は最初のディレクトリコピー操作時に最適な戦略を自動選択し、結果をキャッシュします。

```typescript
// src/utils/copy/index.ts より
async getDirectoryStrategy(): Promise<CopyStrategy> {
  // 1. NativeCloneが利用可能でディレクトリクローニングをサポートしている場合は使用
  // 2. Cloneが利用可能な場合は使用
  // 3. Rsyncが利用可能な場合は使用
  // 4. Standardにフォールバック
}
```

戦略が実行中に失敗した場合、自動的にStandard戦略にフォールバックします。
