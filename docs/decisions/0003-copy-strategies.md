# ADR-0003: Copy-on-Write Optimization Strategies

## Status

Accepted

## Context

Vibe's `start` command copies files and directories from the main repository to worktrees. These can include:
- Large dependency directories (`node_modules/`, `vendor/`)
- Build artifacts
- Local configuration files

Naive copying of large directories is:
- Slow (especially for `node_modules` with thousands of files)
- Disk space intensive (duplicates data)
- I/O bound (bottleneck on slower storage)

Modern filesystems (APFS, Btrfs, XFS) support Copy-on-Write (CoW), which can create instant, space-efficient copies.

## Decision

We implemented a tiered copy strategy system:

### 1. Filesystem Detection

At runtime, we detect the filesystem type and capabilities:
- **macOS (APFS)**: Use `clonefile()` via FFI
- **Linux (Btrfs/XFS)**: Use `cp --reflink=auto`
- **Fallback**: Traditional recursive copy

### 2. Strategy Selection

```
src/utils/copy/
├── index.ts         # Strategy selection
├── cow-darwin.ts    # macOS APFS clonefile
├── cow-linux.ts     # Linux reflink copy
└── fallback.ts      # Cross-platform fallback
```

Strategy is selected based on:
1. Platform detection (`runtime.build.os`)
2. Filesystem capability testing
3. Graceful fallback on failure

### 3. Implementation Details

**macOS (APFS clonefile)**:
- Uses Deno FFI to call native `clonefile()` function
- Instant copy with shared data blocks
- Falls back to regular copy if clonefile fails

**Linux (reflink)**:
- Uses `cp --reflink=auto` command
- Automatically uses CoW if supported
- Falls back gracefully to regular copy

**Fallback**:
- Traditional recursive directory copy
- Works on all platforms and filesystems
- Used when CoW is unavailable or fails

## Consequences

### Positive

- **Performance**: Near-instant directory copies on supported filesystems
- **Space efficiency**: CoW shares data blocks until modification
- **Graceful degradation**: Always works, even without CoW support
- **Transparent**: Users don't need to configure anything

### Negative

- **Complexity**: Multiple code paths for different platforms
- **FFI dependency**: macOS implementation requires FFI (Deno-specific)
- **Testing burden**: Need to test on multiple filesystems

### Neutral

- Progress reporting shows which strategy is used
- Strategy selection happens once per copy operation
- Some edge cases may still fall back to regular copy
