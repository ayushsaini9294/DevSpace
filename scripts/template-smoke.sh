#!/usr/bin/env bash
# Starter template smoke tests (Phase 11 contract, section 6): every template in
# apps/api/templates/<id> is run inside the IDE image the way a member would in the IDE terminal,
# in a container started like the API starts one (random uid:gid, all capabilities dropped,
# no-new-privileges, 1 CPU, 2 GB, 512 pids, network devspace-ide), with the image's own start
# script, so the DEVSPACE_PREVIEW_BASE* paths are the ones start.sh sets. Web apps are checked
# from the host through the container's address (as the Preview proxy reaches them), under their
# preview path.
#
# Needs: image devspace-ide:4 (npm run ide:build), scripts/ide-network.sh and, as root,
# scripts/ide-firewall.sh (npm install needs the internet). Usage: bash scripts/template-smoke.sh
# [template id ...] (default: all). Exits non-zero if any check failed. Used in CI.
set -euo pipefail

IMAGE="${IDE_IMAGE:-devspace-ide:4}"
NETWORK=devspace-ide
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATES="$ROOT/apps/api/templates"
USER_ID="$((20000 + RANDOM % 10000)):$((20000 + RANDOM % 10000))"
failures=0
containers=()
workdirs=()

cleanup() {
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  for dir in "${workdirs[@]}"; do
    # Files written inside belong to the random uid; remove them from a container as that uid.
    docker run --rm --user "$USER_ID" --entrypoint sh -v "$dir:/w" "$IMAGE" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
    rm -rf "$dir" 2>/dev/null || true
  done
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
expect_contains() { # description, needle, haystack
  if printf '%s' "$3" | grep -qF -- "$2"; then pass "$1"; else fail "$1: '$2' not found in: $(printf '%s' "$3" | head -c 300)"; fi
}

# ---------- one container per template ----------

IDE=""
IP=""
BASE_PATH=""

start_ide() { # template id
  local id="$1" work token
  work="$(mktemp -d)"
  workdirs+=("$work")
  cp -a "$TEMPLATES/$id/." "$work/"
  chmod -R a+rwX "$work"
  IDE="devspace-smoke-$id-$$"
  BASE_PATH="/ide/smoke-$id-$$"
  containers+=("$IDE")
  token="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  docker run -d --name "$IDE" --network "$NETWORK" --user "$USER_ID" \
    --cap-drop ALL --security-opt no-new-privileges \
    --cpus 1 --memory 2g --memory-swap 2g --pids-limit 512 \
    -e DEVSPACE_CONNECTION_TOKEN="$token" -e DEVSPACE_BASE_PATH="$BASE_PATH" \
    -v "$work:/home/workspace" "$IMAGE" >/dev/null
  IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$IDE")"
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://$IP:3000$BASE_PATH/version" && return 0
    sleep 1
  done
  fail "$id: the IDE did not start"
  docker logs "$IDE" 2>&1 | tail -20 >&2
  return 1
}

# Runs a command in the copy as a terminal would: the server's DEVSPACE_PREVIEW_* environment
# (set by start.sh; `docker exec` doesn't inherit it), in /home/workspace.
TERMINAL_PRELUDE='pid="$(ls /proc | grep -E "^[0-9]+$" | sort -n | sed -n 2p)";
eval "$(tr "\0" "\n" <"/proc/$pid/environ" | grep "^DEVSPACE_PREVIEW_" | sed "s/^/export /; s/=\(.*\)$/=\"\1\"/")";
cd /home/workspace;'

in_terminal() { # command (sh)
  docker exec "$IDE" bash -c "$TERMINAL_PRELUDE $1"
}

# Starts a long-running command in the background, output in /tmp/app.log inside the container.
start_app() { # command
  docker exec -d "$IDE" bash -c "$TERMINAL_PRELUDE exec $1 >/tmp/app.log 2>&1"
}

app_log() { docker exec "$IDE" sh -c 'tail -30 /tmp/app.log 2>/dev/null' >&2 || true; }

wait_for_port() { # port -> 0 when it answers HTTP from the host (npm start/dev may install first)
  for _ in $(seq 1 300); do
    curl -s -m 3 -o /dev/null "http://$IP:$1/" && return 0
    sleep 1
  done
  return 1
}

code() { curl -s -m 15 -o /dev/null -w '%{http_code}' "$@" || true; }
body() { curl -s -m 15 "$@" || true; }

preview_base() { # port -> the path start.sh set for it
  in_terminal "printf '%s' \"\$DEVSPACE_PREVIEW_BASE_$1\""
}

npm_install() { # id
  if in_terminal 'timeout 600 npm install --no-audit --no-fund >/tmp/install.log 2>&1'; then
    pass "$1: npm install"
  else
    fail "$1: npm install"
    docker exec "$IDE" sh -c 'tail -30 /tmp/install.log' >&2 || true
    return 1
  fi
}

common_files() { # id
  local dir="$TEMPLATES/$1"
  [ -s "$dir/README.md" ] && pass "$1: README.md" || fail "$1: README.md is missing or empty"
  if [ "$1" = empty ]; then return 0; fi
  local line
  for line in node_modules/ dist/ .env __pycache__/ .venv/; do
    if grep -qxF -- "$line" "$dir/.gitignore" 2>/dev/null; then :; else fail "$1: .gitignore lacks $line"; return 0; fi
  done
  pass "$1: .gitignore"
}

# The page at `url` and every script and stylesheet it links (relative or under the base) load.
check_page_and_assets() { # id, url, base
  local id="$1" url="$2" base="$3" html ref target n=0
  html="$(body "$url")"
  expect "$id: GET ${url#http://"$IP"}" 200 "$(code "$url")"
  expect_contains "$id: the page is HTML" '<' "$html"
  # Absolute paths outside the base would not load in Preview.
  if printf '%s' "$html" | grep -oE '(src|href)="/[^"]*"' | grep -vF "=\"$base" | grep -q .; then
    fail "$id: the page uses absolute paths outside $base: $(printf '%s' "$html" | grep -oE '(src|href)="/[^"]*"' | grep -vF "=\"$base" | head -3 | tr '\n' ' ')"
  fi
  while read -r ref; do
    [ -n "$ref" ] || continue
    case "$ref" in http:* | https:* | //* | data:* | '#'* | mailto:*) continue ;; esac
    if [[ "$ref" == /* ]]; then target="$(printf '%s' "$url" | grep -oE '^http://[^/]+')$ref"; else target="$url${ref#./}"; fi
    expect "$id: asset $ref" 200 "$(code "$target")"
    n=$((n + 1))
  done < <(printf '%s' "$html" | grep -oE '<(script|link)[^>]*(src|href)="[^"]*"' | grep -oE '(src|href)="[^"]*"' | sed -E 's/^(src|href)="//; s/"$//')
  echo "       ($n linked assets checked)"
}

# ---------- per template ----------

smoke_empty() {
  pass "empty: nothing to run"
}

smoke_html() {
  local base
  base="$(preview_base 8080)"
  expect "html: preview path from start.sh" "$BASE_PATH/__preview/8080/" "$base"
  start_app 'npm start'
  if ! wait_for_port 8080; then fail "html: nothing answers on 8080"; app_log; return; fi
  check_page_and_assets html "http://$IP:8080$base" "$base"
  expect "html: GET / (without the preview path)" 200 "$(code "http://$IP:8080/")"
}

smoke_express() {
  local base
  base="$(preview_base 8080)"
  # No separate npm install: `npm start` installs what it needs first (prestart).
  start_app 'npm start'
  if ! wait_for_port 8080; then fail "express: nothing answers on 8080"; app_log; return; fi
  check_page_and_assets express "http://$IP:8080$base" "$base"
  expect "express: GET ${base}api/hello" 200 "$(code "http://$IP:8080${base}api/hello")"
  expect_contains "express: /api/hello answers JSON" '{' "$(body "http://$IP:8080${base}api/hello")"
}

# A Vite page under the preview base: the HTML, its module scripts (Vite's client and the app's
# entry, transformed), so the browser can run it.
check_vite() { # id, base
  local id="$1" base="$2" html
  html="$(body "http://$IP:5173$base")"
  expect_contains "$id: Vite page has a module script" 'type="module"' "$html"
  expect_contains "$id: Vite client under the preview base" "src=\"${base}@vite/client\"" "$html"
  check_page_and_assets "$id" "http://$IP:5173$base" "$base"
  expect_contains "$id: the app's entry is served as JavaScript" 'import' \
    "$(body "http://$IP:5173${base}$(printf '%s' "$html" | grep -oE 'src="[^"]*main\.jsx?"' | head -1 | sed -E "s#^src=\"${base}##; s#\"\$##")")"
}

smoke_react() {
  local base
  base="$(preview_base 5173)"
  expect "react: preview path from start.sh" "$BASE_PATH/__preview/5173/" "$base"
  npm_install react || return
  if in_terminal 'timeout 300 npm run build >/tmp/build.log 2>&1 && [ -f dist/index.html ]'; then
    pass "react: npm run build"
  else
    fail "react: npm run build"
    docker exec "$IDE" sh -c 'tail -30 /tmp/build.log' >&2 || true
  fi
  start_app 'npm run dev'
  if ! wait_for_port 5173; then fail "react: nothing answers on 5173"; app_log; return; fi
  check_vite react "$base"
}

smoke_fullstack() {
  local base
  base="$(preview_base 5173)"
  # No separate npm install: `npm run dev` installs what it needs first (predev).
  start_app 'npm run dev'
  if ! wait_for_port 5173; then fail "fullstack: nothing answers on 5173"; app_log; return; fi
  check_vite fullstack "$base"
  # The client's API calls go through Vite's proxy to the server.
  local hello=""
  for _ in $(seq 1 30); do
    hello="$(body "http://$IP:5173${base}api/hello")"
    printf '%s' "$hello" | grep -q '{' && break
    sleep 1
  done
  expect_contains "fullstack: ${base}api/hello through Vite's proxy" 'Hello from the server' "$hello"
}

smoke_python() {
  local out
  if in_terminal 'timeout 120 python3 -m pip install --disable-pip-version-check -r requirements.txt >/tmp/pip.log 2>&1'; then
    pass "python: pip install -r requirements.txt"
  else
    fail "python: pip install -r requirements.txt"
  fi
  out="$(in_terminal "printf 'Ada\n7\n' | timeout 30 python3 main.py 2>&1" || echo "EXIT $?")"
  expect_contains "python: greets by name" 'Ada' "$out"
  expect_contains "python: works with the number" '14' "$out"
  if printf '%s' "$out" | grep -qE 'Traceback|EXIT '; then fail "python: main.py failed: $out"; fi
  out="$(in_terminal "printf 'Ada\nseven\n' | timeout 30 python3 main.py 2>&1" || echo "EXIT $?")"
  if printf '%s' "$out" | grep -qE 'Traceback|EXIT '; then fail "python: not a number: $out"; else pass "python: a non-number is handled"; fi
  out="$(in_terminal "timeout 30 python3 main.py </dev/null 2>&1" || echo "EXIT $?")"
  if printf '%s' "$out" | grep -qE 'Traceback|EXIT '; then fail "python: no input: $out"; else pass "python: no input is handled"; fi
}

# ---------- main ----------

[ -d "$TEMPLATES" ] || { echo "template-smoke: $TEMPLATES not found" >&2; exit 1; }
if [ "$#" -gt 0 ]; then ids=("$@"); else mapfile -t ids < <(find "$TEMPLATES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort); fi
[ "${#ids[@]}" -gt 0 ] || { echo "template-smoke: no templates" >&2; exit 1; }

for id in "${ids[@]}"; do
  echo "Template $id"
  if ! declare -F "smoke_$id" >/dev/null; then
    fail "$id: no smoke test for this template (add smoke_$id to scripts/template-smoke.sh)"
    continue
  fi
  common_files "$id"
  if start_ide "$id"; then
    expect "$id: runs as the random uid" "$USER_ID" "$(docker exec "$IDE" sh -c 'echo "$(id -u):$(id -g)"')"
    "smoke_$id"
  fi
  docker rm -f "$IDE" >/dev/null 2>&1 || true
done

if [ "$failures" -gt 0 ]; then
  echo "template-smoke: $failures check(s) failed" >&2
  exit 1
fi
echo "template-smoke: all templates work in $IMAGE"
