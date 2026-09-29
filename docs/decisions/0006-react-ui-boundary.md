# 0006 — React client with a project-owned UI package

- Status: Accepted
- Date: 2026-09-29

## Context

The web client uses React 19 and Astryx. Product components should own their visual language and avoid depending directly on a third-party component API throughout feature code. The client also needs an independently runnable development server while the API remains a Bun service.

## Decision

Use React 19 with Vite for the browser client. Put Astryx theme setup, wrapped controls, and its CSS entry point in `packages/ui`. Feature code imports the stable project-owned UI surface. Keep domain and API contracts outside rendering components. Vite proxies browser API requests to the Bun server during development.

## Alternatives considered

- Import Astryx directly throughout `apps/web`: simpler at first, but couples each screen to its API and styling conventions.
- Put all UI components inside `apps/web`: viable, but prevents other clients from reusing the project-owned UI boundary.
- Serve development assets from the API process: possible, but adds development bundling concerns to the server lifecycle.

## Consequences

Astryx can be adapted or replaced behind `packages/ui`; app screens use the project wrappers. Vite is a development/build tool, not a production runtime dependency. Production asset serving and self-hosted app packaging remain future work.
