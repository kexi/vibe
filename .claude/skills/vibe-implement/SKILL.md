---
description: Implement a vibe feature, bug fix, or issue. Use when the user says "implement", "build", "fix", "develop", "work on", or references a GitHub issue/PR number (#123) or URL to implement. Runs the full cycle of design, development, and code review using specialized vibe agents.
argument-hint: "<issue#|PR#|URL|description>"
allowed-tools: Bash(gh *), Bash(git *), Bash(pnpm *), Bash(bun *), Read, Edit, Write, Glob, Grep, Agent
---

# vibe Implement

Full implementation cycle: **Design → Develop → Review** using specialized vibe agents.

**Argument**: $ARGUMENTS

---

## Step 1: Gather Context

Parse the argument to determine the input type and gather details.

### 1.1 Determine Input Type

| Pattern                       | Type        | Action                                    |
| ----------------------------- | ----------- | ----------------------------------------- |
| `#123` or `123` (number only) | Issue or PR | Fetch via `gh`                            |
| `https://github.com/...`      | GitHub URL  | Extract owner/repo/number, fetch via `gh` |
| Any other text                | Description | Use as-is                                 |

### 1.2 Fetch Details

**For Issue numbers:**

```bash
gh issue view <number> --repo kexi/vibe --json title,body,labels,comments
```

**For PR numbers:**

```bash
gh pr view <number> --repo kexi/vibe --json title,body,files,comments,reviews
```

**For GitHub URLs:**

Extract the issue/PR number from the URL and fetch as above.

### 1.3 Summarize Requirements

Compile the gathered information into a clear requirements summary:

- **What**: What needs to be done
- **Why**: Motivation or context (from issue body, labels, etc.)
- **Scope**: Which files or areas are likely affected
- **Constraints**: Any specific requirements mentioned in comments or reviews

---

## Step 2: Design (vibe-architect-expert)

Delegate to the `vibe-architect-expert` agent for architectural design.

Use the Agent tool with `subagent_type: "vibe-architect-expert"`.

**Include in the prompt:**

- The full requirements summary from Step 1
- Ask the agent to produce:
  1. Affected files and modules
  2. Which design patterns to apply (DI, Strategy, Error hierarchy, etc.)
  3. Interface changes or new types needed
  4. Security considerations (reference the 13-category checklist)
  5. Testing strategy (unit/integration/E2E)
  6. Migration concerns (if touching settings or config schema)

**Receive back**: A structured design plan with file paths and specific implementation guidance.

---

## Step 2.5: Design Security Review (vibe-security-expert)

Delegate to `vibe-security-expert` to review the design plan from Step 2.

Use the Agent tool with `subagent_type: "vibe-security-expert"`.

**Include in the prompt:**

- The requirements summary from Step 1
- The complete design plan from Step 2
- Ask the agent to identify security risks in the proposed design before implementation begins

**Receive back**: Security risks and recommendations for the design.

If risks are found, revise the design plan before proceeding to Step 3.

---

## Step 3: Develop (vibe-develop-expert)

Delegate to the `vibe-develop-expert` agent for implementation.

Use the Agent tool with `subagent_type: "vibe-develop-expert"`.

**Include in the prompt:**

- The requirements summary from Step 1
- The complete design plan from Step 2
- Instruct the agent to:
  1. Implement the changes following the design plan
  2. Follow platform conventions (all 3 OSes, all 5 shells, all 3 runtimes)
  3. Use correct terminal output patterns (stderr for messages, stdout for shell)
  4. Use proper color conventions (colorize(), warnLog(), errorLog())
  5. Add tests matching the testing strategy from Step 2
  6. Update documentation (EN/JA sync) if commands or options change

**Receive back**: Implementation complete with files modified.

---

## Step 4: Review (vibe-code-review-expert)

Delegate to the `vibe-code-review-expert` agent for code review.

Use the Agent tool with `subagent_type: "vibe-code-review-expert"`.

**Include in the prompt:**

- The requirements summary from Step 1
- Ask the agent to review all changes made in Step 3
- The agent will apply its full checklist (Security, Error Handling, Code Quality, Concurrency, Test Coverage, Platform-Specific, Documentation, CI/CD)

**Receive back**: A structured review with Critical/Warning/Suggestion findings.

---

## Step 4.5: Security Audit (vibe-security-expert)

Delegate to `vibe-security-expert` to audit all changes made in Step 3.

Use the Agent tool with `subagent_type: "vibe-security-expert"`.

**Include in the prompt:**

- The requirements summary from Step 1
- Ask the agent to audit all changes against its attack surface checklist

**Receive back**: A security audit with CRITICAL/HIGH/MEDIUM findings.

If **CRITICAL** or **HIGH** findings exist, fix them before proceeding to Step 5.

---

## Step 5: Fix Review Findings

If the review in Step 4 found **Critical** or **Warning** issues:

1. Fix each issue identified by the review
2. After fixing, re-run Step 4 (review again) to verify fixes
3. Repeat until no Critical or Warning issues remain

**Suggestion** level findings: List them for the user but do not auto-fix unless trivial.

---

## Step 6: Verify

Run all project checks to ensure nothing is broken:

```bash
pnpm run check:all
```

If any checks fail, fix the issues and re-run until all pass.

---

## Step 7: Summary

Present the final summary to the user:

```markdown
## Implementation Complete

### Requirements

- <brief description of what was implemented>

### Design Decisions

- <key architectural choices made>

### Changes

| File            | Action   | Description |
| --------------- | -------- | ----------- |
| path/to/file.ts | Modified | ...         |
| path/to/new.ts  | Created  | ...         |

### Review Results

- Critical: 0
- Warning: 0
- Suggestions: <list any remaining>

### Checks

- All checks passing ✓

### Next Steps

- <any follow-up actions needed>
```
