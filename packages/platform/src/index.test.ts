import { expect, test } from "bun:test";
import { createWebPlatform, normalizeFileAccept, validateExternalUrl, type WebPlatformRuntime } from "./index";

test("external links accept web and mail URLs while rejecting script schemes", () => {
  expect(validateExternalUrl("https://example.test/path")).toBe("https://example.test/path");
  expect(validateExternalUrl("mailto:hello@example.test")).toBe("mailto:hello@example.test");
  expect(() => validateExternalUrl("javascript:alert(1)")).toThrow("Only HTTP, HTTPS, and mailto");
  expect(() => validateExternalUrl("/relative/path")).toThrow("absolute URLs");
});

test("file picker filters accept MIME types and extensions", () => {
  expect(normalizeFileAccept([" .md ", "text/plain", "image/*", ".md"])).toEqual([".md", "text/plain", "image/*"]);
  expect(() => normalizeFileAccept(["javascript:alert(1)"])).toThrow("extensions or MIME types");
});

test("browser file export creates a named download without shell access", async () => {
  let clicked = false;
  let revokedUrl = "";
  let downloadName = "";
  let downloadUrl = "";
  const anchor = {
    click() { clicked = true; },
    remove() {},
    set href(value: string) { downloadUrl = value; },
    set download(value: string) { downloadName = value; },
    set hidden(_value: boolean) {},
  } as unknown as HTMLAnchorElement;
  const runtime = {
    navigator: { onLine: true },
    document: { createElement: () => anchor, body: { append() {} } },
    URL: { createObjectURL: () => "blob:download", revokeObjectURL: (url: string) => { revokedUrl = url; } },
    Blob,
    window: { open() {} },
    setTimeout(callback: () => void) { return callback; },
  } as unknown as WebPlatformRuntime;
  const platform = createWebPlatform(runtime);
  await platform.saveFile("draft.json", "{}", "application/json");
  expect(clicked).toBe(true);
  expect(downloadName).toBe("draft.json");
  expect(downloadUrl).toBe("blob:download");
  await expect(platform.saveFile("../unsafe.json", "{}", "application/json")).rejects.toThrow("single file name");
  expect(revokedUrl).toBe("");
});
