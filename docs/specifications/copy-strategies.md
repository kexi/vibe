# Copy Strategies

vibe leverages Copy-on-Write (CoW) and platform-native tools for directory copying to achieve fast and disk-efficient operations.

## What is Copy-on-Write (CoW)?

CoW is a filesystem-level optimization technique. When copying a file, only metadata is duplicated instead of the actual data. Data is only copied when it is actually modified.

**Benefits:**

- Near-zero copy time (metadata operations only)
- Reduced disk usage (data is shared until modified)

## Strategy Overview

| Strategy        | Implementation   | macOS (APFS)   | Linux (Btrfs/XFS) | Windows (NTFS) |
| --------------- | ---------------- | -------------- | ----------------- | -------------- |
| **NativeClone** | Direct FFI calls | File/Directory | File only         | -              |
| **Clone**       | cp command       | File/Directory | File/Directory    | -              |
| **Rsync**       | rsync command    | Fallback       | Fallback          | -              |
| **Robocopy**    | robocopy command | -              | -                 | Multi-threaded |
| **Standard**    | Runtime API      | Final fallback | Final fallback    | Final fallback |

## Platform-specific Priority Order

### macOS (APFS)

```
Directory copy: NativeClone → Clone → Rsync → Standard
File copy: Standard (runtime API)
```

### Linux (Btrfs/XFS)

```
Directory copy: Clone → Rsync → Standard
File copy: Standard (runtime API)
```

> **Note:** On Linux, `NativeClone` is skipped because it does not support directory cloning.

### Windows (NTFS)

```
Directory copy: Robocopy → Standard
File copy: Standard (runtime API)
```

> **Note:** On Windows, CoW strategies (NativeClone, Clone) and Rsync are not available. Robocopy provides multi-threaded copying via the `/MT` flag.

## Strategy Details

### NativeClone

Invokes system calls directly via FFI. This is the fastest option as there is no process spawning overhead.

| Platform | System Call     | File      | Directory     |
| -------- | --------------- | --------- | ------------- |
| macOS    | `clonefile()`   | Supported | Supported     |
| Linux    | `FICLONE ioctl` | Supported | Not supported |

**Implementation files:**

- `packages/core/src/utils/copy/strategies/native-clone.ts`
- `packages/core/src/utils/copy/ffi/darwin.ts` (macOS)
- `packages/core/src/utils/copy/ffi/linux.ts` (Linux)

### Clone

CoW copy using the `cp` command.

| Platform | Command (File)      | Command (Directory)    |
| -------- | ------------------- | ---------------------- |
| macOS    | `cp -c`             | `cp -cR`               |
| Linux    | `cp --reflink=auto` | `cp -r --reflink=auto` |

**Implementation file:** `packages/core/src/utils/copy/strategies/clone.ts`

### Rsync

Uses the `rsync` command. Does not use CoW but excels at incremental copying.

**Implementation file:** `packages/core/src/utils/copy/strategies/rsync.ts`

### Robocopy

Uses Windows built-in `robocopy` command with multi-threaded copying. Available only on Windows.

| Flag         | Purpose                                    |
| ------------ | ------------------------------------------ |
| `/E`         | Copy subdirectories including empty ones   |
| `/MT`        | Multi-threaded copying (default 8 threads) |
| `/COPY:DAT`  | Copy Data, Attributes, Timestamps          |
| `/DCOPY:DAT` | Copy Directory timestamps and attributes   |

> **Note:** `/PURGE` and `/MIR` are intentionally not used to prevent data loss.

**Exit codes:** robocopy uses non-standard exit codes. Codes 0-7 indicate success, while 8 and above indicate errors.

**Implementation file:** `packages/core/src/utils/copy/strategies/robocopy.ts`

### Standard

Uses the runtime's built-in copy API (`node:fs/promises` `cp()`). This is the final fallback that works on all platforms.

**Implementation file:** `packages/core/src/utils/copy/strategies/standard.ts`

## Filesystem Requirements

CoW requires a compatible filesystem.

| Platform | Supported  | Not Supported |
| -------- | ---------- | ------------- |
| macOS    | APFS       | HFS+          |
| Linux    | Btrfs, XFS | ext4          |
| Windows  | -          | NTFS (no CoW) |

On unsupported filesystems, the Standard strategy is automatically used as a fallback. On Windows, Robocopy is used as the primary strategy instead of CoW.

## Permission Requirements

```bash
--allow-ffi   # Required for NativeClone strategy
--allow-run   # Required for Clone/Rsync/Robocopy strategies (cp, rsync, robocopy commands)
```

## File Structure

```
packages/core/src/utils/copy/
├── index.ts           # CopyService main class
├── types.ts           # Interface definitions
├── detector.ts        # Capability detection
├── validation.ts      # Path validation (command injection prevention)
├── ffi/
│   ├── types.ts       # FFI type definitions and error codes
│   ├── darwin.ts      # macOS clonefile FFI
│   ├── linux.ts       # Linux FICLONE FFI
│   └── detector.ts    # FFI availability check
└── strategies/
    ├── native-clone.ts  # NativeClone strategy
    ├── clone.ts         # Clone strategy
    ├── rsync.ts         # Rsync strategy
    ├── robocopy.ts      # Robocopy strategy (Windows)
    ├── standard.ts      # Standard strategy
    └── index.ts         # Exports
```

## Strategy Selection Mechanism

`CopyService` automatically selects the optimal strategy on the first directory copy operation and caches the result.

```typescript
// From packages/core/src/utils/copy/index.ts
async getDirectoryStrategy(): Promise<CopyStrategy> {
  // 1. Use NativeClone if available and supports directory cloning
  // 2. Use Clone if available
  // 3. Use Rsync if available
  // 4. Use Robocopy if available (Windows)
  // 5. Fall back to Standard
}
```

If a strategy fails during execution, it automatically falls back to the Standard strategy.
