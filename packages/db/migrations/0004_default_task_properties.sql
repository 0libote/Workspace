INSERT INTO property_definitions (id, workspace_id, name, property_type, required, options)
SELECT
  md5(workspace.id::text || ':default-task-property:' || definition.name)::uuid,
  workspace.id,
  definition.name,
  definition.property_type,
  FALSE,
  definition.options
FROM workspaces AS workspace
CROSS JOIN (VALUES
  ('Status', 'status', '["Todo", "In progress", "Done"]'::jsonb),
  ('Priority', 'select', '["Low", "Normal", "High", "Urgent"]'::jsonb),
  ('Start date', 'date', NULL::jsonb),
  ('Due date', 'date', NULL::jsonb),
  ('Duration', 'duration', NULL::jsonb)
) AS definition(name, property_type, options)
WHERE NOT EXISTS (
  SELECT 1
  FROM property_definitions existing
  WHERE existing.workspace_id = workspace.id AND existing.name = definition.name
);
