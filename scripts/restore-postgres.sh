#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$2" != "--confirm" ]]; then
  printf 'Usage: %s BACKUP_FILE --confirm\nRestoring replaces the configured workspace database.\n' "$0" >&2
  exit 2
fi
backup_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [[ ! -s "$backup_file" ]]; then
  printf 'Backup file is missing or empty: %s\n' "$backup_file" >&2
  exit 2
fi
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

# Keep concurrent application writes out of the database during the restore.
docker compose stop app
restart_app() { docker compose start app >/dev/null; }
trap restart_app EXIT

docker compose exec -T postgres sh -ec \
  'pg_restore --single-transaction --clean --if-exists --exit-on-error --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup_file"
