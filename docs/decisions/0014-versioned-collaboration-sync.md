# ADR 0014: Versioned, workspace-authorized collaboration sync

## Status

Accepted

## Context

Pages and canvas scenes need offline editing and concurrent updates. Node identity, properties, relations, and permissions remain relational data. Sync must work in a single self-hosted Bun/PostgreSQL deployment without Redis or a hosted provider.

## Decision

Use a versioned JSON envelope over same-origin WebSockets for Yjs document updates. Protocol version 1 scopes each join and update to a workspace, node, and supported document kind (`page` or `canvas`). The client sends a state vector when joining and base64url encoded binary Yjs updates while editing. The server derives the actor from the HttpOnly session cookie, verifies the request origin and workspace role, and checks the node kind before subscribing or accepting updates. Client-supplied actor IDs are never trusted.

Each update carries a UUID mutation ID. A retry must reuse that ID. The server records the accepted ID with the authenticated actor, document scope, and update digest in the same transaction as the update. Repeating an ID with the same digest returns its prior acknowledgement; reusing it with different content is rejected. Protocol version mismatches receive an explicit error so clients can upgrade instead of misreading messages.

Use Bun's WebSocket transport and PostgreSQL persistence in the existing application process. Browser offline updates are stored in IndexedDB and retried in order after reconnect. Yjs is limited to document-like page and canvas content; structured node properties continue to use validated transactional APIs.

The server stores one merged Yjs state and monotonically increasing revision per workspace/node/document kind. A transaction locks that state row, merges the update, and records the idempotency digest and acknowledgement revision. The client connection adapter applies remote updates, queues local updates with stable IDs, waits for acknowledgements, and retries after bounded exponential backoff. IndexedDB stores both pending mutations and a recoverable Yjs state cache; the cache is discardable and can be cleared together with a document's queue. Existing page JSON documents and canvas scene snapshots have not yet migrated to this collaboration store; editor adoption must include a one-time, race-safe data migration before the store becomes their source of truth.

## Alternatives considered

- Use PostgreSQL notifications, Redis, or a hosted realtime service: rejected for the first self-hosted deployment because they add infrastructure without a measured scale need.
- Send full document snapshots for every edit: rejected because it loses Yjs' incremental merge behavior and increases transfer size.
- Trust client actor or workspace data: rejected because authorization must come from the session and database membership.
- Put relational node properties in Yjs: rejected because SQL constraints and workspace queries remain authoritative for that data.

## Consequences

- Protocol changes require an explicit version and compatibility decision.
- Offline retries are safe only when they preserve the original mutation ID and update bytes.
- Authorization is evaluated at connection join and before every mutation; a revoked session or membership must close or reject the socket.
- PostgreSQL remains the durable collaboration store. WebSocket broadcasts are a latency optimization; reconnect state is derived from persisted Yjs updates.
- IndexedDB is a local queue/cache, not a second shared source of truth.
