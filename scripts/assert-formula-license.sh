#!/usr/bin/env bash
# Fail unless a Homebrew formula declares vibe's MIT license.
#
# The tap is a separately-published statement of vibe's license; a formula
# still claiming the pre-v3 Apache-2.0 terms must not ship (#553). Kept as a
# shell script (not TypeScript like the other release scripts) because the
# tap-push steps run with the tap repo as cwd, where only bash and the
# ../vibe-source checkout are guaranteed — no project toolchain is set up.
#
# Usage: assert-formula-license.sh <formula-path>
set -euo pipefail

formula="${1:?usage: assert-formula-license.sh <formula-path>}"

if ! grep -q 'license "MIT"' "$formula"; then
  echo "::error::${formula} does not declare license \"MIT\" (vibe is MIT-licensed from v3.0.0)"
  grep -n "license" "$formula" || true
  exit 1
fi
