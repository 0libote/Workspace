import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Astryx Workspace",
    identifier: "app.astryx.workspace",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
  },
} satisfies ElectrobunConfig;
