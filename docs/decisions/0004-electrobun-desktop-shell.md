# 0004 — Electrobun as the planned desktop shell

- Status: Accepted
- Date: 2026-09-29

## Context

Desktop should reuse the React application while providing native menus, notifications, and file access. Product logic should remain portable if the shell changes later.

## Decision

Use Electrobun 2.0.1 with Bun as the desktop main-process runtime. `apps/desktop` opens the existing self-hosted web application in a native BrowserWindow and exposes only native application menus; it contains no domain or persistence logic. `ASTRYX_SERVER_URL` selects the self-hosted HTTP(S) origin, defaulting to the local Docker Compose port. The web client uses the `packages/platform` contract; the browser adapter works inside the webview while native file and notification adapters remain future work.

## Alternatives considered

- Tauri: viable alternative, but not selected for the initial target.
- Electron: mature but heavier than desired for this product.

## Consequences

No domain or product package may depend directly on Electrobun APIs. The host-native canary package has been built on Linux. GUI launch, signing, deep links, updater configuration, and native capability bridging still require desktop-target verification.
