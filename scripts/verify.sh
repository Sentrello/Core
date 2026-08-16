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

# Formatting is applied rather than only reported — then checked below, so
# anything it could not fix still fails instead of being carried silently.
if [ -x ./node_modules/.bin/biome ]; then
  ./node_modules/.bin/biome check --write . >/dev/null 2>&1 || true
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
