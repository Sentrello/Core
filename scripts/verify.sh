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

# Formatting is applied, and then the tree is compared against what it was.
#
# Applying and carrying on looks helpful and is a trap: the gate passes, the
# fix is never staged, and whatever is committed or tagged next is the version
# that was never checked. That is exactly how a v0.3.0 tag ended up pointing at
# a package.json its own CI rejects — verify ran, wrote the fix, said ready,
# and the fix stayed in the working tree.
#
# So a write is now a failure. Noisy, but the alternative is silent and wrong.
if [ -x ./node_modules/.bin/biome ]; then
  before="$(git status --porcelain 2>/dev/null)"
  ./node_modules/.bin/biome check --write . >/dev/null 2>&1 || true
  after="$(git status --porcelain 2>/dev/null)"
  if [ "$before" != "$after" ]; then
    printf '  %-12s %s\n' "formatting" "APPLIED — review and stage it, then run again"
    git status --porcelain | sed 's/^/      /'
    failed=1
  fi
fi

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
