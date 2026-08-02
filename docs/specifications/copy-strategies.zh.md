> 🇺🇸 [English](./copy-strategies.md) | 🇯🇵 [日本語版](./copy-strategies.ja.md)

# 复制策略

> **历史说明：** 本文所述的 TypeScript 实现（Deno API / `packages/core`）已在 Rust 移植的 Phase 6 中移除。vibe 现在是单一的 Rust 二进制文件，复制逻辑位于 `rust/crates/vibe-core`（原生 CoW 位于 `rust/crates/vibe-native`）。本文档作为设计历史保留。

vibe 在目录复制中利用 Copy-on-Write (CoW)，以实现快速且节省磁盘空间的操作。

## 什么是 Copy-on-Write (CoW)？

CoW 是一种文件系统层面的优化技术。复制文件时，只复制元数据而非实际数据。只有在数据真正被修改时才会执行复制。

**优势：**

- 复制耗时接近于零（仅涉及元数据操作）
- 减少磁盘占用（在被修改之前数据是共享的）

## 策略概览

| 策略            | 实现方式      | macOS (APFS)   | Linux (Btrfs/XFS) |
| --------------- | ------------- | -------------- | ----------------- |
| **NativeClone** | 直接 FFI 调用 | 文件/目录      | 仅文件            |
| **Clone**       | cp 命令       | 文件/目录      | 文件/目录         |
| **Rsync**       | rsync 命令    | 回退方案       | 回退方案          |
| **Standard**    | Deno API      | 最终回退方案   | 最终回退方案      |

## 各平台的优先级顺序

### macOS (APFS)

```
Directory copy: NativeClone → Clone → Rsync → Standard
File copy: Standard (Deno.copyFile)
```

### Linux (Btrfs/XFS)

```
Directory copy: Clone → Rsync → Standard
File copy: Standard (Deno.copyFile)
```

> **注意：** 在 Linux 上会跳过 `NativeClone`，因为它不支持目录克隆。

## 策略详解

### NativeClone

通过 FFI 直接调用系统调用。由于没有进程创建的开销，这是最快的方案。

| 平台  | 系统调用        | 文件 | 目录   |
| ----- | --------------- | ---- | ------ |
| macOS | `clonefile()`   | 支持 | 支持   |
| Linux | `FICLONE ioctl` | 支持 | 不支持 |

**实现文件：**

- `packages/core/src/utils/copy/strategies/native-clone.ts`
- `packages/core/src/utils/copy/ffi/darwin.ts` (macOS)
- `packages/core/src/utils/copy/ffi/linux.ts` (Linux)

### Clone

使用 `cp` 命令进行 CoW 复制。

| 平台  | 命令（文件）        | 命令（目录）           |
| ----- | ------------------- | ---------------------- |
| macOS | `cp -c`             | `cp -cR`               |
| Linux | `cp --reflink=auto` | `cp -r --reflink=auto` |

**实现文件：** `packages/core/src/utils/copy/strategies/clone.ts`

### Rsync

使用 `rsync` 命令。虽然不使用 CoW，但在增量复制方面表现出色。

**实现文件：** `packages/core/src/utils/copy/strategies/rsync.ts`

### Standard

使用 Deno 的标准 API（`Deno.copyFile`）。这是在所有平台上都可用的最终回退方案。

**实现文件：** `packages/core/src/utils/copy/strategies/standard.ts`

## 文件系统要求

CoW 需要文件系统的支持。

| 平台  | 支持       | 不支持 |
| ----- | ---------- | ------ |
| macOS | APFS       | HFS+   |
| Linux | Btrfs, XFS | ext4   |

在不支持的文件系统上，会自动使用 Standard 策略作为回退方案。

## 权限要求

```bash
--allow-ffi   # Required for NativeClone strategy
--allow-run   # Required for Clone/Rsync strategies (cp, rsync commands)
```

## 文件结构

```
packages/core/src/utils/copy/
├── index.ts           # CopyService 主类
├── types.ts           # 接口定义
├── detector.ts        # 能力检测
├── validation.ts      # 路径校验（防止命令注入）
├── ffi/
│   ├── types.ts       # FFI 类型定义与错误码
│   ├── darwin.ts      # macOS clonefile FFI
│   ├── linux.ts       # Linux FICLONE FFI
│   └── detector.ts    # FFI 可用性检查
└── strategies/
    ├── native-clone.ts  # NativeClone 策略
    ├── clone.ts         # Clone 策略
    ├── rsync.ts         # Rsync 策略
    ├── standard.ts      # Standard 策略
    └── index.ts         # 导出
```

## 策略选择机制

`CopyService` 会在首次执行目录复制操作时自动选择最优策略，并缓存该结果。

```typescript
// From packages/core/src/utils/copy/index.ts
async getDirectoryStrategy(): Promise<CopyStrategy> {
  // 1. Use NativeClone if available and supports directory cloning
  // 2. Use Clone if available
  // 3. Use Rsync if available
  // 4. Fall back to Standard
}
```

如果某个策略在执行过程中失败，会自动回退到 Standard 策略。
