import {
  validateCollectionQuery,
  validateCollectionView,
  type CollectionQuery,
  type CollectionViewConfiguration,
  type SavedCollection,
  type SavedCollectionId,
  type SavedCollectionRepository,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import type { SQL } from "bun";

interface CollectionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly query: unknown;
  readonly view_config: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly created_by: string;
  readonly updated_by: string;
}

function jsonValue<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: CollectionRow): SavedCollection {
  return {
    id: row.id as SavedCollectionId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name,
    query: validateCollectionQuery(jsonValue<unknown>(row.query)),
    view: validateCollectionView(jsonValue<unknown>(row.view_config)),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    createdBy: row.created_by as UserId,
    updatedBy: row.updated_by as UserId,
  };
}

export class PostgresSavedCollectionRepository implements SavedCollectionRepository {
  constructor(private readonly database: SQL) {}

  async create(collection: SavedCollection): Promise<SavedCollection> {
    const rows = await this.database<CollectionRow[]>`
      INSERT INTO saved_collections
        (id, workspace_id, name, query, view_config, created_at, updated_at, created_by, updated_by)
      VALUES (
        ${collection.id}::uuid, ${collection.workspaceId}::uuid, ${collection.name},
        ${collection.query}::jsonb, ${collection.view}::jsonb,
        ${collection.createdAt}::timestamptz, ${collection.updatedAt}::timestamptz,
        ${collection.createdBy}::uuid, ${collection.updatedBy}::uuid
      )
      RETURNING id, workspace_id, name, query, view_config, created_at, updated_at, created_by, updated_by
    `;
    return fromRow(rows[0]);
  }

  async getById(workspaceId: WorkspaceId, id: SavedCollectionId): Promise<SavedCollection | null> {
    const rows = await this.database<CollectionRow[]>`
      SELECT id, workspace_id, name, query, view_config, created_at, updated_at, created_by, updated_by
      FROM saved_collections WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listByWorkspace(workspaceId: WorkspaceId): Promise<readonly SavedCollection[]> {
    const rows = await this.database<CollectionRow[]>`
      SELECT id, workspace_id, name, query, view_config, created_at, updated_at, created_by, updated_by
      FROM saved_collections WHERE workspace_id = ${workspaceId}::uuid
      ORDER BY lower(name), id
    `;
    return rows.map(fromRow);
  }

  async update(collection: SavedCollection): Promise<SavedCollection | null> {
    const rows = await this.database<CollectionRow[]>`
      UPDATE saved_collections
      SET name = ${collection.name}, query = ${collection.query}::jsonb, view_config = ${collection.view}::jsonb,
        updated_at = ${collection.updatedAt}::timestamptz, updated_by = ${collection.updatedBy}::uuid
      WHERE workspace_id = ${collection.workspaceId}::uuid AND id = ${collection.id}::uuid
      RETURNING id, workspace_id, name, query, view_config, created_at, updated_at, created_by, updated_by
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async remove(workspaceId: WorkspaceId, id: SavedCollectionId): Promise<boolean> {
    const rows = await this.database<{ id: string }[]>`
      DELETE FROM saved_collections WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid RETURNING id
    `;
    return rows.length > 0;
  }
}

export type { CollectionQuery, CollectionViewConfiguration };
