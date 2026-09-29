import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  createMembership,
  createRelation,
  createNode,
  createUser,
  createWorkspace,
  type NodeId,
  type NodeType,
  type RelationDefinitionId,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  applyMigrations,
  PostgresNodeRepository,
  PostgresNodeRelationRepository,
  PostgresRelationDefinitionRepository,
  PostgresUserRepository,
  PostgresWorkspaceMembershipRepository,
  PostgresWorkspaceRepository,
} from "@workspace/db";
import { createSecretToken, persistSession } from "./auth";
import { createAppHandler } from "./api";

const databaseUrl = Bun.env.DATABASE_URL_TEST;

test.skipIf(!databaseUrl)("workspace viewers can read nodes but cannot create them", async () => {
  const database = new SQL(databaseUrl!);
  const userId = crypto.randomUUID() as UserId;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const nodeId = crypto.randomUUID() as NodeId;
  const now = new Date();
  const nowIso = now.toISOString();
  let workspaceCreated = false;
  let createdWorkspaceId: string | undefined;

  try {
    await applyMigrations(database);
    const user = createUser({ id: userId, email: `${userId}@viewer.integration.test`, displayName: "Read-only viewer", now: nowIso });
    const workspace = createWorkspace({ id: workspaceId, name: "Viewer permissions", now: nowIso });
    const membership = createMembership(workspaceId, userId, "viewer", nowIso);
    await new PostgresUserRepository(database).create(user);
    await new PostgresWorkspaceRepository(database).create(workspace);
    workspaceCreated = true;
    await new PostgresWorkspaceMembershipRepository(database).create(membership);
    await new PostgresNodeRepository(database).create(createNode({
      id: nodeId,
      workspaceId,
      type: "task" as NodeType,
      title: "Visible task",
      actorId: userId,
      now: nowIso,
    }));

    const token = createSecretToken();
    const csrfToken = createSecretToken();
    await persistSession(database, userId, token, csrfToken, now);
    const handler = createAppHandler(database);
    const origin = "http://127.0.0.1:3190";
    const cookie = `workspace_session=${token}`;
    const listResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/nodes?workspaceId=${workspaceId}&limit=50`,
      { headers: { cookie } },
    ));
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json() as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual([nodeId]);
    const exportResponse = await handler(new Request(`http://127.0.0.1:3190/api/workspaces/${workspaceId}/export`, { headers: { cookie } }));
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-disposition")).toContain("astryx-workspace-export.json");
    expect(exportResponse.headers.get("cache-control")).toBe("no-store");
    const workspaceExport = await exportResponse.json() as {
      format: string;
      version: number;
      workspace: { id: string };
      actors: Array<Record<string, unknown>>;
      nodes: Array<{ node: { id: string; title: string }; properties: unknown[] }>;
    };
    expect(workspaceExport).toMatchObject({ format: "astryx-workspace-export", version: 1, workspace: { id: workspaceId } });
    expect(workspaceExport.nodes).toEqual([{ node: expect.objectContaining({ id: nodeId, title: "Visible task" }), properties: [] }]);
    expect(workspaceExport.actors[0]).not.toHaveProperty("email");
    const graphResponse = await handler(new Request(`http://127.0.0.1:3190/api/graph?workspaceId=${workspaceId}&nodeId=${nodeId}`, { headers: { cookie } }));
    expect(graphResponse.status).toBe(200);
    expect(await graphResponse.json()).toMatchObject({ nodes: [{ id: nodeId, title: "Visible task" }], edges: [], truncated: false });

    const searchResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/search?workspaceId=${workspaceId}&query=visible&type=task`,
      { headers: { cookie } },
    ));
    expect(searchResponse.status).toBe(200);
    expect((await searchResponse.json() as { items: Array<{ node: { id: string }; matchedIn: string }> }).items)
      .toEqual([{ node: expect.objectContaining({ id: nodeId }), matchedIn: "title" }]);
    const invalidSearchResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/search?workspaceId=${workspaceId}&query=x`,
      { headers: { cookie } },
    ));
    expect(invalidSearchResponse.status).toBe(400);

    const workspaceResponse = await handler(new Request("http://127.0.0.1:3190/api/workspaces", {
      method: "POST",
      headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "Newly created workspace" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const createdWorkspace = await workspaceResponse.json() as { id: string; timeZone: string };
    createdWorkspaceId = createdWorkspace.id;
    expect(createdWorkspace.timeZone).toBe("UTC");
    const definitionsResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${createdWorkspaceId}/properties`,
      { headers: { cookie } },
    ));
    expect(definitionsResponse.status).toBe(200);
    const definitions = await definitionsResponse.json() as Array<{ name: string; type: string; options?: readonly string[] }>;
    expect(definitions.map(({ name }) => name)).toEqual(["Due date", "Due time", "Duration", "Priority", "Start date", "Start time", "Status"]);
    expect(definitions.find(({ name }) => name === "Status")?.options).toEqual(["Todo", "In progress", "Done"]);

    const viewerCollectionsResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/collections`,
      { headers: { cookie } },
    ));
    expect(viewerCollectionsResponse.status).toBe(200);
    expect(await viewerCollectionsResponse.json()).toEqual([]);
    const viewerCollectionCreate = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/collections`,
      {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ name: "Denied collection", query: {}, view: {} }),
      },
    ));
    expect(viewerCollectionCreate.status).toBe(404);
    const viewerTimeZoneUpdate = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/settings`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ timeZone: "America/New_York" }),
      },
    ));
    expect(viewerTimeZoneUpdate.status).toBe(404);
    const viewerCalendarMove = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar/${nodeId}/move?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-09" }),
      },
    ));
    expect(viewerCalendarMove.status).toBe(404);
    await database`UPDATE workspace_memberships SET role = 'editor' WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid`;
    const updateTimeZoneResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/settings`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ timeZone: "America/New_York" }),
      },
    ));
    expect(updateTimeZoneResponse.status).toBe(200);
    expect((await updateTimeZoneResponse.json() as { timeZone: string }).timeZone).toBe("America/New_York");
    const calendarDefinitionResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/properties`,
      {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ name: "Start date", type: "date" }),
      },
    ));
    expect(calendarDefinitionResponse.status).toBe(201);
    const calendarDefinition = await calendarDefinitionResponse.json() as { id: string };
    const calendarPropertyResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/nodes/${nodeId}/properties/${calendarDefinition.id}?workspaceId=${workspaceId}`,
      {
        method: "PUT",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ value: { type: "date", value: "2026-10-09" } }),
      },
    ));
    expect(calendarPropertyResponse.status).toBe(200);
    const calendarResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar?workspaceId=${workspaceId}&from=2026-10-01&to=2026-10-31`,
      { headers: { cookie } },
    ));
    expect(calendarResponse.status).toBe(200);
    expect((await calendarResponse.json() as { events: Array<{ node: { id: string }; schedule: unknown }> }).events)
      .toEqual([{ node: expect.objectContaining({ id: nodeId }), schedule: { kind: "allDay", startDate: "2026-10-09", endDateExclusive: "2026-10-10" } }]);
    const calendarIcsResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar.ics?workspaceId=${workspaceId}&from=2026-10-01&to=2026-10-31`,
      { headers: { cookie } },
    ));
    expect(calendarIcsResponse.status).toBe(200);
    expect(calendarIcsResponse.headers.get("content-type")).toContain("text/calendar");
    expect(calendarIcsResponse.headers.get("content-disposition")).toContain(".ics");
    expect(await calendarIcsResponse.text()).toContain(`DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261010`);
    const calendarTimeDefinitionResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/properties`,
      {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ name: "Start time", type: "dateTime" }),
      },
    ));
    expect(calendarTimeDefinitionResponse.status).toBe(201);
    const calendarTimeDefinition = await calendarTimeDefinitionResponse.json() as { id: string };
    const calendarTimePropertyResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/nodes/${nodeId}/properties/${calendarTimeDefinition.id}?workspaceId=${workspaceId}`,
      {
        method: "PUT",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ value: { type: "dateTime", value: "2026-10-09T10:30:00-04:00" } }),
      },
    ));
    expect(calendarTimePropertyResponse.status).toBe(200);
    expect((await calendarTimePropertyResponse.json() as { value: { value: string } }).value.value).toBe("2026-10-09T14:30:00.000Z");
    const timedCalendarResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar?workspaceId=${workspaceId}&from=2026-10-01&to=2026-10-31`,
      { headers: { cookie } },
    ));
    expect((await timedCalendarResponse.json() as { events: Array<{ schedule: unknown }> }).events[0]?.schedule)
      .toEqual({ kind: "timed", startInstant: "2026-10-09T14:30:00.000Z" });
    const timedCalendarIcsResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar.ics?workspaceId=${workspaceId}&from=2026-10-01&to=2026-10-31`,
      { headers: { cookie } },
    ));
    expect(await timedCalendarIcsResponse.text()).toContain("DTSTART:20261009T143000Z");
    const invalidCalendarMove = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar/${nodeId}/move?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-02-30" }),
      },
    ));
    expect(invalidCalendarMove.status).toBe(400);
    const moveCalendarEventResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar/${nodeId}/move?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-10" }),
      },
    ));
    expect(moveCalendarEventResponse.status).toBe(200);
    expect((await moveCalendarEventResponse.json() as { schedule: unknown }).schedule)
      .toEqual({ kind: "timed", startInstant: "2026-10-10T14:30:00.000Z" });
    const createCollectionResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/workspaces/${workspaceId}/collections`,
      {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Visible tasks",
          query: { types: ["task"], titleContains: "Visible", sortBy: "title", sortDirection: "asc" },
          view: { layout: "calendar", columns: ["title", "type", "updatedAt"] },
        }),
      },
    ));
    expect(createCollectionResponse.status).toBe(201);
    const createdCollection = await createCollectionResponse.json() as { id: string; name: string };
    expect(createdCollection.name).toBe("Visible tasks");
    const collectionItemsResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/collections/${createdCollection.id}/items?workspaceId=${workspaceId}`,
      { headers: { cookie } },
    ));
    expect(collectionItemsResponse.status).toBe(200);
    expect((await collectionItemsResponse.json() as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual([nodeId]);
    const collectionCalendarResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/calendar?workspaceId=${workspaceId}&collectionId=${createdCollection.id}&from=2026-10-01&to=2026-10-31`,
      { headers: { cookie } },
    ));
    expect(collectionCalendarResponse.status).toBe(200);
    expect((await collectionCalendarResponse.json() as { events: Array<{ node: { id: string } }> }).events.map(({ node }) => node.id)).toEqual([nodeId]);
    const updateCollectionResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/collections/${createdCollection.id}?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Visible task list",
          query: { types: ["task"], titleContains: "Visible", sortBy: "updatedAt", sortDirection: "desc" },
          view: { layout: "list", columns: ["title", "updatedAt"] },
        }),
      },
    ));
    expect(updateCollectionResponse.status).toBe(200);
    expect((await updateCollectionResponse.json() as { name: string; view: { layout: string } })).toMatchObject({ name: "Visible task list", view: { layout: "list" } });
    const deleteCollectionResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/collections/${createdCollection.id}?workspaceId=${workspaceId}`,
      { method: "DELETE", headers: { cookie, origin, "x-csrf-token": csrfToken } },
    ));
    expect(deleteCollectionResponse.status).toBe(204);
    await database`UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid`;

    const updateResponse = await handler(new Request(
      `http://127.0.0.1:3190/api/nodes/${nodeId}?workspaceId=${workspaceId}`,
      {
        method: "PATCH",
        headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ title: "Viewer must not rename" }),
      },
    ));
    expect(updateResponse.status).toBe(404);

    const createResponse = await handler(new Request("http://127.0.0.1:3190/api/nodes", {
      method: "POST",
      headers: { cookie, origin, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, type: "task", title: "Should be denied" }),
    }));
    expect(createResponse.status).toBe(404);
    expect(await createResponse.json()).toEqual({ error: "workspace_not_found" });
    const persisted = await new PostgresNodeRepository(database).listByWorkspace(workspaceId, { limit: 50 });
    expect(persisted.items).toHaveLength(1);
    expect(persisted.items[0]?.title).toBe("Visible task");
  } finally {
    if (createdWorkspaceId) await database`DELETE FROM workspaces WHERE id = ${createdWorkspaceId}::uuid`;
    if (workspaceCreated) await database`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
    await database`DELETE FROM app_users WHERE id = ${userId}::uuid`;
    await database.close({ timeout: 1 });
  }
});

test.skipIf(!databaseUrl)("canvas API validates bindings, saves portable scenes with revisions, and enforces workspace roles", async () => {
  const database = new SQL(databaseUrl!);
  const userId = crypto.randomUUID() as UserId;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const canvasNodeId = crypto.randomUUID() as NodeId;
  const taskNodeId = crypto.randomUUID() as NodeId;
  const pageNodeId = crypto.randomUUID() as NodeId;
  const now = new Date();
  const nowIso = now.toISOString();
  try {
    await applyMigrations(database);
    const user = createUser({ id: userId, email: `${userId}@canvas.integration.test`, displayName: "Canvas owner", now: nowIso });
    const workspace = createWorkspace({ id: workspaceId, name: "Canvas workspace", now: nowIso });
    await new PostgresUserRepository(database).create(user);
    await new PostgresWorkspaceRepository(database).create(workspace);
    await new PostgresWorkspaceMembershipRepository(database).create(createMembership(workspaceId, userId, "owner", nowIso));
    const nodes = new PostgresNodeRepository(database);
    await nodes.create(createNode({ id: taskNodeId, workspaceId, type: "task" as NodeType, title: "Canonical task", actorId: userId, now: nowIso }));
    await nodes.create(createNode({ id: canvasNodeId, workspaceId, type: "canvas" as NodeType, title: "Launch board", actorId: userId, now: nowIso }));
    await nodes.create(createNode({ id: pageNodeId, workspaceId, type: "page" as NodeType, title: "Project notes", actorId: userId, now: nowIso }));
    const relationDefinition = { id: crypto.randomUUID() as RelationDefinitionId, workspaceId, type: "references", fromLabel: "references", toLabel: "referenced by", allowSelfRelation: false };
    await new PostgresRelationDefinitionRepository(database).create(relationDefinition);
    await new PostgresNodeRelationRepository(database).create(createRelation({ id: crypto.randomUUID(), workspaceId, fromNodeId: taskNodeId, toNodeId: canvasNodeId, actorId: userId, now: nowIso }, relationDefinition));

    const token = createSecretToken();
    const csrfToken = createSecretToken();
    await persistSession(database, userId, token, csrfToken, now);
    const handler = createAppHandler(database);
    const graphResponse = await handler(new Request(`http://127.0.0.1:3190/api/graph?workspaceId=${workspaceId}&nodeId=${canvasNodeId}&depth=1`, { headers: { cookie: `workspace_session=${token}` } }));
    expect(graphResponse.status).toBe(200);
    const graph = await graphResponse.json() as { nodes: Array<{ id: string; title: string }>; edges: Array<{ source: string; target: string; type: string }>; truncated: boolean };
    expect(graph.nodes.map(({ id, title }) => ({ id, title }))).toEqual([{ id: canvasNodeId, title: "Launch board" }, { id: taskNodeId, title: "Canonical task" }]);
    expect(graph.edges.map(({ source, target, type }) => ({ source, target, type }))).toEqual([{ source: taskNodeId, target: canvasNodeId, type: "references" }]);
    expect(graph.truncated).toBe(false);
    const url = `http://127.0.0.1:3190/api/nodes/${canvasNodeId}/canvas?workspaceId=${workspaceId}`;
    const cookie = `workspace_session=${token}`;
    const emptyResponse = await handler(new Request(url, { headers: { cookie } }));
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({ revision: 0, bindings: [], scene: { elements: [], appState: {}, files: {} } });

    const scene = { elements: [{ id: "task-card", type: "rectangle", customData: { workspaceNodeId: taskNodeId } }], appState: { viewBackgroundColor: "#fff" }, files: {} };
    const body = { expectedRevision: 0, scene, bindings: [{ elementId: "task-card", nodeId: taskNodeId }] };
    const missingCsrf = await handler(new Request(url, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(missingCsrf.status).toBe(403);
    const saveResponse = await handler(new Request(url, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({ revision: 1, scene, bindings: body.bindings });
    const pageUrl = `http://127.0.0.1:3190/api/nodes/${pageNodeId}/document?workspaceId=${workspaceId}`;
    const content = [{ id: "paragraph-1", type: "paragraph", content: [{ type: "text", text: "Portable note", styles: {} }], children: [] }];
    const documentSave = await handler(new Request(pageUrl, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, content }),
    }));
    expect(documentSave.status).toBe(200);
    const exportResponse = await handler(new Request(`http://127.0.0.1:3190/api/workspaces/${workspaceId}/export`, { headers: { cookie } }));
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.json() as {
      nodes: Array<{ node: { id: string }; document?: { content: unknown[] }; canvas?: { scene: unknown; bindings: unknown[] } }>;
      relations: Array<{ fromNodeId: string; toNodeId: string; type: string }>;
    };
    expect(exported.nodes.find(({ node }) => node.id === canvasNodeId)?.canvas).toMatchObject({ scene, bindings: body.bindings });
    expect(exported.nodes.find(({ node }) => node.id === pageNodeId)?.document?.content).toEqual(content);
    expect(exported.relations).toContainEqual(expect.objectContaining({ fromNodeId: taskNodeId, toNodeId: canvasNodeId, type: "references" }));
    const staleSave = await handler(new Request(url, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(staleSave.status).toBe(409);
    const largeScene = { elements: [{ id: "large-text", type: "text", text: "x".repeat(1_100_000) }], appState: {}, files: {} };
    const largeSave = await handler(new Request(url, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, scene: largeScene, bindings: [] }),
    }));
    expect(largeSave.status).toBe(200);
    expect((await largeSave.json() as { revision: number }).revision).toBe(2);
    const invalidBinding = await handler(new Request(url, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2, scene, bindings: [{ elementId: "missing", nodeId: taskNodeId }] }),
    }));
    expect(invalidBinding.status).toBe(400);

    await database`UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid`;
    expect((await handler(new Request(url, { headers: { cookie } }))).status).toBe(200);
    const viewerWrite = await handler(new Request(url, {
      method: "PUT",
      headers: { cookie, origin: "http://127.0.0.1:3190", "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ ...body, expectedRevision: 2 }),
    }));
    expect(viewerWrite.status).toBe(404);
  } finally {
    await database`DELETE FROM node_relations WHERE workspace_id = ${workspaceId}::uuid`;
    await database`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
    await database`DELETE FROM app_users WHERE id = ${userId}::uuid`;
    await database.close({ timeout: 1 });
  }
});
