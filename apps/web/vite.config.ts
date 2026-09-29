import { createLogger, defineConfig } from "vite";

const logger = createLogger();
const defaultWarn = logger.warn.bind(logger);
logger.warn = (message, options) => {
  // Vite builds a browser-only SPA; React Server Component directives are inert here.
  if (message.includes('The semantics of the module level directive "use client"')) return;
  defaultWarn(message, options);
};

export default defineConfig({
  customLogger: logger,
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:3190", ws: true },
      "/health": "http://127.0.0.1:3190",
      "/ready": "http://127.0.0.1:3190",
    },
  },
});
