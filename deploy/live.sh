#!/usr/bin/env bash
# Runs DevSpace live from this PC (WSL), online through Cloudflare Tunnel (tunnel mode:
# compose.prod.yml + compose.tunnel.yml). docs/deploy.md, "Free: run it from your PC", explains
# the Cloudflare side.
#
#   bash deploy/live.sh start     build if needed, then start DevSpace and the tunnel
#   bash deploy/live.sh stop      stop everything (data is kept)
#   bash deploy/live.sh status    is it running, is the tunnel connected, how much memory is free
#   bash deploy/live.sh logs [service]   follow the logs (api, worker, caddy, cloudflared, ...)
#   bash deploy/live.sh backup    make a backup now
#   bash deploy/live.sh restore <backup folder> --yes   put a backup back
#   bash deploy/live.sh update    rebuild from the code in this folder and restart
#   bash deploy/live.sh token     replace the tunnel token (if you made a new tunnel)
#
# Live data lives outside the repository, in ~/devspace-live (DEVSPACE_LIVE_DIR changes it):
#   .env       the settings and secrets (made on the first start; never share or commit it)
#   data/      projects' Git repositories and members' copies
#   backups/   nightly backups (03:00, newest 7 kept, only while the PC is on)
# The database lives in a Docker volume (devspace-live_pgdata) and is in every backup.
#
# The first start asks for your two domains and the tunnel token (typed hidden); everything else
# is generated. DevSpace can't run live and in development (`npm run dev`) at the same time:
# they share the IDE's AI gateway, so start refuses while npm run dev is running.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
LIVE_DIR="${DEVSPACE_LIVE_DIR:-$HOME/devspace-live}"
env_file="$LIVE_DIR/.env"

export COMPOSE_PROJECT_NAME=devspace-live
export COMPOSE_FILE=compose.prod.yml:compose.tunnel.yml
export COMPOSE_ENV_FILES="$env_file"
export COMPOSE_PROFILES=tunnel
cd "$here"
dc() { docker compose "$@"; }

say() { echo "live: $*"; }
die() {
  echo "live: $*" >&2
  exit 1
}

setting() { # name → value in the .env ('' if unset)
  sed -n "s/^$1=//p" "$env_file" 2>/dev/null | tail -n 1
}
set_setting() { # name value: replace the line (the file stays private)
  local tmp
  tmp="$(mktemp "$LIVE_DIR/.env.XXXXXX")"
  awk -v n="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == n { print n "=" v; next } { print }' "$env_file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}

port_of() { # setting, default
  local v
  v="$(setting "$1")"
  echo "${v:-$2}"
}
caddy_port() { port_of TUNNEL_HTTP_PORT 8080; }
metrics_port() { port_of TUNNEL_METRICS_PORT 20241; }

# ---- checks ----
need_docker() {
  command -v docker >/dev/null || die "Docker isn't installed in this Ubuntu."
  docker info >/dev/null 2>&1 || die "Docker isn't running. Close every Ubuntu window, wait 10 seconds, open Ubuntu again, and retry."
}

stack_running() { [ -n "$(dc ps -q api 2>/dev/null)" ]; }

dev_running() {
  # `npm run dev` from this repository (concurrently, the API/worker watchers, Vite), or anything
  # else holding the AI gateway port while the live stack is down.
  pgrep -u "$(id -u)" -f "$repo/node_modules/.bin/(concurrently|tsx|vite)" >/dev/null 2>&1 && return 0
  if ! stack_running && ss -ltn | awk '{print $4}' | grep -q '^10\.213\.0\.1:3200$'; then return 0; fi
  return 1
}

heavy_job_running() {
  # e2e tests or another image build: never at the same time as starting or building (memory).
  pgrep -f '(playwright test|@playwright/test/cli)' >/dev/null 2>&1 && { echo "an e2e test run"; return 0; }
  pgrep -f '(docker(-buildx)? (buildx )?build|docker-compose .*build|docker compose .*build)' >/dev/null 2>&1 && { echo "a Docker build"; return 0; }
  return 1
}

available_mb() { free -m | awk '/^Mem:/ { print $7 }'; }

preflight() {
  need_docker
  if dev_running; then
    die "npm run dev is running. DevSpace can't run live and in development at the same time (they share the IDE's AI gateway). Stop npm run dev (Ctrl+C in its window), then run this again."
  fi
  local job
  if job="$(heavy_job_running)"; then
    die "$job is running. To spare memory, wait until it finishes, then run this again."
  fi
  local mb
  mb="$(available_mb)"
  if [ "$mb" -lt 1200 ]; then
    die "only $mb MB of memory is free. Close some programs (or stop other Docker stacks) and try again."
  fi
  docker network inspect devspace-ide >/dev/null 2>&1 \
    || die "the IDE network is missing (WSL sets it up when it starts). Close every Ubuntu window, run 'wsl --shutdown' in Windows PowerShell, open Ubuntu again, and retry."
  if ! stack_running; then
    local p
    for p in "$(caddy_port)" "$(port_of API_PORT 3300)" "$(port_of IDE_PORT 3400)" "$(port_of POSTGRES_PORT 25432)" "$(port_of REDIS_PORT 26379)" "$(metrics_port)"; do
      if ss -ltn | awk '{print $4}' | grep -qE "[:.]$p\$"; then
        die "port $p is already in use by another program (a test stack? bash deploy/tunnel-smoke.sh --down). Free it and try again."
      fi
    done
  fi
}

# ---- first run: the .env ----
valid_domain() {
  [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]
}

ask_domain() { # prompt → a lowercase domain on stdout
  local value
  while true; do
    read -r -p "$1" value
    value="$(tr '[:upper:]' '[:lower:]' <<<"$value" | tr -d '[:space:]')"
    value="${value#https://}"
    value="${value#http://}"
    value="${value%/}"
    if valid_domain "$value"; then
      echo "$value"
      return
    fi
    echo "  That doesn't look like a domain (example: my-devspace.eu.org). Try again." >&2
  done
}

ask_token() { # → the tunnel token on stdout (typed hidden)
  local value
  while true; do
    read -r -s -p "Tunnel token (paste it, or the whole install command; it stays hidden): " value
    echo >&2
    # The dashboard shows a command like "cloudflared service install eyJh..."; keep the token.
    value="$(awk '{ print $NF }' <<<"$value")"
    if [[ "$value" =~ ^[A-Za-z0-9+/_=-]{60,}$ ]]; then
      echo "$value"
      return
    fi
    echo "  That doesn't look like a tunnel token (a long text starting with eyJ). Try again." >&2
  done
}

make_env() {
  [ -t 0 ] || die "the first start asks a few questions: run it in an Ubuntu terminal window."
  echo
  echo "First start: DevSpace needs your two domains and the Cloudflare tunnel token."
  echo "(docs/deploy.md, \"Free: run it from your PC\", shows where to find them.)"
  echo
  local app ide token
  app="$(ask_domain "App domain (what people open, e.g. my-devspace.eu.org): ")"
  while true; do
    ide="$(ask_domain "IDE domain (a second, different domain, e.g. my-devspace-ide.eu.org): ")"
    if [ "$ide" = "$app" ] || [[ "$ide" == *".$app" ]] || [[ "$app" == *".$ide" ]]; then
      echo "  The IDE domain must be a different domain, not the app domain or part of it. Try again." >&2
      continue
    fi
    break
  done
  token="$(ask_token)"

  mkdir -p "$LIVE_DIR"
  chmod 700 "$LIVE_DIR"
  (
    umask 077
    cat >"$env_file" <<EOF
# DevSpace live settings (tunnel mode), made by deploy/live.sh. Private: never share or commit it.
# Keep a copy somewhere safe (a password manager). Never change POSTGRES_PASSWORD or
# AI_SECRETS_KEY once DevSpace has run: the first locks DevSpace out of its database, the second
# makes everyone connect OpenRouter again.

# Your two domains (both on Cloudflare).
APP_DOMAIN=$app
IDE_DOMAIN=$ide
# The Cloudflare tunnel's token (replace it with: bash deploy/live.sh token).
CLOUDFLARE_TUNNEL_TOKEN=$token

# Secrets, generated on the first start.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
AI_SECRETS_KEY=$(openssl rand -base64 32)

# This PC.
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
DATA_DIR=$LIVE_DIR/data
BACKUP_DIR=$LIVE_DIR/backups
BACKUP_KEEP=7
BACKUP_SCHEDULE=0 3 * * *
# Not used in tunnel mode (Cloudflare makes the certificates), but compose.prod.yml needs a value.
ACME_EMAIL=unused@example.invalid

# GitHub (optional; docs/deploy.md, "Optional: connect GitHub").
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY_FILE=

# AI models (optional; empty = DevSpace's defaults).
AI_DEFAULT_MODELS=
AI_FALLBACK_MODELS=

# Ports on 127.0.0.1 (change only if another program uses one). In the Cloudflare dashboard both
# routes point at http://localhost:<TUNNEL_HTTP_PORT>.
TUNNEL_HTTP_PORT=8080
API_PORT=3300
IDE_PORT=3400
POSTGRES_PORT=25432
REDIS_PORT=26379
TUNNEL_METRICS_PORT=20241
EOF
  )
  say "settings saved in $env_file (private to you)"
}

check_env() {
  [ -f "$env_file" ] || die "no settings yet: run 'bash deploy/live.sh start' first."
  local name
  for name in APP_DOMAIN IDE_DOMAIN CLOUDFLARE_TUNNEL_TOKEN POSTGRES_PASSWORD AI_SECRETS_KEY DOCKER_GID DATA_DIR BACKUP_DIR; do
    [ -n "$(setting "$name")" ] || die "$name is empty in $env_file."
  done
}

# ---- building ----
build_images() {
  say "building DevSpace (takes 5-15 minutes the first time; keep this window open)"
  dc build
}

ensure_ide_image() {
  docker image inspect devspace-ide:5 >/dev/null 2>&1 && return
  say "building the IDE image devspace-ide:5 (a few minutes, only once)"
  (
    cd "$repo"
    docker build --quiet -f deploy/Dockerfile --target tracker-dist --output type=local,dest=docker/ide/tracker/dist . >/dev/null
    docker build --quiet -t devspace-ide:5 docker/ide >/dev/null
  )
}

ensure_folders() {
  local data backups
  data="$(setting DATA_DIR)"
  backups="$(setting BACKUP_DIR)"
  mkdir -p "$backups"
  chmod 700 "$backups"
  # The data folder belongs to the app's user (uid 10001), like on a server.
  docker run --rm --user 0 -v "$data:/data" --entrypoint sh devspace-app:latest \
    -c 'mkdir -p /data/repos /data/copies && chown 10001:10001 /data /data/repos /data/copies && chmod 750 /data'
}

health() { # → the health JSON through Caddy (as the tunnel sends it), or fails
  curl -sS -f --max-time 5 --connect-to "::127.0.0.1:$(caddy_port)" \
    "http://$(setting APP_DOMAIN)/api/health" 2>/dev/null
}

tunnel_ready() { # → the number of live connections to Cloudflare, or fails
  local json
  json="$(curl -sS -f --max-time 5 "http://127.0.0.1:$(metrics_port)/ready" 2>/dev/null)" || return 1
  sed -nE 's/.*"readyConnections":([0-9]+).*/\1/p' <<<"$json"
}

ide_containers() { # the IDE containers whose copy lives in this live DATA_DIR
  local data id
  data="$(setting DATA_DIR)"
  for id in $(docker ps -q --filter label=devspace.copy 2>/dev/null || true); do
    if docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$id" 2>/dev/null | grep -q "^$data/"; then
      echo "$id"
    fi
  done
}

wait_until_up() {
  say "waiting for DevSpace to answer"
  local i
  for i in $(seq 1 90); do
    if health >/dev/null; then break; fi
    if [ "$i" -eq 90 ]; then
      dc ps -a >&2 || true
      dc logs --tail 30 migrate api >&2 || true
      die "DevSpace didn't start. The messages above say why (often a setting in $env_file)."
    fi
    sleep 2
  done
  say "DevSpace answers: $(health)"
  local n=''
  for i in $(seq 1 30); do
    n="$(tunnel_ready || true)"
    [ -n "$n" ] && [ "$n" -gt 0 ] && break
    sleep 2
  done
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then
    say "the tunnel is connected to Cloudflare ($n connections)"
    say "DevSpace is live at https://$(setting APP_DOMAIN)"
  else
    say "DevSpace runs, but the tunnel isn't connected to Cloudflare yet."
    say "Check the token, and see what cloudflared says: bash deploy/live.sh logs cloudflared"
  fi
}

# ---- commands ----
cmd_start() {
  need_docker
  if [ ! -f "$env_file" ]; then
    preflight
    make_env
  fi
  check_env
  preflight
  if ! docker image inspect devspace-app:latest devspace-caddy:latest devspace-backup:latest >/dev/null 2>&1; then
    build_images
  fi
  ensure_ide_image
  ensure_folders
  say "starting DevSpace (the database is updated first if needed)"
  dc up -d --remove-orphans
  wait_until_up
}

cmd_update() {
  check_env
  preflight
  build_images
  ensure_ide_image
  ensure_folders
  say "restarting with the new version (people using it may see it reconnect)"
  dc up -d --remove-orphans
  wait_until_up
}

cmd_stop() {
  need_docker
  [ -f "$env_file" ] || die "DevSpace was never started here (no $env_file)."
  local ids
  ids="$(ide_containers)"
  if [ -n "$ids" ]; then
    say "stopping open IDEs"
    # shellcheck disable=SC2086
    docker stop $ids >/dev/null
  fi
  say "stopping DevSpace (your data is kept)"
  dc down
  say "stopped. Start again with: bash deploy/live.sh start"
}

cmd_status() {
  need_docker
  check_env
  echo "App:  https://$(setting APP_DOMAIN)"
  echo "IDEs: https://<copy>.$(setting IDE_DOMAIN)"
  echo
  dc ps -a --format 'table {{.Service}}\t{{.Status}}'
  echo
  local h n
  if h="$(health)"; then echo "Health:  $h"; else echo "Health:  not answering"; fi
  n="$(tunnel_ready || true)"
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then
    echo "Tunnel:  connected to Cloudflare ($n connections)"
  else
    echo "Tunnel:  NOT connected (bash deploy/live.sh logs cloudflared)"
  fi
  local ids count
  ids="$(ide_containers)"
  count="$(grep -c . <<<"$ids" || true)"
  echo "IDEs open: $count"
  echo "Memory free: $(available_mb) MB of $(free -m | awk '/^Mem:/ { print $2 }') MB"
  local containers
  # shellcheck disable=SC2086
  containers="$(dc ps -q) $ids"
  if [ -n "${containers// /}" ]; then
    echo
    # shellcheck disable=SC2086
    docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $containers
  fi
}

cmd_logs() {
  need_docker
  check_env
  dc logs --tail 100 -f "$@"
}

cmd_backup() {
  need_docker
  check_env
  stack_running || die "DevSpace isn't running (bash deploy/live.sh start)."
  dc exec -T backup devspace-backup </dev/null
  say "backups in $(setting BACKUP_DIR):"
  ls -1 "$(setting BACKUP_DIR)"
}

cmd_restore() {
  need_docker
  check_env
  bash "$here/restore.sh" "$@"
}

cmd_token() {
  [ -f "$env_file" ] || die "no settings yet: run 'bash deploy/live.sh start' first."
  [ -t 0 ] || die "run it in an Ubuntu terminal window."
  set_setting CLOUDFLARE_TUNNEL_TOKEN "$(ask_token)"
  say "token saved."
  if stack_running; then
    dc up -d cloudflared
    say "the tunnel restarted with the new token."
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  update) cmd_update ;;
  token) cmd_token ;;
  *)
    sed -n '2,13p' "$here/live.sh" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
