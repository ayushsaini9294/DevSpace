#!/usr/bin/env bash
# Puts a DevSpace backup back: the database, the projects' Git repositories and members' copies.
#
#   bash deploy/restore.sh /srv/devspace/backups/20261006T030000Z --yes
#
# Everything made after that backup is lost (the folders it replaces are kept aside in DATA_DIR).
# It stops the API and the worker, restores, then starts them again. Without --yes it only says
# what it would do. Run it from the server, in the repository folder, as a user who can use Docker.
#
# It uses the same settings as `docker compose` in deploy/ (deploy/.env). COMPOSE_FILE,
# COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES are honoured (deploy/test-backup.sh uses them).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yml}"

folder=""
yes=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -h | --help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) echo "restore: unknown option $arg" >&2; exit 2 ;;
    *) folder="$arg" ;;
  esac
done
if [ -z "$folder" ]; then
  echo "Usage: bash deploy/restore.sh <backup folder> --yes" >&2
  echo "Backups are folders like /srv/devspace/backups/20261006T030000Z (BACKUP_DIR in deploy/.env)." >&2
  exit 2
fi
name="$(basename "$folder")"
if ! [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "restore: '$folder' doesn't look like a backup folder (its name should be like 20261006T030000Z)" >&2
  exit 2
fi

if [ "$yes" -ne 1 ]; then
  echo "This would replace DevSpace's database, repositories and copies with backup $name."
  echo "Everything changed since then would be lost. The API and the worker stop while it runs."
  echo "To go ahead, run it again with --yes:"
  echo "  bash deploy/restore.sh $folder --yes"
  exit 1
fi

dc() { docker compose "$@"; }

# Which of the app's services are running now, so exactly those are started again afterwards.
running="$(dc ps --status running --services 2>/dev/null || true)"
restart=()
for svc in api worker caddy; do
  if grep -qx "$svc" <<<"$running"; then restart+=("$svc"); fi
done

echo "restore: stopping the API and the worker"
dc stop api worker >/dev/null 2>&1 || true

# The database must be running (it is, unless the whole stack was down).
dc up -d --wait postgres >/dev/null

echo "restore: restoring $name"
status=0
dc run --rm --no-deps restore "$name" || status=$?

if [ "${#restart[@]}" -gt 0 ]; then
  echo "restore: starting ${restart[*]} again"
  dc up -d "${restart[@]}"
fi

if [ "$status" -ne 0 ]; then
  echo "restore: FAILED (exit $status). See the messages above." >&2
  exit "$status"
fi
echo "restore: done. Backup $name is back."
