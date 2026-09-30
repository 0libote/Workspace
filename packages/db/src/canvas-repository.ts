import type { CanvasNodeBinding, NodeCanvasDocument, NodeCanvasRepository, SaveNodeCanvasInput, UserId, WorkspaceId } from "@workspace/domain";
import type { SQL } from "bun";

interface CanvasRow {
  readonly workspace_id: string;
  readonly node_id: string;
  readonly scene: unknown;
  readonly revision: number;
  readonly updated_at: Date | string;
  readonly updated_by: string;
}

interface BindingRow {
  readonly element_id: string;
  readonly node_id: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: CanvasRow, bindings: readonly CanvasNodeBinding[]): NodeCanvasDocument {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    nodeId: row.node_id as NodeCanvasDocument["nodeId"],
    scene: typeof row.scene === "string" ? JSON.parse(row.scene) as NodeCanvasDocument["scene"] : row.scene as NodeCanvasDocument["scene"],
    bindings,
    revision: row.revision,
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by as UserId,
  };
}

async function getBindings(database: SQL, workspaceId: WorkspaceId, nodeId: NodeCanvasDocument["nodeId"]): Promise<readonly CanvasNodeBinding[]> {
  const rows = await database<BindingRow[]>`
    SELECT element_id, node_id FROM canvas_node_bindings
    WHERE workspace_id = ${workspaceId}::uuid AND canvas_node_id = ${nodeId}::uuid
    ORDER BY element_id
  `;
  return rows.map(({ element_id, node_id }) => ({ elementId: element_id, nodeId: node_id as CanvasNodeBinding["nodeId"] }));
}

export class PostgresNodeCanvasRepository implements NodeCanvasRepository {
  constructor(private readonly database: SQL) {}

  async get(workspaceId: WorkspaceId, nodeId: NodeCanvasDocument["nodeId"]): Promise<NodeCanvasDocument | null> {
    const rows = await this.database<CanvasRow[]>`
      SELECT workspace_id, node_id, scene, revision, updated_at, updated_by
      FROM node_canvases WHERE workspace_id = ${workspaceId}::uuid AND node_id = ${nodeId}::uuid
    `;
    const row = rows[0];
    return row ? fromRow(row, await getBindings(this.database, workspaceId, nodeId)) : null;
  }

  save(input: SaveNodeCanvasInput): Promise<NodeCanvasDocument | null> {
    return this.database.begin(async (transaction) => {
      const rows = await transaction<CanvasRow[]>`
        INSERT INTO node_canvases (workspace_id, node_id, scene, revision, updated_at, updated_by)
        SELECT ${input.workspaceId}::uuid, ${input.nodeId}::uuid, ${input.scene}, 1,
          ${input.now}::timestamptz, ${input.actorId}::uuid
        WHERE ${input.expectedRevision} = 0 OR EXISTS (
          SELECT 1 FROM node_canvases current_canvas
          WHERE current_canvas.workspace_id = ${input.workspaceId}::uuid
            AND current_canvas.node_id = ${input.nodeId}::uuid
            AND current_canvas.revision = ${input.expectedRevision}
        )
        ON CONFLICT (workspace_id, node_id) DO UPDATE SET
          scene = EXCLUDED.scene,
          revision = node_canvases.revision + 1,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
        WHERE node_canvases.revision = ${input.expectedRevision}
        RETURNING workspace_id, node_id, scene, revision, updated_at, updated_by
      `;
      const row = rows[0];
      if (!row) return null;

      await transaction`
        DELETE FROM canvas_node_bindings
        WHERE workspace_id = ${input.workspaceId}::uuid AND canvas_node_id = ${input.nodeId}::uuid
      `;
      for (const binding of input.bindings) {
        await transaction`
          INSERT INTO canvas_node_bindings (workspace_id, canvas_node_id, element_id, node_id)
          VALUES (${input.workspaceId}::uuid, ${input.nodeId}::uuid, ${binding.elementId}, ${binding.nodeId}::uuid)
        `;
      }
      return fromRow(row, input.bindings);
    });
  }
}
