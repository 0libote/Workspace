import { expect, test } from "bun:test";
import { SQL } from "bun";
import * as Y from "yjs";
import { createMembership, createNode, createUser, createWorkspace, type NodeId, type UserId, type WorkspaceId } from "@workspace/domain";
import { applyMigrations, PostgresNodeRepository, PostgresUserRepository, PostgresWorkspaceMembershipRepository, PostgresWorkspaceRepository } from "@workspace/db";
import { decodeSyncBytes, encodeSyncBytes } from "@workspace/sync";
import { createSecretToken, persistSession } from "./auth";
import { handleSyncSocketMessage, syncWebSocketHandlers, tryUpgradeSync, type SyncSocketData, type SyncWebSocket } from "./sync";

const databaseUrl = Bun.env.DATABASE_URL_TEST;

test.skipIf(!databaseUrl)("sync transport authorizes scope, persists Yjs updates, acknowledges retries, and broadcasts state", async () => {
  const database = new SQL(databaseUrl!);
  const userId = crypto.randomUUID() as UserId;
  const workspaceId = crypto.randomUUID() as WorkspaceId;
  const nodeId = crypto.randomUUID() as NodeId;
  const now = new Date();
  let created = false;
  const token = createSecretToken();
  try {
    await applyMigrations(database);
    await new PostgresUserRepository(database).create(createUser({ id: userId, email: `${userId}@sync.integration.test`, displayName: "Sync tester", now: now.toISOString() }));
    await new PostgresWorkspaceRepository(database).create(createWorkspace({ id: workspaceId, name: "Sync integration", now: now.toISOString() }));
    created = true;
    await new PostgresWorkspaceMembershipRepository(database).create(createMembership(workspaceId, userId, "owner", now.toISOString()));
    await new PostgresNodeRepository(database).create(createNode({ id: nodeId, workspaceId, type: "page" as never, title: "Sync page", actorId: userId, now: now.toISOString() }));
    await persistSession(database, userId, token, createSecretToken(), now);

    let upgradeData: SyncSocketData | undefined;
    const published: string[] = [];
    const server = {
      upgrade(_request: Request, options: { readonly data: SyncSocketData }) { upgradeData = options.data; return true; },
      publish(_topic: string, message: string) { published.push(message); return 1; },
    };
    const origin = "http://127.0.0.1:3190";
    const request = new Request(`http://127.0.0.1:3190/api/sync/${workspaceId}/${nodeId}/page`, {
      headers: { upgrade: "websocket", origin, cookie: `workspace_session=${token}` },
    });
    expect(await tryUpgradeSync(request, server, database)).toBeUndefined();
    expect(upgradeData?.actorId).toBe(userId);
    const sent: string[] = [];
    const socket: SyncWebSocket = {
      data: upgradeData!,
      send(message) { sent.push(message); return message.length; },
      subscribe() {},
      unsubscribe() {},
      close() {},
    };
    const empty = new Y.Doc();
    await handleSyncSocketMessage(socket, JSON.stringify({ protocol: 1, kind: "join", workspaceId, nodeId, documentKind: "page", stateVector: encodeSyncBytes(Y.encodeStateVector(empty)) }));
    expect(JSON.parse(sent.pop()!).kind).toBe("sync");

    const local = new Y.Doc();
    local.getMap("content").set("title", "shared");
    const update = Y.encodeStateAsUpdate(local);
    const mutationId = crypto.randomUUID();
    const envelope = JSON.stringify({ protocol: 1, kind: "update", workspaceId, nodeId, documentKind: "page", mutationId, update: encodeSyncBytes(update) });
    await handleSyncSocketMessage(socket, envelope);
    expect(JSON.parse(sent.pop()!)).toMatchObject({ kind: "accepted", serverRevision: 1, mutationId });
    expect(published).toHaveLength(1);
    await handleSyncSocketMessage(socket, envelope);
    expect(JSON.parse(sent.pop()!)).toMatchObject({ kind: "accepted", serverRevision: 1, mutationId });
    expect(published).toHaveLength(1);

    const second = new Y.Doc();
    const state = JSON.parse(published[0]!) as { update: string };
    Y.applyUpdate(second, decodeSyncBytes(state.update));
    expect(second.getMap("content").get("title")).toBe("shared");
    const denied = await tryUpgradeSync(new Request(request.url, { headers: { upgrade: "websocket", origin: "https://attacker.invalid", cookie: `workspace_session=${token}` } }), server, database);
    expect(denied?.status).toBe(403);
    await syncWebSocketHandlers.message(socket, JSON.stringify({ protocol: 2, kind: "join", workspaceId, nodeId, documentKind: "page", stateVector: "AA" }));
    expect(JSON.parse(sent.pop()!)).toMatchObject({ kind: "error", code: "unsupported_version" });
    empty.destroy(); local.destroy(); second.destroy();
  } finally {
    if (created) await database`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
    await database`DELETE FROM app_users WHERE id = ${userId}::uuid`;
    await database.close();
  }
});
