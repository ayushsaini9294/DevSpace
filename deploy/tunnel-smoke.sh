#!/usr/bin/env bash
# Local proof of tunnel mode (compose.prod.yml + compose.tunnel.yml), before the real domains
# exist. A stand-in for Cloudflare + cloudflared (deploy/tunnel-standin.mjs) answers HTTPS on
# 127.0.0.1:443 for https://devspace-app.test and https://<copyId>.devspace-ide.test, and passes
# requests to Caddy (http, 127.0.0.1:8080) the way cloudflared does: the Host unchanged, plus
# X-Forwarded-Proto: https, CF-Connecting-IP and X-Forwarded-For. Then it checks:
#   - the app's page, its CSP (https/wss addresses) and /api/health;
#   - sign up, and that the API sees https and the visitor's address from CF-Connecting-IP
#     (not one the visitor made up, and not 127.0.0.1);
#   - an IDE host: served as https on the copy's own host, 404 for strangers, never cached by
#     Cloudflare; the same request straight to Caddy (no tunnel, so no https) is refused;
#   - WebSockets: the app's live updates, and an IDE host's Origin rule;
#   - Caddy listens on 127.0.0.1 only.
#
#   bash deploy/tunnel-smoke.sh          # test, then remove everything it made
#   bash deploy/tunnel-smoke.sh --keep   # test, then leave it running (for the browser journey)
#   bash deploy/tunnel-smoke.sh --down   # remove a stack left by --keep
#
# With --keep, the full journey runs against it like this (Chromium sends *.test to 127.0.0.1
# and accepts the stand-in's self-signed certificate):
#   DEVSPACE_URL=https://devspace-app.test DEVSPACE_RESOLVE='*.test' \
#     npx playwright test -c deploy/journey/playwright.config.ts
#
# It uses the tunnel ports (8080, 3300, 3400, 25432, 26379), 443 and the AI gateway
# (10.213.0.1:3200), so a live stack (bash deploy/live.sh stop) and `npm run dev` must be
# stopped first. Its own Compose project (devspace-tunnel-smoke); development and live data are
# never touched. Builds the images first (one heavy job: don't run it during e2e or a build).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$here"

APP_DOMAIN=devspace-app.test
IDE_DOMAIN=devspace-ide.test
COPY=00000000-0000-4000-8000-000000000000
COPY_HOST="$COPY.$IDE_DOMAIN"
STANDIN_PORT=443
CADDY_PORT=8080
standin=devspace-tunnel-standin
state="${XDG_STATE_HOME:-$HOME/.local/state}/devspace-tunnel-smoke"
keep=0
case "${1:-}" in
  --keep) keep=1 ;;
  --down | '') ;;
  *) echo "Usage: bash deploy/tunnel-smoke.sh [--keep | --down]" >&2; exit 2 ;;
esac

export COMPOSE_PROJECT_NAME=devspace-tunnel-smoke
export COMPOSE_FILE=compose.prod.yml:compose.tunnel.yml
export COMPOSE_ENV_FILES="$state/tunnel.env"
unset COMPOSE_PROFILES # never the real cloudflared here
dc() { docker compose "$@"; }

remove_all() {
  docker rm -f "$standin" >/dev/null 2>&1 || true
  if [ -f "$state/tunnel.env" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  # IDE containers this stack's API started (their copy lives in this stack's DATA_DIR).
  local id
  for id in $(docker ps -aq --filter label=devspace.copy 2>/dev/null || true); do
    if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null | grep -q "^$state/data/"; then
      docker rm -f "$id" >/dev/null 2>&1 || true
    fi
  done
  if [ -d "$state" ]; then
    docker run --rm --user 0 -v "$state:/s" --entrypoint sh devspace-app:latest -c 'rm -rf /s/data /s/backups' >/dev/null 2>&1 || true
    rm -rf "$state"
  fi
}

if [ "${1:-}" = "--down" ]; then
  remove_all
  echo "tunnel-smoke: removed the test stack"
  exit 0
fi

pass=0
ok() { pass=$((pass + 1)); echo "  ok - $*"; }
fail() {
  echo "  FAILED - $*" >&2
  echo "tunnel-smoke: last API, Caddy and stand-in logs:" >&2
  dc logs --tail 40 api caddy migrate >&2 || true
  docker logs --tail 20 "$standin" >&2 || true
  exit 1
}
# Through the stand-in: every name goes to 127.0.0.1:443, like DNS pointing at Cloudflare.
https_() { curl -sS -k --max-time 20 --connect-to "::127.0.0.1:$STANDIN_PORT" "$@"; }
# Straight to Caddy, skipping the tunnel.
direct() { curl -sS --max-time 20 --connect-to "::127.0.0.1:$CADDY_PORT" "$@"; }

# ---- before starting ----
in_use() { ss -ltn | awk '{print $4}' | grep -qE "^$1\$"; }
for p in "$STANDIN_PORT" "$CADDY_PORT" 3300 3400 25432 26379; do
  if in_use "(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\*|\[::1\]):$p"; then
    echo "tunnel-smoke: port $p is in use. Stop the live stack (bash deploy/live.sh stop) or a stack left by --keep (bash deploy/tunnel-smoke.sh --down)." >&2
    exit 1
  fi
done
if in_use '10\.213\.0\.1:3200'; then
  echo "tunnel-smoke: the AI gateway port 10.213.0.1:3200 is in use (npm run dev, or the live stack?). Stop it first." >&2
  exit 1
fi
docker network inspect devspace-ide >/dev/null 2>&1 || bash "$repo/scripts/ide-network.sh"

remove_all
mkdir -p "$state/cert"
chmod 700 "$state"
trap 'status=$?; [ "$keep" -eq 1 ] || remove_all; exit $status' EXIT

cat >"$state/tunnel.env" <<EOF
APP_DOMAIN=$APP_DOMAIN
IDE_DOMAIN=$IDE_DOMAIN
ACME_EMAIL=unused@example.invalid
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
POSTGRES_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
AI_SECRETS_KEY=$(head -c 32 /dev/urandom | base64)
DATA_DIR=$state/data
BACKUP_DIR=$state/backups
EOF
chmod 600 "$state/tunnel.env"

# A throwaway certificate for the stand-in (Cloudflare's own certificate does this when live).
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$APP_DOMAIN" \
  -addext "subjectAltName=DNS:$APP_DOMAIN,DNS:*.$IDE_DOMAIN,DNS:$IDE_DOMAIN" \
  -keyout "$state/cert/key.pem" -out "$state/cert/cert.pem" >/dev/null 2>&1
chmod 644 "$state/cert/key.pem" "$state/cert/cert.pem"

echo "tunnel-smoke: building the images (devspace-app, devspace-caddy, devspace-backup)"
dc build >"$state/build.log" 2>&1 || { tail -50 "$state/build.log" >&2; echo "tunnel-smoke: build failed" >&2; exit 1; }

docker run --rm --user 0 -v "$state:/s" --entrypoint sh devspace-app:latest \
  -c 'mkdir -p /s/data/repos /s/data/copies /s/backups && chown -R 10001:10001 /s/data'

echo "tunnel-smoke: starting the stack (Caddy on 127.0.0.1:$CADDY_PORT) and the stand-in for Cloudflare"
dc up -d >"$state/up.log" 2>&1 || { cat "$state/up.log" >&2; fail "docker compose up"; }
docker run -d --name "$standin" --network host --user 0 --entrypoint node \
  -v "$here/tunnel-standin.mjs:/standin/tunnel-standin.mjs:ro" -v "$state/cert:/cert:ro" \
  -e STANDIN_PORT="$STANDIN_PORT" -e TUNNEL_HTTP_PORT="$CADDY_PORT" \
  -e STANDIN_CERT=/cert/cert.pem -e STANDIN_KEY=/cert/key.pem \
  devspace-app:latest /standin/tunnel-standin.mjs >/dev/null

for _ in $(seq 1 90); do
  if https_ -o /dev/null -f "https://$APP_DOMAIN/api/health" 2>/dev/null; then break; fi
  sleep 2
done

# ---- checks ----
health="$(https_ "https://$APP_DOMAIN/api/health")" || fail "/api/health did not answer through the tunnel"
for part in '"ok":true' '"db":true' '"redis":true'; do
  grep -qF "$part" <<<"$health" || fail "/api/health said $health"
done
ok "/api/health through the tunnel: $health"

headers="$(https_ -D - -o "$state/index.html" "https://$APP_DOMAIN/")"
grep -q '<div id="root">' "$state/index.html" || fail "the app's page isn't the web build"
grep -qi "^content-security-policy:.*connect-src 'self' wss://$APP_DOMAIN;" <<<"$headers" || fail "the CSP doesn't allow wss://$APP_DOMAIN"
grep -qi "^content-security-policy:.*frame-src https://\*\.$IDE_DOMAIN;" <<<"$headers" || fail "the CSP doesn't allow https://*.$IDE_DOMAIN frames"
grep -qi '^strict-transport-security: max-age=' <<<"$headers" || fail "no Strict-Transport-Security"
grep -qi '^x-content-type-options: nosniff' <<<"$headers" || fail "no X-Content-Type-Options"
ok "the app's page comes through with the https CSP (wss://$APP_DOMAIN, https://*.$IDE_DOMAIN), HSTS and nosniff"

# The visitor claims to be 6.6.6.6 (X-Forwarded-For); Cloudflare says 198.51.100.23.
email="tunnel-$(date +%s)@example.com"
signup="$(https_ -D "$state/signup.headers" -o "$state/signup.json" -w '%{http_code}' \
  -H 'content-type: application/json' -H "origin: https://$APP_DOMAIN" \
  -H 'x-forwarded-for: 6.6.6.6' -H 'x-standin-client-ip: 198.51.100.23' \
  --data "{\"name\":\"Tunnel Test\",\"email\":\"$email\",\"password\":\"tunnel-pass-123\"}" \
  "https://$APP_DOMAIN/api/auth/signup")"
[ "$signup" = 201 ] || fail "sign up answered $signup: $(cat "$state/signup.json")"
cookie_line="$(grep -i '^set-cookie: devspace_session=' "$state/signup.headers" | head -n 1)"
grep -qi 'secure' <<<"$cookie_line" || fail "the session cookie isn't Secure"
session="$(sed -E 's/^[Ss]et-[Cc]ookie: (devspace_session=[^;]*).*/\1/' <<<"$cookie_line" | tr -d '\r')"
me="$(https_ -H "cookie: $session" "https://$APP_DOMAIN/api/auth/me")"
grep -qF "\"email\":\"$email\"" <<<"$me" || fail "/api/auth/me said $me"
ok "sign up through the tunnel works, with a Secure session cookie"

keys="$(dc exec -T redis redis-cli --scan --pattern 'devspace:rate:signup:*' </dev/null | tr -d '\r')"
grep -qx 'devspace:rate:signup:198.51.100.23' <<<"$keys" || fail "the API didn't count sign-ups by CF-Connecting-IP (keys: $keys)"
if grep -qE ':(6\.6\.6\.6|127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$' <<<"$keys"; then
  fail "the API counted sign-ups by a made-up or local address (keys: $keys)"
fi
ok "the API sees the visitor's address from CF-Connecting-IP (198.51.100.23), not a made-up X-Forwarded-For or 127.0.0.1"

[ "$(https_ -o /dev/null -w '%{http_code}' -H "cookie: $session" -X POST -H 'content-type: application/json' \
  -H "origin: https://evil.$IDE_DOMAIN" --data '{}' "https://$APP_DOMAIN/api/projects")" = 403 ] \
  || fail "a POST from another origin wasn't refused"
ok "/api refuses a POST from another origin"

ide_headers="$(https_ -D - -o /dev/null "https://$COPY_HOST/ide/$COPY")"
grep -qE '^HTTP/[0-9.]+ 308' <<<"$ide_headers" || fail "the copy's IDE host didn't answer 308 (the API didn't see https on the copy host): $(head -n 1 <<<"$ide_headers")"
grep -qi '^cloudflare-cdn-cache-control: no-store' <<<"$ide_headers" || fail "IDE responses don't tell Cloudflare not to cache them"
code="$(https_ -o /dev/null -w '%{http_code}' "https://$COPY_HOST/ide/$COPY/")"
[ "$code" = 404 ] || fail "an IDE without its cookie answered $code"
code="$(https_ -o /dev/null -w '%{http_code}' "https://$IDE_DOMAIN/")"
[ "$code" = 404 ] || fail "the bare IDE domain answered $code"
code="$(https_ -o /dev/null -w '%{http_code}' -H "cookie: $session" "https://$COPY_HOST/ide/$COPY/")"
[ "$code" = 404 ] || fail "the app's session opened an IDE ($code)"
ok "an IDE host is served as https on its own copy host (308), 404 without its cookie, for the bare domain and for the app's session, and never cached by Cloudflare"

code="$(direct -o /dev/null -w '%{http_code}' "http://$COPY_HOST/ide/$COPY")"
[ "$code" = 404 ] || fail "straight to Caddy (plain http, no tunnel) the IDE host answered $code, not 404"
ok "the same IDE request straight to Caddy, without the tunnel's https, is refused (404)"

ws="$(docker run --rm --network host --entrypoint node \
  -v "$here/tunnel-ws-check.mjs:/check/tunnel-ws-check.mjs:ro" \
  -e APP_DOMAIN="$APP_DOMAIN" -e IDE_DOMAIN="$IDE_DOMAIN" -e SESSION="$session" -e STANDIN_PORT="$STANDIN_PORT" \
  devspace-app:latest /check/tunnel-ws-check.mjs 2>&1)" || fail "WebSockets: $ws"
while IFS= read -r line; do ok "${line#ok - }"; done <<<"$ws"

listen="$(ss -ltn | awk '{print $4}' | grep -E ":$CADDY_PORT\$" || true)"
[ "$listen" = "127.0.0.1:$CADDY_PORT" ] || fail "Caddy should listen on 127.0.0.1:$CADDY_PORT only, but listens on: $listen"
ok "Caddy listens on 127.0.0.1:$CADDY_PORT only (nothing is open to the network)"

echo "tunnel-smoke: all $pass checks passed"
if [ "$keep" -eq 1 ]; then
  echo "tunnel-smoke: left running. Remove it with: bash deploy/tunnel-smoke.sh --down"
fi
