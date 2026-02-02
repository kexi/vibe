> 🇺🇸 [English](./README.md)

# @kexi/vibe-core

[Vibe CLI](https://github.com/kexi/vibe) のコアコンポーネント - ランタイム抽象化、型定義、エラー、コンテキスト管理。

## 概要

このパッケージは Vibe CLI で使用される共有コア機能を提供します：

- **ランタイム抽象化**: Deno と Node.js の両方をサポートするクロスプラットフォームランタイム層
- **型定義**: 設定スキーマと型定義（Zod を使用）
- **エラー**: 統一されたエラーハンドリングクラス
- **コンテキスト**: アプリケーションコンテキストと依存性注入

## インストール

### npm

```bash
npm install @kexi/vibe-core
```

### JSR (Deno)

```typescript
import { runtime, initRuntime } from "jsr:@kexi/vibe-core";
```

## 使用方法

### ランタイム抽象化

ランタイムモジュールは、Deno と Node.js 間でファイルシステム操作、プロセス実行、環境変数を統一的に扱うインターフェースを提供します：

```typescript
import { initRuntime, runtime } from "@kexi/vibe-core";

// アプリケーション起動時にランタイムを初期化
await initRuntime();

// 統一されたランタイム API を使用
const content = await runtime.fs.readTextFile("./config.json");
const result = await runtime.process.run({ cmd: "git", args: ["status"] });
const home = runtime.env.get("HOME");
```

### 型定義と設定

Vibe 設定ファイルのパースと検証：

```typescript
import { parseVibeConfig, type VibeConfig } from "@kexi/vibe-core";

const config = parseVibeConfig(rawData, "./vibe.toml");
```

### エラーハンドリング

一貫したエラーハンドリングのための型付きエラークラス：

```typescript
import { GitOperationError, ConfigurationError, WorktreeError } from "@kexi/vibe-core";

throw new GitOperationError("clone", "リポジトリが見つかりません");
throw new ConfigurationError("無効なフックコマンド", "./vibe.toml");
```

### コンテキスト管理

依存性注入によるアプリケーションコンテキストの管理：

```typescript
import { createAppContext, setGlobalContext, getGlobalContext } from "@kexi/vibe-core";

// 起動時にコンテキストを初期化
const ctx = createAppContext(runtime);
setGlobalContext(ctx);

// アプリケーション内のどこからでもコンテキストにアクセス
const { runtime } = getGlobalContext();
```

## API リファレンス

### エクスポート

| エクスポート                      | 説明                                               |
| --------------------------------- | -------------------------------------------------- |
| `@kexi/vibe-core`                 | すべてのエクスポートを含むメインエントリーポイント |
| `@kexi/vibe-core/runtime`         | ランタイム抽象化層                                 |
| `@kexi/vibe-core/types`           | 設定の型定義とスキーマ                             |
| `@kexi/vibe-core/errors`          | エラークラス                                       |
| `@kexi/vibe-core/context`         | コンテキスト管理                                   |
| `@kexi/vibe-core/context/testing` | テストユーティリティ                               |

### ランタイム検出

```typescript
import { IS_DENO, IS_NODE, IS_BUN, RUNTIME_NAME } from "@kexi/vibe-core";

if (IS_DENO) {
  console.log("Deno で実行中");
} else if (IS_NODE) {
  console.log("Node.js で実行中");
}
```

## ライセンス

Apache-2.0
