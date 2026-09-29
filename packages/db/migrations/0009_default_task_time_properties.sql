INSERT INTO property_definitions (id, workspace_id, name, property_type, required, options)
SELECT
  md5(workspace.id::text || ':default-task-property:' || definition.name)::uuid,
  workspace.id,
  definition.name,
  'dateTime',
  FALSE,
  NULL
FROM workspaces AS workspace
CROSS JOIN (VALUES ('Start time'), ('Due time')) AS definition(name)
WHERE NOT EXISTS (
  SELECT 1 FROM property_definitions existing
  WHERE existing.workspace_id = workspace.id AND existing.name = definition.name
);
