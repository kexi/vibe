> 🇯🇵 [日本語版](./architecture.ja.md)

# Architecture Overview

This document describes the architecture of the Vibe CLI tool.

## Runtime Abstraction Layer

Vibe supports multiple JavaScript runtimes (Deno and Node.js) through a runtime abstraction layer.

```mermaid
flowchart TD
    subgraph Application
        A[CLI Commands] --> B[AppContext]
        B --> C[Runtime Interface]
    end

    subgraph "Runtime Implementations"
        C --> D[Deno Runtime]
        C --> E[Node.js Runtime]
    end

    subgraph "Native Modules"
        D --> F["@kexi/vibe-native (N-API)"]
        E --> F
    end

    subgraph "Platform Operations"
        F --> H[clonefile/FICLONE]
        F --> I[Trash Operations]
    end
```

### Key Components

| Component | Description |
|-----------|-------------|
| CLI Commands | User-facing commands (start, clean, trust, etc.) |
| AppContext | Dependency injection container for runtime, config, and settings |
| Runtime Interface | Abstract interface for filesystem, process, environment operations |
| Deno Runtime | Deno APIs implementation with N-API native module support |
| Node.js Runtime | Node.js APIs implementation with N-API native module support |
| @kexi/vibe-native | Shared N-API module for Copy-on-Write and trash operations |

## Copy Strategy

Vibe uses different strategies for copying files and directories based on platform capabilities.

```mermaid
flowchart TD
    A[CopyService] --> B{detectCapabilities}
    B --> C{CoW Supported?}
    C -->|Yes| D[NativeCloneStrategy]
    C -->|No| E{rsync available?}
    E -->|Yes| F[RsyncStrategy]
    E -->|No| G[StandardStrategy]

    D --> H[clonefile / FICLONE]
    F --> I[rsync -a]
    G --> J[recursive copy]
```

### Strategy Selection

| Strategy | Platform | Description |
|----------|----------|-------------|
| NativeCloneStrategy | macOS (APFS), Linux (Btrfs, XFS) | Uses Copy-on-Write for instant copies |
| RsyncStrategy | Unix-like | Uses rsync for efficient copying |
| StandardStrategy | All | Recursive file-by-file copy |

## Clean Strategy

Vibe provides fast directory removal with trash support.

```mermaid
flowchart TD
    A[fastRemoveDirectory] --> B{Native Trash Available?}
    B -->|Yes| C[Native Trash Module]
    B -->|No| D{macOS?}

    C --> E[XDG Trash / Finder Trash]

    D -->|Yes| F[AppleScript Fallback]
    D -->|No| G{Same Filesystem?}

    F --> E

    G -->|Yes| H[Rename to /tmp]
    G -->|No| I[Rename to Parent Dir]

    H --> J[Background Delete]
    I --> J
```

### Trash Handling

| Method | Platform | Description |
|--------|----------|-------------|
| Native Trash | Node.js (all platforms) | Uses @kexi/vibe-native with trash crate |
| AppleScript | Deno on macOS | Fallback using Finder via osascript |
| /tmp + Background | Linux (no desktop) | Moves to /tmp and deletes in background |
| Parent Dir + Background | Cross-device | Same filesystem fallback for network mounts |

## Context and Dependency Injection

Vibe uses a simple dependency injection pattern through AppContext.

```mermaid
flowchart LR
    subgraph AppContext
        R[Runtime]
        C[Config]
        S[Settings]
    end

    subgraph Commands
        START[start]
        CLEAN[clean]
        TRUST[trust]
    end

    AppContext --> START
    AppContext --> CLEAN
    AppContext --> TRUST
```

### Benefits

1. **Testability**: Commands can be tested with mock contexts
2. **Flexibility**: Runtime can be swapped without changing command logic
3. **Configuration**: Settings and config are accessible throughout the application
