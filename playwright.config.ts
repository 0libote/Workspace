import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:4173/health",
    env: {
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? "",
      APP_URL: "http://127.0.0.1:4173",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
