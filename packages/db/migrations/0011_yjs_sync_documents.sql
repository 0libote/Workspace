CREATE TABLE node_sync_documents (
  workspace_id UUID NOT NULL,
  node_id UUID NOT NULL,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('page', 'canvas')),
  state BYTEA NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, node_id, document_kind),
  FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE node_sync_mutations (
  workspace_id UUID NOT NULL,
  node_id UUID NOT NULL,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('page', 'canvas')),
  actor_id UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  mutation_id UUID NOT NULL,
  update_digest CHAR(64) NOT NULL CHECK (update_digest ~ '^[0-9a-f]{64}$'),
  server_revision INTEGER NOT NULL CHECK (server_revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, node_id, document_kind, actor_id, mutation_id),
  FOREIGN KEY (workspace_id, node_id, document_kind)
    REFERENCES node_sync_documents(workspace_id, node_id, document_kind) ON DELETE CASCADE
);

CREATE INDEX node_sync_mutations_created_at_idx ON node_sync_mutations (created_at);
