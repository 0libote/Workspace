# PostgreSQL backup and restore

The PostgreSQL database is the source of truth for workspace content and authentication data. The named Compose volume keeps it across container replacement; it does not protect against disk loss, operator error, or volume corruption. Keep backups outside the machine that runs the app and protect them as sensitive data.

## Create a backup

With the Compose stack running, run:

```sh
./scripts/backup-postgres.sh
```

The script writes a PostgreSQL custom-format dump under `backups/`, creates the directory with mode `0700`, and writes each dump with mode `0600`. It uses a temporary file and only publishes the final name after `pg_dump` succeeds. Copy completed dumps to separate protected storage and define a retention schedule that fits your workspace.

To choose another local backup directory, pass it as the first argument:

```sh
./scripts/backup-postgres.sh /mnt/protected/workspace-backups
```

## Restore a backup

Restore replaces the configured Compose database. Confirm the backup is the one you intend to restore, then run:

```sh
./scripts/restore-postgres.sh backups/node-workspace-YYYYMMDDTHHMMSSZ.dump --confirm
```

The script stops the app to prevent writes, restores the dump in a single transaction, and starts the app again. Versioned migrations are applied by the app on startup. Keep a separate pre-restore backup before recovering over a database that contains changes you may still need.

## Verify a backup

A successful backup should be checked with PostgreSQL's archive reader before it is copied offsite:

```sh
docker compose exec -T postgres pg_restore --list < backups/node-workspace-YYYYMMDDTHHMMSSZ.dump
```

For a recovery drill, restore into a disposable PostgreSQL database running the same major version, then start an app instance against that database and verify login, workspaces, page documents, properties, and relations. Repeat the drill after PostgreSQL major-version upgrades and keep a dated record of the result. The repository provides scripts for backup and in-place restore; scheduling, offsite transport, and automated recovery drills are operator responsibilities.
