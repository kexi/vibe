---
description: Run all checks (lint, typecheck, tests)
allowed-tools: Bash(pnpm *), Bash(bun *)
---

# vibe Check All

Run all quality and security checks for the project. Fix any issues found automatically when possible.

Security checks are integrated into the Lint step via ESLint rules.

---

## Steps

Run each check sequentially. Track which checks pass and which fail.

### 1. Format Check

```bash
pnpm run fmt:check
```

If formatting issues are found, run `pnpm run fmt` to fix them, then re-check.

### 2. Lint (includes security rules)

```bash
pnpm run lint
```

If lint errors are found, run `pnpm run lint:fix` to auto-fix, then re-check.

### 3. Type Check

```bash
pnpm run check
```

If type errors are found, analyze the errors and suggest fixes.

### 4. Tests

```bash
pnpm run test
```

If tests fail, analyze the failures and suggest fixes.

### 5. Docs Check

```bash
pnpm run check:docs
```

### 6. Video Check

```bash
pnpm run check:video
```

---

## Summary

After all checks complete, provide a summary:

```
## Check Results

| Check           | Status |
| --------------- | ------ |
| Format          | ...    |
| Lint            | ...    |
| Type Check      | ...    |
| Tests           | ...    |
| Docs            | ...    |
| Video           | ...    |
```

If all checks pass, confirm the project is ready for PR.
If any checks fail, list the remaining issues that need manual attention.
