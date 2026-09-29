import { expect, test } from "@playwright/test";

const databaseConfigured = Boolean(process.env.DATABASE_URL_TEST);
const testEmail = "owner@node-workspace-e2e.invalid";
const testPassword = "E2E-only-password-never-use-elsewhere";

test.skip(!databaseConfigured, "Set DATABASE_URL_TEST to a disposable PostgreSQL database for workspace e2e coverage.");

test("setup, create a task node, update it, archive and restore it, then log out", async ({ page, baseURL }) => {
  const origin = baseURL!;
  const statusResponse = await page.request.get(`${origin}/api/setup/status`);
  expect(statusResponse.ok()).toBeTruthy();
  const status = await statusResponse.json() as { setupRequired: boolean };
  let csrfToken: string;

  if (status.setupRequired) {
    const response = await page.request.post(`${origin}/api/setup`, {
      headers: { origin },
      data: {
        email: testEmail,
        password: testPassword,
        displayName: "Workspace E2E Owner",
        workspaceName: "Workspace E2E",
      },
    });
    expect(response.status()).toBe(201);
    csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
  } else {
    const response = await page.request.post(`${origin}/api/auth/login`, {
      headers: { origin },
      data: { email: testEmail, password: testPassword },
    });
    expect(response.status()).toBe(200);
    csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
  }

  const workspacesResponse = await page.request.get(`${origin}/api/workspaces`);
  expect(workspacesResponse.status()).toBe(200);
  const workspaces = await workspacesResponse.json() as Array<{ id: string; name: string }>;
  const workspace = workspaces.find((candidate) => candidate.name === "Workspace E2E");
  expect(workspace).toBeDefined();

  const propertyDefinitionsResponse = await page.request.get(`${origin}/api/workspaces/${workspace!.id}/properties`);
  const propertyDefinitions = await propertyDefinitionsResponse.json() as Array<{ id: string; name: string }>;
  let propertyDefinition = propertyDefinitions.find((definition) => definition.name === "Status");
  if (!propertyDefinition) {
    const response = await page.request.post(`${origin}/api/workspaces/${workspace!.id}/properties`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { name: "Status", type: "status", options: ["Todo", "Done"] },
    });
    expect(response.status()).toBe(201);
    propertyDefinition = await response.json() as { id: string; name: string };
  }
  const relationDefinitionsResponse = await page.request.get(`${origin}/api/workspaces/${workspace!.id}/relations`);
  const relationDefinitions = await relationDefinitionsResponse.json() as Array<{ id: string; type: string }>;
  if (!relationDefinitions.some((definition) => definition.type === "references")) {
    const response = await page.request.post(`${origin}/api/workspaces/${workspace!.id}/relations`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { type: "references", fromLabel: "references", toLabel: "referenced by" },
    });
    expect(response.status()).toBe(201);
  }

  const csrfMissingMutation = await page.request.post(`${origin}/api/nodes`, {
    headers: { origin },
    data: { workspaceId: workspace!.id, type: "task", title: "No CSRF token" },
  });
  expect(csrfMissingMutation.status()).toBe(403);

  const listResponse = await page.request.get(`${origin}/api/nodes?workspaceId=${workspace!.id}&type=task&limit=100`);
  const nodePage = await listResponse.json() as { items: Array<{ id: string; title: string }> };
  let node = nodePage.items.find((candidate) => candidate.title === "Prepare launch" || candidate.title === "Launch ready");
  if (!node) {
    const createResponse = await page.request.post(`${origin}/api/nodes`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { workspaceId: workspace!.id, type: "task", title: "Prepare launch" },
    });
    expect(createResponse.status()).toBe(201);
    node = await createResponse.json() as { id: string; title: string };
  }
  if (node.title !== "Prepare launch") {
    const normalizeResponse = await page.request.patch(`${origin}/api/nodes/${node.id}?workspaceId=${workspace!.id}`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { title: "Prepare launch" },
    });
    expect(normalizeResponse.status()).toBe(200);
    node = { ...node, title: "Prepare launch" };
  }
  expect(node.title).toBe("Prepare launch");

  expect(nodePage.items.some((item) => item.id === node.id) || node.title === "Prepare launch").toBe(true);
  const outsideWorkspaceResponse = await page.request.get(
    `${origin}/api/nodes/${node.id}?workspaceId=${crypto.randomUUID()}`,
  );
  expect(outsideWorkspaceResponse.status()).toBe(404);

  const setPropertyResponse = await page.request.put(
    `${origin}/api/nodes/${node.id}/properties/${propertyDefinition.id}?workspaceId=${workspace!.id}`,
    {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { value: { type: "status", value: "Done" } },
    },
  );
  expect(setPropertyResponse.status()).toBe(200);
  const nodePropertiesResponse = await page.request.get(
    `${origin}/api/nodes/${node.id}/properties?workspaceId=${workspace!.id}`,
  );
  expect(await nodePropertiesResponse.json()).toContainEqual({
    nodeId: node.id,
    definitionId: propertyDefinition.id,
    value: { type: "status", value: "Done" },
  });

  const pageListResponse = await page.request.get(`${origin}/api/nodes?workspaceId=${workspace!.id}&type=page&limit=100`);
  const pageList = await pageListResponse.json() as { items: Array<{ id: string; title: string }> };
  let relatedNode = pageList.items.find((candidate) => candidate.title === "Launch notes");
  if (!relatedNode) {
    const response = await page.request.post(`${origin}/api/nodes`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { workspaceId: workspace!.id, type: "page", title: "Launch notes" },
    });
    expect(response.status()).toBe(201);
    relatedNode = await response.json() as { id: string; title: string };
  }
  const initialDocumentResponse = await page.request.get(
    `${origin}/api/nodes/${relatedNode.id}/document?workspaceId=${workspace!.id}`,
  );
  expect(initialDocumentResponse.status()).toBe(200);
  const initialDocument = await initialDocumentResponse.json() as { revision: number };
  const documentContent = [{
    id: "launch-paragraph",
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: "Launch details", styles: {} }],
    children: [],
  }];
  const saveDocumentResponse = await page.request.put(
    `${origin}/api/nodes/${relatedNode.id}/document?workspaceId=${workspace!.id}`,
    {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { expectedRevision: initialDocument.revision, content: documentContent },
    },
  );
  expect(saveDocumentResponse.status()).toBe(200);
  expect((await saveDocumentResponse.json() as { revision: number }).revision).toBe(initialDocument.revision + 1);
  const staleDocumentResponse = await page.request.put(
    `${origin}/api/nodes/${relatedNode.id}/document?workspaceId=${workspace!.id}`,
    {
      headers: { origin, "x-csrf-token": csrfToken },
      data: { expectedRevision: initialDocument.revision, content: documentContent },
    },
  );
  expect(staleDocumentResponse.status()).toBe(409);

  const outgoingResponse = await page.request.get(`${origin}/api/nodes/${node.id}/relations?workspaceId=${workspace!.id}`);
  const outgoing = await outgoingResponse.json() as Array<{ toNodeId: string; type: string }>;
  if (!outgoing.some((relation) => relation.toNodeId === relatedNode.id && relation.type === "references")) {
    const linkResponse = await page.request.post(
      `${origin}/api/nodes/${node.id}/relations?workspaceId=${workspace!.id}`,
      {
        headers: { origin, "x-csrf-token": csrfToken },
        data: { type: "references", toNodeId: relatedNode.id },
      },
    );
    expect(linkResponse.status()).toBe(201);
  }
  const backlinksResponse = await page.request.get(
    `${origin}/api/nodes/${relatedNode.id}/backlinks?workspaceId=${workspace!.id}`,
  );
  expect(await backlinksResponse.json()).toContainEqual(expect.objectContaining({
    fromNodeId: node.id,
    toNodeId: relatedNode.id,
    type: "references",
  }));

  const updateResponse = await page.request.patch(`${origin}/api/nodes/${node.id}?workspaceId=${workspace!.id}`, {
    headers: { origin, "x-csrf-token": csrfToken },
    data: { title: "Launch ready" },
  });
  expect((await updateResponse.json() as { title: string }).title).toBe("Launch ready");

  const archiveResponse = await page.request.delete(`${origin}/api/nodes/${node.id}?workspaceId=${workspace!.id}`, {
    headers: { origin, "x-csrf-token": csrfToken },
  });
  expect((await archiveResponse.json() as { archivedAt?: string }).archivedAt).toBeTruthy();

  const restoreResponse = await page.request.post(`${origin}/api/nodes/${node.id}/restore?workspaceId=${workspace!.id}`, {
    headers: { origin, "x-csrf-token": csrfToken },
  });
  expect((await restoreResponse.json() as { archivedAt?: string }).archivedAt).toBeUndefined();

  const resetResponse = await page.request.patch(`${origin}/api/nodes/${node.id}?workspaceId=${workspace!.id}`, {
    headers: { origin, "x-csrf-token": csrfToken },
    data: { title: "Prepare launch" },
  });
  expect(resetResponse.status()).toBe(200);

  const logoutResponse = await page.request.post(`${origin}/api/auth/logout`, {
    headers: { origin, "x-csrf-token": csrfToken },
  });
  expect(logoutResponse.status()).toBe(204);
  expect((await page.request.get(`${origin}/api/workspaces`)).status()).toBe(401);
});
