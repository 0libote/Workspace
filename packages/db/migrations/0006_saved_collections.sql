CREATE TABLE saved_collections (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  query JSONB NOT NULL CHECK (jsonb_typeof(query) = 'object'),
  view_config JSONB NOT NULL CHECK (jsonb_typeof(view_config) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, id)
);

CREATE INDEX saved_collections_workspace_name_idx ON saved_collections(workspace_id, lower(name), id);
