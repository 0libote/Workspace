#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="${1:-$project_root/backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/node-workspace-$timestamp.dump"
temporary_file="$backup_file.tmp"
trap 'rm -f "$temporary_file"' EXIT
umask 077

cd "$project_root"
docker compose exec -T postgres sh -ec \
  'pg_dump --format=custom --no-owner --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$temporary_file"
[[ -s "$temporary_file" ]]
mv "$temporary_file" "$backup_file"
chmod 600 "$backup_file"
printf 'Created PostgreSQL backup: %s\n' "$backup_file"
