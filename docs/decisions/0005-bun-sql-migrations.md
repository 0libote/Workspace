# 0005 — Use Bun.SQL and checked, transactional migrations

- Status: Accepted
- Date: 2026-09-29

## Context

The server runtime is Bun, PostgreSQL is the primary relational store, and the project aims to keep the self-hosted stack small. Production schema changes must be deterministic, serialized across server instances, and protected from accidental edits after they have been applied.

## Decision

Use Bun's built-in `SQL` client rather than adding a PostgreSQL driver. Keep ordered SQL migration files in `packages/db/migrations`. The migration runner takes a PostgreSQL transaction-scoped advisory lock, executes each unapplied migration in a transaction, and records a SHA-256 checksum in `schema_migrations`. A changed applied migration is an error.

## Alternatives considered

- Third-party PostgreSQL client and migration framework: not needed for the current requirements, and adds runtime dependencies.
- ORM schema synchronization: rejected because production upgrades require explicit reviewed migrations.
- Unlocked startup migrations: rejected because concurrent app instances could race.

## Consequences

Migration changes are serialized across instances and DDL errors roll back the current migration. Applied migration files are immutable; later schema work requires a new migration. Migrations currently run through an explicit `bun run db:migrate` command. Startup automation, migration failure recovery documentation, and deployment orchestration remain roadmap work.
