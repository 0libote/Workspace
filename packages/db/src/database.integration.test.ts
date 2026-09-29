import { test, expect } from "bun:test";
import { SQL } from "bun";
import * as Y from "yjs";
import {
  createMembership,
  createNode,
  createRelation,
  createSavedCollection,
  createUser,
  createWorkspace,
  validateNodeDocumentContent,
  type NodeId,
  type NodeType,
  type PropertyDefinition,
  type PropertyDefinitionId,
  type RelationDefinition,
  type RelationDefinitionId,
  type SavedCollectionId,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  applyMigrations,
  PostgresCalendarRepository,
  PostgresNodeCanvasRepository,
  PostgresSyncDocumentRepository,
  PostgresWorkspaceGraphRepository,
  PostgresNodePropertyRepository,
  PostgresNodeRelationRepository,
  PostgresSavedCollectionRepository,
  PostgresNodeRepository,
  PostgresNodeDocumentRepository,
  PostgresNodeTypeDefinitionRepository,
  PostgresPropertyDefinitionRepository,
  PostgresRelationDefinitionRepository,
  PostgresUserRepository,
  PostgresWorkspaceMembershipRepository,
  PostgresWorkspaceRepository,
} from "./index";

const databaseUrl = Bun.env.DATABASE_URL_TEST;

test.skipIf(!databaseUrl)("PostgreSQL migrations and node persistence retain workspace boundaries", async () => {
  const database = new SQL(databaseUrl!);
  const userId = crypto.randomUUID() as UserId;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const differentWorkspaceId = crypto.randomUUID() as WorkspaceId;
  const nodeId = crypto.randomUUID() as NodeId;
  const relatedNodeId = crypto.randomUUID() as NodeId;
  const canvasNodeId = crypto.randomUUID() as NodeId;
  const propertyDefinitionId = crypto.randomUUID() as PropertyDefinitionId;
  const relationDefinitionId = crypto.randomUUID() as RelationDefinitionId;
  const now = new Date().toISOString();
  let workspaceCreated = false;

  try {
    const firstRun = await applyMigrations(database);
    const secondRun = await applyMigrations(database);
    expect([...firstRun.applied, ...firstRun.alreadyApplied].sort()).toEqual([
      "0001_initial_workspace",
      "0002_auth_credentials_and_sessions",
      "0003_node_documents",
      "0004_default_task_properties",
      "0005_search_indexes",
      "0006_saved_collections",
      "0007_workspace_time_zone",
      "0008_calendar_property_range_index",
      "0009_default_task_time_properties",
      "0010_canvas_documents",
      "0011_yjs_sync_documents",
    ]);
    expect([...secondRun.alreadyApplied].sort()).toEqual([
      "0001_initial_workspace",
      "0002_auth_credentials_and_sessions",
      "0003_node_documents",
      "0004_default_task_properties",
      "0005_search_indexes",
      "0006_saved_collections",
      "0007_workspace_time_zone",
      "0008_calendar_property_range_index",
      "0009_default_task_time_properties",
      "0010_canvas_documents",
      "0011_yjs_sync_documents",
    ]);

    const workspace = createWorkspace({ id: workspaceId, name: "Integration workspace", now });
    const user = createUser({ id: userId, email: `${userId}@example.test`, displayName: "Integration user", now });
    const membership = createMembership(workspace.id, user.id, "owner", now);
    const users = new PostgresUserRepository(database);
    const workspaces = new PostgresWorkspaceRepository(database);
    const memberships = new PostgresWorkspaceMembershipRepository(database);
    expect(await users.create(user)).toEqual(user);
    expect(await workspaces.create(workspace)).toEqual(workspace);
    const updatedWorkspace = await workspaces.updateTimeZone(workspaceId, "Europe/London", new Date().toISOString());
    expect(updatedWorkspace).toMatchObject({ id: workspaceId, timeZone: "Europe/London" });
    workspaceCreated = true;
    expect(await memberships.create(membership)).toEqual(membership);
    expect((await memberships.get(workspaceId, userId))?.role).toBe("owner");

    const nodeTypes = new PostgresNodeTypeDefinitionRepository(database);
    const customType = { type: "meeting" as NodeType, label: "Meeting", source: "workspace" as const, workspaceId };
    expect(await nodeTypes.register(customType)).toEqual(customType);
    expect((await nodeTypes.getForWorkspace(workspaceId)).some(({ type }) => type === customType.type)).toBe(true);

    const repository = new PostgresNodeRepository(database);
    const node = createNode({
      id: nodeId,
      workspaceId,
      type: "task" as NodeType,
      title: "Prepare launch",
      actorId: userId,
      now,
    });
    await repository.create(node);
    await repository.create(createNode({
      id: relatedNodeId,
      workspaceId,
      type: "page" as NodeType,
      title: "Launch notes",
      actorId: userId,
      now,
    }));
    expect(await repository.getById(workspaceId, nodeId)).toEqual(node);
    expect(await repository.getById(differentWorkspaceId, nodeId)).toBeNull();
    expect((await repository.updateTitle(workspaceId, nodeId, "  Launch ready  ", userId, now))?.title).toBe("Launch ready");
    expect((await repository.archive(workspaceId, nodeId, userId, now))?.archivedAt).toBe(now);
    expect((await repository.restore(workspaceId, nodeId, userId, now))?.archivedAt).toBeUndefined();

    const documents = new PostgresNodeDocumentRepository(database);
    const content = validateNodeDocumentContent([{
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Launch details", styles: {} }],
      children: [],
    }]);
    expect(await documents.get(workspaceId, relatedNodeId)).toBeNull();
    const initialDocument = await documents.save({
      workspaceId,
      nodeId: relatedNodeId,
      content,
      expectedRevision: 0,
      actorId: userId,
      now,
    });
    expect(initialDocument?.revision).toBe(1);
    expect(initialDocument?.content).toEqual(content);
    expect(await documents.get(differentWorkspaceId, relatedNodeId)).toBeNull();
    expect(await documents.save({
      workspaceId,
      nodeId: relatedNodeId,
      content,
      expectedRevision: 0,
      actorId: userId,
      now,
    })).toBeNull();

    expect((await documents.save({
      workspaceId,
      nodeId: relatedNodeId,
      content,
      expectedRevision: 1,
      actorId: userId,
      now,
    }))?.revision).toBe(2);
    const contentMatches = await repository.searchByWorkspace(workspaceId, { query: "details", page: 1, pageSize: 10 });
    expect(contentMatches.items.map(({ node, matchedIn }) => [node.id, matchedIn])).toEqual([[relatedNodeId, "content"]]);
    const typeFilteredMatches = await repository.searchByWorkspace(workspaceId, { query: "launch", type: "page" as NodeType, page: 1, pageSize: 10 });
    expect(typeFilteredMatches.items.map(({ node }) => node.id)).toEqual([relatedNodeId]);
    const firstSearchPage = await repository.searchByWorkspace(workspaceId, { query: "launch", page: 1, pageSize: 1 });
    const secondSearchPage = await repository.searchByWorkspace(workspaceId, { query: "launch", page: 2, pageSize: 1 });
    expect(firstSearchPage.hasMore).toBe(true);
    expect(secondSearchPage.hasMore).toBe(false);
    expect(firstSearchPage.items[0]?.node.id).not.toBe(secondSearchPage.items[0]?.node.id);

    const definition: PropertyDefinition = {
      id: propertyDefinitionId,
      workspaceId,
      name: "Due date",
      type: "date",
      required: false,
    };
    const propertyDefinitions = new PostgresPropertyDefinitionRepository(database);
    await propertyDefinitions.create(definition);
    const properties = new PostgresNodePropertyRepository(database);
    const property = { nodeId, definitionId: propertyDefinitionId, value: { type: "date" as const, value: "2026-10-09" } };
    expect(await properties.set(workspaceId, property)).toEqual(property);
    const calendarItems = await new PostgresCalendarRepository(database).listRange(workspaceId, {
      dateFrom: "2026-10-01", dateToExclusive: "2026-11-01",
      instantFrom: "2026-10-01T00:00:00.000Z", instantTo: "2026-11-01T00:00:00.000Z",
    });
    expect(calendarItems.map(({ node, properties: values }) => [node.id, values["Due date"]])).toEqual([[nodeId, property.value]]);
    const filteredCalendarItems = await new PostgresCalendarRepository(database).listRange(workspaceId, {
      dateFrom: "2026-10-01", dateToExclusive: "2026-11-01",
      instantFrom: "2026-10-01T00:00:00.000Z", instantTo: "2026-11-01T00:00:00.000Z",
      collectionQuery: { version: 1, types: ["task" as NodeType], titleContains: "launch", sortBy: "title", sortDirection: "asc", groupBy: null },
    });
    expect(filteredCalendarItems.map(({ node }) => node.id)).toEqual([nodeId]);
    const excludedCalendarItems = await new PostgresCalendarRepository(database).listRange(workspaceId, {
      dateFrom: "2026-10-01", dateToExclusive: "2026-11-01",
      instantFrom: "2026-10-01T00:00:00.000Z", instantTo: "2026-11-01T00:00:00.000Z",
      collectionQuery: { version: 1, types: ["page" as NodeType], titleContains: "launch", sortBy: "title", sortDirection: "asc", groupBy: null },
    });
    expect(excludedCalendarItems).toEqual([]);
    expect(await properties.getForNode(workspaceId, nodeId)).toEqual([property]);
    expect(await properties.remove(workspaceId, nodeId, propertyDefinitionId)).toBe(true);
    expect(await properties.remove(workspaceId, nodeId, propertyDefinitionId)).toBe(false);

    const statusDefinition: PropertyDefinition = {
      id: crypto.randomUUID() as PropertyDefinitionId,
      workspaceId,
      name: "Status",
      type: "status",
      required: true,
      options: ["Todo", "Done"],
    };
    expect((await propertyDefinitions.create(statusDefinition)).options).toEqual(["Todo", "Done"]);
    expect(await properties.set(workspaceId, {
      nodeId,
      definitionId: statusDefinition.id,
      value: { type: "status", value: "Todo" },
    })).toEqual({
      nodeId,
      definitionId: statusDefinition.id,
      value: { type: "status", value: "Todo" },
    });
    expect(await properties.getForNodes(workspaceId, [relatedNodeId, nodeId], statusDefinition.id)).toEqual([{
      nodeId,
      definitionId: statusDefinition.id,
      value: { type: "status", value: "Todo" },
    }]);

    const relationDefinition: RelationDefinition = {
      id: relationDefinitionId,
      workspaceId,
      type: "references",
      fromLabel: "references",
      toLabel: "referenced by",
      allowSelfRelation: false,
    };
    const relationDefinitions = new PostgresRelationDefinitionRepository(database);
    await relationDefinitions.create(relationDefinition);
    const relation = createRelation({
      id: crypto.randomUUID(),
      workspaceId,
      fromNodeId: nodeId,
      toNodeId: relatedNodeId,
      actorId: userId,
      now,
    }, relationDefinition);
    const relations = new PostgresNodeRelationRepository(database);
    expect(await relations.create(relation)).toEqual(relation);
    expect(await relations.getBacklinks(workspaceId, relatedNodeId)).toEqual([relation]);
    const graph = new PostgresWorkspaceGraphRepository(database);
    const localGraph = await graph.query({ workspaceId, nodeId, depth: 1, limit: 10 });
    expect(localGraph.nodes.map(({ id, title }) => ({ id, title }))).toEqual([{ id: nodeId, title: "Launch ready" }, { id: relatedNodeId, title: "Launch notes" }]);
    expect(localGraph.edges).toEqual([{ id: relation.id, source: nodeId, target: relatedNodeId, type: relation.type }]);
    expect(localGraph.truncated).toBe(false);
    expect(await graph.query({ workspaceId, nodeId, depth: 1, limit: 1 })).toMatchObject({ nodes: [{ id: nodeId }], truncated: true });

    const savedCollections = new PostgresSavedCollectionRepository(database);
    const collection = createSavedCollection({
      id: crypto.randomUUID() as SavedCollectionId,
      workspaceId,
      name: "Launch tasks",
      query: { types: ["task"], titleContains: "launch", sortBy: "title", sortDirection: "asc" },
      view: { layout: "table", columns: ["title", "type", "updatedAt"] },
      actorId: userId,
      now,
    });
    expect(await savedCollections.create(collection)).toEqual(collection);
    expect(await savedCollections.listByWorkspace(workspaceId)).toEqual([collection]);
    const collectionNodes = await repository.queryCollection(workspaceId, collection.query, { page: 1, pageSize: 10 });
    expect(collectionNodes.items.map(({ id }) => id)).toEqual([nodeId]);
    const unfilteredQuery = { ...collection.query, types: [], titleContains: "" };
    const firstCollectionPage = await repository.queryCollection(workspaceId, unfilteredQuery, { page: 1, pageSize: 1 });
    const secondCollectionPage = await repository.queryCollection(workspaceId, unfilteredQuery, { page: 2, pageSize: 1 });
    expect(firstCollectionPage.hasMore).toBe(true);
    expect(secondCollectionPage.hasMore).toBe(false);
    expect(firstCollectionPage.items[0]?.id).not.toBe(secondCollectionPage.items[0]?.id);

    await repository.create(createNode({ id: canvasNodeId, workspaceId, type: "canvas" as NodeType, title: "Planning canvas", actorId: userId, now }));
    const secondRelation = createRelation({ id: crypto.randomUUID(), workspaceId, fromNodeId: relatedNodeId, toNodeId: canvasNodeId, actorId: userId, now }, relationDefinition);
    await relations.create(secondRelation);
    const twoHopGraph = await graph.query({ workspaceId, nodeId, depth: 2, limit: 10 });
    expect(twoHopGraph.nodes.map(({ id }) => id)).toEqual([nodeId, relatedNodeId, canvasNodeId]);
    expect(twoHopGraph.edges.map(({ id }) => id).sort()).toEqual([relation.id, secondRelation.id].sort());
    const canvases = new PostgresNodeCanvasRepository(database);
    const scene = { elements: [{ id: "task-card", type: "rectangle" }], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
    const binding = { elementId: "task-card", nodeId };
    const initialCanvas = await canvases.save({ workspaceId, nodeId: canvasNodeId, scene, bindings: [binding], expectedRevision: 0, actorId: userId, now });
    expect(initialCanvas).toMatchObject({ revision: 1, scene, bindings: [binding] });
    expect(await canvases.get(differentWorkspaceId, canvasNodeId)).toBeNull();
    expect(await canvases.save({ workspaceId, nodeId: canvasNodeId, scene, bindings: [], expectedRevision: 0, actorId: userId, now })).toBeNull();
    const nextScene = { ...scene, elements: [{ id: "task-card", type: "rectangle", x: 100 }] };
    expect((await canvases.save({ workspaceId, nodeId: canvasNodeId, scene: nextScene, bindings: [binding], expectedRevision: 1, actorId: userId, now }))?.revision).toBe(2);
    await expect(canvases.save({ workspaceId, nodeId: canvasNodeId, scene, bindings: [{ elementId: "task-card", nodeId: crypto.randomUUID() as NodeId }], expectedRevision: 2, actorId: userId, now })).rejects.toThrow();
    expect((await canvases.get(workspaceId, canvasNodeId))?.revision).toBe(2);
    expect((await canvases.get(workspaceId, canvasNodeId))?.bindings).toEqual([binding]);

    const sync = new PostgresSyncDocumentRepository(database);
    const initialYDoc = new Y.Doc();
    const remoteYDoc = new Y.Doc();
    const firstMutationId = crypto.randomUUID();
    const secondMutationId = crypto.randomUUID();
    const firstUpdatePromise = new Promise<Uint8Array>((resolve) => initialYDoc.once("update", resolve));
    initialYDoc.getMap("content").set("first", "from client one");
    const firstUpdate = await firstUpdatePromise;
    const secondUpdatePromise = new Promise<Uint8Array>((resolve) => remoteYDoc.once("update", resolve));
    remoteYDoc.getMap("content").set("second", "from client two");
    const secondUpdate = await secondUpdatePromise;
    expect(await sync.getState({ workspaceId, nodeId: relatedNodeId, documentKind: "page", stateVector: Y.encodeStateVector(initialYDoc) })).toMatchObject({ revision: 0 });
    expect(await sync.applyUpdate({ workspaceId, nodeId: relatedNodeId, documentKind: "page", actorId: userId, mutationId: firstMutationId, update: firstUpdate, now })).toMatchObject({ revision: 1, duplicate: false });
    expect(await sync.applyUpdate({ workspaceId, nodeId: relatedNodeId, documentKind: "page", actorId: userId, mutationId: firstMutationId, update: firstUpdate, now })).toMatchObject({ revision: 1, duplicate: true });
    await expect(sync.applyUpdate({ workspaceId, nodeId: relatedNodeId, documentKind: "page", actorId: userId, mutationId: firstMutationId, update: secondUpdate, now })).rejects.toThrow("different update content");
    expect(await sync.applyUpdate({ workspaceId, nodeId: relatedNodeId, documentKind: "page", actorId: userId, mutationId: secondMutationId, update: secondUpdate, now })).toMatchObject({ revision: 2, duplicate: false });
    const missed = await sync.getState({ workspaceId, nodeId: relatedNodeId, documentKind: "page", stateVector: Y.encodeStateVector(initialYDoc) });
    Y.applyUpdate(initialYDoc, missed.update);
    expect(Object.fromEntries(initialYDoc.getMap("content").entries())).toEqual({ first: "from client one", second: "from client two" });
    expect((await sync.getState({ workspaceId: differentWorkspaceId, nodeId: relatedNodeId, documentKind: "page", stateVector: Y.encodeStateVector(initialYDoc) })).revision).toBe(0);
    initialYDoc.destroy();
    remoteYDoc.destroy();

    expect(await savedCollections.remove(workspaceId, collection.id)).toBe(true);
    expect(await savedCollections.remove(workspaceId, collection.id)).toBe(false);
    expect((await workspaces.archive(workspaceId, now))?.archivedAt).toBe(now);
    expect((await users.deactivate(userId, now))?.deactivatedAt).toBe(now);
  } finally {
    if (workspaceCreated) {
      await database`DELETE FROM node_relations WHERE workspace_id = ${workspaceId}::uuid`;
      await database`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
    }
    await database`DELETE FROM app_users WHERE id = ${userId}::uuid`;
    await database.close({ timeout: 1 });
  }
});
