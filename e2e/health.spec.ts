import { expect, test } from "@playwright/test";

test("server health endpoint reports a healthy application", async ({ page }) => {
  const response = await page.goto("/health");
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toContainText('"status":"ok"');
});
