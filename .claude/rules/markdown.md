# Markdown File Synchronization Rules

## Naming Convention

- `*.md` - English version (default)
- `*.ja.md` - Japanese version

## Synchronization Requirements

When creating or modifying markdown files, ensure both language versions are kept in sync:

1. **Creating a new file**: If you create `example.md`, also create `example.ja.md` with Japanese translation
2. **Modifying content**: When updating `example.md`, also update `example.ja.md` to reflect the same changes
3. **Structural consistency**: Both versions must have the same structure (headings, sections, lists)

## Translation Guidelines

- Translate content naturally, not word-for-word
- Keep code blocks, file paths, and technical terms unchanged
- Dates: English uses `YYYY-MM-DD`, Japanese uses `YYYY年M月D日`

## Exceptions

The following files are excluded from this rule:

- `README.md` (single language is acceptable)
- Files in `node_modules/`
- Auto-generated files
