import type { NodeId, SyncDocumentKind, UserId, WorkspaceId } from "@workspace/domain";
import { PostgresSyncDocumentRepository, SyncMutationConflict } from "@workspace/db";
import type { SQL } from "bun";
import {
  decodeSyncBytes,
  encodeSyncBytes,
  parseSyncClientMessage,
  UnsupportedSyncProtocolVersion,
  type SyncServerMessage,
} from "@workspace/sync";
import { findSession } from "./auth";

export interface SyncSocketData {
  readonly database: SQL;
  readonly sessionId: string;
  readonly actorId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly server: SyncUpgradeServer;
  joined: boolean;
  topic?: string;
  authorizationTimer?: ReturnType<typeof setInterval>;
}

export interface SyncWebSocket {
  readonly data: SyncSocketData;
  send(message: string): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  close(code?: number, reason?: string): void;
}

export interface SyncUpgradeServer {
  upgrade(request: Request, options: { readonly data: SyncSocketData }): boolean;
  publish(topic: string, message: string): number;
}

function response(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function topicFor(scope: Pick<SyncSocketData, "workspaceId" | "nodeId" | "documentKind">): string {
  return `sync:${scope.workspaceId}:${scope.nodeId}:${scope.documentKind}`;
}

function isExpectedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(Bun.env.APP_URL ?? request.url).origin; }
  catch { return false; }
}

async function authorized(scope: SyncSocketData, write: boolean): Promise<boolean> {
  const rows = await scope.database<{ readonly role: "owner" | "editor" | "viewer" }[]>`
    SELECT memberships.role
    FROM auth_sessions
    JOIN app_users ON app_users.id = auth_sessions.user_id
    JOIN workspace_memberships AS memberships ON memberships.user_id = app_users.id
    JOIN workspaces ON workspaces.id = memberships.workspace_id
    JOIN nodes ON nodes.workspace_id = workspaces.id
    WHERE auth_sessions.id = ${scope.sessionId}::uuid
      AND auth_sessions.user_id = ${scope.actorId}::uuid
      AND auth_sessions.revoked_at IS NULL
      AND auth_sessions.expires_at > CURRENT_TIMESTAMP
      AND app_users.deactivated_at IS NULL
      AND memberships.workspace_id = ${scope.workspaceId}::uuid
      AND workspaces.archived_at IS NULL
      AND nodes.id = ${scope.nodeId}::uuid
      AND nodes.archived_at IS NULL
      AND nodes.type = ${scope.documentKind}
  `;
  const role = rows[0]?.role;
  return Boolean(role && (!write || role !== "viewer"));
}

export async function tryUpgradeSync(
  request: Request,
  server: SyncUpgradeServer,
  database: SQL | null,
): Promise<Response | undefined> {
  const route = /^\/api\/sync\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(page|canvas)$/.exec(new URL(request.url).pathname);
  if (!route) return undefined;
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return response(426, "websocket_required");
  if (!database) return response(503, "database_unavailable");
  if (!isExpectedOrigin(request)) return response(403, "origin_rejected");
  const session = await findSession(database, request);
  if (!session) return response(401, "unauthorized");
  const scope: SyncSocketData = {
    database,
    sessionId: session.id,
    actorId: session.user.id,
    workspaceId: route[1] as WorkspaceId,
    nodeId: route[2] as NodeId,
    documentKind: route[3] as SyncDocumentKind,
    server,
    joined: false,
  };
  if (!await authorized(scope, false)) return response(404, "sync_document_not_found");
  if (!server.upgrade(request, { data: scope })) return response(400, "websocket_upgrade_failed");
  return undefined;
}

function send(socket: SyncWebSocket, message: SyncServerMessage): void {
  socket.send(JSON.stringify(message));
}

export async function handleSyncSocketMessage(socket: SyncWebSocket, text: string): Promise<void> {
  const scope = socket.data;
  const message = parseSyncClientMessage(text);
  if (message.workspaceId !== scope.workspaceId || message.nodeId !== scope.nodeId) {
    send(socket, { protocol: 1, kind: "error", code: "not_authorized" });
    socket.close(4403, "sync scope mismatch");
    return;
  }
  const repository = new PostgresSyncDocumentRepository(scope.database);
  if (message.kind === "join") {
    if (scope.joined || message.documentKind !== scope.documentKind || !await authorized(scope, false)) {
      send(socket, { protocol: 1, kind: "error", code: "not_authorized" });
      socket.close(4403, "sync access denied");
      return;
    }
    const state = await repository.getState({
      workspaceId: scope.workspaceId,
      nodeId: scope.nodeId,
      documentKind: scope.documentKind,
      stateVector: decodeSyncBytes(message.stateVector),
    });
    scope.topic = topicFor(scope);
    socket.subscribe(scope.topic);
    scope.joined = true;
    send(socket, { protocol: 1, kind: "sync", update: encodeSyncBytes(state.update), serverRevision: state.revision });
    return;
  }

  if (!scope.joined || message.documentKind !== scope.documentKind || !await authorized(scope, true)) {
    send(socket, { protocol: 1, kind: "error", code: "not_authorized" });
    socket.close(4403, "sync write access denied");
    return;
  }
  const update = decodeSyncBytes(message.update);
  try {
    const result = await repository.applyUpdate({
      workspaceId: scope.workspaceId,
      nodeId: scope.nodeId,
      documentKind: scope.documentKind,
      actorId: scope.actorId,
      mutationId: message.mutationId,
      update,
      now: new Date().toISOString(),
    });
    send(socket, { protocol: 1, kind: "accepted", mutationId: message.mutationId, serverRevision: result.revision });
    if (!result.duplicate && scope.topic) {
      const broadcast: SyncServerMessage = { protocol: 1, kind: "sync", update: message.update, serverRevision: result.revision };
      scope.server.publish(scope.topic, JSON.stringify(broadcast));
    }
  } catch (error) {
    if (error instanceof SyncMutationConflict) {
      send(socket, { protocol: 1, kind: "error", code: "conflict" });
      return;
    }
    if (error instanceof RangeError) {
      send(socket, { protocol: 1, kind: "error", code: "invalid_message" });
      return;
    }
    throw error;
  }
}

export const syncWebSocketHandlers = {
  data: {} as SyncSocketData,
  maxPayloadLength: 2_000_000,
  open(socket: SyncWebSocket) {
    socket.data.authorizationTimer = setInterval(() => {
      void authorized(socket.data, false).then((allowed) => {
        if (!allowed) socket.close(4403, "sync access revoked");
      }).catch(() => socket.close(1011, "authorization check failed"));
    }, 30_000);
  },
  async message(socket: SyncWebSocket, message: string | Buffer) {
    try {
      await handleSyncSocketMessage(socket, typeof message === "string" ? message : message.toString("utf8"));
    } catch (error) {
      if (error instanceof UnsupportedSyncProtocolVersion) send(socket, { protocol: 1, kind: "error", code: "unsupported_version" });
      else if (error instanceof RangeError) send(socket, { protocol: 1, kind: "error", code: "invalid_message" });
      else {
        console.error({ event: "sync_message_failed", error: error instanceof Error ? error.message : "unknown error" });
        socket.close(1011, "sync failed");
      }
    }
  },
  close(socket: SyncWebSocket) {
    if (socket.data.authorizationTimer) clearInterval(socket.data.authorizationTimer);
    if (socket.data.topic) socket.unsubscribe(socket.data.topic);
  },
};
