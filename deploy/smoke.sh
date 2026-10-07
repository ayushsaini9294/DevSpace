#!/usr/bin/env bash
# Smoke test of the production stack in LOCAL mode (compose.prod.yml + compose.local.yml):
# builds the images, starts everything with throwaway settings on http://app.localhost:<port> and
# http://<copyId>.ide.localhost:<port>, waits for it to be healthy, signs up through the API, and
# checks the app's page and headers, /api/health, and that the IDE hosts answer 404 to strangers.
#
#   bash deploy/smoke.sh          # test, then remove everything it made
#   bash deploy/smoke.sh --keep   # test, then leave it running to try in the browser
#   bash deploy/smoke.sh --down   # remove a stack left by --keep
#
# Settings: SMOKE_PORT (default 8088). Needs Docker, the devspace-ide network (made here if
# missing) and the IDE firewall (scripts/ide-firewall.sh, root; WSL applies it at boot). The API's
# own ports (3000, 3100 and the AI gateway's 10.213.0.1:3200) must be free, so stop `npm run dev`
# first. It uses its own Compose project (devspace-local) and never touches development data.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$here"

PORT="${SMOKE_PORT:-8088}"
APP="http://app.localhost:$PORT"
IDE_BASE="ide.localhost:$PORT"
state="${XDG_STATE_HOME:-$HOME/.local/state}/devspace-smoke"
copy_host="00000000-0000-4000-8000-000000000000.$IDE_BASE"
keep=0
case "${1:-}" in
  --keep) keep=1 ;;
  --down) ;;
  '') ;;
  *) echo "Usage: bash deploy/smoke.sh [--keep | --down]" >&2; exit 2 ;;
esac

export COMPOSE_PROJECT_NAME=devspace-local
export COMPOSE_FILE=compose.prod.yml:compose.local.yml
export COMPOSE_ENV_FILES="$state/local.env"
dc() { docker compose "$@"; }

remove_all() {
  if [ -f "$state/local.env" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # IDE containers the local API started (not part of the Compose project): the ones whose copy
  # lives in this stack's DATA_DIR. Development IDE containers are left alone.
  local id
  for id in $(docker ps -aq --filter label=devspace.copy 2>/dev/null || true); do
    if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null | grep -q "^$state/data/"; then
      docker rm -f "$id" >/dev/null 2>&1 || true
    fi
  done
  if [ -d "$state" ]; then
    # Data files belong to uid 10001; remove them through Docker.
    docker run --rm --user 0 -v "$state:/s" --entrypoint sh devspace-app:latest -c 'rm -rf /s/data /s/backups' >/dev/null 2>&1 || true
    rm -rf "$state"
  fi
}

if [ "${1:-}" = "--down" ]; then
  remove_all
  echo "smoke: removed the local stack"
  exit 0
fi

pass=0
ok() { pass=$((pass + 1)); echo "  ok - $*"; }
fail() {
  echo "  FAILED - $*" >&2
  echo "smoke: last API and Caddy logs:" >&2
  dc logs --tail 40 api caddy migrate >&2 || true
  exit 1
}
http() { # curl with *.localhost pinned to 127.0.0.1 (curl does this itself too, but be sure)
  curl -sS --max-time 20 --resolve "app.localhost:$PORT:127.0.0.1" --resolve "ide.localhost:$PORT:127.0.0.1" \
    --resolve "$copy_host:127.0.0.1" "$@"
}

# ---- before starting ----
for p in "$PORT" 3000 3100 15432 16379; do
  if ss -ltn | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    echo "smoke: port $p is in use. Stop whatever uses it (npm run dev? a stack left by --keep: bash deploy/smoke.sh --down)." >&2
    exit 1
  fi
done
if ss -ltn | awk '{print $4}' | grep -q '^10\.213\.0\.1:3200$'; then
  echo "smoke: the AI gateway port 10.213.0.1:3200 is in use (npm run dev?). Stop it first." >&2
  exit 1
fi
docker network inspect devspace-ide >/dev/null 2>&1 || bash "$repo/scripts/ide-network.sh"
docker image inspect devspace-ide:5 >/dev/null 2>&1 || echo "smoke: note: devspace-ide:5 isn't built (npm run ide:build); the IDE itself won't start, the rest is tested"

remove_all
mkdir -p "$state"
chmod 700 "$state"
trap 'status=$?; [ "$keep" -eq 1 ] || remove_all; exit $status' EXIT

cat >"$state/local.env" <<EOF
APP_DOMAIN=app.localhost
IDE_DOMAIN=ide.localhost
ACME_EMAIL=local@example.invalid
LOCAL_PORT_SUFFIX=:$PORT
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
POSTGRES_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
AI_SECRETS_KEY=$(head -c 32 /dev/urandom | base64)
POSTGRES_PORT=15432
REDIS_PORT=16379
DATA_DIR=$state/data
BACKUP_DIR=$state/backups
EOF
chmod 600 "$state/local.env"

echo "smoke: building the images (devspace-app, devspace-caddy, devspace-backup)"
dc build >"$state/build.log" 2>&1 || { tail -50 "$state/build.log" >&2; echo "smoke: build failed" >&2; exit 1; }

# DATA_DIR must belong to the uid the API runs as (10001), like on a server.
docker run --rm --user 0 -v "$state:/s" --entrypoint sh devspace-app:latest \
  -c 'mkdir -p /s/data/repos /s/data/copies /s/backups && chown -R 10001:10001 /s/data'

echo "smoke: starting the stack on $APP"
dc up -d >"$state/up.log" 2>&1 || { cat "$state/up.log" >&2; fail "docker compose up"; }

for _ in $(seq 1 90); do
  if http -o /dev/null -f "$APP/api/health" 2>/dev/null; then break; fi
  sleep 2
done

# ---- checks ----
health="$(http "$APP/api/health")" || fail "/api/health did not answer"
for part in '"ok":true' '"db":true' '"redis":true'; do
  grep -qF "$part" <<<"$health" || fail "/api/health said $health"
done
ok "/api/health through Caddy: $health"

headers="$(http -D - -o "$state/index.html" "$APP/")"
grep -q '<div id="root">' "$state/index.html" || fail "the app's page isn't the web build"
grep -qi '^content-security-policy:.*frame-src http://\*\.ide\.localhost' <<<"$headers" || fail "the app's page has no CSP with the IDE frame-src"
grep -qi '^cache-control: no-cache' <<<"$headers" || fail "index.html is cacheable"
grep -qi '^x-content-type-options: nosniff' <<<"$headers" || fail "no X-Content-Type-Options"
grep -qi '^referrer-policy: strict-origin-when-cross-origin' <<<"$headers" || fail "no Referrer-Policy"
ok "the app's page is served with CSP, nosniff, Referrer-Policy and no-cache"

asset="$(grep -oE '/assets/[^"]+\.js' "$state/index.html" | head -n 1)"
[ -n "$asset" ] || fail "no hashed script in index.html"
http -D - -o /dev/null "$APP$asset" | grep -qi '^cache-control: public, max-age=31536000, immutable' || fail "$asset isn't cached long"
[ "$(http -o /dev/null -w '%{http_code}' "$APP/assets/does-not-exist.js")" = 404 ] || fail "a missing asset isn't a 404"
http "$APP/projects/some/page" | grep -q '<div id="root">' || fail "app routes don't fall back to index.html"
ok "hashed assets are cached long, a missing one is a 404, and app pages fall back to index.html"

email="smoke-$(date +%s)@example.com"
signup="$(http -D "$state/signup.headers" -o "$state/signup.json" -w '%{http_code}' \
  -H 'content-type: application/json' -H "origin: $APP" \
  --data "{\"name\":\"Smoke Test\",\"email\":\"$email\",\"password\":\"smoke-pass-123\"}" "$APP/api/auth/signup")"
[ "$signup" = 201 ] || fail "sign up answered $signup: $(cat "$state/signup.json")"
cookie_line="$(grep -i '^set-cookie: devspace_session=' "$state/signup.headers" | head -n 1)"
[ -n "$cookie_line" ] || fail "sign up set no session cookie"
grep -qi 'secure' <<<"$cookie_line" || fail "the session cookie isn't Secure in production"
grep -qi 'httponly' <<<"$cookie_line" || fail "the session cookie isn't HttpOnly"
session="$(sed -E 's/^[Ss]et-[Cc]ookie: (devspace_session=[^;]*).*/\1/' <<<"$cookie_line" | tr -d '\r')"
me="$(http -H "cookie: $session" "$APP/api/auth/me")"
grep -qF "\"email\":\"$email\"" <<<"$me" || fail "/api/auth/me said $me"
ok "sign up through Caddy works, with a Secure HttpOnly session cookie"

[ "$(http -o /dev/null -w '%{http_code}' -H "cookie: $session" -X POST -H 'content-type: application/json' -H 'origin: http://evil.localhost' --data '{}' "$APP/api/projects")" = 403 ] \
  || fail "a POST from another origin wasn't refused"
ok "/api refuses a POST from another origin"

code="$(http -o /dev/null -w '%{http_code}' "http://$copy_host/ide/00000000-0000-4000-8000-000000000000/")"
[ "$code" = 404 ] || fail "an unknown copy's IDE host answered $code"
code="$(http -o /dev/null -w '%{http_code}' "http://$IDE_BASE/")"
[ "$code" = 404 ] || fail "the bare IDE host answered $code"
code="$(http -o /dev/null -w '%{http_code}' -H "cookie: $session" "http://$copy_host/ide/00000000-0000-4000-8000-000000000000/")"
[ "$code" = 404 ] || fail "the app's session opened an IDE ($code)"
ok "IDE hosts answer 404 to strangers, to the bare IDE host and to the app's session cookie"

echo "smoke: all $pass checks passed"
if [ "$keep" -eq 1 ]; then
  echo "smoke: left running. Open $APP in your browser. Remove it with: bash deploy/smoke.sh --down"
fi
