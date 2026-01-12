# Copy Strategies

vibeはディレクトリコピー時にCopy-on-Write (CoW) を活用して、高速かつディスク効率の良いコピーを実現します。

## Copy-on-Write (CoW) とは

CoWはファイルシステムレベルの最適化技術です。ファイルをコピーする際、実際のデータをコピーせずメタデータのみを複製します。データは実際に変更されたときに初めてコピーされます。

**メリット:**
- コピー時間がほぼゼロ（メタデータ操作のみ）
- ディスク使用量の削減（変更がなければデータを共有）

## 戦略一覧

| 戦略 | 実装方式 | macOS (APFS) | Linux (Btrfs/XFS) |
|------|---------|--------------|-------------------|
| **NativeClone** | FFI直接呼び出し | ファイル/ディレクトリ | ファイルのみ |
| **Clone** | cp コマンド | ファイル/ディレクトリ | ファイル/ディレクトリ |
| **Rsync** | rsync コマンド | フォールバック | フォールバック |
| **Standard** | Deno API | 最終フォールバック | 最終フォールバック |

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

> **Note:** Linuxでは`NativeClone`がディレクトリクローンをサポートしないためスキップされます。

## 各戦略の詳細

### NativeClone

FFIを使用してシステムコールを直接呼び出します。プロセス生成のオーバーヘッドがないため最も高速です。

| プラットフォーム | システムコール | ファイル | ディレクトリ |
|-----------------|---------------|---------|-------------|
| macOS | `clonefile()` | 対応 | 対応 |
| Linux | `FICLONE ioctl` | 対応 | 非対応 |

**実装ファイル:**
- `src/utils/copy/strategies/native-clone.ts`
- `src/utils/copy/ffi/darwin.ts` (macOS)
- `src/utils/copy/ffi/linux.ts` (Linux)

### Clone

`cp`コマンドを使用したCoWコピーです。

| プラットフォーム | コマンド（ファイル） | コマンド（ディレクトリ） |
|-----------------|-------------------|----------------------|
| macOS | `cp -c` | `cp -cR` |
| Linux | `cp --reflink=auto` | `cp -r --reflink=auto` |

**実装ファイル:** `src/utils/copy/strategies/clone.ts`

### Rsync

`rsync`コマンドを使用します。CoWは使用しませんが、差分コピーに優れています。

**実装ファイル:** `src/utils/copy/strategies/rsync.ts`

### Standard

Denoの標準API（`Deno.copyFile`）を使用します。全プラットフォームで動作する最終フォールバックです。

**実装ファイル:** `src/utils/copy/strategies/standard.ts`

## ファイルシステム要件

CoWを利用するには対応ファイルシステムが必要です。

| プラットフォーム | 対応FS | 非対応FS |
|-----------------|--------|---------|
| macOS | APFS | HFS+ |
| Linux | Btrfs, XFS | ext4 |

非対応ファイルシステムでは自動的にStandard戦略にフォールバックします。

## 権限要件

```bash
--allow-ffi   # NativeClone戦略に必要
--allow-run   # Clone/Rsync戦略に必要（cp, rsyncコマンド実行）
```

## ファイル構造

```
src/utils/copy/
├── index.ts           # CopyService メインクラス
├── types.ts           # インターフェース定義
├── detector.ts        # 機能検出
├── validation.ts      # パス検証（コマンドインジェクション対策）
├── ffi/
│   ├── types.ts       # FFI型定義・エラーコード
│   ├── darwin.ts      # macOS clonefile FFI
│   ├── linux.ts       # Linux FICLONE FFI
│   └── detector.ts    # FFI可用性チェック
└── strategies/
    ├── native-clone.ts  # NativeClone戦略
    ├── clone.ts         # Clone戦略
    ├── rsync.ts         # Rsync戦略
    ├── standard.ts      # Standard戦略
    └── index.ts         # エクスポート
```

## 戦略選択の仕組み

`CopyService`は初回のディレクトリコピー時に最適な戦略を自動選択し、結果をキャッシュします。

```typescript
// src/utils/copy/index.ts より
async getDirectoryStrategy(): Promise<CopyStrategy> {
  // 1. NativeCloneが使用可能かつディレクトリ対応なら使用
  // 2. Cloneが使用可能なら使用
  // 3. Rsyncが使用可能なら使用
  // 4. 最終的にStandardにフォールバック
}
```

戦略が失敗した場合も自動的にStandardにフォールバックします。
