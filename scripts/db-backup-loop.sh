#!/bin/sh
# Backup loop for the optional `db-backup` compose service (cron-free, matches the
# app's self-contained deployment). Dumps every BACKUP_INTERVAL_SECONDS to
# /backups and keeps the newest BACKUP_KEEP files. Auth via PG* env vars.
set -e

: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_KEEP:=14}"
: "${PGHOST:=db}"
: "${PGDATABASE:=schedule}"

mkdir -p /backups

while true; do
  TS=$(date +%Y%m%d_%H%M%S)
  OUT="/backups/schedule_${TS}.sql.gz"
  echo "[db-backup] $(date) -> $OUT"
  if pg_dump --clean --if-exists -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" | gzip > "$OUT"; then
    ls -1t /backups/schedule_*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  else
    echo "[db-backup] FAILED — removing partial file"
    rm -f "$OUT"
  fi
  sleep "$BACKUP_INTERVAL_SECONDS"
done
