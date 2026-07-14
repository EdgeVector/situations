#!/usr/bin/env bash
# Push LastGit main → GitHub public mirror for situations.
# Usage: .lastgit/sync-github-mirror.sh [--once]
set -euo pipefail
export LASTGIT_SOCKET="${LASTGIT_SOCKET:-$HOME/.lastgit/code/data/folddb.sock}"
export LASTGIT_SCHEMA_MAP="${LASTGIT_SCHEMA_MAP:-$HOME/.lastgit/schema-map.json}"
export PATH="$HOME/code/edgevector/lastgit/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
export LASTGIT_MIRROR_CLONE="${LASTGIT_MIRROR_CLONE:-$HOME/.lastgit/mirror-clones/situations}"
export LASTGIT_MIRROR_REMOTE_URL="${LASTGIT_MIRROR_REMOTE_URL:-https://github.com/EdgeVector/situations.git}"
export LASTGIT_MIRROR_SOURCE_URL="${LASTGIT_MIRROR_SOURCE_URL:-lastdb:///situations}"
export LASTGIT_MIRROR_SOURCE_REMOTE=lastgit
export LASTGIT_MIRROR_REMOTE=origin
export LASTGIT_MIRROR_INTERVAL="${LASTGIT_MIRROR_INTERVAL:-60}"

if [ ! -d "$LASTGIT_MIRROR_CLONE/.git" ]; then
  mkdir -p "$(dirname "$LASTGIT_MIRROR_CLONE")"
  git -c lastgit.socket="$LASTGIT_SOCKET" clone -q "$LASTGIT_MIRROR_SOURCE_URL" "$LASTGIT_MIRROR_CLONE"
  git -C "$LASTGIT_MIRROR_CLONE" config lastgit.socket "$LASTGIT_SOCKET"
  if git -C "$LASTGIT_MIRROR_CLONE" remote get-url origin >/dev/null 2>&1; then
    git -C "$LASTGIT_MIRROR_CLONE" remote set-url origin "$LASTGIT_MIRROR_REMOTE_URL"
  else
    git -C "$LASTGIT_MIRROR_CLONE" remote add origin "$LASTGIT_MIRROR_REMOTE_URL"
  fi
fi

MODE="${1:-}"
exec "$HOME/code/edgevector/lastgit/.lastgit/sync-github-mirror.sh" situations $MODE
