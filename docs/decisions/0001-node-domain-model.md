# 0001 — Nodes as the shared domain model

- Status: Accepted
- Date: 2026-09-29

## Context

Pages, tasks, projects, events, and other workspace objects must appear in multiple views without duplicated state. Separate feature-owned records would make updates inconsistent and weaken offline/sync behaviour.

## Decision

Represent meaningful workspace items as typed nodes with stable IDs. Store extensible typed properties separately from node identity. Model relationships as first-class records. Collections, calendars, graphs, and canvases query or render those same nodes.

## Alternatives considered

- Independent page, task, and calendar-event stores: rejected because each becomes a source of truth.
- One giant table with every possible field: rejected because types and user-defined properties need to evolve.

## Consequences

Views and feature packages must use domain/API contracts. Node/property/relation validation and query semantics are foundational. Specialized document and canvas payloads may have their own storage, but their identity and links remain attached to nodes.
