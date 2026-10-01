#!/usr/bin/env bash
# Checks the IDE image, network and firewall on a real container, started the way the API starts
# it (Phase 5 contract): random uid:gid, all capabilities dropped, no-new-privileges, 1 CPU,
# 2 GB memory without extra swap, 512 pids, only a temp folder mounted, network devspace-ide.
#
# Needs: image devspace-ide:5 (npm run ide:build), scripts/ide-network.sh and, as root,
# scripts/ide-firewall.sh. Exits non-zero on the first failed check. Used in CI.
set -euo pipefail

IMAGE=devspace-ide:5
NETWORK=devspace-ide
RUN_ID="check-$$"
IDE="devspace-ide-$RUN_ID"
PROBE="devspace-ide-probe-$RUN_ID"
BASE_PATH="/ide/$RUN_ID"
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
USER_ID="$((20000 + RANDOM % 10000)):$((20000 + RANDOM % 10000))"
# The AI gateway (Phase 12): same defaults as the API and scripts/ide-firewall.sh.
AI_GATEWAY_HOST="${AI_GATEWAY_HOST:-10.213.0.1}"
AI_GATEWAY_PORT="${AI_GATEWAY_PORT:-3200}"
AI_TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
AI_BASE_URL="http://$AI_GATEWAY_HOST:$AI_GATEWAY_PORT/v1"
AI_MODEL="qwen/qwen3.8-27b:free"
WORKSPACE="$(mktemp -d)"
failures=0

cleanup() {
  docker rm -f "$IDE" "$PROBE" >/dev/null 2>&1 || true
  # Files written inside belong to the random uid; remove them from a container as that uid.
  docker run --rm --user "$USER_ID" --entrypoint sh -v "$WORKSPACE:/w" "$IMAGE" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rmdir "$WORKSPACE" 2>/dev/null || true
}
trap cleanup EXIT

pass() { echo "  ok   $1"; }
fail() {
  echo "  FAIL $1" >&2
  failures=$((failures + 1))
}
expect() { # description, expected, actual
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}

run_restricted() { # name, extra args...
  local name="$1"
  shift
  docker run -d --name "$name" --network "$NETWORK" --user "$USER_ID" \
    --cap-drop ALL --security-opt no-new-privileges \
    --cpus 1 --memory 2g --memory-swap 2g --pids-limit 512 "$@" >/dev/null
}

echo "IDE image"
echo "hello from the copy" >"$WORKSPACE/hello.txt"
chmod 0777 "$WORKSPACE"
chmod 0666 "$WORKSPACE/hello.txt"
run_restricted "$IDE" \
  -e DEVSPACE_CONNECTION_TOKEN="$TOKEN" -e DEVSPACE_BASE_PATH="$BASE_PATH" \
  -e DEVSPACE_AI_TOKEN="$AI_TOKEN" -e DEVSPACE_AI_BASE_URL="$AI_BASE_URL" -e DEVSPACE_AI_MODEL="$AI_MODEL" \
  -v "$WORKSPACE:/home/workspace" "$IMAGE"
IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$IDE")"
URL="http://$IP:3000$BASE_PATH"

for _ in $(seq 1 60); do
  curl -s -o /dev/null "$URL/version" && break
  sleep 1
done
code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

expect "readiness $BASE_PATH/version without token" 200 "$(code "$URL/version")"
expect "workbench without token is refused" 403 "$(code "$URL/")"
expect "workbench with a wrong token is refused" 403 "$(code -H 'Cookie: vscode-tkn=wrong-token-wrong-token' "$URL/")"
expect "workbench with the token cookie" 200 "$(code -H "Cookie: vscode-tkn=$TOKEN" "$URL/")"
if curl -s -H "Cookie: vscode-tkn=$TOKEN" "$URL/" | grep -q 'workbench'; then pass "the page is VS Code's workbench"; else fail "the page is not VS Code's workbench"; fi
expect "runs as the given uid:gid" "$USER_ID" "$(docker exec "$IDE" sh -c 'echo "$(id -u):$(id -g)"')"
expect "HOME is writable" yes "$(docker exec "$IDE" sh -c '[ -w "$HOME" ] && echo yes || echo no')"
expect "no capabilities" 0000000000000000 "$(docker exec "$IDE" sh -c "awk '/^CapEff/ {print \$2}' /proc/1/status")"
expect "no-new-privileges" 1 "$(docker exec "$IDE" sh -c "awk '/^NoNewPrivs/ {print \$2}' /proc/1/status")"
expect "the copy is mounted at /home/workspace" "hello from the copy" "$(docker exec "$IDE" cat /home/workspace/hello.txt)"
expect "no sudo in the image" no "$(docker exec "$IDE" sh -c 'command -v sudo >/dev/null && echo yes || echo no')"
expect "no Docker socket" no "$(docker exec "$IDE" sh -c '[ -e /var/run/docker.sock ] && echo yes || echo no')"
expect "Node.js 24" v24 "$(docker exec "$IDE" sh -c 'node --version | cut -d. -f1')"
expect "npm install in the copy (cache in HOME)" installed "$(docker exec "$IDE" sh -c \
  'cd /home/workspace && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0 >/dev/null 2>&1 \
   && node -e "require(\"is-number\")" && [ -d "$HOME/.npm/_cacache" ] && echo installed || echo failed')"
expect "npm install -g goes to HOME" installed "$(docker exec "$IDE" sh -c \
  'npm install -g --no-audit --no-fund is-number@7.0.0 >/dev/null 2>&1 \
   && [ -d "$HOME/.npm-global/lib/node_modules/is-number" ] && echo installed || echo failed')"

# Python (Phase 11): python3, pip to HOME, and a venv inside the copy, all as the random uid.
expect "Python 3" "Python 3" "$(docker exec "$IDE" sh -c 'python3 --version | cut -d. -f1')"
expect "pip install goes to HOME (~/.local)" installed "$(docker exec "$IDE" sh -c \
  'python3 -m pip install --no-cache-dir --disable-pip-version-check six==1.17.0 >/dev/null 2>&1 \
   && python3 -c "import six, os; assert six.__file__.startswith(os.environ[\"HOME\"] + \"/.local/\")" \
   && echo installed || echo failed')"
expect "a venv in the copy, with pip" installed "$(docker exec "$IDE" sh -c \
  'cd /home/workspace && python3 -m venv .venv >/dev/null 2>&1 \
   && .venv/bin/pip install --no-cache-dir --disable-pip-version-check six==1.17.0 >/dev/null 2>&1 \
   && .venv/bin/python -c "import six; assert six.__file__.startswith(\"/home/workspace/.venv/\")" \
   && echo installed || echo failed')"

# Preview (Phase 11): the server (the first process after tini), and so every terminal, has the
# preview paths; the connection token stays out of its environment.
server_env() {
  docker exec "$IDE" sh -c 'pid="$(ls /proc | grep -E "^[0-9]+$" | sort -n | sed -n 2p)"; tr "\0" "\n" <"/proc/$pid/environ"'
}
expect "DEVSPACE_PREVIEW_BASE_8080 in the server's env" "DEVSPACE_PREVIEW_BASE_8080=$BASE_PATH/__preview/8080/" \
  "$(server_env | grep '^DEVSPACE_PREVIEW_BASE_8080=' || true)"
expect "DEVSPACE_PREVIEW_BASE_5173 in the server's env" "DEVSPACE_PREVIEW_BASE_5173=$BASE_PATH/__preview/5173/" \
  "$(server_env | grep '^DEVSPACE_PREVIEW_BASE_5173=' || true)"
expect "DEVSPACE_PREVIEW_BASE is the 5173 one" "DEVSPACE_PREVIEW_BASE=$BASE_PATH/__preview/5173/" \
  "$(server_env | grep '^DEVSPACE_PREVIEW_BASE=' || true)"
expect "no connection token in the server's env" 0 "$(server_env | grep -c '^DEVSPACE_CONNECTION_TOKEN=' || true)"

expect "tracker extension installed outside HOME" yes "$(docker exec "$IDE" sh -c   '[ -f "$OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/dist/extension.js" ] && grep -q "\"name\": \"devspace-tracker\"" "$OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/package.json" && echo yes || echo no')"
expect "the member cannot move or delete the tracker" kept "$(docker exec "$IDE" sh -c   'd="$OPENVSCODE_SERVER_ROOT/extensions"; mv "$d/devspace-tracker" "$d/moved" 2>/dev/null; rm -rf "$d/devspace-tracker" 2>/dev/null;    [ -f "$d/devspace-tracker/dist/extension.js" ] && echo kept || echo gone')"

# The AI assistant (Phase 12): Cline, pinned, outside HOME and owned by root, connected to the
# gateway by start.sh; the gateway settings are gone from the environment and its files are private.
cline_ext='$OPENVSCODE_SERVER_ROOT/extensions/saoudrizwan.claude-dev'
expect "Cline installed outside HOME, owned by root" "4.1.22 0:0" "$(docker exec "$IDE" sh -c \
  "d=$cline_ext; v=\$(grep -m1 -o '\"version\": \"[^\"]*\"' \"\$d/package.json\" | cut -d'\"' -f4); echo \"\$v \$(stat -c %u:%g \"\$d/dist/extension.js\")\"")"
expect "the member cannot move or delete Cline" kept "$(docker exec "$IDE" sh -c \
  "d=$cline_ext; mv \"\$d\" \"\$d-moved\" 2>/dev/null; rm -rf \"\$d\" 2>/dev/null; [ -f \"\$d/dist/extension.js\" ] && echo kept || echo gone")"
cline_json() { # file under ~/.cline/data, python expression on `d`
  docker exec "$IDE" sh -c "cat \"\$HOME/.cline/data/$1\"" 2>/dev/null |
    python3 -c "import json, sys; d = json.load(sys.stdin); print($2)" 2>/dev/null || echo missing
}
expect "Cline's provider is OpenAI Compatible (act and plan)" "openai openai" \
  "$(cline_json globalState.json "d['actModeApiProvider'], d['planModeApiProvider']")"
expect "Cline's base URL is the gateway" "$AI_BASE_URL" "$(cline_json globalState.json "d['openAiBaseUrl']")"
expect "Cline's model is DEVSPACE_AI_MODEL" "$AI_MODEL" "$(cline_json globalState.json "d['actModeOpenAiModelId']")"
expect "Cline's welcome screen is skipped" True "$(cline_json globalState.json "d['welcomeViewCompleted']")"
expect "Cline's telemetry is off" disabled "$(cline_json globalState.json "d['telemetrySetting']")"
expect "Cline asks before edits, commands, browser and MCP" "False False False False False False" \
  "$(cline_json globalState.json "*[d['autoApprovalSettings']['actions'][k] for k in ['editFiles', 'editFilesExternally', 'executeSafeCommands', 'executeAllCommands', 'useBrowser', 'useMcp']]")"
expect "Cline's API key is the gateway token" yes \
  "$(cline_json secrets.json "'yes' if d['openAiApiKey'] == '$AI_TOKEN' else 'no'")"
expect "Cline's files are private to the member" "700 600 600" "$(docker exec "$IDE" sh -c \
  'cd "$HOME/.cline/data" && stat -c %a . secrets.json globalState.json | tr "\n" " " | sed "s/ $//"')"
for var in DEVSPACE_AI_TOKEN DEVSPACE_AI_BASE_URL DEVSPACE_AI_MODEL; do
  expect "no $var in the server's (and so terminals') env" 0 "$(server_env | grep -c "^$var=" || true)"
done
# Every process the server started (extension hosts, the terminals' pty host, …), not tini or
# `docker exec`, which get the container's settings from Docker itself.
expect "the gateway token is in none of the server's processes" 0 "$(docker exec "$IDE" sh -c "
  server=\$(ls /proc | grep -E '^[0-9]+\$' | sort -n | sed -n 2p); n=0; hits=0
  for p in /proc/[0-9]*; do
    pid=\${p#/proc/}; a=\$pid
    while [ \"\$a\" -gt 1 ] && [ \"\$a\" != \"\$server\" ]; do a=\$(awk '/^PPid/ {print \$2}' /proc/\$a/status 2>/dev/null || echo 0); done
    [ \"\$a\" = \"\$server\" ] || continue
    n=\$((n + 1)); tr '\0' '\n' <\$p/environ 2>/dev/null | grep -q -- '$AI_TOKEN' && hits=\$((hits + 1))
  done
  [ \$n -ge 1 ] && echo \$hits || echo 'no server process'")"

echo "Network isolation (from a second container on $NETWORK)"
run_restricted "$PROBE" --entrypoint sleep "$IMAGE" 300
probe() { docker exec "$PROBE" sh -c "$1" 2>/dev/null || true; }
reach() { # host, port -> open | blocked
  probe "curl -s -m 5 -o /dev/null telnet://$1:$2 </dev/null; rc=\$?; [ \$rc -eq 0 ] || [ \$rc -eq 52 ] && echo open || echo blocked"
}
# The bridge's own address, read from the interface: some Docker versions (GitHub's runners)
# leave IPAM.Config's Gateway empty when it wasn't set explicitly.
GATEWAY="$(ip -4 -o addr show dev br-dsp-ide | awk '{print $4}' | cut -d/ -f1 | head -n1)"
HOST_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')"
# An empty address would make a "blocked" result meaningless.
for ip in "$GATEWAY" "$HOST_IP"; do
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FAIL: could not find the gateway or host address (got '$GATEWAY' / '$HOST_IP')"; exit 1; }
done

# A listener on the host, on all addresses, standing in for the API: the host can reach it, so a
# failed connection from the probe is the firewall and not an empty port.
LISTEN_PORT="$((40000 + RANDOM % 10000))"
python3 -m http.server "$LISTEN_PORT" --bind 0.0.0.0 >/dev/null 2>&1 &
LISTENER=$!
trap 'kill $LISTENER 2>/dev/null || true; cleanup' EXIT
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://$HOST_IP:$LISTEN_PORT/" && break
  sleep 0.5
done
expect "the host reaches its own listener $HOST_IP:$LISTEN_PORT" 200 "$(code "http://$HOST_IP:$LISTEN_PORT/")"

# The AI gateway's address (Phase 12): the API's gateway when it is running, else a stand-in
# listener on exactly that address and port.
GATEWAY_LISTENER=""
if ! curl -s -m 3 -o /dev/null "http://$AI_GATEWAY_HOST:$AI_GATEWAY_PORT/"; then
  python3 -m http.server "$AI_GATEWAY_PORT" --bind "$AI_GATEWAY_HOST" >/dev/null 2>&1 &
  GATEWAY_LISTENER=$!
  trap 'kill $LISTENER $GATEWAY_LISTENER 2>/dev/null || true; cleanup' EXIT
  for _ in $(seq 1 20); do
    curl -s -o /dev/null "http://$AI_GATEWAY_HOST:$AI_GATEWAY_PORT/" && break
    sleep 0.5
  done
fi

expect "internet (https://example.com)" 200 "$(probe "curl -s -m 15 -o /dev/null -w '%{http_code}' https://example.com")"
expect "other IDE container $IP:3000" blocked "$(reach "$IP" 3000)"
expect "host via bridge gateway $GATEWAY:$LISTEN_PORT" blocked "$(reach "$GATEWAY" "$LISTEN_PORT")"
expect "host via $HOST_IP:$LISTEN_PORT" blocked "$(reach "$HOST_IP" "$LISTEN_PORT")"
expect "host via docker0 172.17.0.1:$LISTEN_PORT" blocked "$(reach 172.17.0.1 "$LISTEN_PORT")"
expect "private 10.0.0.1:80" blocked "$(reach 10.0.0.1 80)"
expect "private 172.16.0.1:80" blocked "$(reach 172.16.0.1 80)"
expect "private 192.168.1.1:80" blocked "$(reach 192.168.1.1 80)"
expect "link-local 169.254.169.254:80" blocked "$(reach 169.254.169.254 80)"
# Phase 12: the AI gateway is the one host port a container may reach; the rest stay refused.
# (Over HTTP: an HTTP listener keeps a bare TCP connection open until curl's timeout.)
expect "the AI gateway $AI_GATEWAY_HOST:$AI_GATEWAY_PORT (from the probe)" open "$(probe \
  "curl -s -m 5 -o /dev/null -w '%{http_code}' http://$AI_GATEWAY_HOST:$AI_GATEWAY_PORT/v1/models | grep -Eq '^[1-5][0-9][0-9]\$' && echo open || echo blocked")"
expect "the AI gateway from the IDE, at Cline's base URL" yes "$(docker exec "$IDE" sh -c \
  "curl -s -m 5 -o /dev/null -w '%{http_code}' '$AI_BASE_URL/models' | grep -Eq '^[1-5][0-9][0-9]\$' && echo yes || echo no")"
for port in 3000 3100 5432 6379; do
  expect "host via the gateway's address $AI_GATEWAY_HOST:$port (API, IDE, PostgreSQL, Redis)" blocked "$(reach "$AI_GATEWAY_HOST" "$port")"
  expect "host via $HOST_IP:$port" blocked "$(reach "$HOST_IP" "$port")"
done
expect "the gateway port on another host address $HOST_IP:$AI_GATEWAY_PORT" blocked "$(reach "$HOST_IP" "$AI_GATEWAY_PORT")"
expect "the host still reaches the IDE (replies to the API)" 200 "$(code "$URL/version")"

if [ "$failures" -gt 0 ]; then
  echo "ide-check: $failures check(s) failed" >&2
  exit 1
fi
echo "ide-check: all checks passed"
