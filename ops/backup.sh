#!/bin/sh
set -eu
umask 077
: "${BACKUP_DIR:?Set an encrypted backup destination}"
: "${PGHOST:?Set PGHOST}"
: "${PGDATABASE:?Set PGDATABASE}"
: "${PGUSER:?Set PGUSER}"
: "${PGPASSFILE:?Set a restricted PostgreSQL password file}"
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/pathway-$stamp.dump"
pg_dump --format=custom --no-owner --file="$target.part"
mv "$target.part" "$target"
printf 'Backup completed: %s\n' "$target"
