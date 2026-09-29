CREATE TABLE app_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  deactivated_at TIMESTAMPTZ
);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ
);

CREATE TABLE workspace_memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_node_types (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type ~ '^[a-z][a-z0-9_-]*$'),
  label TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  PRIMARY KEY (workspace_id, type),
  UNIQUE (workspace_id, label)
);

CREATE TABLE relation_definitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type ~ '^[a-z][a-z0-9_-]*$'),
  from_label TEXT NOT NULL CHECK (length(btrim(from_label)) > 0),
  to_label TEXT NOT NULL CHECK (length(btrim(to_label)) > 0),
  allow_self_relation BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, type)
);

CREATE TABLE nodes (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type ~ '^[a-z][a-z0-9_-]*$'),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  archived_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (created_by) REFERENCES app_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by) REFERENCES app_users(id) ON DELETE RESTRICT
);

CREATE TABLE property_definitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  property_type TEXT NOT NULL CHECK (property_type IN (
    'text', 'number', 'boolean', 'date', 'dateTime', 'dateRange', 'select',
    'multiSelect', 'user', 'relation', 'url', 'email', 'phone', 'file',
    'formula', 'status', 'duration'
  )),
  required BOOLEAN NOT NULL DEFAULT FALSE,
  options JSONB,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name),
  CHECK (options IS NULL OR jsonb_typeof(options) = 'array')
);

CREATE TABLE node_properties (
  workspace_id UUID NOT NULL,
  node_id UUID NOT NULL,
  property_definition_id UUID NOT NULL,
  value_type TEXT NOT NULL,
  value JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object' AND value->>'type' = value_type),
  PRIMARY KEY (node_id, property_definition_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, property_definition_id) REFERENCES property_definitions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE node_relations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  from_node_id UUID NOT NULL,
  to_node_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, from_node_id, to_node_id, relation_type),
  FOREIGN KEY (workspace_id, from_node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, to_node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, relation_type) REFERENCES relation_definitions(workspace_id, type) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES app_users(id) ON DELETE RESTRICT
);

CREATE INDEX nodes_workspace_type_active_idx ON nodes(workspace_id, type, id) WHERE archived_at IS NULL;
CREATE INDEX nodes_workspace_title_idx ON nodes(workspace_id, lower(title));
CREATE INDEX node_relations_from_idx ON node_relations(workspace_id, from_node_id);
CREATE INDEX node_relations_to_idx ON node_relations(workspace_id, to_node_id);
CREATE INDEX node_properties_definition_idx ON node_properties(workspace_id, property_definition_id);
