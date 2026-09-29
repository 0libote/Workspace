import { validateSyncClientMessage, type SyncUpdateMessage } from "./index";

export interface QueuedSyncMutation {
  readonly message: SyncUpdateMessage;
  readonly queuedAt: number;
  readonly attempts: number;
}

export type MutationInsertResult = "inserted" | "same" | "conflict";

export interface SyncMutationStorage {
  insertIfAbsent(mutation: QueuedSyncMutation): Promise<MutationInsertResult>;
  list(workspaceId: string, nodeId: string): Promise<readonly QueuedSyncMutation[]>;
  markAttempt(mutationId: string): Promise<void>;
  remove(mutationId: string): Promise<void>;
}

export class OfflineSyncQueue {
  constructor(private readonly storage: SyncMutationStorage) {}

  async enqueue(message: SyncUpdateMessage, queuedAt = Date.now()): Promise<void> {
    validateSyncClientMessage(message);
    const existing = await this.storage.insertIfAbsent({ message, queuedAt, attempts: 0 });
    if (existing === "conflict") throw new Error("A sync mutation ID cannot be reused with different content.");
  }

  async pending(workspaceId: string, nodeId: string): Promise<readonly QueuedSyncMutation[]> {
    const pending = await this.storage.list(workspaceId, nodeId);
    return [...pending].sort((a, b) => a.queuedAt - b.queuedAt || a.message.mutationId.localeCompare(b.message.mutationId));
  }

  /** Retries in order and removes an entry only after the server acknowledges it. */
  async flush(
    workspaceId: string,
    nodeId: string,
    send: (mutation: SyncUpdateMessage) => Promise<boolean>,
  ): Promise<{ readonly acknowledged: number; readonly remaining: number }> {
    let acknowledged = 0;
    for (const queued of await this.pending(workspaceId, nodeId)) {
      try {
        if (!await send(queued.message)) {
          await this.storage.markAttempt(queued.message.mutationId);
          break;
        }
        await this.storage.remove(queued.message.mutationId);
        acknowledged += 1;
      } catch {
        await this.storage.markAttempt(queued.message.mutationId);
        break;
      }
    }
    return { acknowledged, remaining: (await this.pending(workspaceId, nodeId)).length };
  }
}

/** Browser-native persistent queue shared by tabs on the same origin. */
export class IndexedDbSyncMutationStorage implements SyncMutationStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(readonly databaseName = "commonplace-sync") {}

  async insertIfAbsent(mutation: QueuedSyncMutation): Promise<"inserted" | "same" | "conflict"> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("mutations", "readwrite");
      const store = transaction.objectStore("mutations");
      let result: "inserted" | "same" | "conflict" = "inserted";
      const get = store.get(mutation.message.mutationId);
      get.onsuccess = () => {
        const existing = get.result as QueuedSyncMutation | undefined;
        if (existing) {
          result = JSON.stringify(existing.message) === JSON.stringify(mutation.message) ? "same" : "conflict";
          return;
        }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= 5_000) {
            reject(new Error("The offline sync queue has reached its 5,000 update limit."));
            transaction.abort();
            return;
          }
          store.add(mutation);
        };
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not write the offline sync queue."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline sync queue transaction aborted."));
    });
  }

  async list(workspaceId: string, nodeId: string): Promise<readonly QueuedSyncMutation[]> {
    const database = await this.openDatabase();
    const all = await this.request<QueuedSyncMutation[]>(database.transaction("mutations", "readonly").objectStore("mutations").getAll());
    return all.filter(({ message }) => message.workspaceId === workspaceId && message.nodeId === nodeId);
  }

  async markAttempt(mutationId: string): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction("mutations", "readwrite");
    const store = transaction.objectStore("mutations");
    const get = store.get(mutationId);
    get.onsuccess = () => {
      const queued = get.result as QueuedSyncMutation | undefined;
      if (queued) store.put({ ...queued, attempts: queued.attempts + 1 });
    };
    await this.transactionDone(transaction);
  }

  async remove(mutationId: string): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction("mutations", "readwrite");
    transaction.objectStore("mutations").delete(mutationId);
    await this.transactionDone(transaction);
  }

  openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this environment."));
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("mutations")) request.result.createObjectStore("mutations", { keyPath: "message.mutationId" });
        if (!request.result.objectStoreNames.contains("documents")) request.result.createObjectStore("documents", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open the offline sync queue."));
    });
    return this.databasePromise;
  }

  request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not read the offline sync queue."));
    });
  }

  transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not update the offline sync queue."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline sync queue transaction aborted."));
    });
  }
}

export interface CachedSyncDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly documentKind: "page" | "canvas";
  readonly state: Uint8Array;
  readonly savedAt: number;
}

/** Disposable local recovery cache; PostgreSQL remains the shared source of truth. */
export class IndexedDbSyncDocumentStorage {
  private readonly storage: IndexedDbSyncMutationStorage;

  constructor(databaseName = "commonplace-sync") { this.storage = new IndexedDbSyncMutationStorage(databaseName); }

  async load(workspaceId: string, nodeId: string, documentKind: "page" | "canvas"): Promise<Uint8Array | null> {
    const database = await this.storage.openDatabase();
    const row = await this.storage.request<CachedSyncDocument | undefined>(database.transaction("documents", "readonly").objectStore("documents").get(this.key(workspaceId, nodeId, documentKind)));
    return row ? new Uint8Array(row.state) : null;
  }

  async save(workspaceId: string, nodeId: string, documentKind: "page" | "canvas", state: Uint8Array): Promise<void> {
    const database = await this.storage.openDatabase();
    const transaction = database.transaction("documents", "readwrite");
    transaction.objectStore("documents").put({
      id: this.key(workspaceId, nodeId, documentKind), workspaceId, nodeId, documentKind,
      state: new Uint8Array(state), savedAt: Date.now(),
    } satisfies CachedSyncDocument);
    await this.storage.transactionDone(transaction);
  }

  async clear(workspaceId: string, nodeId: string, documentKind: "page" | "canvas"): Promise<void> {
    const database = await this.storage.openDatabase();
    const transaction = database.transaction(["documents", "mutations"], "readwrite");
    const transactionFinished = this.storage.transactionDone(transaction);
    const documents = transaction.objectStore("documents");
    documents.delete(this.key(workspaceId, nodeId, documentKind));
    const all = await this.storage.request<QueuedSyncMutation[]>(transaction.objectStore("mutations").getAll());
    for (const mutation of all) {
      const message = mutation.message;
      if (message.workspaceId === workspaceId && message.nodeId === nodeId && message.documentKind === documentKind) {
        transaction.objectStore("mutations").delete(message.mutationId);
      }
    }
    await transactionFinished;
  }

  private key(workspaceId: string, nodeId: string, documentKind: "page" | "canvas"): string {
    return `${workspaceId}:${nodeId}:${documentKind}`;
  }
}
