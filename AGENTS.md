# Agent Guide

## Product vision

Build a self-hosted personal and team workspace for documents, structured data, tasks, calendars, graphs, and canvases. These are unified ways to work with shared information, not separate applications.

> **Everything is a node. Everything else is a view.**

> **Never implement a feature by creating a second source of truth for information already represented in the domain model.**

Priorities are data ownership, portability, self-hosting, offline-first behaviour, a coherent user experience, and long-term maintainability. Do not introduce cloud dependencies, Redis, microservices, or proprietary data formats without a demonstrated need.

## Before changing code

1. Read this file, `ROADMAP.md`, and relevant documents in `docs/architecture/` and `docs/decisions/`.
2. Inspect the repository and identify the roadmap tasks affected.
3. Make the smallest coherent change that preserves the shared-node model.
4. Update roadmap checkboxes only when implementation and required verification are complete. Add newly discovered work instead of deleting unfinished items.

## Structure

- `apps/web`: React client and PWA.
- `apps/server`: Bun HTTP, API, WebSocket and background work.
- `apps/desktop`: Electrobun shell; no business logic.
- `packages/domain`: framework-independent domain model and rules.
- `packages/db`: PostgreSQL schema and versioned migrations.
- Other `packages/*`: product capabilities and stable contracts; see the roadmap before creating new packages.
- `docs/architecture`: system boundaries and evolving architecture.
- `docs/decisions`: lightweight numbered ADRs.

Keep domain logic out of React, route handlers, and rendering libraries. Frontend code uses stable API/domain contracts rather than database-shaped objects. Keep Excalidraw, calendar engines, BlockNote, and Electrobun behind package boundaries.

## Engineering conventions

- Use strict TypeScript and explicit public APIs. Avoid casual `any`, hidden circular imports, and giant components/services.
- Prefer Bun runtime, workspaces, package manager, test runner, and APIs where suitable. Avoid Node-only tooling when Bun has a sound native option.
- Validate untrusted input at system boundaries and return useful errors. Use structured server logs; do not send telemetry externally by default.
- PostgreSQL is the relational source of truth for nodes, properties, relations, views, permissions, and scheduling metadata. Yjs is for collaborative document-like state where appropriate, not all application data.
- Database changes require deterministic, versioned migrations. Never rely on production schema auto-sync. After release, do not rewrite migration history casually.
- Before adding a dependency, assess Bun/browser built-ins, maintenance, license, necessity, and implementation cost. Do not replace proven complex systems merely to avoid a dependency.
- Preserve open, exportable user data. Consider permissions, sync, offline behaviour, errors, mobile, accessibility, and performance as part of feature design.

## Tests and commands

Use Bun's test runner for domain and integration tests where practical. Add behaviour-focused tests with features; run the relevant tests, type checks, and builds before claiming completion. Never hide or silently ignore failures. Record any environment blocker and follow-up task.

Expected root commands as packages are implemented: `bun install`, `bun run dev`, `bun test`, `bun run typecheck`, and `bun run build`. Commands must remain accurate as scripts are added. Docker Compose is the self-hosting target; document backup and restore expectations. Docker volumes alone are not backups.

## Roadmap and architecture records

`ROADMAP.md` is the durable implementation plan, not a changelog. Keep specific tasks grouped by milestone, with dependencies, testing, documentation, security, accessibility, desktop, PWA, export, performance, and release work represented. Check off only completed tasks with relevant tests. Significant architectural choices belong in `docs/decisions/` with context, decision, alternatives, consequences, and status.

## Runtime availability

This project requires Bun for its runtime and package commands. If Bun is missing in a development environment, install Bun before using the project commands; do not silently substitute Node as the application runtime.
