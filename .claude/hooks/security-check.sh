#!/bin/bash
set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')

# Skip if file doesn't exist or is not a .ts file
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi
if [[ ! "$FILE_PATH" =~ \.ts$ ]]; then
  exit 0
fi

# Skip test files
if [[ "$FILE_PATH" =~ \.(test|spec)\.ts$ ]]; then
  exit 0
fi

# Run ESLint security rules on the file (non-blocking)
pnpm exec eslint --no-warn-ignored --rule '{}' "$FILE_PATH" 2>&1 | grep -E "no-eval|no-new-func|no-restricted-imports|no-restricted-syntax|no-unescaped-cd-output" >&2 || true

exit 0
