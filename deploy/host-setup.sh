#!/usr/bin/env bash
# One-time server setup for DevSpace. Run it as root from the repository folder, after Docker is
# installed:
#
#   sudo bash deploy/host-setup.sh
#
# Safe to run again (after an update, run it again to refresh the IDE image and the boot unit).
# It:
#   1. checks Docker and Docker Compose are installed;
#   2. makes the user DevSpace runs as (devspace, uid/gid 10001) and the folders DATA_DIR
#      (owned by it) and BACKUP_DIR (root only);
#   3. makes deploy/.env from deploy/.env.example if there isn't one, and fills in DOCKER_GID
#      and, if empty, POSTGRES_PASSWORD and AI_SECRETS_KEY with new random values;
#   4. installs the IDE network and firewall (scripts/ide-network.sh, scripts/ide-firewall.sh) as a
#      systemd unit, devspace-ide-net, that runs every time Docker starts, and runs it now;
#   5. builds the IDE image devspace-ide:5 (with DevSpace's tracker extension) using Docker only.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
env_file="$here/.env"
uid=10001
gid=10001

say() { echo "host-setup: $*"; }
die() { echo "host-setup: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash deploy/host-setup.sh"
command -v docker >/dev/null || die "Docker isn't installed (docs/deploy.md, step 5)"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin isn't installed (docs/deploy.md, step 5)"
docker buildx version >/dev/null 2>&1 || die "the Docker Buildx plugin isn't installed (docs/deploy.md, step 5)"
docker info >/dev/null 2>&1 || die "Docker isn't running: systemctl start docker"
[ -S /var/run/docker.sock ] || die "/var/run/docker.sock is missing"
[ -f "$repo/scripts/ide-network.sh" ] && [ -f "$repo/scripts/ide-firewall.sh" ] || die "run this from the DevSpace repository"

# ---- 1. deploy/.env ----
if [ ! -f "$env_file" ]; then
  install -m 600 "$here/.env.example" "$env_file"
  say "made deploy/.env from deploy/.env.example"
fi
chmod 600 "$env_file"

get_setting() { # name → value in deploy/.env ('' if unset)
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}
set_setting() { # name value: replace the line, or add it
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$name=" "$env_file"; then
    awk -v n="$name" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == n { print n "=" v; next } { print }' "$env_file" >"$tmp"
  else
    cat "$env_file" >"$tmp"
    printf '%s=%s\n' "$name" "$value" >>"$tmp"
  fi
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
}

set_setting DOCKER_GID "$(stat -c %g /var/run/docker.sock)"
if [ -z "$(get_setting POSTGRES_PASSWORD)" ]; then
  set_setting POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  say "made a database password (POSTGRES_PASSWORD)"
fi
if [ -z "$(get_setting AI_SECRETS_KEY)" ]; then
  set_setting AI_SECRETS_KEY "$(openssl rand -base64 32)"
  say "made an encryption key for stored AI keys (AI_SECRETS_KEY)"
fi

# ---- 2. The devspace user and the folders ----
if ! getent group "$gid" >/dev/null; then
  groupadd --system --gid "$gid" devspace
fi
if ! getent passwd "$uid" >/dev/null; then
  useradd --system --uid "$uid" --gid "$gid" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin devspace
fi
say "DevSpace runs as $(getent passwd "$uid" | cut -d: -f1) (uid $uid)"

data_dir="$(get_setting DATA_DIR)"
data_dir="${data_dir:-/srv/devspace/data}"
backup_dir="$(get_setting BACKUP_DIR)"
backup_dir="${backup_dir:-/srv/devspace/backups}"
case "$data_dir$backup_dir" in *' '*) die "DATA_DIR and BACKUP_DIR must not contain spaces" ;; esac
mkdir -p "$data_dir/repos" "$data_dir/copies" "$backup_dir"
chown "$uid:$gid" "$data_dir" "$data_dir/repos" "$data_dir/copies"
chmod 750 "$data_dir"
chown root:root "$backup_dir"
chmod 700 "$backup_dir"
mkdir -p /srv/devspace/secrets
chown "$uid:$gid" /srv/devspace/secrets
chmod 700 /srv/devspace/secrets
say "folders ready: $data_dir (data), $backup_dir (backups), /srv/devspace/secrets (GitHub key)"

# ---- 3. The IDE network and firewall, at every Docker start ----
install -d -m 755 /usr/local/lib/devspace
install -m 755 "$repo/scripts/ide-network.sh" /usr/local/lib/devspace/ide-network.sh
install -m 755 "$repo/scripts/ide-firewall.sh" /usr/local/lib/devspace/ide-firewall.sh
cat >/etc/systemd/system/devspace-ide-net.service <<'UNIT'
[Unit]
Description=DevSpace IDE network and firewall
# Runs as soon as Docker is up, and again whenever Docker restarts. IDE containers never start on
# their own (the API starts them on request), so no member code runs before the firewall is in place.
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/devspace/ide-network.sh
ExecStart=/usr/local/lib/devspace/ide-firewall.sh

[Install]
WantedBy=docker.service
UNIT
systemctl daemon-reload
systemctl enable devspace-ide-net.service >/dev/null 2>&1
systemctl restart devspace-ide-net.service
say "IDE network and firewall installed (systemd unit devspace-ide-net, runs whenever Docker starts)"

# ---- 4. The IDE image ----
say "building the IDE image devspace-ide:5 (takes a few minutes the first time)"
(
  cd "$repo"
  # The tracker extension is built inside Docker (no Node.js needed on the server).
  docker build --quiet -f deploy/Dockerfile --target tracker-dist --output type=local,dest=docker/ide/tracker/dist . >/dev/null
  docker build --quiet -t devspace-ide:5 docker/ide >/dev/null
)
say "IDE image ready: $(docker image inspect --format '{{.Id}}' devspace-ide:5 | cut -c1-19)"

missing=()
for name in APP_DOMAIN IDE_DOMAIN ACME_EMAIL CLOUDFLARE_API_TOKEN; do
  [ -n "$(get_setting "$name")" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  say "next: fill in ${missing[*]} in deploy/.env (sudo nano deploy/.env), then start DevSpace:"
else
  say "next: start DevSpace:"
fi
say "  cd deploy && sudo docker compose up -d --build"
