import { SQL } from "bun";
import { applyMigrations } from "@workspace/db";

const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set before running database migrations.");

const database = new SQL(databaseUrl);
try {
  const result = await applyMigrations(database);
  console.info({
    event: "database_migrations_complete",
    applied: result.applied,
    alreadyApplied: result.alreadyApplied,
  });
} finally {
  await database.close({ timeout: 5 });
}
