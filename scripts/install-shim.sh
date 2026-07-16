#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${SITUATIONS_INSTALL_DIRECT:-}" != "1" ] && [ -x "$repo_root/scripts/refresh-host.sh" ]; then
  exec "$repo_root/scripts/refresh-host.sh" "$@"
fi

source_bin="$repo_root/bin/situations"

if [ ! -x "$source_bin" ]; then
  echo "situations shim source is not executable: $source_bin" >&2
  exit 1
fi

if [ "${SITUATIONS_INSTALL_BIN:-}" ]; then
  install_bin=$SITUATIONS_INSTALL_BIN
elif [ "${FSITUATIONS_INSTALL_BIN:-}" ]; then
  install_bin=$FSITUATIONS_INSTALL_BIN
elif [ -d "$HOME/.local/bin" ] || case ":$PATH:" in *":$HOME/.local/bin:"*) true ;; *) false ;; esac; then
  install_bin=$HOME/.local/bin
elif case ":$PATH:" in *":$HOME/bin:"*) true ;; *) false ;; esac; then
  install_bin=$HOME/bin
else
  install_bin=$HOME/.local/bin
fi

mkdir -p "$install_bin"
ln -sf "$source_bin" "$install_bin/situations"
ln -sf "$source_bin" "$install_bin/fsituations"

echo "Installed situations shim: $install_bin/situations -> $source_bin"
echo "Installed fsituations compatibility shim: $install_bin/fsituations -> $source_bin"
