#!/bin/sh
# Runs inside the backup container: schedules deploy/backup.sh with busybox cron
# (BACKUP_SCHEDULE, default every night at 03:00 in the server's time zone) and logs to the
# container's output (`docker compose logs backup`).
set -eu

schedule="${BACKUP_SCHEDULE:-0 3 * * *}"

# cron starts jobs with an empty environment, so save the settings for the job (root only).
umask 077
: >/etc/devspace-backup.env
for name in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE BACKUP_KEEP; do
  eval "value=\${$name:-}"
  # Single-quote the value (and any single quote inside it).
  quoted=$(printf '%s' "$value" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$name" "$quoted" >>/etc/devspace-backup.env
done

mkdir -p /etc/crontabs
printf '%s . /etc/devspace-backup.env && /usr/local/bin/devspace-backup >/proc/1/fd/1 2>/proc/1/fd/2\n' \
  "$schedule" >/etc/crontabs/root

echo "backup: scheduled \"$schedule\" (time zone $(date +%Z), now $(date '+%Y-%m-%d %H:%M')), keeping the newest ${BACKUP_KEEP:-7}"
exec crond -f -l 8
