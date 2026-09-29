# 0009 — Saved collections are versioned node queries

- Status: Accepted
- Date: 2026-09-29

## Context

Users need reusable table, list, and board views over workspace content. A collection must remain current as nodes change and should not become another place where titles or properties are stored.

## Decision

Persist each saved collection as a workspace-scoped record containing a versioned, JSON query and view configuration. Validate filter, sort, grouping, layout, and columns in the domain layer. Execute collection queries against canonical nodes with bounded pages and deterministic ordering, using node ID as a tie breaker. Board views group by node type.

## Alternatives considered

- Copy matching nodes into collection-owned rows: rejected because results would become stale and duplicate node state.
- Store arbitrary SQL or executable filters: rejected because user-controlled configuration must stay portable and safe to validate.
- Add a separate query service: rejected because PostgreSQL and the existing node repository can serve the current query needs.

## Consequences

Collection results reflect current node data each time they are queried. Query and view JSON carry version numbers for future migrations. Workspace editors can rename collections, update their query and view configuration, or delete the saved collection while leaving its nodes intact. Filters cover node types and title text. Columns can include title, type, timestamps, and workspace property definitions selected by ID; supported property values can be edited inline through the canonical node property API. Property filtering remains follow-up work. Page-number pagination is bounded to 100 pages of 50 nodes per API request.
