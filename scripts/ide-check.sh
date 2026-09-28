#!/usr/bin/env bash
# Checks the IDE image, network and firewall on a real container, started the way the API starts
# it (Phase 5 contract): random uid:gid, all capabilities dropped, no-new-privileges, 1 CPU,
# 2 GB memory without extra swap, 512 pids, only a temp folder mounted, network devspace-ide.
#
# Needs: image devspace-ide:2 (npm run ide:build), scripts/ide-network.sh and, as root,
# scripts/ide-firewall.sh. Exits non-zero on the first failed check. Used in CI.
set -euo pipefail

IMAGE=devspace-ide:2
NETWORK=devspace-ide
RUN_ID="check-$$"
IDE="devspace-ide-$RUN_ID"
PROBE="devspace-ide-probe-$RUN_ID"
BASE_PATH="/ide/$RUN_ID"
TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
USER_ID="$((20000 + RANDOM % 10000)):$((20000 + RANDOM % 10000))"
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

expect "tracker extension installed outside HOME" yes "$(docker exec "$IDE" sh -c   '[ -f "$OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/dist/extension.js" ] && grep -q "\"name\": \"devspace-tracker\"" "$OPENVSCODE_SERVER_ROOT/extensions/devspace-tracker/package.json" && echo yes || echo no')"
expect "the member cannot move or delete the tracker" kept "$(docker exec "$IDE" sh -c   'd="$OPENVSCODE_SERVER_ROOT/extensions"; mv "$d/devspace-tracker" "$d/moved" 2>/dev/null; rm -rf "$d/devspace-tracker" 2>/dev/null;    [ -f "$d/devspace-tracker/dist/extension.js" ] && echo kept || echo gone')"

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

expect "internet (https://example.com)" 200 "$(probe "curl -s -m 15 -o /dev/null -w '%{http_code}' https://example.com")"
expect "other IDE container $IP:3000" blocked "$(reach "$IP" 3000)"
expect "host via bridge gateway $GATEWAY:$LISTEN_PORT" blocked "$(reach "$GATEWAY" "$LISTEN_PORT")"
expect "host via $HOST_IP:$LISTEN_PORT" blocked "$(reach "$HOST_IP" "$LISTEN_PORT")"
expect "host via docker0 172.17.0.1:$LISTEN_PORT" blocked "$(reach 172.17.0.1 "$LISTEN_PORT")"
expect "host via $HOST_IP:5432 (PostgreSQL's published port)" blocked "$(reach "$HOST_IP" 5432)"
expect "private 10.0.0.1:80" blocked "$(reach 10.0.0.1 80)"
expect "private 172.16.0.1:80" blocked "$(reach 172.16.0.1 80)"
expect "private 192.168.1.1:80" blocked "$(reach 192.168.1.1 80)"
expect "link-local 169.254.169.254:80" blocked "$(reach 169.254.169.254 80)"
expect "the host still reaches the IDE (replies to the API)" 200 "$(code "$URL/version")"

if [ "$failures" -gt 0 ]; then
  echo "ide-check: $failures check(s) failed" >&2
  exit 1
fi
echo "ide-check: all checks passed"
