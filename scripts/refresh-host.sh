#!/usr/bin/env sh
set -eu

app=situations
remote=${SITUATIONS_HOST_TRACK_REMOTE:-lastdb:///situations}
branch=${SITUATIONS_HOST_TRACK_BRANCH:-main}
host_root=${HOST_TRACK_HOME:-"$HOME/.host-track"}
host_track=${SITUATIONS_HOST_TRACK_DIR:-"$host_root/$app"}
install_bin=${SITUATIONS_INSTALL_BIN:-${FSITUATIONS_INSTALL_BIN:-"$HOME/.local/bin"}}
stamp_dir=${HOST_TRACK_STAMP_DIR:-"$HOME/.host-track/stamps"}

if [ "${1:-}" = "--help" ]; then
  cat <<'EOF'
Usage: scripts/refresh-host.sh [--force]

Fast-forward ~/.host-track/situations from lastdb:///situations main, then link
~/.local/bin/situations and ~/.local/bin/fsituations to that host-track checkout.
EOF
  exit 0
fi
if [ "${1:-}" = "--force" ]; then
  shift
fi
[ "$#" -eq 0 ] || {
  echo "usage: scripts/refresh-host.sh [--force]" >&2
  exit 2
}

mkdir -p "$host_root" "$install_bin" "$stamp_dir"

if [ ! -d "$host_track/.git" ]; then
  rm -rf "$host_track"
  git clone "$remote" "$host_track"
fi

git -C "$host_track" remote get-url lastgit >/dev/null 2>&1 \
  || git -C "$host_track" remote add lastgit "$remote"
git -C "$host_track" fetch lastgit "$branch"
if ! git -C "$host_track" diff --quiet || ! git -C "$host_track" diff --cached --quiet; then
  echo "situations host track has local changes; refusing to refresh: $host_track" >&2
  exit 1
fi
current_branch=$(git -C "$host_track" branch --show-current || true)
if [ "$current_branch" != "$branch" ]; then
  git -C "$host_track" checkout "$branch" 2>/dev/null \
    || git -C "$host_track" checkout -b "$branch" "lastgit/$branch"
fi
git -C "$host_track" merge --ff-only "lastgit/$branch"

source_bin="$host_track/bin/situations"
if [ ! -x "$source_bin" ]; then
  echo "situations shim source is not executable: $source_bin" >&2
  exit 1
fi

ln -sf "$source_bin" "$install_bin/situations"
ln -sf "$source_bin" "$install_bin/fsituations"

host_head=$(git -C "$host_track" rev-parse HEAD)
gate_head=$(git -C "$host_track" ls-remote "$remote" "refs/heads/$branch" | awk 'NR == 1 {print $1}')
exec_path=$(command -v situations 2>/dev/null || printf '%s/situations' "$install_bin")
stamp="$stamp_dir/$app.json"

jq -n \
  --arg app "$app" \
  --arg command "situations" \
  --arg gate "lastgit" \
  --arg gate_main "$remote#$branch" \
  --arg host_track "$host_track" \
  --arg host_head "$host_head" \
  --arg gate_head "$gate_head" \
  --arg exec_path "$exec_path" \
  --arg kind "B checkout-shim" \
  --arg refreshed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    app: $app,
    command: $command,
    gate: $gate,
    gate_main: $gate_main,
    host_track: $host_track,
    host_head: $host_head,
    gate_head: $gate_head,
    exec_path: $exec_path,
    kind: $kind,
    stale: ($host_head != $gate_head),
    refreshed_at: $refreshed_at
  }' > "$stamp"

echo "Refreshed situations host track: $host_track@$host_head"
echo "Installed situations shim: $install_bin/situations -> $source_bin"
echo "Installed fsituations compatibility shim: $install_bin/fsituations -> $source_bin"
