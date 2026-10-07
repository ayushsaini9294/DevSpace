#!/usr/bin/env bash
# Proves backups and restore work, on a throwaway copy of the production database service:
# makes data (a table with rows, a Git repository folder, a member's copy), backs it up, wipes it,
# restores the backup with deploy/restore.sh, and checks everything is back. Also checks that
# node_modules is left out of the copies archive, that only the newest BACKUP_KEEP backups are
# kept, that a failed backup leaves the older ones alone, and that restore refuses without --yes.
#
#   bash deploy/test-backup.sh
#
# Needs Docker. Uses its own Compose project (devspace-backuptest), its own database port
# (TEST_BACKUP_PG_PORT, default 15433) and temporary folders; touches nothing else.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

PG_PORT="${TEST_BACKUP_PG_PORT:-15433}"
if ss -ltn 2>/dev/null | grep -q ":$PG_PORT "; then
  echo "test-backup: port $PG_PORT is in use; set TEST_BACKUP_PG_PORT to a free port" >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/devspace-backuptest.XXXXXX")"
data="$tmp/data"
backups="$tmp/backups"
mkdir -p "$data" "$backups"

export COMPOSE_PROJECT_NAME=devspace-backuptest
export COMPOSE_FILE=compose.prod.yml
export COMPOSE_ENV_FILES="$tmp/test.env"
# Only postgres, backup and restore run; the other settings just have to be present.
cat >"$tmp/test.env" <<EOF
APP_DOMAIN=app.invalid
IDE_DOMAIN=ide.invalid
ACME_EMAIL=test@example.invalid
DOCKER_GID=0
AI_SECRETS_KEY=$(head -c 32 /dev/urandom | base64)
POSTGRES_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
POSTGRES_PORT=$PG_PORT
DATA_DIR=$data
BACKUP_DIR=$backups
BACKUP_KEEP=2
EOF

dc() { docker compose "$@"; }
pass=0
ok() { pass=$((pass + 1)); echo "  ok - $*"; }
fail() { echo "  FAILED - $*" >&2; exit 1; }
sql() { dc exec -T postgres psql -U devspace -d devspace -At -v ON_ERROR_STOP=1 -c "$1" </dev/null; }
backup_names() { ls -1 "$backups" | grep -E '^[0-9]{8}T[0-9]{6}Z$' || true; }

cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  # Restored files belong to the container's root user; remove them through Docker.
  docker run --rm -v "$tmp:/t" --entrypoint sh devspace-backup:latest -c 'rm -rf /t/* /t/.[!.]*' >/dev/null 2>&1 || true
  rmdir "$tmp" 2>/dev/null || rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

echo "test-backup: building the backup image and starting a throwaway database"
dc build backup >/dev/null
dc up -d --wait postgres >/dev/null

echo "test-backup: making data"
sql "CREATE TABLE proof (id int PRIMARY KEY, note text); INSERT INTO proof VALUES (1, 'first'), (2, 'second');" >/dev/null
mkdir -p "$data/repos/p1.git/refs" "$data/copies/p1/c1/src" "$data/copies/p1/c1/node_modules/left-out" "$data/copies/p1/c1/.git"
echo "ref: refs/heads/main" >"$data/repos/p1.git/HEAD"
echo "unsubmitted work" >"$data/copies/p1/c1/src/notes.txt"
echo "[core]" >"$data/copies/p1/c1/.git/config"
echo "rebuildable" >"$data/copies/p1/c1/node_modules/left-out/index.js"
want_notes="$(sha256sum "$data/copies/p1/c1/src/notes.txt" | cut -d' ' -f1)"

echo "test-backup: backing up three times (BACKUP_KEEP=2)"
for i in 1 2 3; do
  dc run --rm --no-deps backup devspace-backup >"$tmp/backup-$i.log" 2>&1 || { cat "$tmp/backup-$i.log"; fail "backup $i"; }
  sleep 1.1 # each backup gets its own second-resolution name
done
mapfile -t names < <(backup_names)
[ "${#names[@]}" -eq 2 ] && ok "only the newest 2 backups are kept" || fail "expected 2 backups, found ${#names[@]}"
latest="${names[-1]}"
for f in db.dump repos.tar.zst copies.tar.zst manifest.json; do
  [ -s "$backups/$latest/$f" ] || fail "$f missing in backup $latest"
done
ok "backup $latest has db.dump, repos.tar.zst, copies.tar.zst and manifest.json"
listing="$(docker run --rm -v "$backups/$latest:/b:ro" --entrypoint tar devspace-backup:latest --list --zstd -f /b/copies.tar.zst)"
grep -q 'copies/p1/c1/src/notes.txt' <<<"$listing" || fail "the member's file is not in copies.tar.zst"
grep -q 'copies/p1/c1/.git/config' <<<"$listing" || fail "the copy's .git is not in copies.tar.zst"
grep -q 'node_modules' <<<"$listing" && fail "node_modules was not left out of copies.tar.zst"
ok "copies.tar.zst holds the member's work and its .git, without node_modules"

echo "test-backup: a backup that fails leaves the others alone"
if dc run --rm --no-deps -e PGPASSWORD=wrong-password backup devspace-backup >"$tmp/backup-bad.log" 2>&1; then
  fail "a backup with a wrong database password succeeded"
fi
mapfile -t after < <(backup_names)
[ "${after[*]}" = "${names[*]}" ] || fail "a failed backup changed the kept backups"
[ -z "$(find "$backups" -mindepth 1 -maxdepth 1 -name '.incomplete-*')" ] || fail "a failed backup left a half-written folder"
grep -q FAILED "$tmp/backup-bad.log" || fail "the failed backup didn't say it failed"
ok "a failed backup exits non-zero, says so, and keeps the older backups"

echo "test-backup: wiping the data"
sql "DROP TABLE proof;" >/dev/null
rm -rf "$data/repos" "$data/copies"
mkdir -p "$data/copies/p1/c9"
echo "made after the backup" >"$data/copies/p1/c9/new.txt"

if bash ./restore.sh "$backups/$latest" >"$tmp/restore-no.log" 2>&1; then
  fail "restore ran without --yes"
fi
[ "$(sql "SELECT to_regclass('public.proof') IS NULL")" = "t" ] || fail "restore without --yes changed the database"
ok "restore refuses without --yes"

echo "test-backup: restoring $latest"
bash ./restore.sh "$backups/$latest" --yes >"$tmp/restore.log" 2>&1 || { cat "$tmp/restore.log"; fail "restore"; }

[ "$(sql "SELECT string_agg(note, ',' ORDER BY id) FROM proof")" = "first,second" ] || fail "the database rows are not back"
ok "the database is back"
[ "$(cat "$data/repos/p1.git/HEAD" 2>/dev/null)" = "ref: refs/heads/main" ] || fail "the repository is not back"
ok "the Git repository folder is back"
[ "$(sha256sum "$data/copies/p1/c1/src/notes.txt" 2>/dev/null | cut -d' ' -f1)" = "$want_notes" ] || fail "the member's copy is not back"
[ -f "$data/copies/p1/c1/.git/config" ] || fail "the copy's .git is not back"
[ ! -e "$data/copies/p1/c9" ] || fail "a copy made after the backup is still in place"
[ "$(stat -c %u "$data/copies/p1/c1/src/notes.txt")" = "$(id -u)" ] || fail "restored files lost their owner"
ok "the member's copy is back, with its owner"
before="$(find "$data" -mindepth 1 -maxdepth 1 -name '.before-restore-*' | head -n 1)"
[ -n "$before" ] && [ -f "$before/copies/p1/c9/new.txt" ] || fail "the replaced folders were not kept aside"
ok "the folders the restore replaced are kept in DATA_DIR/.before-restore-*"

echo "test-backup: all $pass checks passed"
