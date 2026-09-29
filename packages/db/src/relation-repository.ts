import {
  DomainError,
  type NodeId,
  type NodeRelation,
  type NodeRelationRepository,
  type RelationDefinition,
  type RelationDefinitionId,
  type RelationDefinitionRepository,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import type { SQL } from "bun";

interface RelationDefinitionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly type: string;
  readonly from_label: string;
  readonly to_label: string;
  readonly allow_self_relation: boolean;
}

interface RelationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly relation_type: string;
  readonly created_at: Date | string;
  readonly created_by: string;
}

function fromDefinitionRow(row: RelationDefinitionRow): RelationDefinition {
  return {
    id: row.id as RelationDefinitionId,
    workspaceId: row.workspace_id as WorkspaceId,
    type: row.type,
    fromLabel: row.from_label,
    toLabel: row.to_label,
    allowSelfRelation: row.allow_self_relation,
  };
}

function fromRelationRow(row: RelationRow): NodeRelation {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    fromNodeId: row.from_node_id as NodeId,
    toNodeId: row.to_node_id as NodeId,
    type: row.relation_type,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    createdBy: row.created_by as UserId,
  };
}

export class PostgresRelationDefinitionRepository implements RelationDefinitionRepository {
  constructor(private readonly database: SQL) {}

  async create(definition: RelationDefinition): Promise<RelationDefinition> {
    const rows = await this.database<RelationDefinitionRow[]>`
      INSERT INTO relation_definitions (id, workspace_id, type, from_label, to_label, allow_self_relation)
      VALUES (
        ${definition.id}::uuid, ${definition.workspaceId}::uuid, ${definition.type},
        ${definition.fromLabel}, ${definition.toLabel}, ${definition.allowSelfRelation}
      )
      RETURNING id, workspace_id, type, from_label, to_label, allow_self_relation
    `;
    return fromDefinitionRow(rows[0]);
  }

  async getByType(workspaceId: WorkspaceId, type: string): Promise<RelationDefinition | null> {
    const rows = await this.database<RelationDefinitionRow[]>`
      SELECT id, workspace_id, type, from_label, to_label, allow_self_relation
      FROM relation_definitions
      WHERE workspace_id = ${workspaceId}::uuid AND type = ${type}
    `;
    return rows[0] ? fromDefinitionRow(rows[0]) : null;
  }

  async getForWorkspace(workspaceId: WorkspaceId): Promise<readonly RelationDefinition[]> {
    const rows = await this.database<RelationDefinitionRow[]>`
      SELECT id, workspace_id, type, from_label, to_label, allow_self_relation
      FROM relation_definitions WHERE workspace_id = ${workspaceId}::uuid ORDER BY type
    `;
    return rows.map(fromDefinitionRow);
  }
}

export class PostgresNodeRelationRepository implements NodeRelationRepository {
  constructor(private readonly database: SQL) {}

  async create(relation: NodeRelation): Promise<NodeRelation> {
    return this.database.begin(async (transaction) => {
      const definitions = await transaction<{ allow_self_relation: boolean }[]>`
        SELECT allow_self_relation FROM relation_definitions
        WHERE workspace_id = ${relation.workspaceId}::uuid AND type = ${relation.type}
        FOR SHARE
      `;
      if (!definitions[0]) throw new DomainError("invalid_relation", "The relation type is not registered in this workspace.");
      if (relation.fromNodeId === relation.toNodeId && !definitions[0].allow_self_relation) {
        throw new DomainError("invalid_relation", "This relation does not allow a node to relate to itself.");
      }

      const rows = await transaction<RelationRow[]>`
        INSERT INTO node_relations (id, workspace_id, from_node_id, to_node_id, relation_type, created_at, created_by)
        VALUES (
          ${relation.id}::uuid, ${relation.workspaceId}::uuid, ${relation.fromNodeId}::uuid,
          ${relation.toNodeId}::uuid, ${relation.type}, ${relation.createdAt}::timestamptz, ${relation.createdBy}::uuid
        )
        RETURNING id, workspace_id, from_node_id, to_node_id, relation_type, created_at, created_by
      `;
      return fromRelationRow(rows[0]);
    });
  }

  async getBacklinks(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeRelation[]> {
    const rows = await this.database<RelationRow[]>`
      SELECT id, workspace_id, from_node_id, to_node_id, relation_type, created_at, created_by
      FROM node_relations
      WHERE workspace_id = ${workspaceId}::uuid AND to_node_id = ${nodeId}::uuid
      ORDER BY created_at, id
    `;
    return rows.map(fromRelationRow);
  }

  async getOutgoing(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeRelation[]> {
    const rows = await this.database<RelationRow[]>`
      SELECT id, workspace_id, from_node_id, to_node_id, relation_type, created_at, created_by
      FROM node_relations
      WHERE workspace_id = ${workspaceId}::uuid AND from_node_id = ${nodeId}::uuid
      ORDER BY created_at, id
    `;
    return rows.map(fromRelationRow);
  }
}
