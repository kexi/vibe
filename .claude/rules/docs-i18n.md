---
globs: "packages/docs/src/content/docs/**/*.mdx"
---

# Documentation i18n Synchronization Rules

## Directory Structure

- `packages/docs/src/content/docs/*.mdx` - English version (default, Starlight `root` locale)
- `packages/docs/src/content/docs/ja/*.mdx` - Japanese version
- `packages/docs/src/content/docs/zh/*.mdx` - Simplified Chinese version

Each translated locale mirrors the English directory structure under its own
subdirectory:

```
packages/docs/src/content/docs/
├── changelog.mdx              ← English
├── getting-started.mdx
├── commands/
│   ├── start.mdx
│   └── clean.mdx
├── ja/
│   ├── changelog.mdx          ← Japanese
│   ├── getting-started.mdx
│   └── commands/
│       ├── start.mdx
│       └── clean.mdx
└── zh/
    ├── changelog.mdx          ← Simplified Chinese
    ├── getting-started.mdx
    └── commands/
        ├── start.mdx
        └── clean.mdx
```

The locales themselves are declared in `packages/docs/astro.config.ts`
(`locales` + the per-entry `sidebar` `translations`); adding a locale directory
without registering it there leaves the pages unreachable from the language
picker.

## Synchronization Requirements

When modifying any `.mdx` file under `packages/docs/src/content/docs/`, **always update its counterparts in the other two locales**:

1. **Editing an English file** → Update the corresponding `ja/` and `zh/` files
2. **Editing a translated file** → Update the English file and the remaining translation
3. **Creating a new English file** → Also create the `ja/` and `zh/` versions with translations
4. **Deleting a file** → Delete all three versions

`just check-i18n` asserts that the three sets of
relative paths are identical, so an unmirrored page fails CI.

## Path Mapping

| English                                     | Japanese                                       | Simplified Chinese                             |
| ------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `packages/docs/src/content/docs/<path>.mdx` | `packages/docs/src/content/docs/ja/<path>.mdx` | `packages/docs/src/content/docs/zh/<path>.mdx` |

Examples:

- `changelog.mdx` ↔ `ja/changelog.mdx` ↔ `zh/changelog.mdx`
- `commands/start.mdx` ↔ `ja/commands/start.mdx` ↔ `zh/commands/start.mdx`
- `configuration/hooks.mdx` ↔ `ja/configuration/hooks.mdx` ↔ `zh/configuration/hooks.mdx`

## Translation Guidelines

- Translate content naturally, not word-for-word
- Keep code blocks, CLI commands, file paths, and technical terms unchanged
- Dates: English uses `YYYY-MM-DD`, Japanese uses `YYYY年M月D日`, Simplified
  Chinese uses `YYYY年M月D日`
- Chinese translations use **Simplified Chinese (zh-CN)** and mainland
  conventions; do not mix in Japanese kanji forms or Traditional Chinese
- Frontmatter `title` and `description` should be translated
- Sidebar labels live in `astro.config.ts`, not in the frontmatter: a new sidebar
  entry needs `translations: { ja: "…", zh: "…" }`
- Keep Mermaid diagrams identical (node labels can be translated if needed)
