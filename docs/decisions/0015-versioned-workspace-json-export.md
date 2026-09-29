# ADR 0015: Versioned workspace JSON export

## Status

Accepted

## Context

Users need a readable, portable copy of their workspace data. The canonical information lives across relational node, property, relation, membership, and saved collection records, with separate structured page and Excalidraw canvas payloads. An export must preserve IDs and relations without making the export format a second application source of truth.

## Decision

Provide an authenticated, read-only workspace JSON export with the format identifier `astryx-workspace-export` and integer schema version. Build each snapshot in a PostgreSQL repeatable-read, read-only transaction. Include workspace settings, actor IDs and display names, memberships, custom types, property and relation definitions, active and archived nodes, typed properties, page document content, Excalidraw scene JSON and node bindings, and saved collection definitions. Do not export passwords, sessions, or member email addresses. Keep file payload export as a separate task until application attachment storage exists.

## Alternatives considered

- Export database-shaped tables as unrelated arrays: rejected because it makes node ownership and per-node content harder for consumers to follow.
- Export only visible active nodes: rejected because archived user data should remain portable.
- Include user emails and credentials: rejected because authentication data is unnecessary for restoring workspace content and exposes personal data.
- Treat Yjs sync rows as a second document copy: rejected because the editor and canvas still use JSON snapshots as their canonical path.

## Consequences

- Exports preserve stable node, property, relation, membership, and collection IDs for future restore/import tooling.
- The v1 JSON output can grow with workspace size and is assembled in memory; large-workspace streaming and attachment bundles remain follow-up work.
- Property values that reference files remain present, but binary file export waits for the storage boundary and metadata model.
