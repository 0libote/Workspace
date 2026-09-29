import type { CollectionQuery, WorkspaceId, WorkspaceNode } from "@workspace/domain";
import type { SQL } from "bun";

interface CalendarRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly type: string;
  readonly title: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly created_by: string;
  readonly updated_by: string;
  readonly archived_at: Date | string | null;
  readonly properties: Record<string, unknown> | string | null;
}

export interface CalendarNode {
  readonly node: WorkspaceNode;
  readonly properties: Readonly<Record<string, unknown>>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Range query over the canonical scheduling properties; it does not create calendar records. */
export class PostgresCalendarRepository {
  constructor(private readonly database: SQL) {}

  async listRange(workspaceId: WorkspaceId, range: {
    readonly dateFrom: string;
    readonly dateToExclusive: string;
    readonly instantFrom: string;
    readonly instantTo: string;
    readonly collectionQuery?: CollectionQuery;
  }): Promise<readonly CalendarNode[]> {
    const types = this.database.array([...(range.collectionQuery?.types ?? [])], "text");
    const titleContains = range.collectionQuery?.titleContains.toLowerCase() ?? "";
    const rows = await this.database<CalendarRow[]>`
      SELECT nodes.id, nodes.workspace_id, nodes.type, nodes.title, nodes.created_at, nodes.updated_at,
        nodes.created_by, nodes.updated_by, nodes.archived_at,
        jsonb_object_agg(definitions.name, properties.value) FILTER (WHERE definitions.name IS NOT NULL) AS properties
      FROM nodes
      JOIN node_properties AS properties
        ON properties.workspace_id = nodes.workspace_id AND properties.node_id = nodes.id
      JOIN property_definitions AS definitions
        ON definitions.workspace_id = properties.workspace_id AND definitions.id = properties.property_definition_id
      WHERE nodes.workspace_id = ${workspaceId}::uuid AND nodes.archived_at IS NULL
        AND (cardinality(${types}) = 0 OR nodes.type = ANY(${types}))
        AND (${titleContains} = '' OR position(${titleContains} in lower(nodes.title)) > 0)
        AND definitions.name IN ('Start date', 'Due date', 'Start time', 'Due time', 'Duration')
      GROUP BY nodes.id
      HAVING
        (bool_or(definitions.name = 'Start date' AND properties.value->>'type' = 'dateTime'
          AND properties.value->>'value' >= ${range.instantFrom} AND properties.value->>'value' < ${range.instantTo})
          OR bool_or(definitions.name = 'Due date' AND properties.value->>'type' = 'dateTime'
          AND properties.value->>'value' >= ${range.instantFrom} AND properties.value->>'value' < ${range.instantTo})
          OR bool_or(definitions.name = 'Start time' AND properties.value->>'type' = 'dateTime'
          AND properties.value->>'value' >= ${range.instantFrom} AND properties.value->>'value' < ${range.instantTo})
          OR bool_or(definitions.name = 'Due time' AND properties.value->>'type' = 'dateTime'
          AND properties.value->>'value' >= ${range.instantFrom} AND properties.value->>'value' < ${range.instantTo})
          OR bool_or(definitions.name = 'Start date' AND properties.value->>'type' = 'date'
          AND properties.value->>'value' >= ${range.dateFrom} AND properties.value->>'value' < ${range.dateToExclusive})
          OR bool_or(definitions.name = 'Due date' AND properties.value->>'type' = 'date'
          AND properties.value->>'value' >= ${range.dateFrom} AND properties.value->>'value' < ${range.dateToExclusive})
          OR (bool_or(definitions.name = 'Start date' AND properties.value->>'type' = 'date'
          AND properties.value->>'value' < ${range.dateFrom}) AND bool_or(definitions.name = 'Due date'
          AND properties.value->>'type' = 'date' AND properties.value->>'value' >= ${range.dateFrom}))
          OR (bool_or(definitions.name = 'Start time' AND properties.value->>'type' = 'dateTime'
          AND properties.value->>'value' < ${range.instantTo}) AND bool_or(definitions.name = 'Due time'
          AND properties.value->>'type' = 'dateTime' AND properties.value->>'value' >= ${range.instantFrom})))
      ORDER BY nodes.title, nodes.id
      LIMIT 500
    `;
    return rows.map((row) => ({
      node: {
        id: row.id as WorkspaceNode["id"],
        workspaceId: row.workspace_id as WorkspaceId,
        type: row.type as WorkspaceNode["type"],
        title: row.title,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        createdBy: row.created_by as WorkspaceNode["createdBy"],
        updatedBy: row.updated_by as WorkspaceNode["updatedBy"],
        ...(row.archived_at === null ? {} : { archivedAt: iso(row.archived_at) }),
      },
      properties: typeof row.properties === "string" ? JSON.parse(row.properties) as Record<string, unknown> : row.properties ?? {},
    }));
  }
}
