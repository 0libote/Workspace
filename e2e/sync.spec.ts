import { expect, test } from "@playwright/test";
import type { NodeId, WorkspaceId } from "../packages/domain/src/index";
import type { SyncUpdateMessage } from "../packages/sync/src/index";

test("IndexedDB sync queue survives a tab instance and removes only acknowledged updates", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const sourceModule = "/@fs/home/oliver/Workspace/packages/sync/src/index.ts";
    const { IndexedDbSyncDocumentStorage, IndexedDbSyncMutationStorage, OfflineSyncQueue, createSyncDocument, encodeSyncDocumentState } = await import(/* @vite-ignore */ sourceModule);
    const databaseName = `sync-queue-e2e-${crypto.randomUUID()}`;
    const first = new OfflineSyncQueue(new IndexedDbSyncMutationStorage(databaseName));
    const second = new OfflineSyncQueue(new IndexedDbSyncMutationStorage(databaseName));
    const message: SyncUpdateMessage = {
      protocol: 1 as const,
      kind: "update" as const,
      workspaceId: "78e92f6c-9066-4e38-9af8-7e677d448066" as WorkspaceId,
      nodeId: "dba7b2fa-f4ae-4190-8888-95ccb932a852" as NodeId,
      documentKind: "page",
      mutationId: crypto.randomUUID(),
      update: "AQID",
    };
    await first.enqueue(message, 123);
    const before = await second.pending(message.workspaceId, message.nodeId);
    const flushed = await second.flush(message.workspaceId, message.nodeId, async (retried: SyncUpdateMessage) => retried.mutationId === message.mutationId);
    const cacheOne = new IndexedDbSyncDocumentStorage(databaseName);
    const cacheTwo = new IndexedDbSyncDocumentStorage(databaseName);
    const document = createSyncDocument();
    document.getMap("cache").set("saved", "recoverable");
    const state = encodeSyncDocumentState(document);
    await cacheOne.save(message.workspaceId, message.nodeId, "page", state);
    const restoredState = await cacheTwo.load(message.workspaceId, message.nodeId, "page");
    await cacheTwo.clear(message.workspaceId, message.nodeId, "page");
    const cleared = await cacheOne.load(message.workspaceId, message.nodeId, "page");
    document.destroy();
    return { queuedId: before[0]?.message.mutationId, flushed, remaining: await first.pending(message.workspaceId, message.nodeId), cacheRestored: restoredState !== null && Array.from(restoredState).join(",") === Array.from(state).join(","), cacheCleared: cleared === null };
  });
  expect(result.queuedId).toBeTruthy();
  expect(result.flushed).toEqual({ acknowledged: 1, remaining: 0 });
  expect(result.remaining).toEqual([]);
  expect(result.cacheRestored).toBe(true);
  expect(result.cacheCleared).toBe(true);
});

test.skip(!process.env.DATABASE_URL_TEST, "Set DATABASE_URL_TEST to a disposable PostgreSQL database for authenticated sync coverage.");

test("authenticated browser websocket persists and serves Yjs updates", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Create owner account" }).isVisible().catch(() => false)) {
    await page.getByLabel("Your name").fill("Sync E2E Owner");
    await page.getByLabel("Workspace name").fill("Sync E2E Workspace");
    await page.getByLabel("Email address").fill("owner@node-workspace-e2e.invalid");
    await page.getByLabel("Password").fill("E2E-only-password-never-use-elsewhere");
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else {
    await page.getByLabel("Email address").fill("owner@node-workspace-e2e.invalid");
    await page.getByLabel("Password").fill("E2E-only-password-never-use-elsewhere");
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  const scope = await page.evaluate(async () => {
    const workspaceId = (await fetch("/api/workspaces").then((response) => response.json()) as Array<{ id: string }>)[0]?.id;
    const session = await fetch("/api/auth/me").then((response) => response.json()) as { csrfToken: string };
    if (!workspaceId) throw new Error("No workspace available for sync test");
    const created = await fetch("/api/nodes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ workspaceId, type: "page", title: `Sync E2E ${crypto.randomUUID()}` }),
    });
    if (!created.ok) throw new Error("Could not create a page for sync test");
    return { workspaceId, nodeId: (await created.json() as { id: string }).id };
  });
  const result = await page.evaluate(async ({ workspaceId, nodeId }) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sync/${workspaceId}/${nodeId}/page`;
    const loadModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
    const syncModule = await loadModule("/@fs/home/oliver/Workspace/packages/sync/src/index.ts") as {
      IndexedDbSyncDocumentStorage: new (name: string) => { load(workspace: string, node: string, kind: "page" | "canvas"): Promise<Uint8Array | null> };
      IndexedDbSyncMutationStorage: new (name: string) => unknown;
      OfflineSyncQueue: new (storage: unknown) => { pending(workspace: string, node: string): Promise<readonly unknown[]> };
      SyncConnection: { open(options: Record<string, unknown>): Promise<{ close(): void }> };
      createSyncDocument(): { getMap(name: string): { set(key: string, value: string): void; get(key: string): unknown }; destroy(): void };
      applySyncDocumentUpdate(document: unknown, update: Uint8Array): void;
    };
    const document = syncModule.createSyncDocument();
    document.getMap("content").set("transport", "real");
    const databaseName = `sync-transport-${crypto.randomUUID()}`;
    const queue = new syncModule.OfflineSyncQueue(new syncModule.IndexedDbSyncMutationStorage(databaseName));
    const documentCache = new syncModule.IndexedDbSyncDocumentStorage(databaseName);
    const connectionRef: Array<{ close(): void }> = [];
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sync provider did not connect")), 8_000);
      void syncModule.SyncConnection.open({
        url, workspaceId, nodeId, documentKind: "page", document, queue, documentCache,
        onStatus: (status: string) => { if (status === "connected") { clearTimeout(timer); resolve(); } },
      }).then((syncConnection) => {
        connectionRef.push(syncConnection);
        window.addEventListener("pagehide", () => connectionRef[0]?.close(), { once: true });
      }, reject);
    });
    await connected;
    for (let attempt = 0; attempt < 40 && (await queue.pending(workspaceId, nodeId)).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const queuedAfterAck = (await queue.pending(workspaceId, nodeId)).length;
    const receive = (socket: WebSocket, expected: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 8_000);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.kind === expected) { clearTimeout(timer); resolve(message); }
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket failed")); };
    });
    const second = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { second.onopen = () => resolve(); second.onerror = () => reject(new Error("Recovery WebSocket failed")); });
    second.send(JSON.stringify({ protocol: 1, kind: "join", workspaceId, nodeId, documentKind: "page", stateVector: "AA" }));
    const recovered = await receive(second, "sync");
    const recoveredDoc = syncModule.createSyncDocument();
    const encodedUpdate = String(recovered.update);
    syncModule.applySyncDocumentUpdate(recoveredDoc, Uint8Array.from(atob(encodedUpdate.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encodedUpdate.length % 4) % 4)), (character) => character.charCodeAt(0)));
    const recoveredValue = recoveredDoc.getMap("content").get("transport");
    const cachedState = await documentCache.load(workspaceId, nodeId, "page");
    const cachedDoc = syncModule.createSyncDocument();
    if (cachedState) syncModule.applySyncDocumentUpdate(cachedDoc, cachedState);
    const cachedValue = cachedDoc.getMap("content").get("transport");
    second.close(); connectionRef[0]?.close();
    document.destroy(); recoveredDoc.destroy(); cachedDoc.destroy();
    return { queuedAfterAck, recoveredRevision: recovered.serverRevision, recoveredValue, cachedValue };
  }, scope);
  expect(result.queuedAfterAck).toBe(0);
  expect(result.recoveredRevision).toBe(1);
  expect(result.recoveredValue).toBe("real");
  expect(result.cachedValue).toBe("real");
});
