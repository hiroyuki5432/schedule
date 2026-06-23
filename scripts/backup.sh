#!/bin/sh
# On-demand database backup. Writes a gzipped plain-SQL dump to ./backups and
# keeps the most recent BACKUP_KEEP files. Run from the project root:
#   sh scripts/backup.sh
#
# Restore with: sh scripts/restore.sh backups/schedule_YYYYMMDD_HHMMSS.sql.gz
set -e

cd "$(dirname "$0")/.."

# Load .env (POSTGRES_USER / POSTGRES_DB) if present.
[ -f .env ] && . ./.env

PGUSER="${POSTGRES_USER:-app}"
PGDB="${POSTGRES_DB:-schedule}"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p backups
TS=$(date +%Y%m%d_%H%M%S)
OUT="backups/schedule_${TS}.sql.gz"

echo "Backing up database '$PGDB' -> $OUT"
# --clean --if-exists so the dump can be restored over an existing database.
docker compose exec -T db pg_dump --clean --if-exists -U "$PGUSER" -d "$PGDB" | gzip > "$OUT"

# Rotation: keep the newest $KEEP dumps.
ls -1t backups/schedule_*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "Done. Current backups:"
ls -1t backups/schedule_*.sql.gz
