#!/bin/sh
# Entrypoint of the DevSpace IDE image. Checks the settings the API passes, prepares a writable
# HOME for whatever uid we run as, and starts OpenVSCode Server on port 3000.
set -eu

fail() {
  echo "devspace-ide: $*" >&2
  exit 64
}

token="${DEVSPACE_CONNECTION_TOKEN:-}"
base_path="${DEVSPACE_BASE_PATH:-}"

[ -n "$token" ] || fail "DEVSPACE_CONNECTION_TOKEN is not set"
# VS Code accepts only these characters in a connection token.
printf '%s' "$token" | grep -Eq '^[A-Za-z0-9_-]{16,}$' ||
  fail "DEVSPACE_CONNECTION_TOKEN must be at least 16 characters of A-Z a-z 0-9 _ -"

[ -n "$base_path" ] || fail "DEVSPACE_BASE_PATH is not set (expected /ide/<copyId>)"
printf '%s' "$base_path" | grep -Eq '^(/[A-Za-z0-9_-]+)+$' ||
  fail "DEVSPACE_BASE_PATH must look like /ide/<copyId> (no trailing slash)"

HOME="${HOME:-/tmp/devspace-home}"
export HOME
umask 077
mkdir -p "$HOME"
[ -w "$HOME" ] || fail "HOME ($HOME) is not writable by uid $(id -u)"

token_file="$HOME/.devspace-connection-token"
printf '%s' "$token" >"$token_file"
umask 022

# Keep the token out of the environment of terminals and extensions.
unset DEVSPACE_CONNECTION_TOKEN token

exec "$OPENVSCODE_SERVER_ROOT/bin/openvscode-server" \
  --host 0.0.0.0 \
  --port 3000 \
  --connection-token-file "$token_file" \
  --server-base-path "$base_path" \
  --default-folder /home/workspace \
  --telemetry-level off \
  "$@"
