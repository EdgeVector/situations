#!/usr/bin/env sh
set -eu
exec "$HOME/.local/bin/lastdb" app upgrade situations "$@"
