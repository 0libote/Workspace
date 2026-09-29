import {
  validateNodeDocumentContent,
  type NodeDocument,
  type NodeDocumentRepository,
  type NodeId,
  type SaveNodeDocumentInput,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import type { SQL } from "bun";

interface DocumentRow {
  readonly workspace_id: string;
  readonly node_id: string;
  readonly content: unknown;
  readonly revision: number;
  readonly updated_at: Date | string;
  readonly updated_by: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: DocumentRow): NodeDocument {
  const content = typeof row.content === "string" ? JSON.parse(row.content) as unknown : row.content;
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    nodeId: row.node_id as NodeId,
    content: validateNodeDocumentContent(content),
    revision: row.revision,
    updatedAt: toIsoString(row.updated_at),
    updatedBy: row.updated_by as UserId,
  };
}

export class PostgresNodeDocumentRepository implements NodeDocumentRepository {
  constructor(private readonly database: SQL) {}

  async get(workspaceId: WorkspaceId, nodeId: NodeId): Promise<NodeDocument | null> {
    const rows = await this.database<DocumentRow[]>`
      SELECT workspace_id, node_id, content, revision, updated_at, updated_by
      FROM node_documents
      WHERE workspace_id = ${workspaceId}::uuid AND node_id = ${nodeId}::uuid
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async save(input: SaveNodeDocumentInput): Promise<NodeDocument | null> {
    const rows = await this.database<DocumentRow[]>`
      INSERT INTO node_documents (workspace_id, node_id, content, revision, updated_at, updated_by)
      VALUES (
        ${input.workspaceId}::uuid, ${input.nodeId}::uuid, ${input.content},
        1, ${input.now}::timestamptz, ${input.actorId}::uuid
      )
      ON CONFLICT (workspace_id, node_id) DO UPDATE SET
        content = EXCLUDED.content,
        revision = node_documents.revision + 1,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      WHERE node_documents.revision = ${input.expectedRevision}
      RETURNING workspace_id, node_id, content, revision, updated_at, updated_by
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }
}
