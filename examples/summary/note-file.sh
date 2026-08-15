#!/bin/sh
# vibe [summary] example: show a note you wrote yourself, per worktree.
#
# Each worktree's summary is the first line of its `.vibe/note.txt`. Nothing is
# derived and nothing is generated — you decide what a worktree is "about" and
# write it down:
#
#   echo "waiting on review from the API team" > .vibe/note.txt
#
# This is the example to start from when git history does not answer the
# question you actually have ("which of these am I blocked on?").
#
# Requires: jq. Unix only (vibe runs the command through /bin/sh).
#
# Usage — put this in .vibe.toml at the repository root and run `vibe trust`:
#
#   [summary]
#   command = "./examples/summary/note-file.sh"
#   timeout_seconds = 5
#
# Protocol
#   stdin : {"worktrees":[{"name":..,"path":..,"base":..|null,"head":..|null}]}
#   stdout: {"<name>":"<summary>"}
#
# Tip: add `.vibe/note.txt` to `.git/info/exclude` (or commit it deliberately).
# vibe already truncates a summary to its first line, but this reads only the
# first line anyway so the file can hold longer notes below it.
set -eu

cat | jq -r '.worktrees[] | "\(.name)\t\(.path)"' | while IFS="$(printf '\t')" read -r name path; do
    note_file="$path/.vibe/note.txt"
    [ -f "$note_file" ] || continue
    # `head -n 1` because the rest of the file is the user's scratch space.
    note=$(head -n 1 "$note_file")
    [ -n "$note" ] || continue
    # `--arg` handles the JSON escaping; a note containing a quote is routine.
    jq -c -n --arg name "$name" --arg note "$note" '{($name): $note}'
done | jq -s 'add // {}'
