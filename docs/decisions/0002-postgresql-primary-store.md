# 0002 — PostgreSQL as the primary relational store

- Status: Accepted
- Date: 2026-09-29

## Context

The self-hosted application needs durable storage for nodes, properties, relations, users, permissions, saved views, scheduling, search metadata, and sync metadata without requiring several infrastructure services.

## Decision

Use PostgreSQL as the primary server database. Evolve schema through deterministic, versioned migrations. Add other infrastructure only in response to demonstrated needs.

## Alternatives considered

- Embedded database: less suitable for multi-user server and collaboration goals.
- PostgreSQL plus separate cache/search/message services from day one: rejected as unnecessary operational burden.

## Consequences

Database boundaries and migration safety are core responsibilities. Search begins with PostgreSQL capabilities; scaling choices can be revisited with measured evidence.
