import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebHandler } from "./web";

test("serves built assets and falls back to the app shell for client routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-web-"));
  try {
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "icons"));
    await Bun.write(join(root, "index.html"), "<main>app shell</main>");
    await Bun.write(join(root, "assets", "app.js"), "console.log('app')");
    await Bun.write(join(root, "manifest.webmanifest"), '{"name":"Astryx"}');
    await Bun.write(join(root, "sw.js"), "self.addEventListener('fetch', () => {})");
    await Bun.write(join(root, "icons", "icon.svg"), "<svg></svg>");
    const handler = createWebHandler(root);

    const shell = await handler(new Request("http://localhost/tasks"));
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe("<main>app shell</main>");
    const asset = await handler(new Request("http://localhost/assets/app.js"));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log('app')");
    expect(await (await handler(new Request("http://localhost/manifest.webmanifest"))).text()).toBe('{"name":"Astryx"}');
    expect(await (await handler(new Request("http://localhost/sw.js"))).text()).toContain("addEventListener");
    expect(await (await handler(new Request("http://localhost/icons/icon.svg"))).text()).toBe("<svg></svg>");
    expect((await handler(new Request("http://localhost/assets/missing.js"))).status).toBe(404);
    expect((await handler(new Request("http://localhost/%2e%2e%2fsecret"))).status).toBe(404);
    expect((await handler(new Request("http://localhost/tasks", { method: "POST" }))).status).toBe(405);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
