# ADR 0013: Store canvas scenes as open Excalidraw JSON

## Status

Accepted

## Context

Workspace canvases need a visual editing engine while keeping tasks, pages, properties, and relations canonical in the workspace domain. Canvas state must remain exportable and scoped to a workspace. Concurrent edits also need stale-write protection.

## Decision

Represent a canvas as a canonical `canvas` node. Store its Excalidraw-compatible scene JSON in a versioned PostgreSQL row keyed by `(workspace_id, node_id)`. Store element-to-node references in a separate `canvas_node_bindings` table with workspace-scoped foreign keys. Save scene and bindings atomically with an expected revision. Export scenes in Excalidraw's open `.excalidraw` JSON format, keeping node IDs in element custom data for portability. Project linked text labels from canonical node titles when opening the canvas.

Keep Excalidraw behind `packages/canvas`; the package owns node search, linking, conversion, inspector actions, and persistence integration. The library owns only drawing interaction and scene serialization.

## Alternatives considered

- Persist tasks or pages as canvas element data: rejected because it would create a second source of truth.
- Store only opaque engine-specific blobs: rejected because it weakens exportability and inspection.
- Put node IDs only in element custom data: rejected because the relational binding table is needed for validation, workspace constraints, and future querying.

## Consequences

- Scene files remain compatible with Excalidraw JSON import/export, and bindings are separately validated against canonical workspace nodes.
- Database backups must include both canvas tables along with the node tables.
- Concurrent saves that use stale revisions return a conflict and preserve the latest committed scene.
- The initial editor caps scenes at 5,000 elements and 8 MB. Images are retained in the Excalidraw scene files map; separate attachment storage and collaborative canvas editing remain future work.
- Replacing Excalidraw later requires an adapter or a migration of scene JSON, but does not require migrating canonical node records.
