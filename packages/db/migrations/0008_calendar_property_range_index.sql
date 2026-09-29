CREATE INDEX node_properties_calendar_range_idx
  ON node_properties (workspace_id, property_definition_id, (value->>'value'));
