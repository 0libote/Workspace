import type { NodeId, SyncDocumentKind, WorkspaceId } from "@workspace/domain";
import * as Y from "yjs";
import { OfflineSyncQueue, IndexedDbSyncDocumentStorage, IndexedDbSyncMutationStorage } from "./offline-queue";

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const MAX_SYNC_MESSAGE_BYTES = 2_000_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base64Pattern = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;

export type { SyncDocumentKind } from "@workspace/domain";

export class UnsupportedSyncProtocolVersion extends RangeError {
  constructor() { super("Sync protocol version is unsupported."); }
}

export interface SyncJoinMessage {
  readonly protocol: typeof SYNC_PROTOCOL_VERSION;
  readonly kind: "join";
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly stateVector: string;
}

export interface SyncUpdateMessage {
  readonly protocol: typeof SYNC_PROTOCOL_VERSION;
  readonly kind: "update";
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly mutationId: string;
  readonly update: string;
}

export type SyncClientMessage = SyncJoinMessage | SyncUpdateMessage;
export type SyncServerMessage =
  | { readonly protocol: typeof SYNC_PROTOCOL_VERSION; readonly kind: "sync"; readonly update: string; readonly serverRevision: number }
  | { readonly protocol: typeof SYNC_PROTOCOL_VERSION; readonly kind: "accepted"; readonly mutationId: string; readonly serverRevision: number }
  | { readonly protocol: typeof SYNC_PROTOCOL_VERSION; readonly kind: "error"; readonly code: "unsupported_version" | "invalid_message" | "not_authorized" | "conflict" | "too_large" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSyncClientMessage(value: unknown): SyncClientMessage {
  if (record(value) && value.protocol !== SYNC_PROTOCOL_VERSION) throw new UnsupportedSyncProtocolVersion();
  if (!record(value) ||
      (value.kind !== "join" && value.kind !== "update") ||
      typeof value.workspaceId !== "string" || !uuidPattern.test(value.workspaceId) ||
      typeof value.nodeId !== "string" || !uuidPattern.test(value.nodeId)) {
    throw new RangeError("Sync message has an invalid protocol version or node scope.");
  }
  if (value.kind === "join") {
    if ((value.documentKind !== "page" && value.documentKind !== "canvas") ||
        typeof value.stateVector !== "string" || value.stateVector.length > 90_000 || !base64Pattern.test(value.stateVector)) {
      throw new RangeError("Sync join message is malformed.");
    }
    return value as unknown as SyncJoinMessage;
  }
  if ((value.documentKind !== "page" && value.documentKind !== "canvas") ||
      typeof value.mutationId !== "string" || !uuidPattern.test(value.mutationId) ||
      typeof value.update !== "string" || value.update.length === 0 || value.update.length > MAX_SYNC_MESSAGE_BYTES ||
      !base64Pattern.test(value.update)) {
    throw new RangeError("Sync update message is malformed.");
  }
  return value as unknown as SyncUpdateMessage;
}

export function parseSyncClientMessage(text: string): SyncClientMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_SYNC_MESSAGE_BYTES) throw new RangeError("Sync message exceeds the 2 MB limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw new RangeError("Sync message must contain valid JSON."); }
  return validateSyncClientMessage(parsed);
}

export function encodeSyncBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeSyncBytes(encoded: string): Uint8Array {
  if (!base64Pattern.test(encoded)) throw new RangeError("Sync binary data is malformed.");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function parseSyncServerMessage(text: string): SyncServerMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_SYNC_MESSAGE_BYTES) throw new RangeError("Sync message exceeds the 2 MB limit.");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new RangeError("Sync server message must contain valid JSON."); }
  if (!record(value) || value.protocol !== SYNC_PROTOCOL_VERSION) throw new RangeError("Sync server message has an unsupported protocol version.");
  if (value.kind === "error" && ["unsupported_version", "invalid_message", "not_authorized", "conflict", "too_large"].includes(String(value.code))) {
    return value as unknown as SyncServerMessage;
  }
  if ((value.kind === "sync" || value.kind === "accepted") && typeof value.serverRevision === "number" && Number.isSafeInteger(value.serverRevision) && value.serverRevision >= 0) {
    if (value.kind === "sync" && typeof value.update === "string" && base64Pattern.test(value.update)) return value as unknown as SyncServerMessage;
    if (value.kind === "accepted" && typeof value.mutationId === "string" && uuidPattern.test(value.mutationId)) return value as unknown as SyncServerMessage;
  }
  throw new RangeError("Sync server message is malformed.");
}

export type SyncConnectionStatus = "connecting" | "connected" | "offline" | "conflict" | "unauthorized";

export interface SyncWebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SyncConnectionOptions {
  readonly url: string;
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly document: Y.Doc;
  readonly queue?: OfflineSyncQueue;
  readonly createWebSocket?: (url: string) => SyncWebSocketLike;
  readonly onStatus?: (status: SyncConnectionStatus) => void;
  readonly minimumReconnectDelayMs?: number;
  readonly maximumReconnectDelayMs?: number;
  readonly documentCache?: SyncDocumentCache;
  /** Set only by openSyncConnection after restoring the same document from local cache. */
  readonly restoredFromCache?: boolean;
  readonly onCacheError?: (error: Error) => void;
}

export interface SyncDocumentCache {
  load(workspaceId: string, nodeId: string, documentKind: SyncDocumentKind): Promise<Uint8Array | null>;
  save(workspaceId: string, nodeId: string, documentKind: SyncDocumentKind, state: Uint8Array): Promise<void>;
  clear(workspaceId: string, nodeId: string, documentKind: SyncDocumentKind): Promise<void>;
}

const REMOTE_UPDATE_ORIGIN = Symbol("sync remote update");
const OPEN = 1;

export function createSyncDocument(): Y.Doc { return new Y.Doc(); }

export function encodeSyncDocumentState(document: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(document);
}

export function applySyncDocumentUpdate(document: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(document, update, REMOTE_UPDATE_ORIGIN);
}

/** Connects a Y.Doc to the versioned server protocol and durable offline queue. */
export class SyncConnection {
  private readonly queue: OfflineSyncQueue;
  private readonly socketFactory: (url: string) => SyncWebSocketLike;
  private socket: SyncWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private stopped = false;
  private joined = false;
  private currentStatus: SyncConnectionStatus = "connecting";
  private readonly seedMutation: SyncUpdateMessage | null;
  private seedQueued = false;
  private sendChain: Promise<void> = Promise.resolve();
  private readonly acknowledgements = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void }>();
  private readonly localUpdateListener: (update: Uint8Array, origin: unknown) => void;

  constructor(private readonly options: SyncConnectionOptions) {
    this.queue = options.queue ?? new OfflineSyncQueue(new IndexedDbSyncMutationStorage());
    this.socketFactory = options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as SyncWebSocketLike);
    this.reconnectDelay = options.minimumReconnectDelayMs ?? 500;
    this.localUpdateListener = (update, origin) => {
      if (this.stopped) return;
      if (origin === REMOTE_UPDATE_ORIGIN) {
        void this.persistDocumentCache();
        return;
      }
      void this.persistDocumentCache();
      const message: SyncUpdateMessage = {
        protocol: SYNC_PROTOCOL_VERSION,
        kind: "update",
        workspaceId: options.workspaceId,
        nodeId: options.nodeId,
        documentKind: options.documentKind,
        mutationId: crypto.randomUUID(),
        update: encodeSyncBytes(update),
      };
      void this.queue.enqueue(message).then(() => this.flush()).catch(() => this.setStatus("offline"));
    };
    options.document.on("update", this.localUpdateListener);
    const stateVector = Y.encodeStateVector(options.document);
    this.seedMutation = stateVector.byteLength > 1 && !options.restoredFromCache ? {
      protocol: SYNC_PROTOCOL_VERSION,
      kind: "update",
      workspaceId: options.workspaceId,
      nodeId: options.nodeId,
      documentKind: options.documentKind,
      mutationId: crypto.randomUUID(),
      update: encodeSyncBytes(Y.encodeStateAsUpdate(options.document)),
    } : null;
    void this.persistDocumentCache();
    void this.connect();
  }

  static async open(options: SyncConnectionOptions): Promise<SyncConnection> {
    const cache = options.documentCache ?? new IndexedDbSyncDocumentStorage();
    let restoredFromCache = false;
    try {
      const state = await cache.load(options.workspaceId, options.nodeId, options.documentKind);
      if (state) {
        Y.applyUpdate(options.document, state, REMOTE_UPDATE_ORIGIN);
        restoredFromCache = true;
      }
    } catch (error) {
      options.onCacheError?.(error instanceof Error ? error : new Error("Could not restore the local sync cache."));
    }
    return new SyncConnection({ ...options, documentCache: cache, restoredFromCache });
  }

  close(): void {
    this.stopped = true;
    this.options.document.off("update", this.localUpdateListener);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.rejectAcknowledgements(new Error("Sync connection closed."));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    try {
      if (this.seedMutation && !this.seedQueued) {
        await this.queue.enqueue(this.seedMutation);
        this.seedQueued = true;
      }
      if (this.stopped) return;
      const socket = this.socketFactory(this.options.url);
      this.socket = socket;
      socket.onopen = () => {
        if (socket !== this.socket || this.stopped) return;
        this.joined = false;
        socket.send(JSON.stringify({
          protocol: SYNC_PROTOCOL_VERSION,
          kind: "join",
          workspaceId: this.options.workspaceId,
          nodeId: this.options.nodeId,
          documentKind: this.options.documentKind,
          stateVector: encodeSyncBytes(Y.encodeStateVector(this.options.document)),
        } satisfies SyncJoinMessage));
      };
      socket.onmessage = (event) => this.receive(socket, event.data);
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socket !== this.socket || this.stopped) return;
        this.socket = null;
        this.joined = false;
        this.rejectAcknowledgements(new Error("Sync connection interrupted."));
        this.setStatus("offline");
        this.scheduleReconnect();
      };
    } catch {
      this.setStatus("offline");
      this.scheduleReconnect();
    }
  }

  private receive(socket: SyncWebSocketLike, raw: unknown): void {
    if (socket !== this.socket || typeof raw !== "string") return;
    let message: SyncServerMessage;
    try { message = parseSyncServerMessage(raw); }
    catch { socket.close(); return; }
    if (message.kind === "sync") {
      Y.applyUpdate(this.options.document, decodeSyncBytes(message.update), REMOTE_UPDATE_ORIGIN);
      if (!this.joined) {
        this.joined = true;
        this.reconnectDelay = this.options.minimumReconnectDelayMs ?? 500;
        this.setStatus("connected");
        void this.flush();
      }
    } else if (message.kind === "accepted") {
      this.acknowledgements.get(message.mutationId)?.resolve(true);
      this.acknowledgements.delete(message.mutationId);
    } else {
      if (message.code === "conflict") this.setStatus("conflict");
      if (message.code === "not_authorized") this.setStatus("unauthorized");
      const current = this.acknowledgements.values().next().value as { reject: (error: Error) => void } | undefined;
      current?.reject(new Error(`Sync server rejected an update: ${message.code}`));
      if (message.code === "not_authorized" || message.code === "unsupported_version") socket.close();
    }
  }

  private flush(): Promise<void> {
    this.sendChain = this.sendChain.then(async () => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN || !this.joined || this.stopped) return;
      const result = await this.queue.flush(this.options.workspaceId, this.options.nodeId, async (mutation) => {
        if (socket !== this.socket || socket.readyState !== OPEN) return false;
        const acknowledged = new Promise<boolean>((resolve, reject) => this.acknowledgements.set(mutation.mutationId, { resolve, reject }));
        socket.send(JSON.stringify(mutation));
        return await acknowledged;
      });
      if (result.remaining > 0 && socket === this.socket && this.currentStatus !== "conflict" && this.currentStatus !== "unauthorized") this.setStatus("offline");
    }).catch(() => this.setStatus("offline"));
    return this.sendChain;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.options.maximumReconnectDelayMs ?? 30_000, Math.max(delay + 1, delay * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private rejectAcknowledgements(error: Error): void {
    for (const item of this.acknowledgements.values()) item.reject(error);
    this.acknowledgements.clear();
  }

  private setStatus(status: SyncConnectionStatus): void {
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }

  private async persistDocumentCache(): Promise<void> {
    if (!this.options.documentCache) return;
    try {
      await this.options.documentCache.save(
        this.options.workspaceId,
        this.options.nodeId,
        this.options.documentKind,
        encodeSyncDocumentState(this.options.document),
      );
    } catch (error) {
      this.options.onCacheError?.(error instanceof Error ? error : new Error("Could not save the local sync cache."));
    }
  }
}

export { IndexedDbSyncDocumentStorage, IndexedDbSyncMutationStorage, OfflineSyncQueue, type CachedSyncDocument, type QueuedSyncMutation, type SyncMutationStorage } from "./offline-queue";
