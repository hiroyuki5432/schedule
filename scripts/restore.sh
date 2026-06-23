#!/bin/sh
# Restore the database from a gzipped SQL dump produced by backup.sh.
# DANGER: this overwrites the current database contents.
#   sh scripts/restore.sh backups/schedule_YYYYMMDD_HHMMSS.sql.gz
set -e

cd "$(dirname "$0")/.."
[ -f .env ] && . ./.env

PGUSER="${POSTGRES_USER:-app}"
PGDB="${POSTGRES_DB:-schedule}"

FILE="$1"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: sh scripts/restore.sh <backups/schedule_*.sql.gz>"
  echo "available:"
  ls -1t backups/schedule_*.sql.gz 2>/dev/null || echo "  (none)"
  exit 1
fi

echo "WARNING: this will OVERWRITE database '$PGDB' with $FILE"
echo "Press Ctrl-C within 5s to abort..."
sleep 5

echo "Restoring..."
gunzip -c "$FILE" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB"
echo "Restore complete."
