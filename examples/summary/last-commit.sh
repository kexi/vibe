#!/bin/sh
# vibe [summary] example: show each worktree's latest commit subject.
#
# Reads the batch document vibe writes to stdin and answers with the subject
# line of each worktree's HEAD commit. Nothing is generated: the answer is a
# fact git already knows, which makes this the cheapest way to see what every
# worktree is currently sitting on.
#
# Requires: jq, git. Unix only (vibe runs the command through /bin/sh).
#
# Usage — put this in .vibe.toml at the repository root and run `vibe trust`:
#
#   [summary]
#   command = "./examples/summary/last-commit.sh"
#   timeout_seconds = 10
#
# Protocol
#   stdin : {"worktrees":[{"name":..,"path":..,"base":..|null,"head":..|null}]}
#   stdout: {"<name>":"<summary>"}
#
# Why the whole answer is built in one `jq` invocation rather than a shell loop
# appending strings: a summary containing a quote or a backslash has to be
# JSON-escaped, and `jq` is the only tool here that does that correctly. Building
# the document by hand with `printf` produces invalid JSON the moment a commit
# subject contains a `"`.
set -eu

# Read the batch once; it is needed twice (to iterate, and to build the answer).
payload=$(cat)

# `-r` so the paths come out unquoted; NUL-separated would be better but the
# POSIX `read` loop below cannot consume NULs. A worktree path containing a
# newline would break this — that is a limitation of the example, not of vibe.
printf '%s' "$payload" | jq -r '.worktrees[] | "\(.name)\t\(.path)"' | while IFS="$(printf '\t')" read -r name path; do
    # `git -C` so the subject comes from THAT worktree's HEAD. A worktree with no
    # commits (or one git cannot read) yields an empty subject; the `|| true`
    # keeps `set -e` from aborting the whole batch over one bad row.
    subject=$(git -C "$path" log -1 --format=%s 2>/dev/null || true)
    [ -n "$subject" ] || continue
    # One JSON object per line, merged below. `--arg` does the escaping.
    jq -c -n --arg name "$name" --arg subject "$subject" '{($name): $subject}'
done | jq -s 'add // {}'
