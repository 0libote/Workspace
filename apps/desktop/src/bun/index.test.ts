import { expect, test } from "bun:test";
import { resolveServerUrl } from "./server-url";

test("desktop shell defaults to local self-hosted server and accepts a configured origin", () => {
  expect(resolveServerUrl(undefined)).toBe("http://127.0.0.1:3417");
  expect(resolveServerUrl("https://workspace.example.test")).toBe("https://workspace.example.test");
});

test("desktop shell rejects non-origin and unsafe server URLs", () => {
  for (const value of ["javascript:alert(1)", "https://user:pass@example.test", "https://example.test/workspace", "https://example.test?next=/"]) {
    expect(() => resolveServerUrl(value)).toThrow("ASTRYX_SERVER_URL");
  }
});
