#!/bin/bash
set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')

# Skip if file doesn't exist (e.g. deleted)
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Format with Prettier
if [[ "$FILE_PATH" =~ \.(ts|tsx|js|jsx|json|md|mdx|yml|yaml|css|html)$ ]]; then
  pnpm exec prettier --write "$FILE_PATH" 2>/dev/null
fi

# Typecheck for TypeScript files
if [[ "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
  OUTPUT=$(pnpm exec tsc --noEmit 2>&1) || {
    echo "$OUTPUT" >&2
    exit 2
  }
fi

exit 0
