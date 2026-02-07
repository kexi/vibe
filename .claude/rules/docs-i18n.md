# Documentation i18n Synchronization Rules

## Glob Pattern

`packages/docs/src/content/docs/**/*.mdx`

## Directory Structure

- `packages/docs/src/content/docs/*.mdx` - English version (default)
- `packages/docs/src/content/docs/ja/*.mdx` - Japanese version

The Japanese version mirrors the English directory structure under the `ja/` subdirectory:

```
packages/docs/src/content/docs/
├── changelog.mdx              ← English
├── getting-started.mdx
├── commands/
│   ├── start.mdx
│   └── clean.mdx
└── ja/
    ├── changelog.mdx          ← Japanese
    ├── getting-started.mdx
    └── commands/
        ├── start.mdx
        └── clean.mdx
```

## Synchronization Requirements

When modifying any `.mdx` file under `packages/docs/src/content/docs/`, **always update its counterpart**:

1. **Editing an English file** → Update the corresponding `ja/` file
2. **Editing a Japanese file** → Update the corresponding English file
3. **Creating a new English file** → Also create the `ja/` version with Japanese translation
4. **Deleting a file** → Delete both versions

## Path Mapping

| English | Japanese |
|---------|----------|
| `packages/docs/src/content/docs/<path>.mdx` | `packages/docs/src/content/docs/ja/<path>.mdx` |

Examples:
- `changelog.mdx` ↔ `ja/changelog.mdx`
- `commands/start.mdx` ↔ `ja/commands/start.mdx`
- `configuration/hooks.mdx` ↔ `ja/configuration/hooks.mdx`

## Translation Guidelines

- Translate content naturally, not word-for-word
- Keep code blocks, CLI commands, file paths, and technical terms unchanged
- Dates: English uses `YYYY-MM-DD`, Japanese uses `YYYY年M月D日`
- Frontmatter `title` and `description` should be translated
- Keep Mermaid diagrams identical (node labels can be translated if needed)
