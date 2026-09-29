import {
  DomainError,
  validatePropertyValue,
  type NodeId,
  type NodeProperty,
  type NodePropertyRepository,
  type PropertyDefinition,
  type PropertyDefinitionId,
  type PropertyDefinitionRepository,
  type PropertyType,
  type PropertyValue,
  type WorkspaceId,
} from "@workspace/domain";
import type { SQL } from "bun";

interface PropertyDefinitionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly property_type: PropertyType;
  readonly required: boolean;
  readonly options: readonly string[] | string | null;
}

interface NodePropertyRow {
  readonly node_id: string;
  readonly property_definition_id: string;
  readonly value: PropertyValue | string;
}

function parseOptions(options: PropertyDefinitionRow["options"]): readonly string[] | undefined {
  if (options === null) return undefined;
  return typeof options === "string" ? JSON.parse(options) as readonly string[] : options;
}

function fromDefinitionRow(row: PropertyDefinitionRow): PropertyDefinition {
  const options = parseOptions(row.options);
  return {
    id: row.id as PropertyDefinitionId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name,
    type: row.property_type,
    required: row.required,
    ...(options === undefined ? {} : { options }),
  };
}

function fromNodePropertyRow(row: NodePropertyRow): NodeProperty {
  return {
    nodeId: row.node_id as NodeId,
    definitionId: row.property_definition_id as PropertyDefinitionId,
    value: typeof row.value === "string" ? JSON.parse(row.value) as PropertyValue : row.value,
  };
}

export class PostgresPropertyDefinitionRepository implements PropertyDefinitionRepository {
  constructor(private readonly database: SQL) {}

  async create(definition: PropertyDefinition): Promise<PropertyDefinition> {
    const options = definition.options === undefined ? null : { values: definition.options };
    const rows = await this.database<PropertyDefinitionRow[]>`
      INSERT INTO property_definitions (id, workspace_id, name, property_type, required, options)
      VALUES (
        ${definition.id}::uuid, ${definition.workspaceId}::uuid, ${definition.name},
        ${definition.type}, ${definition.required}, (${options}::jsonb -> 'values')
      )
      RETURNING id, workspace_id, name, property_type, required, options
    `;
    return fromDefinitionRow(rows[0]);
  }

  async getById(workspaceId: WorkspaceId, definitionId: PropertyDefinitionId): Promise<PropertyDefinition | null> {
    const rows = await this.database<PropertyDefinitionRow[]>`
      SELECT id, workspace_id, name, property_type, required, options
      FROM property_definitions
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${definitionId}::uuid
    `;
    return rows[0] ? fromDefinitionRow(rows[0]) : null;
  }

  async getForWorkspace(workspaceId: WorkspaceId): Promise<readonly PropertyDefinition[]> {
    const rows = await this.database<PropertyDefinitionRow[]>`
      SELECT id, workspace_id, name, property_type, required, options
      FROM property_definitions WHERE workspace_id = ${workspaceId}::uuid ORDER BY name, id
    `;
    return rows.map(fromDefinitionRow);
  }
}

export class PostgresNodePropertyRepository implements NodePropertyRepository {
  constructor(private readonly database: SQL) {}

  async set(workspaceId: WorkspaceId, property: NodeProperty): Promise<NodeProperty> {
    const definitions = await this.database<PropertyDefinitionRow[]>`
      SELECT id, workspace_id, name, property_type, required, options
      FROM property_definitions
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${property.definitionId}::uuid
    `;
    if (!definitions[0]) throw new DomainError("invalid_property_value", "The property definition does not exist in this workspace.");
    validatePropertyValue(fromDefinitionRow(definitions[0]), property.value);

    const rows = await this.database<NodePropertyRow[]>`
      INSERT INTO node_properties (workspace_id, node_id, property_definition_id, value_type, value)
      VALUES (
        ${workspaceId}::uuid, ${property.nodeId}::uuid, ${property.definitionId}::uuid,
        ${property.value.type}, ${property.value}::jsonb
      )
      ON CONFLICT (node_id, property_definition_id) DO UPDATE
      SET value_type = EXCLUDED.value_type, value = EXCLUDED.value
      RETURNING node_id, property_definition_id, value
    `;
    return fromNodePropertyRow(rows[0]);
  }

  async getForNode(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeProperty[]> {
    const rows = await this.database<NodePropertyRow[]>`
      SELECT property.node_id, property.property_definition_id, property.value
      FROM node_properties AS property
      JOIN nodes ON nodes.workspace_id = property.workspace_id AND nodes.id = property.node_id
      WHERE property.workspace_id = ${workspaceId}::uuid AND property.node_id = ${nodeId}::uuid
      ORDER BY property.property_definition_id
    `;
    return rows.map(fromNodePropertyRow);
  }

  async getForNodes(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
    definitionId: PropertyDefinitionId,
  ): Promise<readonly NodeProperty[]> {
    if (nodeIds.length === 0) return [];
    const rows = await this.database<NodePropertyRow[]>`
      SELECT property.node_id, property.property_definition_id, property.value
      FROM node_properties AS property
      JOIN nodes ON nodes.workspace_id = property.workspace_id AND nodes.id = property.node_id
      WHERE property.workspace_id = ${workspaceId}::uuid
        AND property.node_id = ANY(${this.database.array([...nodeIds], "uuid")})
        AND property.property_definition_id = ${definitionId}::uuid
      ORDER BY property.node_id
    `;
    return rows.map(fromNodePropertyRow);
  }

  async getForNodesAndDefinitions(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
    definitionIds: readonly PropertyDefinitionId[],
  ): Promise<readonly NodeProperty[]> {
    if (nodeIds.length === 0 || definitionIds.length === 0) return [];
    const rows = await this.database<NodePropertyRow[]>`
      SELECT property.node_id, property.property_definition_id, property.value
      FROM node_properties AS property
      JOIN nodes ON nodes.workspace_id = property.workspace_id AND nodes.id = property.node_id
      WHERE property.workspace_id = ${workspaceId}::uuid
        AND property.node_id = ANY(${this.database.array([...nodeIds], "uuid")})
        AND property.property_definition_id = ANY(${this.database.array([...definitionIds], "uuid")})
      ORDER BY property.node_id, property.property_definition_id
    `;
    return rows.map(fromNodePropertyRow);
  }

  async remove(workspaceId: WorkspaceId, nodeId: NodeId, definitionId: PropertyDefinitionId): Promise<boolean> {
    const rows = await this.database<{ node_id: string }[]>`
      DELETE FROM node_properties
      WHERE workspace_id = ${workspaceId}::uuid AND node_id = ${nodeId}::uuid
        AND property_definition_id = ${definitionId}::uuid
      RETURNING node_id
    `;
    return rows.length > 0;
  }
}
