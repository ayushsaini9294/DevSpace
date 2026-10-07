# DevSpace's backup service: PostgreSQL's own tools (same version as the database), GNU tar and
# zstd, and busybox cron to run deploy/backup.sh every night. deploy/restore.sh uses it too.

# PostgreSQL 17.11 (the database's version, so pg_dump/pg_restore match), pinned by digest.
FROM postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
RUN apk add --no-cache tar zstd coreutils jq tini
COPY --chmod=0755 backup.sh /usr/local/bin/devspace-backup
COPY --chmod=0755 restore-inside.sh /usr/local/bin/devspace-restore
COPY --chmod=0755 backup-cron.sh /usr/local/bin/devspace-backup-cron
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/devspace-backup-cron"]
