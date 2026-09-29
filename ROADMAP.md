# Product Roadmap

This is the implementation source of truth. Tasks are checked only when the implementation and relevant verification are complete. Dependencies are called out where order matters.

## Phase 0 — Architecture and repository

### Governance and architecture
- [x] Establish product principles and AI working rules in `AGENTS.md`.
- [x] Create phased roadmap covering product, platform, quality, and release work.
- [x] Record initial node model, PostgreSQL, Yjs, and desktop shell decisions.
- [x] Document package boundaries, data flow, and first deployment topology.
- [ ] Review licensing and dependency policy for the selected stack and define the project license before distribution (BlockNote's Ariakit integration is MPL-2.0; the full transitive audit is pending).

### Monorepo and tooling
- [x] Configure Bun workspaces and shared strict TypeScript settings.
- [x] Create the Electrobun desktop application package (web and server packages are present).
- [x] Create domain, database, and project-owned UI packages with stable boundaries.
- [x] Create the editor package boundary with BlockNote isolated from the app shell.
- [ ] Create canvas, calendar, collections, graph, search, sync, commands, shared, and plugin SDK package boundaries as implementation requires.
- [x] Define the platform package boundary and browser adapter for files, notifications, external links, and environment capabilities.
- [ ] Configure formatting and linting; Bun test, typecheck, and server build commands are present.
- [x] Add CI for install, static checks, unit/integration/browser tests, desktop typecheck, and build.
- [x] Complete Docker Compose for the app and PostgreSQL with health checks and startup migrations.
- [x] Document PostgreSQL backup and restore expectations and validate archive restore into a disposable database.

## Phase 1 — Domain foundation

### Identity and workspace
- [x] Define workspace and user identifiers, workspace archival, user deactivation, and membership roles.
- [x] Define node identity, type, title, audit fields, archive/restore semantics, and validation.
- [x] Define node type registration with built-in types and workspace-scoped custom types.
- [x] Define typed property definitions separately from node property values.
- [x] Define first-class directed relations, inverse labels, self-link rules, and backlink queries.

### Persistence and API
- [x] Add versioned PostgreSQL migrations for workspace, user, node, property definitions/values, node types, memberships, and relations.
- [x] Add domain repository interfaces and PostgreSQL implementations behind domain/API boundaries.
- [x] Add initial workspace, node lifecycle, property, type, and relation HTTP operations with runtime input validation and consistent errors.
- [x] Add workspace membership authorization checks to the implemented operations.
- [x] Add one-time owner setup, password login, opaque sessions, CSRF checks, and logout/revocation.
- [x] Add viewer-role API coverage for workspace reads and writes.
- [ ] Add login rate limiting, account recovery/invitations, and session cleanup policy.
- [x] Add PostgreSQL integration tests for migrations, workspace-scoped node CRUD, typed properties, and relation backlinks.
- [ ] Add multi-version migration upgrade and failure-path checks (initial migration idempotency and checksums are verified).

## Phase 2 — Application shell
- [x] Establish the React web application, project-owned button/theme wrappers, and neutral Astryx theme.
- [x] Add the responsive signed-in shell, workspace selector, and hash-linked All items, Tasks, and Pages views over shared nodes.
- [x] Keep view state in sync with browser back/forward navigation for the hash routes.
- [x] Allow workspace creation and safely close node details when switching workspaces.
- [ ] Complete route handling, mobile navigation, and reduced-motion, keyboard, and screen reader interaction checks.
- [ ] Add command registry and keyboard-accessible command palette.
- [x] Add workspace search entry point with keyboard-accessible labels and loading/empty/error states.
- [ ] Add connection/sync status surfaces.
- [x] Define typed client API contracts and basic loading, error, and empty states.

## Phase 3 — Documents
- [x] Store page identity and properties on nodes; keep block content in a separate PostgreSQL JSONB document row keyed to the page node.
- [x] Integrate BlockNote behind the project editor package with project-owned CSS and the app's accessible UI boundary.
- [x] Add page create/open, debounced autosave, optimistic revision checks, and persistence tests.
- [x] Preserve page drafts in local storage across refresh and offline periods, retry after reconnection, and retain revision conflicts for review.
- [ ] Add structured blocks, including task, node-reference, and view embed extension points.
- [ ] Implement `[[Wiki Links]]` search, create-missing-node flow, structured relation updates, and backlinks.
- [ ] Add page properties.
- [x] Show and create incoming/outgoing node relations with inverse labels in page/task details; verify page/task consistency and linked navigation in the browser workflow.
- [ ] Add editor keyboard, accessibility, and mobile behaviour coverage.
- [ ] Reduce the lazy editor bundle and define a document-load performance budget (current editor chunk is about 890 kB minified / 268 kB gzip).

## Phase 4 — Tasks
- [ ] Represent tasks as nodes with configurable status, priority, dates, assignee, and project properties.
- [x] Seed workspace node properties for status, priority, start date, due date, and duration for new and existing workspaces.
- [ ] Create task nodes from a page and command palette through the shared node operation; the general node API already creates task nodes.
- [x] Add list-level completion controls backed by the canonical Status property; verify list/detail consistency in the browser workflow.
- [x] Add task list and task detail surfaces backed by node queries.
- [x] Persist status, priority, dates, and duration edits through canonical node properties; verify persistence in the browser workflow.
- [x] Let workspace editors define custom task properties and edit common typed values from task details.
- [x] Test page/task relation consistency through the shared node relation API and browser workflow.

## Phase 5 — Collections
- [x] Define versioned saved collection query and view configuration models over canonical nodes.
- [x] Implement validated type/title filtering, sorting, grouping by type, and paginated queries.
- [x] Persist and render saved table, list, and board layouts with standard node columns.
- [x] Add user-configurable property columns and inline edits backed by canonical node properties; verify edits persist across collection and task detail views.
- [x] Add workspace-scoped saved collection CRUD with role checks and query integration coverage.
- [x] Add collection rename, filter editing, and delete controls in the web interface with workspace role checks and responsive browser coverage.
- [x] Virtualize table, list, and board collection results; verify bounded mounted rows and scrolling with large fixtures before broad workspace loading.

## Phase 6 — Calendar
- [x] Define scheduling semantics using node date/datetime properties, time zones, and duration.
- [x] Add calendar rendering behind a project calendar adapter.
- [x] Render scheduled nodes and support month, week, day, and agenda navigation.
- [x] Make drag/drop update the canonical node property with optimistic/error recovery.
- [x] Add saved collection calendar layouts and apply their stored node type/title filters.
- [x] Embed saved calendar views in page documents as portable blocks that reference saved collections.
- [x] Add explicit calendar date-range filters with API-aligned validation and browser coverage.
- [x] Verify end-to-end: page → task → calendar → move date → page reflects update (Playwright workflow).
- [x] Defer recurring rules, external feeds, and CalDAV until core scheduling is stable.

## Phase 7 — Canvas
- [x] Integrate Excalidraw in the canvas package with lazy loading and project-owned surrounding UI.
- [x] Persist canvas state in an open, exportable representation.
- [x] Define canvas element to node bindings without putting domain logic in Excalidraw adapters.
- [x] Add live node-backed task/page cards and server-backed node search.
- [x] Add convert-to-node, link-existing-node, open-node, and contextual inspector actions.
- [ ] Verify one task remains consistent across canvas, page, calendar, and collection views.

## Phase 8 — Search and graph
- [x] Implement PostgreSQL full-text search over node titles and page content using versioned expression indexes.
- [x] Add workspace search type filters, result attribution, relevance ordering, and paginated loading.
- [x] Add relationship graph queries and local/global graph views.
- [x] Test index updates and relation traversal; keep full-text search and graph queries in PostgreSQL until a measured need for external infrastructure exists.

## Phase 9 — Realtime and offline
- [x] Define the v1 sync envelope, protocol versioning, workspace/session authorization contract, and idempotent mutation IDs (ADR 0014, `packages/sync`).
- [x] Add Bun WebSocket transport and client connection lifecycle; verify authenticated browser sync, reconnect backoff, and offline queue acknowledgement.
- [ ] Integrate Yjs for collaborative document/canvas state where suitable.
- [ ] Migrate existing page JSON and canvas snapshots into Yjs with a race-safe one-time seed before switching their canonical persistence path.
- [x] Add the browser IndexedDB mutation queue with stable IDs, in-order retries, and removal only after acknowledgement.
- [x] Connect the queue to WebSocket reconnects, add bounded backoff, and expose conflict status from the client connection.
- [x] Persist Yjs document state in IndexedDB, restore it before connecting, and clear its node-scoped cache with pending mutations.
- [x] Provide a user-visible page revision conflict and local recovery flow; browser coverage verifies the server copy and downloadable local draft both survive refresh.
- [ ] Handle multi-tab/device state and reconnection.
- [ ] Test offline create/edit/reconnect and concurrent document editing.

## Phase 10 — Desktop
- [x] Add an Electrobun Bun-process shell that opens the same self-hosted web application.
- [x] Define `packages/platform` interfaces for files, notifications, external links, and environment.
- [ ] Implement native menus and platform adapters without leaking shell APIs into product code.
- [ ] Add packaging, deep link, update, and desktop smoke-test strategy.

## Phase 11 — PWA and mobile
- [x] Add manifest, icons, install flow, and app shell service worker caching; production Playwright smoke confirms offline navigation fallback and API cache bypass.
- [ ] Add offline content storage and clear sync state on mobile.
- [ ] Deliver touch-first navigation, safe-area layouts, and mobile editor controls.
- [ ] Add mobile canvas interaction and performance budget.
- [ ] Add Web Push only with explicit permission and self-hosted configuration guidance.
- [ ] Verify install and offline workflows on supported browsers.

## Phase 12 — Import and export
- [x] Define versioned workspace JSON export including schema, workspace settings, actors/memberships, nodes, properties, relations, documents, canvases, and saved collections.
- [ ] Include attachment payloads in portable exports after local blob storage and attachment metadata are implemented.
- [x] Add lossy Markdown page export, representing embedded live calendars with readable placeholders.
- [ ] Add Markdown import and round-trip coverage.
- [ ] Add Excalidraw-compatible canvas import/export where practical.
- [x] Add RFC 5545 ICS export for a calendar date range, preserving all-day spans and UTC timed events.
- [ ] Add ICS import for scheduling data.
- [ ] Add Obsidian vault importer with wiki link and attachment mapping.
- [ ] Evaluate Notion export importer and document unsupported constructs.
- [ ] Test data portability and ensure no user content is trapped in a proprietary format.

## Phase 13 — Collaboration and permissions
- [ ] Define workspace roles and node-level access model.
- [ ] Add presence and collaborative cursors where supported.
- [ ] Expand sharing and permissions with audit coverage.
- [ ] Test permission enforcement over API, sync, search, export, and relations.

## Phase 14 — Plugin foundations
- [ ] Define versioned plugin manifest and compatibility policy.
- [ ] Design sandboxed client extension points for commands, blocks, and views.
- [ ] Add capability-based permissions and plugin lifecycle controls.
- [ ] Document plugin SDK and example extension.
- [ ] Defer arbitrary server-side code execution pending a separate security design.

## Phase 15 — Production hardening and release
- [ ] Perform security review of auth, authorization, sync, uploads, and plugin boundaries.
- [ ] Complete accessibility review for keyboard, screen reader, contrast, and reduced motion.
- [ ] Add structured logs, health/version endpoints, and actionable diagnostics.
- [ ] Validate graceful shutdown, database connectivity, migrations, and upgrades.
- [ ] Run performance checks for large node sets, documents, canvases, and attachments.
- [ ] Document tested backup and restore procedure; validate restore into a clean deployment.
- [ ] Publish Docker deployment and upgrade guide without Kubernetes or cloud requirements.
- [ ] Establish desktop/PWA release and support policy.
- [ ] Verify critical proof workflow across page, task, calendar, table, board, and canvas.
