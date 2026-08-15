#!/bin/sh
# vibe [summary] example: let Claude Code describe what each worktree is doing.
#
# Sends the whole batch to the `claude` CLI in ONE prompt and asks for a JSON
# object back. This is the case the batch protocol exists for: an LLM call per
# worktree would cost N round trips and N times the tokens, and a model that
# sees every branch at once can answer comparatively ("the only one touching the
# parser") instead of describing each in isolation.
#
# Requires: jq, git, and the `claude` CLI on PATH (https://claude.com/claude-code).
# Unix only (vibe runs the command through /bin/sh).
#
# Usage — put this in .vibe.toml at the repository root and run `vibe trust`:
#
#   [summary]
#   command = "./examples/summary/claude.sh"
#   timeout_seconds = 120     # an LLM call is far slower than the 30s default
#
# Protocol
#   stdin : {"worktrees":[{"name":..,"path":..,"base":..|null,"head":..|null}]}
#   stdout: {"<name>":"<summary>"}
#
# Cost note: vibe caches per worktree and only asks about the ones whose HEAD or
# working tree changed, so a repeated `vibe list` costs nothing. Still, keep the
# timeout generous — a killed call falls back to the previous (cached) answer.
set -eu

payload=$(cat)

# Enrich each worktree with its recent commit subjects, so the model has
# something to summarize beyond a branch name. `git -C` keeps each log scoped to
# that worktree; `|| true` keeps one unreadable worktree from aborting the batch.
context=$(printf '%s' "$payload" | jq -r '.worktrees[] | "\(.name)\t\(.path)"' |
    while IFS="$(printf '\t')" read -r name path; do
        log=$(git -C "$path" log -5 --format='- %s' 2>/dev/null || true)
        # `--arg`/`-c` so the log's quotes and backslashes are escaped properly.
        jq -c -n --arg name "$name" --arg log "$log" '{name: $name, recent_commits: $log}'
    done | jq -s '{worktrees: .}')

prompt='You are labelling git worktrees for a compact terminal table.

For each worktree in the JSON below, write ONE short phrase (at most 60
characters) describing what work it holds. Base it on the branch name and the
recent commits. Be specific and comparative where the branches overlap.

Reply with ONLY a JSON object mapping each worktree name to its phrase. No
markdown, no code fence, no commentary.

'

# `-p` is the non-interactive (one-shot) mode.
#
# Each stage is run and checked SEPARATELY rather than as one
# `a | b | c || echo '{}'` pipeline. Two reasons, both of which bit the first
# draft of this script:
#
#  1. Under `set -e`, only the LAST command of a pipeline determines the
#     pipeline's status (there is no `pipefail` in POSIX sh), so a `claude` that
#     died would be masked by a `jq` that happily formatted its empty input.
#  2. A trailing `|| echo '{}'` fires on the pipeline's status, not on the stage
#     that actually failed — so a partially-successful run could print jq's
#     output AND the fallback, which is not valid JSON at all.
#
# Splitting the stages makes each failure explicit and guarantees exactly one
# JSON document reaches stdout.
answer=$(printf '%s%s' "$prompt" "$context" | claude -p 2>/dev/null) || answer=""

if [ -z "$answer" ]; then
    # The model could not be reached (offline, not logged in, rate limited).
    # An empty object is a valid answer meaning "no summaries this run"; vibe
    # keeps whatever it had cached and the column simply does not update.
    echo '{}'
    exit 0
fi

# The model is asked for bare JSON, but a code fence still slips through
# occasionally; strip it before validating.
answer=$(printf '%s' "$answer" | sed -e 's/^```json$//' -e 's/^```$//')

# `jq -c .` normalizes AND validates: vibe rejects non-JSON stdout outright, so
# a malformed answer would cost the whole batch. Better a blank column this run.
# Captured first, printed once, so a jq that fails halfway cannot emit a partial
# document followed by the fallback.
normalized=$(printf '%s' "$answer" | jq -c '.' 2>/dev/null) || normalized=""
[ -n "$normalized" ] || normalized='{}'
printf '%s\n' "$normalized"
