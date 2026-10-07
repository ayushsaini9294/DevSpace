#!/bin/sh
# One DevSpace backup. Runs inside the backup container (deploy/backup.Dockerfile), every night
# from cron, or by hand:
#
#   docker compose -f compose.prod.yml exec backup devspace-backup
#
# Writes /backups/<UTC timestamp>/ (BACKUP_DIR on the server) with:
#   db.dump          the database (pg_dump -Fc)
#   repos.tar.zst    every project's Git repository
#   copies.tar.zst   members' copies (their unsubmitted work lives only there), without
#                    node_modules, .venv, dist, build, .next and .cache, which can be rebuilt
#   manifest.json    sizes and SHA-256 sums of the three files
#
# The backup is written to a hidden folder first and checked (the dump can be read, the archives
# are whole, the sums match); only then does it get its real name. After that, backups beyond the
# newest BACKUP_KEEP (7) are deleted. A failed backup exits non-zero and touches no older backup.
set -eu
set -o pipefail

DATA=/data
OUT=/backups
KEEP="${BACKUP_KEEP:-7}"
case "$KEEP" in '' | *[!0-9]* | 0) echo "backup: BACKUP_KEEP must be a whole number above 0" >&2; exit 1 ;; esac

log() { echo "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$OUT/.incomplete-$stamp"
final="$OUT/$stamp"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -rf "$work"
    log "FAILED (exit $status); older backups were left alone"
  fi
}
trap cleanup EXIT

[ -d "$OUT" ] || { log "the backup folder $OUT is missing"; exit 1; }
[ -e "$final" ] && { log "$final already exists"; exit 1; }
mkdir "$work"
log "starting $stamp"

# 1. The database, in PostgreSQL's custom format (compressed; pg_restore reads it).
pg_dump --format=custom --no-password --file="$work/db.dump"
pg_restore --list "$work/db.dump" >/dev/null
log "database saved ($(du -h "$work/db.dump" | cut -f1))"

# 2. Folders under DATA_DIR. An empty archive is made if a folder doesn't exist yet.
archive() { # name, extra tar options...
  name="$1"
  shift
  if [ -d "$DATA/$name" ]; then
    set +e
    tar --create --zstd --numeric-owner --warning=no-file-changed --warning=no-file-removed \
      --directory="$DATA" "$@" --file="$work/$name.tar.zst" "$name"
    code=$?
    set -e
    # GNU tar exits 1 when a file changed while it was read (a member typing); that file may be
    # incomplete but the archive is fine. 2 or more is a real failure.
    [ "$code" -le 1 ] || { log "tar failed for $name (exit $code)"; exit 1; }
  else
    tar --create --zstd --file="$work/$name.tar.zst" --files-from=/dev/null
  fi
  zstd --quiet --test "$work/$name.tar.zst"
  tar --list --zstd --file="$work/$name.tar.zst" >/dev/null
  log "$name saved ($(du -h "$work/$name.tar.zst" | cut -f1))"
}
archive repos
archive copies \
  --exclude=node_modules --exclude=.venv --exclude=dist --exclude=build --exclude=.next --exclude=.cache

# 3. The manifest: sizes and SHA-256 sums.
files=""
for f in db.dump repos.tar.zst copies.tar.zst; do
  bytes="$(stat -c %s "$work/$f")"
  sum="$(sha256sum "$work/$f" | cut -d' ' -f1)"
  files="$files$(jq -n --arg name "$f" --argjson bytes "$bytes" --arg sha256 "$sum" \
    '{name: $name, bytes: $bytes, sha256: $sha256}')"
done
printf '%s' "$files" | jq -s --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg postgres "$(pg_dump --version)" \
  '{format: 1, createdAt: $createdAt, postgres: $postgres, files: .}' >"$work/manifest.json"

# 4. Check the sums against the files once more, then give the backup its real name.
jq -r '.files[] | "\(.sha256)  \(.name)"' "$work/manifest.json" | (cd "$work" && sha256sum -c --quiet -)
mv "$work" "$final"
log "finished $stamp ($(du -sh "$final" | cut -f1))"

# 5. Keep the newest $KEEP finished backups (folders named like 20261006T030000Z).
ls -1 "$OUT" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -rf "${OUT:?}/$old"
  log "deleted old backup $old"
done
# Leftovers of backups that were interrupted (power cut, container killed).
find "$OUT" -mindepth 1 -maxdepth 1 -name '.incomplete-*' ! -name ".incomplete-$stamp" -mmin +60 -exec rm -rf {} + 2>/dev/null || true
log "done; $(ls -1 "$OUT" | grep -cE '^[0-9]{8}T[0-9]{6}Z$') backup(s) kept"
