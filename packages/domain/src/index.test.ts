import { describe, expect, test } from "bun:test";
import {
  archiveNode,
  archiveWorkspace,
  createNode,
  createMembership,
  createRelation,
  createSavedCollection,
  createUser,
  createWorkspace,
  deactivateUser,
  DomainError,
  getBacklinks,
  getRelationLabel,
  normalizeTimeZone,
  registerNodeType,
  restoreNode,
  validateNodeDocumentContent,
  validateCollectionQuery,
  validateCollectionView,
  validatePropertyValue,
  updateWorkspaceTimeZone,
  type NodeId,
  type NodeRelation,
  type NodeType,
  type RelationDefinition,
  type RelationDefinitionId,
  type SavedCollectionId,
  type PropertyDefinition,
  type PropertyDefinitionId,
  type UserId,
  type WorkspaceId,
} from "./index";

const workspaceId = "workspace-1" as WorkspaceId;
const actorId = "user-1" as UserId;
const nodeId = "node-1" as NodeId;
const now = "2026-09-29T10:00:00.000Z";
const later = "2026-09-30T10:00:00.000Z";

describe("workspace identity and lifecycle", () => {
  test("normalizes workspace and user values and creates membership roles", () => {
    const workspace = createWorkspace({ id: workspaceId, name: "  Studio  ", now });
    const user = createUser({ id: actorId, email: " OWNER@EXAMPLE.COM ", displayName: " Oliver ", now });
    expect(workspace.name).toBe("Studio");
    expect(user.email).toBe("owner@example.com");
    expect(createMembership(workspaceId, actorId, "owner", now).role).toBe("owner");
  });

  test("records archive and deactivation timestamps without deleting identity", () => {
    const workspace = createWorkspace({ id: workspaceId, name: "Studio", now });
    const user = createUser({ id: actorId, email: "owner@example.com", displayName: "Oliver", now });
    expect(archiveWorkspace(workspace, later)).toMatchObject({ id: workspaceId, archivedAt: later });
    expect(deactivateUser(user, later)).toMatchObject({ id: actorId, deactivatedAt: later });
  });

  test("rejects invalid users and empty workspaces", () => {
    expect(() => createWorkspace({ id: workspaceId, name: "  ", now })).toThrow(DomainError);
    expect(() => createUser({ id: actorId, email: "bad", displayName: "Oliver", now })).toThrow(DomainError);
  });

  test("stores a validated IANA time zone and updates it without replacing identity", () => {
    const workspace = createWorkspace({ id: workspaceId, name: "Studio", timeZone: " America/New_York ", now });
    expect(workspace.timeZone).toBe("America/New_York");
    expect(updateWorkspaceTimeZone(workspace, "Europe/London", later)).toMatchObject({
      id: workspaceId,
      name: "Studio",
      timeZone: "Europe/London",
      updatedAt: later,
    });
    expect(createWorkspace({ id: workspaceId, name: "UTC", now }).timeZone).toBe("UTC");
    expect(() => normalizeTimeZone("Mars/Olympus_Mons")).toThrow(DomainError);
  });
});

describe("node types and archival", () => {
  test("registers workspace-scoped custom types and rejects duplicates", () => {
    const customType = { type: "meeting" as NodeType, label: "Meeting", source: "workspace" as const, workspaceId };
    const registered = registerNodeType(customType, []);
    expect(registered).toEqual([customType]);
    expect(() => registerNodeType(customType, registered)).toThrow(DomainError);
    expect(createNode({
      id: nodeId,
      workspaceId,
      type: customType.type,
      title: "Review notes",
      actorId,
      now,
      registeredTypes: registered,
    }).type).toBe(customType.type);
    expect(() => createNode({ id: nodeId, workspaceId, type: customType.type, title: "Review notes", actorId, now }))
      .toThrow(DomainError);
  });

  test("archives and restores the same node id with audit updates", () => {
    const node = createNode({ id: nodeId, workspaceId, type: "task" as NodeType, title: "Draft roadmap", actorId, now });
    const archived = archiveNode(node, actorId, later);
    expect(archived).toMatchObject({ id: nodeId, archivedAt: later, updatedAt: later });
    const restored = restoreNode(archived, actorId, now);
    expect(restored.id).toBe(node.id);
    expect(restored).not.toHaveProperty("archivedAt");
  });
});

describe("createNode", () => {
  test("trims title and initializes audit fields from one actor and timestamp", () => {
    expect(createNode({ id: nodeId, workspaceId, type: "task" as NodeType, title: "  Draft roadmap  ", actorId, now })).toEqual({
      id: nodeId,
      workspaceId,
      type: "task" as NodeType,
      title: "Draft roadmap",
      createdAt: now,
      updatedAt: now,
      createdBy: actorId,
      updatedBy: actorId,
    });
  });

  test("rejects an empty title with a domain error", () => {
    expect(() => createNode({ id: nodeId, workspaceId, type: "page" as NodeType, title: "  ", actorId, now }))
      .toThrowError(new DomainError("invalid_title", "A node title must contain at least one non-space character."));
  });

  test("rejects malformed and unregistered node types", () => {
    expect(() => createNode({ id: nodeId, workspaceId, type: "Task" as NodeType, title: "Review", actorId, now }))
      .toThrowError(new DomainError("invalid_node_type", "Node types use a lowercase identifier format."));
    expect(() => createNode({ id: nodeId, workspaceId, type: "meeting" as NodeType, title: "Review", actorId, now }))
      .toThrowError(new DomainError("invalid_node_type", "Node type meeting is not registered for this workspace."));
  });
});

describe("property validation", () => {
  const dueDate: PropertyDefinition = {
    id: "due-date" as PropertyDefinitionId,
    workspaceId,
    name: "Due date",
    type: "date",
    required: false,
  };

  test("accepts a date property and rejects mismatched types", () => {
    expect(() => validatePropertyValue(dueDate, { type: "date", value: "2026-09-30" })).not.toThrow();
    expect(() => validatePropertyValue(dueDate, { type: "text", value: "tomorrow" }))
      .toThrowError(new DomainError("invalid_property_value", "Property Due date expects date, received text."));
  });

  test("rejects invalid date ranges", () => {
    const range: PropertyDefinition = { ...dueDate, type: "dateRange" };
    expect(() => validatePropertyValue(range, {
      type: "dateRange",
      value: { start: "2026-10-01T00:00:00.000Z", end: "2026-09-30T00:00:00.000Z" },
    })).toThrow(DomainError);
  });

  test("rejects impossible calendar dates", () => {
    expect(() => validatePropertyValue(dueDate, { type: "date", value: "2026-02-30" })).toThrow(DomainError);
  });

  test("rejects negative durations", () => {
    const duration: PropertyDefinition = { ...dueDate, name: "Duration", type: "duration" };
    expect(() => validatePropertyValue(duration, { type: "duration", value: -1 }))
      .toThrowError(new DomainError("invalid_property_value", "Property Duration must be zero or more."));
  });

  test("rejects malformed JSON values at runtime boundaries", () => {
    expect(() => validatePropertyValue(dueDate, { type: "multiSelect", value: "not-an-array" }))
      .toThrowError(new DomainError("invalid_property_value", "Property Due date has a malformed value."));
  });
});

describe("getBacklinks", () => {
  const relationDefinition: RelationDefinition = {
    id: "reference" as RelationDefinitionId,
    workspaceId,
    type: "references",
    fromLabel: "references",
    toLabel: "referenced by",
    allowSelfRelation: false,
  };

  test("returns incoming relations and excludes outgoing relations", () => {
    const relation = (id: string, fromNodeId: string, toNodeId: string): NodeRelation => createRelation({
      id,
      workspaceId,
      fromNodeId: fromNodeId as NodeId,
      toNodeId: toNodeId as NodeId,
      actorId,
      now,
    }, relationDefinition);
    const relations = [relation("in", "other", nodeId), relation("out", nodeId, "other")];
    expect(getBacklinks(nodeId, relations).map(({ id }) => id)).toEqual(["in"]);
    expect(getRelationLabel(relations[0], nodeId, relationDefinition)).toBe("referenced by");
    expect(getRelationLabel(relations[1], nodeId, relationDefinition)).toBe("references");
  });

  test("rejects cross-workspace or forbidden self-relations", () => {
    expect(() => createRelation({
      id: "x",
      workspaceId,
      fromNodeId: nodeId,
      toNodeId: nodeId,
      actorId,
      now,
    }, relationDefinition)).toThrow(DomainError);

    expect(() => createRelation({
      id: "x",
      workspaceId: "workspace-2" as WorkspaceId,
      fromNodeId: nodeId,
      toNodeId: "node-2" as NodeId,
      actorId,
      now,
    }, relationDefinition)).toThrow(DomainError);
  });
});

describe("page document validation", () => {
  test("accepts portable structured blocks", () => {
    expect(validateNodeDocumentContent([{
      id: "paragraph-1",
      type: "paragraph",
      content: [{ type: "text", text: "A note", styles: {} }],
      children: [],
    }])).toHaveLength(1);
  });

  test("rejects malformed blocks and excessive nesting", () => {
    expect(() => validateNodeDocumentContent([{ type: "paragraph" }])).toThrow(DomainError);
    let deeplyNested: unknown = "text";
    for (let depth = 0; depth < 34; depth += 1) deeplyNested = [deeplyNested];
    expect(() => validateNodeDocumentContent([{ id: "p", type: "paragraph", content: deeplyNested }]))
      .toThrowError(new DomainError("invalid_document", "Document content must be a JSON array of valid blocks."));
  });
});

describe("saved collection definitions", () => {
  test("normalizes filter, sort, group, and view configuration while keeping node types canonical", () => {
    const collection = createSavedCollection({
      id: "collection-1" as SavedCollectionId,
      workspaceId,
      name: "  My tasks  ",
      query: { types: ["task"], titleContains: " Launch ", sortBy: "title", sortDirection: "asc", groupBy: "type" },
      view: { layout: "board", columns: ["title", "type"] },
      actorId,
      now,
    });
    expect(collection.name).toBe("My tasks");
    expect(collection.query.titleContains).toBe("Launch");
    expect(collection.view.layout).toBe("board");
    expect(collection.query.types).toEqual(["task" as NodeType]);
  });

  test("rejects unsafe or unsupported filters and view columns", () => {
    expect(() => validateCollectionQuery({ types: ["Task;"] })).toThrow(DomainError);
    expect(() => validateCollectionQuery({ types: ["task", "task"] })).toThrow(DomainError);
    expect(() => validateCollectionQuery({ sortBy: "workspaceId; drop table" })).toThrow(DomainError);
    expect(() => validateCollectionQuery({ version: 2 })).toThrow(DomainError);
    expect(() => validateCollectionView({ layout: "canvas", columns: ["title"] })).toThrow(DomainError);
    expect(() => validateCollectionView({ version: 2 })).toThrow(DomainError);
    expect(() => validateCollectionView({ layout: "table", columns: ["type"] })).toThrow(DomainError);
  });

  test("accepts saved calendar views over the same canonical node filters", () => {
    expect(validateCollectionView({ layout: "calendar", columns: ["title"] })).toEqual({
      version: 1,
      layout: "calendar",
      columns: ["title"],
    });
  });
});
