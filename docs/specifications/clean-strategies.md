> 🇯🇵 [日本語版](./clean-strategies.ja.md)

# Clean Strategies

vibe uses a fast removal strategy called "Trash Strategy" for the `vibe clean` command to improve user experience through instant response times.

## What is Trash Strategy?

Trash Strategy moves directories to a temporary location instead of deleting them immediately. The actual deletion happens in the background, allowing the CLI to return control to the user instantly.

**Benefits:**

- Near-instant response (rename operation only)
- Better user experience (no waiting for large directories to be deleted)
- Safe fallback to standard deletion if fast removal fails

## Strategy Overview

| Strategy     | Implementation             | macOS              | Linux                 | Windows               |
| ------------ | -------------------------- | ------------------ | --------------------- | --------------------- |
| **Trash**    | mv + background delete     | Finder Trash       | /tmp + nohup rm       | %TEMP% + background   |
| **Standard** | git worktree remove        | Supported          | Supported             | Supported             |

## Platform-specific Behavior

### macOS

1. **Primary**: Move to Finder Trash via AppleScript (`osascript`)
   - Uses the native macOS trash mechanism
   - Appears in Finder's Trash folder
2. **Fallback**: If Finder is unavailable (e.g., SSH session), falls back to /tmp + background deletion

### Linux

1. **Primary**: Rename to `/tmp/.vibe-trash-{timestamp}-{uuid}` + `nohup rm -rf`
   - `/tmp` is cleaned on reboot
   - `nohup` ensures deletion continues even after parent process exits
2. **Fallback**: If cross-device error (EXDEV) occurs, rename to parent directory instead

### Windows

1. **Primary**: Move to `%TEMP%` directory + background deletion via `cmd /c start /b rd /s /q`

## Strategy Details

### Trash Strategy

The Trash Strategy works by renaming the target directory to a temporary location, then spawning a detached background process to perform the actual deletion.

**Naming convention:** `.vibe-trash-{timestamp}-{uuid}`

Example: `.vibe-trash-1705123456789-a1b2c3d4`

**Process flow:**

1. Read the `.git` file content from the worktree (needed for git worktree cleanup)
2. Move the directory to trash location (instant rename operation)
3. Recreate an empty directory with the original `.git` file
4. Run `git worktree remove --force` on the empty directory (very fast)
5. Spawn a detached background process to delete the trashed directory

**Cleanup mechanism:**

The `cleanupStaleTrash()` function scans for and removes any leftover `.vibe-trash-*` directories from:
- The parent directory of the removed worktree
- The system temp directory

This cleanup runs automatically after each clean operation.

**Implementation file:** `packages/core/src/utils/fast-remove.ts`

### Standard Strategy

Uses the standard `git worktree remove` command. This is used as a fallback when the Trash Strategy fails or is disabled.

**Implementation file:** `packages/core/src/commands/clean.ts`

## Configuration

### User Settings (~/.config/vibe/settings.json)

```json
{
  "clean": {
    "fast_remove": true
  }
}
```

| Setting              | Type    | Default | Description                        |
| -------------------- | ------- | ------- | ---------------------------------- |
| `clean.fast_remove`  | boolean | `true`  | Enable/disable Trash Strategy      |

### Project Config (vibe.toml)

```toml
[clean]
delete_branch = false

[hooks]
pre_clean = ["npm run clean"]
post_clean = ["echo 'Cleanup complete'"]
```

| Setting                | Type     | Default | Description                              |
| ---------------------- | -------- | ------- | ---------------------------------------- |
| `clean.delete_branch`  | boolean  | `false` | Delete the branch after removing worktree |
| `hooks.pre_clean`      | string[] | `[]`    | Commands to run before cleaning          |
| `hooks.post_clean`     | string[] | `[]`    | Commands to run after cleaning           |

## File Structure

```
packages/core/src/
├── utils/
│   └── fast-remove.ts    # Trash Strategy implementation
│       ├── isFastRemoveSupported()    # Check platform support
│       ├── generateTrashName()        # Generate unique trash dir name
│       ├── moveToMacOSTrash()         # macOS Finder trash
│       ├── spawnBackgroundDelete()    # Detached background deletion
│       ├── fastRemoveDirectory()      # Main fast removal function
│       └── cleanupStaleTrash()        # Cleanup leftover trash dirs
└── commands/
    └── clean.ts          # Clean command implementation
```

## Strategy Selection Mechanism

The clean command automatically selects the appropriate strategy based on user settings:

```typescript
// From packages/core/src/commands/clean.ts
const settings = await loadUserSettings(ctx);
const useFastRemove = settings.clean?.fast_remove ?? true; // Default: true

if (useFastRemove && isFastRemoveSupported()) {
  // Try Trash Strategy
  const result = await fastRemoveDirectory(worktreePath, ctx);
  if (result.success) {
    // Success - perform git worktree cleanup
    return;
  }
  // Fall through to Standard Strategy
}

// Standard Strategy: git worktree remove
```

If the Trash Strategy fails for any reason (permissions, cross-device errors, etc.), the system automatically falls back to the Standard Strategy.
