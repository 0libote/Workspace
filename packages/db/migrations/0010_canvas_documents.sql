CREATE TABLE node_canvases (
  workspace_id UUID NOT NULL,
  node_id UUID NOT NULL,
  scene JSONB NOT NULL CHECK (jsonb_typeof(scene) = 'object'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, node_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE canvas_node_bindings (
  workspace_id UUID NOT NULL,
  canvas_node_id UUID NOT NULL,
  element_id TEXT NOT NULL CHECK (length(element_id) BETWEEN 1 AND 255),
  node_id UUID NOT NULL,
  PRIMARY KEY (workspace_id, canvas_node_id, element_id),
  FOREIGN KEY (workspace_id, canvas_node_id) REFERENCES node_canvases(workspace_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX canvas_node_bindings_by_node_idx ON canvas_node_bindings (workspace_id, node_id);
