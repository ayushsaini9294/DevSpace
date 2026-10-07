#!/bin/sh
# Puts one backup back. Runs inside the `restore` service (the backup image with DATA_DIR mounted
# read-write at /restore-data); started by deploy/restore.sh, which stops the API and the worker
# first. Don't run this by hand.
#
#   devspace-restore <backup folder name>
#
# 1. Checks the backup against its manifest (every SHA-256 sum must match).
# 2. Replaces the database with the backup's.
# 3. Replaces DATA_DIR/repos and DATA_DIR/copies with the backup's. The folders it replaces are
#    moved to DATA_DIR/.before-restore-<time>/ (not deleted), in case they are wanted.
set -eu
set -o pipefail

log() { echo "restore: $*"; }

name="${1:-}"
case "$name" in
  '' | */* | .*) log "give the name of a backup folder, like 20261006T030000Z"; exit 2 ;;
esac
src="/backups/$name"
data=/restore-data
[ -f "$src/manifest.json" ] || { log "$name is not a finished backup (no manifest.json in it)"; exit 1; }
[ -d "$data" ] || { log "DATA_DIR is not mounted"; exit 1; }

log "checking $name"
for f in db.dump repos.tar.zst copies.tar.zst; do
  jq -e --arg f "$f" '.files[] | select(.name == $f)' "$src/manifest.json" >/dev/null \
    || { log "manifest.json does not list $f"; exit 1; }
done
jq -r '.files[] | "\(.sha256)  \(.name)"' "$src/manifest.json" | (cd "$src" && sha256sum -c --quiet -) \
  || { log "the backup's files don't match their checksums; nothing was changed"; exit 1; }
pg_restore --list "$src/db.dump" >/dev/null

# Unpack the folders first (into DATA_DIR, so the final move is a rename on the same disk).
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
incoming="$data/.restoring-$stamp"
before="$data/.before-restore-$stamp"
mkdir "$incoming"
trap 'rm -rf "$incoming"' EXIT
for part in repos copies; do
  tar --extract --zstd --numeric-owner --same-owner --same-permissions \
    --directory="$incoming" --file="$src/$part.tar.zst"
  mkdir -p "$incoming/$part"
done
log "folders unpacked"

# The database: empty it, then load the backup.
log "restoring the database"
psql --no-password --quiet --set ON_ERROR_STOP=1 \
  --command 'DROP SCHEMA IF EXISTS public CASCADE' \
  --command 'CREATE SCHEMA public'
pg_restore --no-password --no-owner --exit-on-error --dbname="$PGDATABASE" "$src/db.dump"
log "database restored"

# The folders: move the current ones aside, then the restored ones into place.
mkdir "$before"
for part in repos copies; do
  [ -e "$data/$part" ] && mv "$data/$part" "$before/$part"
  mv "$incoming/$part" "$data/$part"
done
rmdir "$incoming"
trap - EXIT
log "repos and copies restored; the folders they replaced are in $(basename "$before") inside DATA_DIR (delete it when you no longer need it)"
log "done: $name"
