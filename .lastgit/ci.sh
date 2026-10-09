#!/usr/bin/env bash
# LastGit merge gate for situations (public OSS dual-home).
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== shell syntax =="
for f in .lastgit/*.sh bin/* scripts/*.sh; do
  [ -e "$f" ] || continue
  case "$f" in
    *.sh|bin/situations|bin/fsituations)
      echo "bash -n $f"
      bash -n "$f"
      ;;
  esac
done

echo "== dependencies =="
bun install --frozen-lockfile

echo "== typecheck / build =="
for f in src/*.ts; do
  [ -e "$f" ] || continue
  echo "bun build $f"
  bun build "$f" --target=bun --outfile=/dev/null
done
bun run typecheck

echo "== artifact build =="
bun run build

echo "lastgit ci gate PASSED"
