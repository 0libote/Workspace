# Architecture overview

## Product rule

Everything is a node; everything else is a view. A task shown in a page, collection, calendar, graph, or canvas retains one identity and canonical property set.

## Initial boundaries

- `packages/domain` owns framework-independent node, property, relation, and query contracts and rules.
- `packages/db` owns PostgreSQL persistence and versioned migrations; it implements persistence ports without redefining domain meaning.
- `packages/ui` wraps Astryx theme and controls behind a project-owned browser UI surface.
- `packages/editor` wraps BlockNote and returns portable structured block JSON; page identity and properties remain in the domain model.
- `apps/server` owns HTTP/WebSocket boundaries, runtime validation, authorization orchestration, and process lifecycle.
- `apps/web` owns navigation and user interaction, calling stable API contracts.
- Capability packages adapt external engines (editor, canvas, calendar) and do not let those engines become data models.
- `apps/desktop` adapts platform capabilities and contains no business logic.

## Data ownership

Node identity, typed properties, and relations are relational domain data. Document and canvas payloads can use content-appropriate representations, linked to their owning nodes. Saved collections and calendars are queries/views over nodes. External rendering libraries never own duplicate task or event records.

Page block content is stored in `node_documents` JSONB rows keyed by the owning workspace and page node. Writes require an expected revision; stale saves return a conflict. The browser retains a local draft for recovery across refreshes and offline periods; this does not provide multi-writer merging or document history. Page documents can contain a `calendar_view` block that stores a saved collection ID and renders that collection's canonical calendar view; it does not copy task or event data into the document.

Workspace lifecycle and membership roles are domain concepts. User deactivation and workspace/node archiving preserve stable IDs and record lifecycle timestamps rather than deleting identity. Built-in node types are globally available; custom node types are registered per workspace. Directed relation definitions provide labels at both ends, and backlink queries follow the stored relation direction.

## Deployment direction

The initial self-hosted deployment runs the React web assets and Bun API in one application container beside PostgreSQL. Compose waits for PostgreSQL health before starting the application; the server applies checksummed, versioned migrations before accepting requests and exposes liveness and readiness endpoints. PostgreSQL uses a named persistent volume. Redis, Kubernetes, and hosted services are not prerequisites. User-uploaded file storage and backup automation remain future work.

The database package uses Bun.SQL with PostgreSQL. Migration files run serially under a transaction-scoped PostgreSQL advisory lock and are tracked with checksums. Domain repositories scope all node, property, and relation lookups by workspace; the API must additionally authorize the current user through workspace membership. Page and task detail views resolve the same directed relation records, show inverse labels on backlinks, and open linked nodes without duplicating their content.

Saved collections persist versioned, validated query and view JSON in PostgreSQL while querying canonical nodes on demand; collection records never copy node data. Workspace search uses PostgreSQL `simple` full-text search over node titles and page document JSONB text. GIN expression indexes live in a versioned migration and derive from canonical data, so edits automatically change searchable content without a separate indexing worker or external service.

Calendar display lives behind `packages/calendar`: it projects the canonical `Start date`, `Due date`, `Start time`, `Due time`, and `Duration` node properties into a bounded date-range view. PostgreSQL filters candidates by workspace, date range, and optional saved collection type/title filters; the package handles all-day spans, instant conversion, daylight-saving transitions, and display. The workspace calendar accepts explicit ranges of up to 63 days, matching the API query bound. Calendar is available as a saved collection layout as well as a workspace view. Workspaces store an IANA timezone for display and input conversion. Stored date values are not rewritten when the timezone changes, and the calendar does not persist duplicate event records.

Canvas editing lives behind `packages/canvas`, which lazy-loads Excalidraw and owns the surrounding inspector, node search, and save/export controls. Each canvas is itself a canonical `canvas` node. Its Excalidraw-compatible scene is stored as JSONB in `node_canvases`; `canvas_node_bindings` maps scene element IDs to canonical node IDs under workspace-scoped foreign keys. Saves replace scene and bindings in one transaction using an expected revision. Bound labels are projected from current node titles, while Excalidraw custom data keeps node references in exported scene JSON. Excalidraw is a renderer/editor adapter and does not own task or page data.

Relationship graph data is queried from canonical nodes and `node_relations`, not persisted as a duplicate graph. The local graph traverses one or two undirected relation hops from a selected node; the workspace graph returns a bounded recent-node slice. Both return only active nodes and edges contained in the selected node set. The UI renders an accessible SVG overview and offers direct open actions for represented nodes.

`packages/sync` defines the versioned message contract and client lifecycle for document-like synchronization. Protocol v1 scopes Yjs page/canvas updates to a workspace and canonical node and requires a reusable mutation UUID for offline retry idempotency. The package includes an IndexedDB mutation queue, recoverable Yjs state cache, acknowledgement-driven retries, and bounded reconnect backoff. Bun WebSockets authenticate same-origin sessions and workspace roles; PostgreSQL stores merged Yjs updates and idempotency records. These sync documents are not yet the page editor or canvas source of truth: adopting them requires a race-safe migration from the existing JSON snapshots. `packages/platform` defines the browser/native boundary for file selection, export, external links, notifications, and runtime capabilities. Its browser adapter is used by the web client; the future Electrobun shell will inject a native implementation through the same contract.

The web client includes a production web app manifest and service worker. The worker caches the application shell and same-origin static assets only; it bypasses `/api/` requests so authentication and user data are never stored in the service worker cache. Local page draft recovery and the IndexedDB sync queue are separate application storage mechanisms with node-scoped state.

Workspace export is a versioned JSON snapshot assembled under a repeatable-read, read-only PostgreSQL transaction. It preserves canonical workspace records, including archived nodes, and their page/canvas payloads; it excludes credentials and email addresses. Export is a serialization of existing records, not another write model. Binary attachments remain outside v1 until their storage boundary is implemented.

Page Markdown downloads are generated by the editor adapter from the current BlockNote document. This conversion is lossy by design; custom live-calendar blocks become readable placeholders, while versioned workspace JSON preserves their structured references.

Calendar `.ics` downloads serialize the existing range query as RFC 5545 events. All-day end dates stay exclusive in storage and therefore match iCalendar's exclusive `DTEND`; timed events use UTC values to avoid generating incomplete timezone rules. ICS files are exports, not a second scheduling store.

## Evolution

Keep package APIs explicit. Add sync, offline queues, permissions, import/export, and plugins through the roadmap and ADRs. Revisit an accepted decision with a new ADR that explains migration impact; do not silently change the source of truth.
