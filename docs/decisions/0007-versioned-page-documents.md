# 0007 — Store page blocks as versioned node documents

- Status: Accepted
- Date: 2026-09-29

## Context

Pages share node identity, typed properties, and relations with all other workspace items. Rich block content needs a representation suited to an editor without making that editor a second owner of page identity or task data. The first editor is BlockNote; collaboration and offline editing are later milestones.

## Decision

Store editor block JSON in a `node_documents` PostgreSQL table keyed by `(workspace_id, node_id)`. Keep page title, properties, permissions, and relations on the canonical node model. Each document save uses an integer revision and an expected-revision check so concurrent stale writes fail with a conflict instead of silently replacing newer content.

## Alternatives considered

- Put the full block document in a node property: mixes large editor payloads with structured queryable properties.
- Store content in files or a separate service: adds lifecycle and backup complexity before there is a need.
- Use Yjs persistence immediately: appropriate for collaborative editing, but requires sync protocol and update-log work not yet implemented.
- Store only Markdown: simple and portable, but does not preserve structured block types and metadata.

## Consequences

Block content remains in open JSON form in the existing PostgreSQL service and is deleted with its owning node. Revisions detect concurrent saves but do not yet retain history or merge changes. Yjs collaboration, offline recovery, export formats, and attachments remain future work.
