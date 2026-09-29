ALTER TABLE workspaces
  ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (length(btrim(time_zone)) BETWEEN 1 AND 100);
