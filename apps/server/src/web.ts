import { resolve, sep } from "node:path";

export function createWebHandler(webRoot: string | undefined): (request: Request) => Promise<Response> {
  const root = webRoot ? resolve(webRoot) : undefined;

  return async (request) => {
    if (!root) return new Response("Web client is not configured.", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405 });
    const pathname = new URL(request.url).pathname;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return new Response("Not found.", { status: 404 });
    }
    const assetPath = resolve(root, `.${decodedPath}`);
    if (assetPath !== root && !assetPath.startsWith(`${root}${sep}`)) {
      return new Response("Not found.", { status: 404 });
    }
    if (assetPath.startsWith(`${root}${sep}assets${sep}`)) {
      const asset = Bun.file(assetPath);
      if (!await asset.exists()) return new Response("Not found.", { status: 404 });
      return new Response(asset);
    }
    if (assetPath !== root) {
      const file = Bun.file(assetPath);
      if (await file.exists()) return new Response(file);
    }
    return new Response(Bun.file(resolve(root, "index.html")));
  };
}
