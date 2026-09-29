# Node Workspace

A self-hosted workspace where pages, tasks, projects, events, and other items share one node model and appear through different views.

> Everything is a node. Everything else is a view.

## Current state

This repository contains the shared-node domain, Bun API, PostgreSQL persistence, password-based owner setup and login, pages, tasks, saved collections, workspace timezone settings, and a calendar with month/week/day/agenda views. Calendar entries project canonical task properties and date moves update those properties. Product capabilities and remaining work are tracked in [ROADMAP.md](ROADMAP.md). Read [AGENTS.md](AGENTS.md) before making changes.

## Requirements

- Bun (see https://bun.sh)
- Docker Compose for a local PostgreSQL instance, or a PostgreSQL 17 database you manage.

## Development

```sh
bun install
bun run db:migrate
bun run dev
bun run test
bun run typecheck
bun run build
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers bun run test:e2e
```

Copy `.env.example` to `.env`, then start the local database with `docker compose up -d postgres`. Apply versioned migrations with `bun run db:migrate`. `bun run dev` starts the React client at `http://127.0.0.1:4173` and the Bun API at port 3190. The standalone API command (`bun run start`) defaults to port 3000. `GET /health` is liveness; `GET /ready` checks database readiness. The web client supports owner setup/login, workspace selection/creation, shared task/page/project/event nodes, and a BlockNote page editor with debounced saves, local draft recovery across refresh/offline periods, and revision conflict handling. The Tasks and Pages views filter the same nodes. Workspace search finds node titles and page content with type filters and paginated results. Editors can save filtered, sorted node collections as reusable table, list, or board views; collection rows always query the canonical nodes. The calendar renders canonical `Start date`, `Due date`, `Start time`, `Due time`, and `Duration` properties in the workspace timezone. Editors can move events with drag and drop or the date control; failed saves restore the prior display. Task details and task-list completion controls edit canonical properties for status, priority, dates, duration, and workspace-defined fields. Migrations add task defaults for existing workspaces, and workspace creation adds them for new ones. Page and task details show outgoing links and backlinks with inverse labels, and editors can create workspace relation types and connect existing nodes. Authenticated writes require the session's `x-csrf-token` value. Set `APP_URL` to the public web origin when running behind a reverse proxy so CSRF origin checks and secure cookies use the browser-facing URL.

To run the self-hosted stack, set `POSTGRES_PASSWORD` and `APP_URL` in `.env`, then run `docker compose up --build -d`. The app container applies versioned migrations at startup, serves both the web client and API, and waits for PostgreSQL readiness. Open `APP_URL` in a browser. Set `APP_PORT` if the default host port 3000 is already in use. The Compose PostgreSQL volume persists data, but it is not a backup; schedule backups and keep copies outside this host.

The production web client includes an install manifest and a service worker for the app shell and static assets. Use the browser's install action to add Astryx to the device. Offline navigation can load the shell, while API calls still require a connection; page drafts and queued sync edits are stored separately in browser storage.

Workspace members can download a versioned JSON export from the workspace header. It includes active and archived nodes, their properties and relations, page and canvas data, and saved collections. Binary attachments are not part of v1 because attachment storage is not implemented yet.

Page editors can also download a lossy Markdown rendering. Embedded live calendars are represented by readable placeholders; use the workspace JSON export to preserve their full structured content.

Calendar views can download the displayed date range as an RFC 5545 `.ics` file. All-day events retain inclusive dates, and timed events use UTC instants. ICS import and recurring events remain future work.

Use [`docs/operations/backup-and-restore.md`](docs/operations/backup-and-restore.md) to create protected PostgreSQL backups and restore them. The included backup script was validated by restoring its archive into a disposable database.

The Bun test command covers domain behaviour and skips PostgreSQL integration tests when `DATABASE_URL_TEST` is not set. Run those tests against a disposable database with `DATABASE_URL_TEST=... bun run test:integration`. Playwright always runs a health smoke test and runs the authenticated workspace workflow when `DATABASE_URL_TEST` points at a disposable PostgreSQL database. Do not point integration or E2E tests at data you need to keep: the tests create and mutate persistent records.
