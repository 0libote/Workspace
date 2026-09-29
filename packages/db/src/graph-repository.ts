import type { WorkspaceGraph, WorkspaceGraphQuery, WorkspaceGraphRepository, NodeType } from "@workspace/domain";
import type { SQL } from "bun";

interface GraphNodeRow { readonly id: string; readonly type: string; readonly title: string }
interface GraphEdgeRow { readonly id: string; readonly from_node_id: string; readonly to_node_id: string; readonly relation_type: string }

export class PostgresWorkspaceGraphRepository implements WorkspaceGraphRepository {
  constructor(private readonly database: SQL) {}

  async query(query: WorkspaceGraphQuery): Promise<WorkspaceGraph> {
    const nodeRows = query.nodeId
      ? await this.database<GraphNodeRow[]>`
        WITH RECURSIVE edges AS (
          SELECT r.from_node_id, r.to_node_id FROM node_relations r
          JOIN nodes source ON source.workspace_id = r.workspace_id AND source.id = r.from_node_id AND source.archived_at IS NULL
          JOIN nodes target ON target.workspace_id = r.workspace_id AND target.id = r.to_node_id AND target.archived_at IS NULL
          WHERE r.workspace_id = ${query.workspaceId}::uuid
        ), walk(node_id, depth, path) AS (
          SELECT ${query.nodeId}::uuid, 0, ARRAY[${query.nodeId}::uuid]
          UNION ALL
          SELECT next_node.node_id, walk.depth + 1, walk.path || next_node.node_id
          FROM walk
          JOIN LATERAL (
            SELECT CASE WHEN edges.from_node_id = walk.node_id THEN edges.to_node_id ELSE edges.from_node_id END AS node_id
            FROM edges WHERE edges.from_node_id = walk.node_id OR edges.to_node_id = walk.node_id
          ) next_node ON TRUE
          WHERE walk.depth < ${query.depth} AND NOT next_node.node_id = ANY(walk.path)
        ), candidates AS (
          SELECT n.id, n.type, n.title, MIN(walk.depth) AS depth
          FROM walk JOIN nodes n ON n.workspace_id = ${query.workspaceId}::uuid AND n.id = walk.node_id AND n.archived_at IS NULL
          GROUP BY n.id, n.type, n.title
        )
        SELECT id, type, title FROM candidates
        ORDER BY depth, title, id LIMIT ${query.limit + 1}
      `
      : await this.database<GraphNodeRow[]>`
        SELECT id, type, title FROM nodes
        WHERE workspace_id = ${query.workspaceId}::uuid AND archived_at IS NULL
        ORDER BY updated_at DESC, id LIMIT ${query.limit + 1}
      `;
    const truncated = nodeRows.length > query.limit;
    const visibleNodes = nodeRows.slice(0, query.limit);
    const ids = visibleNodes.map(({ id }) => id);
    if (ids.length === 0) return { nodes: [], edges: [], truncated };
    const edgeRows = await this.database<GraphEdgeRow[]>`
      SELECT id, from_node_id, to_node_id, relation_type FROM node_relations
      WHERE workspace_id = ${query.workspaceId}::uuid
        AND from_node_id = ANY(${this.database.array(ids, "uuid")})
        AND to_node_id = ANY(${this.database.array(ids, "uuid")})
      ORDER BY created_at, id
    `;
    return {
      nodes: visibleNodes.map(({ id, type, title }) => ({ id: id as WorkspaceGraph["nodes"][number]["id"], type: type as NodeType, title })),
      edges: edgeRows.map(({ id, from_node_id, to_node_id, relation_type }) => ({ id, source: from_node_id as WorkspaceGraph["nodes"][number]["id"], target: to_node_id as WorkspaceGraph["nodes"][number]["id"], type: relation_type })),
      truncated,
    };
  }
}
