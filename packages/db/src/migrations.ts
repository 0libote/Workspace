import type { SQL } from "bun";

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const migrations = [
  { version: "0001_initial_workspace", file: "0001_initial_workspace.sql" },
  { version: "0002_auth_credentials_and_sessions", file: "0002_auth_credentials_and_sessions.sql" },
  { version: "0003_node_documents", file: "0003_node_documents.sql" },
  { version: "0004_default_task_properties", file: "0004_default_task_properties.sql" },
  { version: "0005_search_indexes", file: "0005_search_indexes.sql" },
  { version: "0006_saved_collections", file: "0006_saved_collections.sql" },
  { version: "0007_workspace_time_zone", file: "0007_workspace_time_zone.sql" },
  { version: "0008_calendar_property_range_index", file: "0008_calendar_property_range_index.sql" },
  { version: "0009_default_task_time_properties", file: "0009_default_task_time_properties.sql" },
  { version: "0010_canvas_documents", file: "0010_canvas_documents.sql" },
  { version: "0011_yjs_sync_documents", file: "0011_yjs_sync_documents.sql" },
] as const;

export async function applyMigrations(database: SQL): Promise<MigrationResult> {
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    const source = await Bun.file(`${import.meta.dir}/../migrations/${migration.file}`).text();
    const checksum = new Bun.CryptoHasher("sha256").update(source).digest("hex");

    const wasApplied = await database.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('node-workspace:migrations', 0))`;
      await transaction`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;

      const rows = await transaction<{ checksum: string }[]>`
        SELECT checksum FROM schema_migrations WHERE version = ${migration.version}
      `;
      const existing = rows[0];
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Applied migration ${migration.version} has changed; migration history must remain immutable.`);
        }
        return true;
      }

      await transaction.unsafe(source).simple();
      await transaction`
        INSERT INTO schema_migrations (version, checksum)
        VALUES (${migration.version}, ${checksum})
      `;
      return false;
    });

    (wasApplied ? alreadyApplied : applied).push(migration.version);
  }

  return { applied, alreadyApplied };
}
