import { expect, test } from "bun:test";
import { decodeSyncBytes, encodeSyncBytes, OfflineSyncQueue, parseSyncClientMessage, parseSyncServerMessage, SyncConnection, validateSyncClientMessage, type QueuedSyncMutation, type SyncDocumentCache, type SyncMutationStorage, type SyncWebSocketLike } from "./index";
import type { NodeId, WorkspaceId } from "@workspace/domain";
import * as Y from "yjs";

const workspaceId = "78e92f6c-9066-4e38-9af8-7e677d448066" as WorkspaceId;
const nodeId = "dba7b2fa-f4ae-4190-8888-95ccb932a852" as NodeId;

test("versioned sync messages carry workspace and node scope", () => {
  expect(parseSyncClientMessage(JSON.stringify({
    protocol: 1, kind: "join", workspaceId, nodeId, documentKind: "page", stateVector: "",
  }))).toMatchObject({ protocol: 1, kind: "join", workspaceId, nodeId, documentKind: "page" });
  expect(validateSyncClientMessage({
    protocol: 1, kind: "update", workspaceId, nodeId,
    documentKind: "page", mutationId: "7d09513a-4b99-4a97-9e49-95cff2ef8b10", update: "AQID",
  })).toMatchObject({ kind: "update", update: "AQID" });
});

test("rejects unsupported versions, malformed identity, and malformed CRDT updates", () => {
  expect(() => validateSyncClientMessage({ protocol: 2, kind: "join", workspaceId, nodeId, documentKind: "page", stateVector: "" })).toThrow("protocol version");
  expect(() => validateSyncClientMessage({ protocol: 1, kind: "join", workspaceId: "bad", nodeId, documentKind: "page", stateVector: "" })).toThrow("node scope");
  expect(() => validateSyncClientMessage({ protocol: 1, kind: "update", workspaceId, nodeId, documentKind: "page", mutationId: crypto.randomUUID(), update: "not valid!" })).toThrow("malformed");
  expect(() => parseSyncClientMessage("{" )).toThrow("valid JSON");
  expect(() => parseSyncClientMessage(JSON.stringify({ protocol: 1, kind: "update", workspaceId, nodeId, documentKind: "page", mutationId: crypto.randomUUID(), update: "A".repeat(2_000_001) }))).toThrow("2 MB");
});

test("encodes binary updates as base64url and validates server acknowledgements", () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
  const encoded = encodeSyncBytes(bytes);
  expect(encoded.includes("+")).toBe(false);
  expect(encoded.includes("/")).toBe(false);
  expect(decodeSyncBytes(encoded)).toEqual(bytes);
  expect(parseSyncServerMessage(JSON.stringify({ protocol: 1, kind: "accepted", mutationId: "7d09513a-4b99-4a97-9e49-95cff2ef8b10", serverRevision: 3 }))).toMatchObject({ kind: "accepted", serverRevision: 3 });
});

class MemoryStorage implements SyncMutationStorage {
  readonly values = new Map<string, QueuedSyncMutation>();
  async insertIfAbsent(value: QueuedSyncMutation) { this.values.set(value.message.mutationId, value); return "inserted" as const; }
  async list(workspace: string, node: string) { return [...this.values.values()].filter(({ message }) => message.workspaceId === workspace && message.nodeId === node); }
  async markAttempt() {}
  async remove(id: string) { this.values.delete(id); }
}

const memoryDocumentCache: SyncDocumentCache = {
  async load() { return null; },
  async save() {},
  async clear() {},
};

class FakeSocket implements SyncWebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

test("SyncConnection applies remote Yjs state and removes local queued updates only after acknowledgement", async () => {
  const local = new Y.Doc();
  const storage = new MemoryStorage();
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const connection = await SyncConnection.open({
    url: "ws://localhost/api/sync/test",
    workspaceId,
    nodeId,
    documentKind: "page",
    document: local,
    queue: new OfflineSyncQueue(storage),
    createWebSocket: () => socket,
    onStatus: (status) => statuses.push(status),
    documentCache: memoryDocumentCache,
  });
  socket.open();
  expect(JSON.parse(socket.sent[0]!).kind).toBe("join");
  local.getMap("content").set("local", "kept");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const emptyRemote = new Y.Doc();
  socket.receive({ protocol: 1, kind: "sync", update: encodeSyncBytes(Y.encodeStateAsUpdate(emptyRemote)), serverRevision: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updateMessage = JSON.parse(socket.sent[1]!) as { mutationId: string; kind: string };
  expect(updateMessage.kind).toBe("update");
  expect(storage.values.size).toBe(1);
  socket.receive({ protocol: 1, kind: "accepted", mutationId: updateMessage.mutationId, serverRevision: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(storage.values.size).toBe(0);

  const remote = new Y.Doc();
  remote.getMap("content").set("remote", "received");
  socket.receive({ protocol: 1, kind: "sync", update: encodeSyncBytes(Y.encodeStateAsUpdate(remote)), serverRevision: 2 });
  expect(local.getMap("content").get("remote")).toBe("received");
  expect(statuses).toContain("connected");
  connection.close();
  local.destroy();
  emptyRemote.destroy();
  remote.destroy();
});

test("SyncConnection reconnects with backoff after a closed socket", async () => {
  const sockets: FakeSocket[] = [];
  const document = new Y.Doc();
  const connection = await SyncConnection.open({
    url: "ws://localhost/api/sync/test",
    workspaceId,
    nodeId,
    documentKind: "canvas",
    document,
    queue: new OfflineSyncQueue(new MemoryStorage()),
    createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    minimumReconnectDelayMs: 1,
    maximumReconnectDelayMs: 4,
    documentCache: memoryDocumentCache,
  });
  sockets[0]!.open();
  sockets[0]!.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sockets).toHaveLength(2);
  expect(sockets[1]!.readyState).toBe(0);
  connection.close();
  document.destroy();
});

test("SyncConnection.open restores cached Yjs state before starting transport", async () => {
  const cachedDoc = new Y.Doc();
  cachedDoc.getMap("content").set("offline", "restored");
  const cachedState = Y.encodeStateAsUpdate(cachedDoc);
  const document = new Y.Doc();
  const socket = new FakeSocket();
  const connection = await SyncConnection.open({
    url: "ws://localhost/api/sync/test",
    workspaceId,
    nodeId,
    documentKind: "page",
    document,
    queue: new OfflineSyncQueue(new MemoryStorage()),
    createWebSocket: () => socket,
    documentCache: {
      async load() { return cachedState; },
      async save() {},
      async clear() {},
    },
  });
  expect(document.getMap("content").get("offline")).toBe("restored");
  socket.open();
  expect(JSON.parse(socket.sent[0]!).kind).toBe("join");
  connection.close();
  cachedDoc.destroy();
  document.destroy();
});
