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

# The AI assistant (Phase 12): Cline, connected to DevSpace's AI gateway as an "OpenAI Compatible"
# provider, so it works with no setup. The gateway token is this copy's own (made fresh with the
# container, and only accepted from this container's address); the member's OpenRouter key never
# comes here. Cline keeps its settings in files under ~/.cline/data (secrets.json is 0600, like
# every file here); they are seeded on the container's first start only, so a member's own
# changes in Cline stay. The default model is the first of DevSpace's free models.
ai_token="${DEVSPACE_AI_TOKEN:-}"
ai_base_url="${DEVSPACE_AI_BASE_URL:-}"
ai_model="${DEVSPACE_AI_MODEL:-}"
cline_data="$HOME/.cline/data"
if [ -n "$ai_token" ] && [ ! -e "$cline_data" ]; then
  printf '%s' "$ai_token" | grep -Eq '^[A-Za-z0-9_-]{32,}$' ||
    fail "DEVSPACE_AI_TOKEN must be at least 32 characters of A-Z a-z 0-9 _ -"
  printf '%s' "$ai_base_url" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?/v1$' ||
    fail "DEVSPACE_AI_BASE_URL must look like http://<gateway host>:<port>/v1"
  printf '%s' "$ai_model" | grep -Eq '^[A-Za-z0-9._:/-]+$' ||
    fail "DEVSPACE_AI_MODEL must be a model id like qwen/qwen3.8-27b:free"
  mkdir -p "$cline_data"
  # Asks before editing files, running commands, using the browser or MCP (Cline's own default
  # would do those without asking); reading the member's files is allowed. No telemetry.
  cat >"$cline_data/globalState.json" <<EOF
{
  "actModeApiProvider": "openai",
  "planModeApiProvider": "openai",
  "openAiBaseUrl": "$ai_base_url",
  "actModeOpenAiModelId": "$ai_model",
  "planModeOpenAiModelId": "$ai_model",
  "welcomeViewCompleted": true,
  "isNewUser": false,
  "telemetrySetting": "disabled",
  "autoApprovalSettings": {
    "version": 1,
    "enabled": true,
    "favorites": [],
    "maxRequests": 20,
    "actions": {
      "readFiles": true,
      "readFilesExternally": false,
      "editFiles": false,
      "editFilesExternally": false,
      "executeSafeCommands": false,
      "executeAllCommands": false,
      "useBrowser": false,
      "useMcp": false
    },
    "enableNotifications": false
  }
}
EOF
  printf '{\n  "openAiApiKey": "%s"\n}\n' "$ai_token" >"$cline_data/secrets.json"
fi
umask 022

# Keep the tokens out of the environment of terminals and extensions.
unset DEVSPACE_CONNECTION_TOKEN token DEVSPACE_AI_TOKEN DEVSPACE_AI_BASE_URL DEVSPACE_AI_MODEL \
  ai_token ai_base_url ai_model

# Preview (Phase 11): the path DevSpace serves an app on port N under, for the member's terminals.
# The templates read these so their pages and assets work behind that path; Vite uses
# DEVSPACE_PREVIEW_BASE (port 5173).
DEVSPACE_PREVIEW_BASE_5173="$base_path/__preview/5173/"
DEVSPACE_PREVIEW_BASE_8080="$base_path/__preview/8080/"
DEVSPACE_PREVIEW_BASE="$DEVSPACE_PREVIEW_BASE_5173"
export DEVSPACE_PREVIEW_BASE_5173 DEVSPACE_PREVIEW_BASE_8080 DEVSPACE_PREVIEW_BASE

# Beginners don't know to press Ctrl+S, and DevSpace only sees saved files. So files save on
# their own after a second by default. Written only when missing: a member's own choice wins.
# (VS Code's own AI chat and its welcome walkthrough are hidden by the devspace-defaults
# script in the image: the web client ignores application-wide settings in these files.)
machine_settings="$HOME/.openvscode-server/data/Machine/settings.json"
if [ ! -e "$machine_settings" ]; then
  mkdir -p "$(dirname "$machine_settings")"
  printf '{\n  "files.autoSave": "afterDelay",\n  "files.autoSaveDelay": 1000\n}\n' >"$machine_settings"
fi

# --disable-workspace-trust (owner decision, 2026-10-01): no "Do you trust the authors?" prompt
# and no Restricted Mode, which kept Cline from loading. The folder is the member's own copy, and
# the safety boundary is the isolated container. Settings files can't change this; only this flag.
exec "$OPENVSCODE_SERVER_ROOT/bin/openvscode-server" \
  --host 0.0.0.0 \
  --port 3000 \
  --connection-token-file "$token_file" \
  --server-base-path "$base_path" \
  --default-folder /home/workspace \
  --telemetry-level off \
  --disable-workspace-trust \
  "$@"
