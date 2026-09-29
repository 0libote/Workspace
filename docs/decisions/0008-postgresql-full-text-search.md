# 0008 — PostgreSQL full-text search

- Status: Accepted
- Date: 2026-09-29

## Context

The workspace needs title and page-content search while remaining self-hosted and keeping PostgreSQL as its source of truth. Search must stay current when a node title or page document changes.

## Decision

Use PostgreSQL's `simple` text-search configuration with `websearch_to_tsquery`, relevance ranking, and GIN expression indexes over `nodes.title` and `node_documents.content::text`. Keep authorization and workspace scoping in the API and repository query. Create indexes through immutable versioned migrations.

## Alternatives considered

- Add an external search service: rejected because current requirements do not justify an extra service or synchronization lifecycle.
- Maintain a separate search document table: rejected because it duplicates content and creates update consistency work.
- Use substring matching only: rejected because it cannot use the selected full-text indexes or rank useful results.

## Consequences

Title and document changes are searchable immediately from canonical rows. Search behavior and tokenization follow PostgreSQL's `simple` configuration; stemming and language-specific dictionaries are not provided. Search performance must be measured against larger self-hosted workspaces before adding more infrastructure.
