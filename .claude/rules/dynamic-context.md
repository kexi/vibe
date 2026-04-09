# Dynamic Context in Skills and Agents

## Single Source of Truth

Do not hardcode values in `.claude/skills/` or `.claude/agents/` markdown files when the information can be obtained from a file or command at runtime.

## Format

Use `!`command arg1 arg2..`` to expand command output into the prompt context.

Examples:

- !`cat .mise.toml` — tool/runtime versions
- !`gh pr diff` — current PR changes
- !`cat package.json` — project metadata

## When to Use

- The information changes over time (versions, config, state)
- A file or command is the authoritative source
- The agent/skill does not need to process the output conditionally

## When NOT to Use

- The output needs conditional logic before use (read the file with a tool instead)
- The command has side effects
- The information is static design knowledge that never changes

## Placement

Place `!`command`` in the relevant section of the agent/skill, not in a generic "first step". For example, `!`cat .mise.toml`` belongs in the runtime section, not at the top of the file.
