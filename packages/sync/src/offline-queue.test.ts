import { expect, test } from "bun:test";
import { OfflineSyncQueue, type QueuedSyncMutation, type SyncMutationStorage } from "./index";
import type { SyncUpdateMessage } from "./index";

class SharedMemoryStorage implements SyncMutationStorage {
  readonly values = new Map<string, QueuedSyncMutation>();
  async insertIfAbsent(mutation: QueuedSyncMutation) {
    const prior = this.values.get(mutation.message.mutationId);
    if (!prior) { this.values.set(mutation.message.mutationId, mutation); return "inserted" as const; }
    return JSON.stringify(prior.message) === JSON.stringify(mutation.message) ? "same" as const : "conflict" as const;
  }
  async list(workspaceId: string, nodeId: string) {
    return [...this.values.values()].filter(({ message }) => message.workspaceId === workspaceId && message.nodeId === nodeId);
  }
  async markAttempt(mutationId: string) {
    const item = this.values.get(mutationId);
    if (item) this.values.set(mutationId, { ...item, attempts: item.attempts + 1 });
  }
  async remove(mutationId: string) { this.values.delete(mutationId); }
}

const base = { protocol: 1 as const, kind: "update" as const, workspaceId: "78e92f6c-9066-4e38-9af8-7e677d448066", nodeId: "dba7b2fa-f4ae-4190-8888-95ccb932a852", documentKind: "page" as const };
const first: SyncUpdateMessage = { ...base, mutationId: "7d09513a-4b99-4a97-9e49-95cff2ef8b10", update: "AQID" } as SyncUpdateMessage;
const second: SyncUpdateMessage = { ...base, mutationId: "7d09513a-4b99-4a97-9e49-95cff2ef8b11", update: "BAUG" } as SyncUpdateMessage;

test("retains mutation IDs, deduplicates retries, and rejects changed payload under an existing ID", async () => {
  const storage = new SharedMemoryStorage();
  const queue = new OfflineSyncQueue(storage);
  await queue.enqueue(first, 2);
  await queue.enqueue(first, 2);
  await expect(queue.enqueue({ ...first, update: "changed" }, 2)).rejects.toThrow("cannot be reused");
  expect((await queue.pending(base.workspaceId, base.nodeId)).map(({ message }) => message.mutationId)).toEqual([first.mutationId]);
});

test("flushes in order and keeps the same update queued after a failed send", async () => {
  const storage = new SharedMemoryStorage();
  const firstQueue = new OfflineSyncQueue(storage);
  const secondTabQueue = new OfflineSyncQueue(storage);
  await firstQueue.enqueue(second, 2);
  await firstQueue.enqueue(first, 1);
  const sent: string[] = [];
  expect(await secondTabQueue.flush(base.workspaceId, base.nodeId, async (message) => {
    sent.push(message.mutationId);
    if (message.mutationId === first.mutationId) throw new Error("offline");
    return true;
  })).toEqual({ acknowledged: 0, remaining: 2 });
  expect(sent).toEqual([first.mutationId]);
  expect(storage.values.get(first.mutationId)?.attempts).toBe(1);
  expect(await secondTabQueue.flush(base.workspaceId, base.nodeId, async (message) => {
    sent.push(message.mutationId);
    return true;
  })).toEqual({ acknowledged: 2, remaining: 0 });
  expect(sent).toEqual([first.mutationId, first.mutationId, second.mutationId]);
});
