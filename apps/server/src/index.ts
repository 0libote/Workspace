import { SQL } from "bun";
import { applyMigrations } from "@workspace/db";
import { createAppHandler } from "./api";
import { createWebHandler } from "./web";
import { syncWebSocketHandlers, tryUpgradeSync } from "./sync";

const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer from 0 to 65535.");

const databaseUrl = Bun.env.DATABASE_URL;
const webHandler = createWebHandler(Bun.env.WEB_DIST_DIR);
const database = databaseUrl ? new SQL(databaseUrl) : null;
if (database) {
  await applyMigrations(database);
  await database.connect();
}
const apiHandler = createAppHandler(database);

const server = Bun.serve({
  port,
  maxRequestBodySize: 9_000_000,
  fetch: async (request, server) => {
    const pathname = new URL(request.url).pathname;
    const syncUpgrade = await tryUpgradeSync(request, server, database);
    if (syncUpgrade !== undefined) return syncUpgrade;
    if (pathname.startsWith("/api") || pathname === "/health" || pathname === "/ready") {
      return await apiHandler(request);
    }
    return await webHandler(request);
  },
  websocket: syncWebSocketHandlers,
});

console.info({ event: "server_started", url: server.url.toString(), databaseConfigured: database !== null });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info({ event: "server_stopping", signal });
  server.stop(true);
  await database?.close({ timeout: 5 });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
