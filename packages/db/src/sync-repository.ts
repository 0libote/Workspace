import type {
  ApplySyncDocumentUpdateInput,
  ApplySyncDocumentUpdateResult,
  GetSyncDocumentStateInput,
  SyncDocumentRepository,
  SyncDocumentState,
} from "@workspace/domain";
import type { SQL } from "bun";
import * as Y from "yjs";

interface SyncStateRow { readonly state: Uint8Array; readonly revision: number }
interface MutationRow { readonly update_digest: string; readonly server_revision: number }

const MAX_PERSISTED_SYNC_STATE_BYTES = 32_000_000;

export class SyncMutationConflict extends Error {
  constructor() { super("The mutation ID was previously used with different update content."); }
}

function emptyUpdate(): Uint8Array {
  const document = new Y.Doc();
  try { return Y.encodeStateAsUpdate(document); }
  finally { document.destroy(); }
}

export class PostgresSyncDocumentRepository implements SyncDocumentRepository {
  constructor(private readonly database: SQL) {}

  async getState(input: GetSyncDocumentStateInput): Promise<SyncDocumentState> {
    const rows = await this.database<SyncStateRow[]>`
      SELECT state, revision FROM node_sync_documents
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND node_id = ${input.nodeId}::uuid
        AND document_kind = ${input.documentKind}
    `;
    if (!rows[0]) return { update: Y.diffUpdate(emptyUpdate(), input.stateVector), revision: 0 };
    return { update: Y.diffUpdate(new Uint8Array(rows[0].state), input.stateVector), revision: rows[0].revision };
  }

  applyUpdate(input: ApplySyncDocumentUpdateInput): Promise<ApplySyncDocumentUpdateResult> {
    const digest = new Bun.CryptoHasher("sha256").update(input.update).digest("hex");
    const initialState = emptyUpdate();
    return this.database.begin(async (transaction) => {
      await transaction`
        INSERT INTO node_sync_documents (workspace_id, node_id, document_kind, state, revision, updated_at, updated_by)
        VALUES (
          ${input.workspaceId}::uuid, ${input.nodeId}::uuid, ${input.documentKind},
          ${initialState}, 0, ${input.now}::timestamptz, ${input.actorId}::uuid
        ) ON CONFLICT (workspace_id, node_id, document_kind) DO NOTHING
      `;
      const states = await transaction<SyncStateRow[]>`
        SELECT state, revision FROM node_sync_documents
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND node_id = ${input.nodeId}::uuid
          AND document_kind = ${input.documentKind}
        FOR UPDATE
      `;
      const state = states[0];
      if (!state) throw new Error("The sync document could not be initialized.");

      const mutations = await transaction<MutationRow[]>`
        SELECT update_digest, server_revision FROM node_sync_mutations
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND node_id = ${input.nodeId}::uuid
          AND document_kind = ${input.documentKind}
          AND actor_id = ${input.actorId}::uuid
          AND mutation_id = ${input.mutationId}::uuid
      `;
      const prior = mutations[0];
      if (prior) {
        if (prior.update_digest !== digest) throw new SyncMutationConflict();
        return { revision: prior.server_revision, duplicate: true };
      }

      const mergedState = Y.mergeUpdates([new Uint8Array(state.state), input.update]);
      if (mergedState.byteLength > MAX_PERSISTED_SYNC_STATE_BYTES) throw new RangeError("The synchronized document exceeds the 32 MB storage limit.");
      const revision = state.revision + 1;
      await transaction`
        UPDATE node_sync_documents SET state = ${mergedState}, revision = ${revision},
          updated_at = ${input.now}::timestamptz, updated_by = ${input.actorId}::uuid
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND node_id = ${input.nodeId}::uuid
          AND document_kind = ${input.documentKind}
      `;
      await transaction`
        INSERT INTO node_sync_mutations (
          workspace_id, node_id, document_kind, actor_id, mutation_id, update_digest, server_revision, created_at
        ) VALUES (
          ${input.workspaceId}::uuid, ${input.nodeId}::uuid, ${input.documentKind},
          ${input.actorId}::uuid, ${input.mutationId}::uuid, ${digest}, ${revision}, ${input.now}::timestamptz
        )
      `;
      return { revision, duplicate: false };
    });
  }
}
