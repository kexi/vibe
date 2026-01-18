# ADR-0002: SHA-256 Hash-Based Trust Mechanism

## Status

Accepted

## Context

Vibe executes configuration files (`.vibe.toml`) that can contain arbitrary shell commands in hooks. This presents a security risk:
- Users may clone repositories with malicious configurations
- Configuration files may be modified by attackers
- Users need protection from unintended code execution

We needed a trust mechanism that:
- Prevents automatic execution of untrusted configuration
- Allows users to explicitly approve configurations
- Detects unauthorized modifications to trusted files
- Works across git repositories and worktrees

## Decision

We implemented a SHA-256 hash-based trust mechanism:

1. **Hash verification**: When a configuration file is trusted, its SHA-256 hash is stored
2. **Repository-based identification**: Files are identified by:
   - Git remote URL (primary identifier)
   - Repository root path (fallback)
   - Relative path within repository
3. **FIFO hash history**: Up to 100 hashes per file are stored (configurable via `maxHashHistory`)
4. **Atomic verification**: `verifyTrustAndRead()` reads and verifies in one operation to prevent TOCTOU attacks
5. **Interactive prompts**: Untrusted files trigger user confirmation before execution

### Storage Format (settings.json v3)

```json
{
  "version": 3,
  "permissions": {
    "allow": [
      {
        "repoId": {
          "remoteUrl": "git@github.com:user/repo.git",
          "repoRoot": "/path/to/repo"
        },
        "relativePath": ".vibe.toml",
        "hashes": ["sha256-hash-1", "sha256-hash-2"],
        "skipHashCheck": false
      }
    ],
    "deny": []
  }
}
```

## Consequences

### Positive

- **Security**: Prevents execution of modified or untrusted configurations
- **TOCTOU protection**: Atomic read-and-verify prevents race conditions
- **Flexibility**: Multiple hashes support configuration changes across branches
- **Transparency**: Users explicitly approve what code runs
- **Git-aware**: Same repository trusted regardless of clone location

### Negative

- **Initial friction**: Users must trust configurations before first use
- **Hash accumulation**: Many configuration changes accumulate hashes (mitigated by FIFO)
- **Storage growth**: Settings file grows with trusted repositories

### Neutral

- Escape hatch: `skipHashCheck` available for development (not recommended for production)
- Migration path: Automatic schema migration from older versions
