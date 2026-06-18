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
- **Mitigation**: `validate_path` (`rust/crates/vibe-core/src/copy/types.rs`) plus canonicalize + containment checks in `repo_info.rs` keep paths within expected boundaries
- **Enforcement**: Code review + runtime validation

## 3. Symlink Attacks

- **Risk**: Following symlinks to access/modify unintended files
- **Mitigation**: `std::fs::canonicalize` resolution + containment checks (both sides canonicalized); glob expansion rejects symlink entries
- **Enforcement**: Runtime validation before file operations

## 4. TOCTOU (Time-of-Check-to-Time-of-Use) Races

- **Risk**: File state changes between security check and usage
- **Mitigation**: `verify_trust_and_read` (`rust/crates/vibe-core/src/settings_io.rs`) reads the file once and hashes that exact content (no re-read)
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

- **Risk**: Compromised upstream packages, malicious lifecycle scripts, exfiltration from build runners, or hijacked publish tokens — see e.g. the [TanStack npm compromise (2026-05-11)](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)
- **Mitigation** (layered):
  - **Registry hardening**: Takumi Guard proxy (`.github/actions/setup-takumi-guard`) intercepts known-malicious packages; `minimumReleaseAge: 4320` (72 h) quarantine in `pnpm-workspace.yaml` blocks freshly published versions
  - **No exotic sources**: `blockExoticSubdeps: true` rejects `github:user/repo`, `file:`, `http:` and other non-registry dependencies anywhere in the graph (defeats the wormable `optionalDependencies: github:<sha>` technique)
  - **Lifecycle scripts off by default**: `strictDepBuilds: true` + explicit `only-built-dependencies` allowlist (currently `node-pty` only, see `.npmrc`); `--ignore-scripts` on every `pnpm install` and `pnpm publish` invocation in CI
  - **Trust monotonicity**: `trustPolicy: no-downgrade` aborts installation when a package transitions to a less-trusted state
  - **Lockfile pinning**: `--frozen-lockfile` in every CI install step
  - **Workflow integrity**: All third-party GitHub Actions pinned to full commit SHA (`pinact-verify` job blocks unpinned references); the toolchain is pinned reproducibly via `flake.lock` (and `rust-toolchain.toml` for Rust)
  - **Runner egress visibility**: `step-security/harden-runner` (audit mode) on every job logs outbound network traffic and `/proc` access, surfacing exfiltration channels such as the `*.getsession.org` C2 used by Shai-Hulud
  - **Publish provenance**: `npm publish --provenance` on every release for OIDC-signed attestation
  - **Secret scanning**: `gitleaks` (config `.gitleaks.toml`) blocks credentials from entering the repo — staged-change scan in the `pre-commit` hook (`lefthook.yml`) and a full-history scan in the `gitleaks` CI job
- **Enforcement**: `pinact-verify` CI job + `pnpm install --frozen-lockfile --ignore-scripts` in CI + `pnpm publish ... --ignore-scripts` + `gitleaks` CI job + Harden-Runner Insights review after each release

### Responding to a gitleaks detection

A gitleaks hit means the secret is already in the working tree or git history and must be treated as compromised:

1. **Rotate immediately**: revoke/rotate the leaked credential at its source (the provider) before anything else — once committed it must be assumed public.
2. **Purge from history**: consider rewriting history (e.g. `git filter-repo`) to remove the secret, recognizing the old value stays compromised regardless.
3. **Allowlist only for false positives**: add a value/regex entry to `.gitleaks.toml` only when the match is genuinely not a secret — never to silence a real leak.

## 9. Unsafe Temp File Creation

- **Risk**: Predictable temp file names enabling symlink attacks
- **Mitigation**: UUID-based naming + atomic rename operations
- **Enforcement**: Code review + fast-remove implementation

## 10. Shell Output Injection

- **Risk**: Paths containing special characters (e.g., single quotes) causing shell injection when `eval`'d
- **Mitigation**: `shell_escape()` (`rust/crates/vibe-core/src/shell.rs`) escapes single quotes in all `cd` output
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
- **Note**: The shell wrapper itself `eval`s vibe's `cd` output by design; that output is single-quote escaped (see "Shell Output Injection" above)

---

## Automated Enforcement

| Tool                   | Scope            | When                                                     |
| ---------------------- | ---------------- | -------------------------------------------------------- |
| ESLint security plugin | Static analysis  | `pnpm run lint`                                          |
| Custom security script | Pattern matching | `pnpm run security:check`                                |
| Claude Code hook       | Edit-time check  | PostToolUse (Write/Edit)                                 |
| CI security-check job  | PR gate          | Every push/PR                                            |
| gitleaks               | Secret scanning  | `pre-commit` (staged) + CI `gitleaks` job (full history) |
