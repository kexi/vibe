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

# Skip test files and the security-check script itself
if [[ "$FILE_PATH" =~ \.(test|spec)\.ts$ ]]; then
  exit 0
fi
if [[ "$FILE_PATH" =~ security-check\.ts$ ]]; then
  exit 0
fi

ISSUES=""

# Check for eval() usage
if grep -nP '\beval\s*\(' "$FILE_PATH" 2>/dev/null; then
  ISSUES="${ISSUES}  WARNING: eval() usage detected\n"
fi

# Check for execSync() usage
if grep -nP '\bexecSync\s*\(' "$FILE_PATH" 2>/dev/null; then
  ISSUES="${ISSUES}  WARNING: execSync() usage detected. Use spawn() instead.\n"
fi

# Check for shell: true
if grep -nP 'shell\s*:\s*true' "$FILE_PATH" 2>/dev/null; then
  ISSUES="${ISSUES}  WARNING: shell: true detected. This enables shell injection.\n"
fi

# Check for unescaped cd output
if grep -nP "console\.log\(\`cd '\\\$\{(?!escapeShellPath)" "$FILE_PATH" 2>/dev/null; then
  ISSUES="${ISSUES}  WARNING: Unescaped path in cd output. Use escapeShellPath().\n"
fi

if [ -n "$ISSUES" ]; then
  echo "Security check warnings for $FILE_PATH:" >&2
  echo -e "$ISSUES" >&2
  # Exit with 0 to not block, just warn
  exit 0
fi

exit 0
