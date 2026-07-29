> 🇺🇸 [English](./clean-strategies.md) | 🇯🇵 [日本語版](./clean-strategies.ja.md)

# Clean Strategies

> **历史说明：** 本文所述的 TypeScript 实现（`packages/core`，例如 `fast-remove.ts`）已在 Rust 移植的 Phase 6 中移除。vibe 现在是单一的 Rust 二进制文件，clean 逻辑位于 `rust/crates/vibe-core`（原生回收站支持位于 `rust/crates/vibe-native`）。本文档作为设计历史保留。

vibe 在 `vibe clean` 命令中采用了称为 “Trash Strategy（回收站策略）” 的快速删除策略，通过即时响应来提升用户体验。

## 什么是 Trash Strategy？

Trash Strategy 不会立即删除目录，而是先将其移动到临时位置。真正的删除在后台进行，因此 CLI 能够立刻把控制权交还给用户。

**优势：**

- 近乎瞬时的响应（仅执行 rename 操作）
- 更好的用户体验（无需等待大目录删除完成）
- 快速删除失败时可安全回退到标准删除

## 策略概览

| 策略         | 实现方式                | macOS        | Linux            | Windows              |
| ------------ | ----------------------- | ------------ | ---------------- | -------------------- |
| **Trash**    | 原生回收站 + 回退方案   | Finder Trash | XDG Trash / /tmp | 回收站 / %TEMP%      |
| **Standard** | git worktree remove     | 支持         | 支持             | 支持                 |

### 原生回收站支持

vibe 通过 Rust 二进制文件使用 [trash crate](https://lib.rs/crates/trash) 来提供跨平台的回收站支持：

- **macOS**：Finder Trash（与之前相同）
- **Linux**：XDG Trash (`~/.local/share/Trash`)，遵循 [FreeDesktop.org 规范](https://specifications.freedesktop.org/trash-spec/trashspec-latest.html)
- **Windows**：回收站

移动到 XDG Trash 的文件会出现在桌面环境的回收站文件夹中（GNOME Files、Dolphin、Nautilus 等），并且可以还原。

## 各平台的具体行为

### macOS

1. **首选 (Rust)**：通过 `trash` crate 移动到 Finder Trash
   - 内部使用 Rust 的 `trash` crate
   - 会出现在 Finder 的回收站文件夹中
2. **回退 (Rust/macOS)**：通过 AppleScript (`osascript`) 移动到 Finder Trash
3. **回退**：若两者都失败（例如 SSH 会话中），则回退到 /tmp + 后台删除

### Linux

1. **首选 (Rust)**：通过 `trash` crate 移动到 XDG Trash
   - 使用实现了 [XDG Trash 规范](https://specifications.freedesktop.org/trash-spec/trashspec-latest.html)的 Rust `trash` crate
   - 文件被移动到 `~/.local/share/Trash/files/`
   - 元数据保存在 `~/.local/share/Trash/info/`
   - 会出现在桌面文件管理器的回收站中（GNOME Files、Dolphin、Nautilus 等）
   - 可从文件管理器中还原
2. **回退**：若原生回收站失败（SSH 会话、无桌面环境）：
   - rename 到 `/tmp/.vibe-trash-{timestamp}-{uuid}` + `nohup rm -rf`
   - `/tmp` 会在重启时被清理
   - `nohup` 确保父进程退出后删除仍继续进行
3. **回退**：若发生跨设备错误（EXDEV），则改为 rename 到父目录

### Windows

1. **首选**：通过 Rust 的 `trash` crate 移动到回收站
2. **回退**：移动到 `%TEMP%` 目录 + 通过 `cmd /c rmdir /s /q` 在后台删除

## 策略详解

### Trash Strategy

Trash Strategy 的工作方式是：先将目标目录 rename 到一个临时位置，然后启动一个分离的后台进程来执行真正的删除。

**命名规则：** `.vibe-trash-{timestamp}-{uuid}`

示例：`.vibe-trash-1705123456789-a1b2c3d4`

**处理流程：**

1. 从 worktree 读取 `.git` 文件的内容（git worktree 清理时需要）
2. 将目录移动到回收站位置（瞬时的 rename 操作）
3. 重新创建一个包含原 `.git` 文件的空目录
4. 对该空目录执行 `git worktree remove --force`（非常快）
5. 启动一个分离的后台进程来删除已移入回收站的目录

**清理机制：**

`cleanup_stale_trash()` 函数会扫描并删除残留的 `.vibe-trash-*` 目录，范围包括：

- 被删除 worktree 的父目录
- 系统临时目录

该清理会在每次 clean 操作后自动执行。

**实现文件：** `rust/crates/vibe-core/src/fast_remove.rs`

### Standard Strategy

使用标准的 `git worktree remove` 命令。当 Trash Strategy 失败或被禁用时，作为回退方案使用。

**实现文件：** `rust/crates/vibe-core/src/commands/clean.rs`

## 配置

### User Settings (~/.config/vibe/settings.json)

```json
{
  "clean": {
    "fast_remove": true
  }
}
```

| 设置项              | 类型    | 默认值  | 说明                       |
| ------------------- | ------- | ------- | -------------------------- |
| `clean.fast_remove` | boolean | `true`  | 启用/禁用 Trash Strategy   |

### Project Config (vibe.toml)

```toml
[clean]
delete_branch = false

[hooks]
pre_clean = ["npm run clean"]
post_clean = ["echo 'Cleanup complete'"]
```

| 设置项                | 类型     | 默认值  | 说明                            |
| --------------------- | -------- | ------- | ------------------------------- |
| `clean.delete_branch` | boolean  | `false` | 删除 worktree 后一并删除分支    |
| `hooks.pre_clean`     | string[] | `[]`    | 清理前执行的命令                |
| `hooks.post_clean`    | string[] | `[]`    | 清理后执行的命令                |

## 文件结构

```
rust/crates/
├── vibe-native/
│   └── src/lib.rs        # 通过 trash crate 实现的跨平台回收站绑定
└── vibe-core/src/
    ├── fast_remove.rs    # Trash Strategy 实现
    │   ├── is_fast_remove_supported()
    │   ├── trash_name()
    │   ├── move_to_system_trash()        # 原生回收站 + 平台回退方案
    │   ├── move_to_macos_trash_via_osascript()
    │   ├── spawn_background_delete()
    │   ├── fast_remove_directory()
    │   └── cleanup_stale_trash()
    └── commands/
        └── clean.rs      # Clean 命令实现
```

**函数说明：**

| 函数                                  | 说明                            |
| ------------------------------------- | ------------------------------- |
| `is_fast_remove_supported()`          | 检查是否支持快速删除            |
| `trash_name()`                        | 生成唯一的回收站目录名          |
| `move_to_system_trash()`              | 原生回收站 + 平台专属回退方案   |
| `move_to_macos_trash_via_osascript()` | Rust macOS Finder Trash 回退方案 |
| `spawn_background_delete()`           | 分离的后台删除                  |
| `fast_remove_directory()`             | 快速删除的主函数                |
| `cleanup_stale_trash()`               | 清理残留的回收站目录            |

## 策略选择机制

clean 命令会根据用户设置自动选择合适的策略：

```rust
// From rust/crates/vibe-core/src/commands/clean.rs
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
        // Recreate the empty worktree marker and let Git unregister it.
        cleanup_stale_trash(deps.io, &deps.spawner, &parent);
        return Ok(());
    }

    // Fall through to Standard Strategy.
}

// Standard Strategy: git worktree remove
```

如果 Trash Strategy 因任何原因失败（权限、跨设备错误等），系统会自动回退到 Standard Strategy。
