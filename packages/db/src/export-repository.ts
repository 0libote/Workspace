import {
  validateNodeDocumentContent,
  validatePropertyValue,
  type CanvasNodeBinding,
  type NodeCanvasDocument,
  type NodeDocument,
  type NodeId,
  type NodeProperty,
  type NodeRelation,
  type PropertyDefinition,
  type PropertyValue,
  type UserId,
  type WorkspaceExport,
  type WorkspaceId,
  type WorkspaceMembership,
  type WorkspaceNode,
  type WorkspaceExportRepository,
} from "@workspace/domain";
import type { SQL } from "bun";
import { PostgresWorkspaceRepository, PostgresNodeTypeDefinitionRepository } from "./identity-repository";
import { PostgresPropertyDefinitionRepository } from "./property-repository";
import { PostgresRelationDefinitionRepository } from "./relation-repository";
import { PostgresSavedCollectionRepository } from "./collection-repository";

function jsonValue<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface ExportNodeRow {
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

interface ExportPropertyRow {
  readonly node_id: string;
  readonly property_definition_id: string;
  readonly value: unknown;
}

interface ExportDocumentRow {
  readonly node_id: string;
  readonly content: unknown;
  readonly revision: number;
  readonly updated_at: Date | string;
  readonly updated_by: string;
}

interface ExportCanvasRow {
  readonly node_id: string;
  readonly scene: unknown;
  readonly revision: number;
  readonly updated_at: Date | string;
  readonly updated_by: string;
}

interface ExportBindingRow {
  readonly canvas_node_id: string;
  readonly element_id: string;
  readonly node_id: string;
}

interface ExportRelationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly relation_type: string;
  readonly created_at: Date | string;
  readonly created_by: string;
}

interface ExportMembershipRow {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly role: WorkspaceMembership["role"];
  readonly joined_at: Date | string;
  readonly display_name: string;
}

export class PostgresWorkspaceExportRepository implements WorkspaceExportRepository {
  constructor(private readonly database: SQL) {}

  exportWorkspace(workspaceId: WorkspaceId, exportedAt: string): Promise<WorkspaceExport | null> {
    return this.database.begin(async (transaction) => {
      await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").simple();
      const workspace = await new PostgresWorkspaceRepository(transaction).getById(workspaceId);
      if (!workspace) return null;

      const [nodeTypes, propertyDefinitions, relationDefinitions, collections, nodeRows, propertyRows, documentRows, canvasRows, bindingRows, relationRows, memberRows] = await Promise.all([
        new PostgresNodeTypeDefinitionRepository(transaction).getForWorkspace(workspaceId),
        new PostgresPropertyDefinitionRepository(transaction).getForWorkspace(workspaceId),
        new PostgresRelationDefinitionRepository(transaction).getForWorkspace(workspaceId),
        new PostgresSavedCollectionRepository(transaction).listByWorkspace(workspaceId),
        transaction<ExportNodeRow[]>`
          SELECT id, workspace_id, type, title, created_at, updated_at, created_by, updated_by, archived_at
          FROM nodes WHERE workspace_id = ${workspaceId}::uuid ORDER BY id
        `,
        transaction<ExportPropertyRow[]>`
          SELECT property.node_id, property.property_definition_id, property.value
          FROM node_properties AS property
          JOIN nodes ON nodes.workspace_id = property.workspace_id AND nodes.id = property.node_id
          WHERE property.workspace_id = ${workspaceId}::uuid ORDER BY property.node_id, property.property_definition_id
        `,
        transaction<ExportDocumentRow[]>`
          SELECT node_id, content, revision, updated_at, updated_by
          FROM node_documents WHERE workspace_id = ${workspaceId}::uuid ORDER BY node_id
        `,
        transaction<ExportCanvasRow[]>`
          SELECT node_id, scene, revision, updated_at, updated_by
          FROM node_canvases WHERE workspace_id = ${workspaceId}::uuid ORDER BY node_id
        `,
        transaction<ExportBindingRow[]>`
          SELECT canvas_node_id, element_id, node_id
          FROM canvas_node_bindings WHERE workspace_id = ${workspaceId}::uuid ORDER BY canvas_node_id, element_id
        `,
        transaction<ExportRelationRow[]>`
          SELECT id, workspace_id, from_node_id, to_node_id, relation_type, created_at, created_by
          FROM node_relations WHERE workspace_id = ${workspaceId}::uuid ORDER BY id
        `,
        transaction<ExportMembershipRow[]>`
          SELECT membership.workspace_id, membership.user_id, membership.role, membership.joined_at, users.display_name
          FROM workspace_memberships AS membership
          JOIN app_users AS users ON users.id = membership.user_id
          WHERE membership.workspace_id = ${workspaceId}::uuid ORDER BY membership.user_id
        `,
      ]);

      const definitionsById = new Map(propertyDefinitions.map((definition) => [definition.id, definition]));
      const propertiesByNode = new Map<string, NodeProperty[]>();
      for (const row of propertyRows) {
        const definition = definitionsById.get(row.property_definition_id as PropertyDefinition["id"]);
        if (!definition) throw new Error("Workspace export found a property without its definition.");
        const value = jsonValue<PropertyValue>(row.value);
        validatePropertyValue(definition, value);
        const property = { nodeId: row.node_id as NodeId, definitionId: row.property_definition_id as PropertyDefinition["id"], value };
        const list = propertiesByNode.get(row.node_id) ?? [];
        list.push(property);
        propertiesByNode.set(row.node_id, list);
      }

      const documentsByNode = new Map<string, NodeDocument>();
      for (const row of documentRows) {
        documentsByNode.set(row.node_id, {
          workspaceId,
          nodeId: row.node_id as NodeId,
          content: validateNodeDocumentContent(jsonValue<unknown>(row.content)),
          revision: row.revision,
          updatedAt: iso(row.updated_at),
          updatedBy: row.updated_by as UserId,
        });
      }

      const bindingsByCanvas = new Map<string, CanvasNodeBinding[]>();
      for (const row of bindingRows) {
        const list = bindingsByCanvas.get(row.canvas_node_id) ?? [];
        list.push({ elementId: row.element_id, nodeId: row.node_id as NodeId });
        bindingsByCanvas.set(row.canvas_node_id, list);
      }
      const canvasesByNode = new Map<string, NodeCanvasDocument>();
      for (const row of canvasRows) {
        const bindings = bindingsByCanvas.get(row.node_id) ?? [];
        canvasesByNode.set(row.node_id, {
          workspaceId,
          nodeId: row.node_id as NodeId,
          scene: jsonValue<NodeCanvasDocument["scene"]>(row.scene),
          bindings,
          revision: row.revision,
          updatedAt: iso(row.updated_at),
          updatedBy: row.updated_by as UserId,
        });
      }

      const nodes: WorkspaceNode[] = nodeRows.map((row) => ({
        id: row.id as NodeId,
        workspaceId: row.workspace_id as WorkspaceId,
        type: row.type as WorkspaceNode["type"],
        title: row.title,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        createdBy: row.created_by as UserId,
        updatedBy: row.updated_by as UserId,
        ...(row.archived_at === null ? {} : { archivedAt: iso(row.archived_at) }),
      }));
      const relations: NodeRelation[] = relationRows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id as WorkspaceId,
        fromNodeId: row.from_node_id as NodeId,
        toNodeId: row.to_node_id as NodeId,
        type: row.relation_type,
        createdAt: iso(row.created_at),
        createdBy: row.created_by as UserId,
      }));
      const memberships: WorkspaceMembership[] = memberRows.map((row) => ({
        workspaceId: row.workspace_id as WorkspaceId,
        userId: row.user_id as UserId,
        role: row.role,
        joinedAt: iso(row.joined_at),
      }));

      return {
        format: "astryx-workspace-export",
        version: 1,
        exportedAt,
        workspace,
        actors: memberRows.map(({ user_id, display_name }) => ({ id: user_id as UserId, displayName: display_name })),
        memberships,
        nodeTypes: nodeTypes.filter((item): item is Extract<typeof item, { source: "workspace" }> => item.source === "workspace"),
        propertyDefinitions,
        relationDefinitions,
        nodes: nodes.map((node) => ({
          node,
          properties: propertiesByNode.get(node.id) ?? [],
          ...(documentsByNode.has(node.id) ? { document: documentsByNode.get(node.id)! } : {}),
          ...(canvasesByNode.has(node.id) ? { canvas: canvasesByNode.get(node.id)! } : {}),
        })),
        relations,
        collections,
      };
    });
  }
}
