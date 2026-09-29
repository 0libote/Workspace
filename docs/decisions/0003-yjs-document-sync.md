# 0003 — Use Yjs selectively for collaborative content

- Status: Accepted
- Date: 2026-09-29

## Context

Documents and some canvas state benefit from offline editing and concurrent collaboration. Relational data such as node properties and permissions benefits from explicit transactional constraints and queries.

## Decision

Use Yjs for document-like collaborative state where it fits. Keep structured relational workspace data in PostgreSQL and define explicit synchronization boundaries between the two.

## Alternatives considered

- Put all application state in a CRDT: rejected because relational constraints, authorization, and querying become harder.
- Use server-only document editing: rejected because offline-first behaviour is a product requirement.

## Consequences

The sync protocol, persistence, authorization, conflict handling, and offline mutation queue require dedicated design and tests before being marked complete. This ADR does not prescribe a specific Yjs transport or storage encoding.
