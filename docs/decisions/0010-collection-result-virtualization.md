# 0010 — Virtualize collection result layouts

- Status: Accepted
- Date: 2026-09-29

## Context

Collection queries return bounded pages of 50 canonical nodes and allow up to 100 pages. The client previously appended each page and rendered every loaded row or card, allowing thousands of DOM elements for one collection. The workspace list remains capped at 100 nodes; broadening it requires its own loading and performance design.

## Decision

Use TanStack Virtual in the web adapter to render only visible collection rows/cards plus ten overscan items on each side. Measure rendered items so property editors, titles, and cards can vary in height. Apply the virtualizer to table, list, and each board lane. Keep query pagination and the explicit Load more action; virtualization controls DOM work, not data access or ownership.

## Alternatives considered

- Increase API limits and continue rendering all returned rows: rejected because it increases network, memory, and rendering cost together.
- Use CSS `content-visibility` alone: rejected because it leaves every row mounted and does not bound DOM size.
- Implement custom scroll measurement and range management: rejected because dynamic row measurement and scroll correction are complex and already supported by the selected headless library.

## Consequences

The virtualization dependency is confined to `apps/web`; it owns no domain state and MIT licensing permits self-hosted distribution. Collection layouts use scrollable result regions and render only a viewport-sized subset. Browser coverage checks the mounted row count and scrolling to the last result in table, list, and board layouts. The workspace-wide 100-node cap remains until that view has its own pagination and accessibility review.
