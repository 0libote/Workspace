CREATE TABLE node_documents (
  workspace_id UUID NOT NULL,
  node_id UUID NOT NULL,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, node_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE
);
