---
globs: "packages/core/src/**/*.ts"
---

# Security Rules

## Guidelines

- SHA-256 based configuration trust mechanism
- Use Node.js `spawn` (avoid shell string execution)
- Path validation with `validatePath()`
- Shell output escaping with `escapeShellPath()` for all `cd` output
- ESLint security plugin (`eslint-plugin-security`) and custom `vibe-security` rules for static analysis
- See [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md) for the full 13-category CLI security checklist
