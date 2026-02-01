# @kexi/vibe-native

Native Copy-on-Write (CoW) file cloning for Node.js using Rust (napi-rs).

## Features

- **macOS**: Uses `clonefile()` syscall on APFS filesystems
- **Linux**: Uses `FICLONE` ioctl on Btrfs/XFS filesystems
- **Zero-copy**: Creates instant file clones without copying data
- **Async/Sync**: Both async and sync APIs available
- **Type-safe**: Full TypeScript support with auto-generated types

## Installation

```bash
npm install @kexi/vibe-native
# or
pnpm add @kexi/vibe-native
```

## Platform Support

| Platform | Architecture | Filesystem                |
| -------- | ------------ | ------------------------- |
| macOS    | x64, arm64   | APFS                      |
| Linux    | x64, arm64   | Btrfs, XFS (with reflink) |

## Usage

```typescript
import {
  cloneAsync,
  cloneSync,
  isAvailable,
  supportsDirectory,
  getPlatform,
} from "@kexi/vibe-native";

// Check if native cloning is available
if (isAvailable()) {
  console.log(`Platform: ${getPlatform()}`);
  console.log(`Directory cloning: ${supportsDirectory()}`);

  // Async cloning (recommended)
  await cloneAsync("/path/to/source", "/path/to/dest");

  // Sync cloning
  cloneSync("/path/to/source", "/path/to/dest");
}
```

## API

### `cloneAsync(src: string, dest: string): Promise<void>`

Clone a file or directory asynchronously using native Copy-on-Write.

### `cloneSync(src: string, dest: string): void`

Clone a file or directory synchronously using native Copy-on-Write.

### `clone(src: string, dest: string): void`

Alias for `cloneSync` (for backward compatibility).

### `isAvailable(): boolean`

Check if native clone operations are available on the current platform.

### `supportsDirectory(): boolean`

Check if directory cloning is supported:

- macOS (`clonefile`): `true`
- Linux (`FICLONE`): `false` (files only)

### `getPlatform(): "darwin" | "linux" | "unknown"`

Get the current platform identifier.

## Security

### File Type Validation

Only regular files and directories are allowed. The following are rejected:

- Symlinks (to prevent path traversal)
- Device files (block/character devices)
- Sockets
- FIFOs (named pipes)

### Path Handling

This library does not perform path normalization or validation. Callers should:

- Validate paths before calling clone functions
- Use `path.resolve()` to normalize relative paths
- Check for symlinks if path traversal is a concern

```typescript
import { resolve, dirname } from "path";
import { realpath } from "fs/promises";

// Example: Safe path handling
async function safeClone(src: string, dest: string, allowedDir: string) {
  const resolvedSrc = await realpath(resolve(src));
  const resolvedDest = resolve(dest);

  // Verify paths are within allowed directory
  if (!resolvedSrc.startsWith(allowedDir)) {
    throw new Error("Source path outside allowed directory");
  }
  if (!resolvedDest.startsWith(allowedDir)) {
    throw new Error("Destination path outside allowed directory");
  }

  await cloneAsync(resolvedSrc, resolvedDest);
}
```

## Error Handling

Errors include system errno information for debugging:

```typescript
try {
  await cloneAsync("/nonexistent", "/dest");
} catch (error) {
  // Error: open source failed: No such file or directory (errno 2)
  console.error(error.message);
}
```

## Filesystem Requirements

### macOS

- **APFS** is required for `clonefile()` to work
- HFS+ and other filesystems will return `ENOTSUP`

### Linux

- **Btrfs** or **XFS** (with reflink support) is required
- ext4 and other filesystems will return `EOPNOTSUPP`

## Building from Source

```bash
# Install dependencies
pnpm install

# Build (requires Rust toolchain)
pnpm run build

# Run tests
cargo test
```

## License

Apache-2.0
