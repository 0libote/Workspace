import {
  archiveNode,
  DomainError,
  renameNode,
  restoreNode,
  type NodeId,
  type NodeRepository,
  type CollectionQuery,
  type UserId,
  type WorkspaceId,
  type WorkspaceNode,
} from "@workspace/domain";
import type { SQL } from "bun";

interface NodeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly type: string;
  readonly title: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly created_by: string;
  readonly updated_by: string;
  readonly archived_at: Date | string | null;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: NodeRow): WorkspaceNode {
  const archivedAt = row.archived_at === null ? undefined : toIsoString(row.archived_at);
  return {
    id: row.id as NodeId,
    workspaceId: row.workspace_id as WorkspaceId,
    type: row.type as WorkspaceNode["type"],
    title: row.title,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    createdBy: row.created_by as UserId,
    updatedBy: row.updated_by as UserId,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

export class PostgresNodeRepository implements NodeRepository {
  constructor(private readonly database: SQL) {}

  async create(node: WorkspaceNode): Promise<WorkspaceNode> {
    const rows = await this.database<NodeRow[]>`
      INSERT INTO nodes (
        id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
      ) VALUES (
        ${node.id}::uuid, ${node.workspaceId}::uuid, ${node.type}, ${node.title},
        ${node.createdAt}::timestamptz, ${node.updatedAt}::timestamptz,
        ${node.createdBy}::uuid, ${node.updatedBy}::uuid, ${node.archivedAt ?? null}::timestamptz
      )
      RETURNING id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
    `;
    return fromRow(rows[0]);
  }

  async getById(workspaceId: WorkspaceId, nodeId: NodeId): Promise<WorkspaceNode | null> {
    const rows = await this.database<NodeRow[]>`
      SELECT id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
      FROM nodes
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${nodeId}::uuid
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listByWorkspace(
    workspaceId: WorkspaceId,
    options: { readonly afterId?: NodeId; readonly limit: number; readonly type?: WorkspaceNode["type"] },
  ): Promise<{ readonly items: readonly WorkspaceNode[]; readonly nextCursor?: NodeId }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new DomainError("invalid_page", "Node page size must be between 1 and 100.");
    }
    const afterId = options.afterId ?? null;
    const type = options.type ?? null;
    const rows = await this.database<NodeRow[]>`
      SELECT id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
      FROM nodes
      WHERE workspace_id = ${workspaceId}::uuid
        AND archived_at IS NULL
        AND (${type}::text IS NULL OR type = ${type})
        AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
      ORDER BY id
      LIMIT ${options.limit + 1}
    `;
    const hasNextPage = rows.length > options.limit;
    const pageRows = hasNextPage ? rows.slice(0, options.limit) : rows;
    const items = pageRows.map(fromRow);
    const lastItem = items.at(-1);
    return {
      items,
      ...(hasNextPage && lastItem ? { nextCursor: lastItem.id } : {}),
    };
  }

  async searchByWorkspace(
    workspaceId: WorkspaceId,
    options: { readonly query: string; readonly type?: WorkspaceNode["type"]; readonly page: number; readonly pageSize: number },
  ): Promise<{ readonly items: readonly { node: WorkspaceNode; matchedIn: "title" | "content" }[]; readonly page: number; readonly hasMore: boolean }> {
    if (!Number.isInteger(options.page) || options.page < 1 || options.page > 100 ||
      !Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
      throw new DomainError("invalid_page", "Search pages must be between 1 and 100 with a page size between 1 and 50.");
    }
    const type = options.type ?? null;
    const rows = await this.database<(NodeRow & { readonly matched_in: "title" | "content" })[]>`
      WITH search AS (SELECT websearch_to_tsquery('simple', ${options.query}) AS query)
      SELECT nodes.id, nodes.workspace_id, nodes.type, nodes.title, nodes.created_at, nodes.updated_at,
        nodes.created_by, nodes.updated_by, nodes.archived_at,
        CASE WHEN to_tsvector('simple', nodes.title) @@ search.query THEN 'title' ELSE 'content' END AS matched_in
      FROM nodes
      CROSS JOIN search
      LEFT JOIN node_documents ON node_documents.workspace_id = nodes.workspace_id AND node_documents.node_id = nodes.id
      WHERE nodes.workspace_id = ${workspaceId}::uuid AND nodes.archived_at IS NULL
        AND (${type}::text IS NULL OR nodes.type = ${type})
        AND search.query <> ''
        AND (to_tsvector('simple', nodes.title) @@ search.query OR
          to_tsvector('simple', COALESCE(node_documents.content::text, '')) @@ search.query)
      ORDER BY GREATEST(
        ts_rank_cd(to_tsvector('simple', nodes.title), search.query),
        ts_rank_cd(to_tsvector('simple', COALESCE(node_documents.content::text, '')), search.query)
      ) DESC, nodes.updated_at DESC, nodes.id
      LIMIT ${options.pageSize + 1} OFFSET ${(options.page - 1) * options.pageSize}
    `;
    const hasMore = rows.length > options.pageSize;
    const pageRows = hasMore ? rows.slice(0, options.pageSize) : rows;
    return {
      items: pageRows.map((row) => ({ node: fromRow(row), matchedIn: row.matched_in })),
      page: options.page,
      hasMore,
    };
  }

  async queryCollection(
    workspaceId: WorkspaceId,
    query: CollectionQuery,
    options: { readonly page: number; readonly pageSize: number },
  ): Promise<{ readonly items: readonly WorkspaceNode[]; readonly page: number; readonly hasMore: boolean }> {
    if (!Number.isInteger(options.page) || options.page < 1 || options.page > 100 ||
      !Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
      throw new DomainError("invalid_page", "Collection pages must be between 1 and 100 with a page size between 1 and 100.");
    }
    const types = this.database.array([...query.types], "text");
    const titleContains = query.titleContains.toLowerCase();
    const rows = await this.database<NodeRow[]>`
      SELECT nodes.id, nodes.workspace_id, nodes.type, nodes.title, nodes.created_at, nodes.updated_at,
        nodes.created_by, nodes.updated_by, nodes.archived_at
      FROM nodes
      WHERE nodes.workspace_id = ${workspaceId}::uuid AND nodes.archived_at IS NULL
        AND (cardinality(${types}) = 0 OR nodes.type = ANY(${types}))
        AND (${titleContains} = '' OR position(${titleContains} in lower(nodes.title)) > 0)
      ORDER BY
        CASE WHEN ${query.sortBy} = 'title' AND ${query.sortDirection} = 'asc' THEN lower(nodes.title) END ASC,
        CASE WHEN ${query.sortBy} = 'title' AND ${query.sortDirection} = 'desc' THEN lower(nodes.title) END DESC,
        CASE WHEN ${query.sortBy} = 'createdAt' AND ${query.sortDirection} = 'asc' THEN nodes.created_at END ASC,
        CASE WHEN ${query.sortBy} = 'createdAt' AND ${query.sortDirection} = 'desc' THEN nodes.created_at END DESC,
        CASE WHEN ${query.sortBy} = 'updatedAt' AND ${query.sortDirection} = 'asc' THEN nodes.updated_at END ASC,
        CASE WHEN ${query.sortBy} = 'updatedAt' AND ${query.sortDirection} = 'desc' THEN nodes.updated_at END DESC,
        nodes.id ASC
      LIMIT ${options.pageSize + 1} OFFSET ${(options.page - 1) * options.pageSize}
    `;
    const hasMore = rows.length > options.pageSize;
    return {
      items: (hasMore ? rows.slice(0, options.pageSize) : rows).map(fromRow),
      page: options.page,
      hasMore,
    };
  }

  async updateTitle(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    title: string,
    actorId: UserId,
    now: string,
  ): Promise<WorkspaceNode | null> {
    return this.updateExisting(workspaceId, nodeId, (node) => renameNode(node, title, actorId, now));
  }

  async archive(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    actorId: UserId,
    now: string,
  ): Promise<WorkspaceNode | null> {
    return this.updateExisting(workspaceId, nodeId, (node) => archiveNode(node, actorId, now));
  }

  async restore(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    actorId: UserId,
    now: string,
  ): Promise<WorkspaceNode | null> {
    return this.updateExisting(workspaceId, nodeId, (node) => restoreNode(node, actorId, now));
  }

  private async updateExisting(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    update: (node: WorkspaceNode) => WorkspaceNode,
  ): Promise<WorkspaceNode | null> {
    return this.database.begin(async (transaction) => {
      const rows = await transaction<NodeRow[]>`
        SELECT id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
        FROM nodes
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${nodeId}::uuid
        FOR UPDATE
      `;
      if (!rows[0]) return null;

      const updated = update(fromRow(rows[0]));
      const saved = await transaction<NodeRow[]>`
        UPDATE nodes SET title = ${updated.title}, updated_at = ${updated.updatedAt},
          updated_by = ${updated.updatedBy}::uuid, archived_at = ${updated.archivedAt ?? null}::timestamptz
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${nodeId}::uuid
        RETURNING id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
      `;
      if (!saved[0]) throw new DomainError("invalid_workspace", "The node disappeared while it was being updated.");
      return fromRow(saved[0]);
    });
  }
}
