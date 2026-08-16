#!/usr/bin/env bash
# Everything that has to be true before a commit, as one exit code.
#
#   bun run verify && git commit ...
#
# The three checks were always being run. The problem was reading their output
# rather than acting on it: in one session a lint fix was applied but never
# committed, a typecheck was reported clean from a cache predating a schema
# change, and a commit went in over a failing test — each time because the
# result was printed next to the commit rather than standing between the work
# and it.
#
# `tsc -b --force`, not `tsc -b`. The incremental build reported a repo clean
# while it referenced three columns that no longer existed.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
# Bun is not always on the PATH of whatever shell runs this — a hook, a CI
# step, an editor task. A gate that silently reports "bun: command not found"
# as a test failure is worse than no gate.
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || { echo "  bun not found on PATH"; exit 1; }
failed=0

step() {
  local name="$1"
  shift
  printf '  %-12s ' "$name"
  local out
  if out="$("$@" 2>&1)"; then
    echo "ok"
  else
    echo "FAILED"
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
    failed=1
  fi
}

# Nothing here writes to the tree.
#
# This used to apply formatting and then compare `git status --porcelain`
# against what it was, which cannot see a change to a file that was already
# modified — every file being verified before a commit. So the gate wrote a
# fix, saw an unchanged porcelain line, and said ready: that is how a v0.3.0
# tag ended up pointing at a package.json its own CI rejects.
#
# The lint step below already fails on anything the formatter would fix, so
# checking is the whole job. Run `bunx biome check --write .` to apply.
step "typecheck" ./node_modules/.bin/tsc -b --force
if [ -x ./node_modules/.bin/biome ]; then
  step "lint" ./node_modules/.bin/biome check .
fi
step "tests" bun test

if [ "$failed" -ne 0 ]; then
  printf '\n  not ready to commit\n'
  exit 1
fi
printf '\n  ready\n'
