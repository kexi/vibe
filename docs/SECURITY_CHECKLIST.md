> [!NOTE]
> :jp: [日本語版](./SECURITY_CHECKLIST.ja.md)

# CLI Security Checklist

A comprehensive security checklist for the vibe CLI tool. Each category includes the mitigation strategy used in this project.

## 1. Command Injection

- **Risk**: Arbitrary command execution via unsanitized user input
- **Mitigation**: Use `spawn()` with array arguments (never shell string concatenation)
- **Enforcement**: ESLint `security/detect-child-process` + custom security check script

## 2. Path Traversal

- **Risk**: Accessing files outside intended directories via `../` sequences
- **Mitigation**: `validatePath()` ensures paths stay within expected boundaries
- **Enforcement**: Code review + runtime validation

## 3. Symlink Attacks

- **Risk**: Following symlinks to access/modify unintended files
- **Mitigation**: `realPath()` resolution + boundary checks
- **Enforcement**: Runtime validation before file operations

## 4. TOCTOU (Time-of-Check-to-Time-of-Use) Races

- **Risk**: File state changes between security check and usage
- **Mitigation**: `verifyTrustAndRead()` performs atomic check-and-read operations
- **Enforcement**: Architectural pattern in trust verification

## 5. Environment Variable Injection

- **Risk**: Malicious values in environment variables affecting behavior
- **Mitigation**: Controlled environment variable merging with explicit allowlists
- **Enforcement**: Code review

## 6. Terminal Escape Sequence Injection

- **Risk**: Malicious escape sequences in output manipulating terminal display
- **Mitigation**: Control character filtering in user-facing output
- **Enforcement**: Output sanitization utilities

## 7. Argument Injection (`--` Option Injection)

- **Risk**: User input interpreted as command-line options (e.g., `--exec`)
- **Mitigation**: Explicit argument arrays (not string concatenation)
- **Enforcement**: `spawn()` array pattern + code review

## 8. Supply Chain Attacks

- **Risk**: Compromised dependencies introducing vulnerabilities
- **Mitigation**: Lockfile pinning + `pnpm audit` + minimum 1-day package age policy
- **Enforcement**: CI lockfile verification + `--frozen-lockfile` + `--ignore-scripts`

## 9. Unsafe Temp File Creation

- **Risk**: Predictable temp file names enabling symlink attacks
- **Mitigation**: UUID-based naming + atomic rename operations
- **Enforcement**: Code review + fast-remove implementation

## 10. Shell Output Injection

- **Risk**: Paths containing special characters (e.g., single quotes) causing shell injection when `eval`'d
- **Mitigation**: `escapeShellPath()` escapes single quotes in all `cd` output
- **Enforcement**: Custom security check script detects unescaped `cd` patterns

## 11. Configuration File Poisoning

- **Risk**: Malicious `.vibe.toml` executing arbitrary commands via hooks
- **Mitigation**: SHA-256 trust mechanism — configs must be explicitly trusted before hooks execute
- **Enforcement**: `trust`/`untrust`/`verify` commands + hash verification

## 12. Unsafe Regex (ReDoS)

- **Risk**: Regular expressions with catastrophic backtracking causing denial of service
- **Mitigation**: ESLint `security/detect-unsafe-regex` rule
- **Enforcement**: ESLint in CI + pre-commit checks

## 13. eval / Dynamic Code Execution

- **Risk**: Executing dynamically constructed code enabling arbitrary code execution
- **Mitigation**: No `eval()` or `new Function()` in production code
- **Enforcement**: ESLint `security/detect-eval-with-expression` + custom security check script
- **Exception**: `.vibedev` uses `eval` for development convenience (documented with warning)

---

## Automated Enforcement

| Tool                   | Scope            | When                      |
| ---------------------- | ---------------- | ------------------------- |
| ESLint security plugin | Static analysis  | `pnpm run lint`           |
| Custom security script | Pattern matching | `pnpm run security:check` |
| Claude Code hook       | Edit-time check  | PostToolUse (Write/Edit)  |
| CI security-check job  | PR gate          | Every push/PR             |
