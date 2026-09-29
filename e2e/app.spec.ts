import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(!process.env.DATABASE_URL_TEST, "Set DATABASE_URL_TEST to a disposable PostgreSQL database for authenticated UI coverage.");

test("sign in and create a node through the workspace interface", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /welcome back|make yourself at home/i })).toBeVisible();

  await page.getByLabel("Email address").fill("owner@node-workspace-e2e.invalid");
  await page.getByLabel("Password").fill("E2E-only-password-never-use-elsewhere");
  if (await page.getByRole("button", { name: "Create owner account" }).isVisible()) {
    await page.getByLabel("Your name").fill("Workspace E2E Owner");
    await page.getByLabel("Workspace name").fill("Workspace E2E");
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else {
    await page.getByRole("button", { name: "Sign in" }).click();
  }

  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  const originalWorkspaceId = await page.locator("#workspace-select").inputValue();
  const [workspaceDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export workspace JSON" }).click(),
  ]);
  expect(workspaceDownload.suggestedFilename()).toBe(`astryx-${originalWorkspaceId.slice(0, 8)}-export.json`);
  await page.getByRole("button", { name: "Workspace settings" }).click();
  const timeZoneDialog = page.getByRole("dialog", { name: "Time zone" });
  await timeZoneDialog.getByLabel("IANA time zone").fill("Mars/Olympus_Mons");
  await timeZoneDialog.getByRole("button", { name: "Save time zone" }).click();
  await expect(timeZoneDialog.getByRole("alert")).toContainText("valid IANA time zone");
  await timeZoneDialog.getByLabel("IANA time zone").fill("America/New_York");
  await timeZoneDialog.getByRole("button", { name: "Save time zone" }).click();
  await expect(timeZoneDialog).toHaveCount(0);
  const savedWorkspaceTimeZone = await page.evaluate(async (id) => {
    const workspaces = await fetch("/api/workspaces").then((response) => response.json()) as Array<{ id: string; timeZone: string }>;
    return workspaces.find((workspace) => workspace.id === id)?.timeZone;
  }, originalWorkspaceId);
  expect(savedWorkspaceTimeZone).toBe("America/New_York");
  const secondaryWorkspaceName = `Shared space ${Date.now()}`;
  await page.getByRole("button", { name: /new workspace/i }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "Create a workspace" });
  await workspaceDialog.getByLabel("Workspace name").fill(secondaryWorkspaceName);
  await workspaceDialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: secondaryWorkspaceName })).toBeVisible();
  const secondaryWorkspaceId = await page.locator("#workspace-select").inputValue();
  await page.locator("#workspace-select").selectOption(originalWorkspaceId);

  const title = `Browser item ${Date.now()}`;
  await page.getByLabel("Item title").fill(title);
  await page.getByRole("button", { name: "Add item" }).click();
  const item = page.getByRole("article").filter({ hasText: title });
  await expect(item).toBeVisible();
  const completionCheckbox = item.getByLabel(`Complete ${title}`);
  await completionCheckbox.check();
  await expect(item.getByLabel(`Status for ${title}`)).toHaveValue("Done");
  await completionCheckbox.uncheck();
  await expect(item.getByLabel(`Status for ${title}`)).toHaveValue("Todo");

  const scheduledTask = await page.evaluate(async ({ workspaceId, title }) => {
    const [nodes, definitions, session] = await Promise.all([
      fetch(`/api/search?workspaceId=${workspaceId}&query=${encodeURIComponent(title)}`).then((response) => response.json()) as Promise<{ items: Array<{ node: { id: string; title: string } }> }>,
      fetch(`/api/workspaces/${workspaceId}/properties`).then((response) => response.json()) as Promise<Array<{ id: string; name: string }>>,
      fetch("/api/auth/me").then((response) => response.json()) as Promise<{ csrfToken: string }>,
    ]);
    const node = nodes.items.find((result) => result.node.title === title)?.node;
    const startDate = definitions.find((definition) => definition.name === "Start date");
    if (!node || !startDate) throw new Error("could not find the task date property");
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const saved = await fetch(`/api/nodes/${node.id}/properties/${startDate.id}?workspaceId=${workspaceId}`, {
      method: "PUT", headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ value: { type: "date", value: date } }),
    });
    if (!saved.ok) throw new Error("could not schedule the test task");
    return { nodeId: node.id, date };
  }, { workspaceId: originalWorkspaceId, title });
  const scheduledNodeId = scheduledTask.nodeId;
  const schedulePageTitle = `Schedule notes ${Date.now()}`;
  await page.getByLabel("Item type", { exact: true }).selectOption("page");
  await page.getByLabel("Item title").fill(schedulePageTitle);
  await page.getByRole("button", { name: "Add item" }).click();
  const schedulePageRow = page.getByRole("article").filter({ hasText: schedulePageTitle });
  await schedulePageRow.getByRole("button", { name: "Open page" }).click();
  await page.getByRole("button", { name: "Connection type" }).click();
  const scheduleRelationDialog = page.getByRole("dialog", { name: "Add a connection type" });
  const scheduleRelationType = `schedules-${Date.now()}`;
  await scheduleRelationDialog.getByLabel("Type key").fill(scheduleRelationType);
  await scheduleRelationDialog.getByLabel("Label from this item").fill("tracks");
  await scheduleRelationDialog.getByLabel("Inverse label").fill("tracked by");
  await scheduleRelationDialog.getByRole("button", { name: "Add connection type" }).click();
  await page.getByLabel("Connection type", { exact: true }).selectOption(scheduleRelationType);
  await page.getByLabel("Connect to item").selectOption({ label: `${title} · task` });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(`Starts ${scheduledTask.date}`, { exact: false })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Back to items" }).click();
  let calendarMovedDate = "";
  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page.locator(".calendar-zone")).not.toContainText("Loading", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: title })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Times shown in America/New_York")).toBeVisible();
  const calendarMode = page.getByLabel("Calendar view");
  for (const mode of ["week", "day", "agenda", "month"] as const) {
    await calendarMode.selectOption(mode);
    await expect(page.locator(`.calendar-grid-${mode}`)).toBeVisible();
  }
  const moveDateField = page.getByLabel(`Move ${title} to date`);
  const currentDate = await moveDateField.inputValue();
  const rangeEnd = await page.evaluate((date) => {
    const end = new Date(`${date}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    return end.toISOString().slice(0, 10);
  }, currentDate);
  await page.getByLabel("Calendar range start").fill(currentDate);
  await page.getByLabel("Calendar range end").fill(rangeEnd);
  await page.getByRole("button", { name: "Apply range" }).click();
  await expect(page.getByRole("heading", { name: `${currentDate} – ${rangeEnd}` })).toBeVisible();
  const [icsDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export .ics" }).click(),
  ]);
  expect(icsDownload.suggestedFilename()).toMatch(/^astryx-calendar-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.ics$/);
  const icsPath = await icsDownload.path();
  expect(icsPath).not.toBeNull();
  expect(await readFile(icsPath!, "utf8")).toContain(`SUMMARY:${title}`);
  await expect(moveDateField).toHaveValue(currentDate);
  const nextDate = await page.evaluate((date) => {
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }, currentDate);
  await moveDateField.fill(nextDate);
  await expect(moveDateField).toHaveValue(nextDate);
  await expect(moveDateField).toBeEnabled();
  const dragTargetDate = await page.evaluate((date) => {
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }, nextDate);
  const dragTargetLabel = await page.evaluate((date) => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`)), dragTargetDate);
  const movedByDrop = page.waitForResponse((response) => response.url().includes(`/api/calendar/${scheduledNodeId}/move?`) && response.request().method() === "PATCH", { timeout: 10_000 });
  await page.getByRole("button", { name: title }).dragTo(page.getByRole("gridcell", { name: dragTargetLabel }), { targetPosition: { x: 30, y: 70 }, steps: 8 });
  expect((await movedByDrop).status()).toBe(200);
  await expect(moveDateField).toHaveValue(dragTargetDate);
  calendarMovedDate = dragTargetDate;
  const readMovedStartDate = () => page.evaluate(async ({ workspaceId, nodeId }) => {
    const properties = await fetch(`/api/nodes/${nodeId}/properties?workspaceId=${workspaceId}`).then((response) => response.json()) as Array<{ value: { type: string; value: unknown } }>;
    return properties.find((property) => property.value.type === "date")?.value.value;
  }, { workspaceId: originalWorkspaceId, nodeId: scheduledNodeId });
  await expect.poll(readMovedStartDate, { timeout: 10_000 }).toBe(calendarMovedDate);
  await page.getByRole("link", { name: "All items" }).click();
  await schedulePageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByText(`Starts ${calendarMovedDate}`, { exact: false })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("link", { name: "Calendar" }).click();
  const failedMoveDate = await page.evaluate((date) => {
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  }, calendarMovedDate);
  await page.route("**/api/calendar/*/move?*", async (route) => { await new Promise((resolve) => setTimeout(resolve, 100)); await route.abort(); });
  await moveDateField.fill(failedMoveDate);
  await expect(moveDateField).toHaveValue(failedMoveDate);
  await expect(moveDateField).toHaveValue(calendarMovedDate);
  await expect(page.locator(".calendar-view .notice[role='status']")).toBeVisible();
  await page.unroute("**/api/calendar/*/move?*");
  await page.getByRole("link", { name: "All items" }).click();

  await page.getByRole("button", { name: "New collection" }).click();
  const calendarCollectionDialog = page.getByRole("dialog", { name: "Create a collection" });
  const calendarCollectionName = `Calendar tasks ${Date.now()}`;
  await calendarCollectionDialog.getByLabel("Name").fill(calendarCollectionName);
  await calendarCollectionDialog.locator('input[name="types"][value="task"]').check();
  await calendarCollectionDialog.getByLabel("Title contains").fill(title);
  await calendarCollectionDialog.getByLabel("View").selectOption("calendar");
  await calendarCollectionDialog.getByRole("button", { name: "Create collection" }).click();
  await page.getByRole("button", { name: `Open collection: ${calendarCollectionName}` }).click();
  await expect(page.getByRole("button", { name: title })).toBeVisible();
  await expect(page.getByText("Times shown in America/New_York")).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await schedulePageRow.getByRole("button", { name: "Open page" }).click();
  await page.getByLabel("Calendar to insert").selectOption({ label: calendarCollectionName });
  await page.getByRole("button", { name: "Insert calendar" }).click();
  const embeddedCalendar = page.locator(".page-calendar-embed");
  await expect(embeddedCalendar.locator(".calendar-event").getByText(title)).toBeVisible({ timeout: 20_000 });
  const [embeddedMarkdownDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export Markdown" }).click(),
  ]);
  const embeddedMarkdownPath = await embeddedMarkdownDownload.path();
  expect(embeddedMarkdownPath).not.toBeNull();
  expect(await readFile(embeddedMarkdownPath!, "utf8")).toContain(`[Embedded calendar: ${calendarCollectionName}]`);
  await page.getByRole("button", { name: "Back to items" }).click();
  await schedulePageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.locator(".page-calendar-embed .calendar-event").getByText(title)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Back to items" }).click();

  await page.getByRole("button", { name: "New collection" }).click();
  const collectionDialog = page.getByRole("dialog", { name: "Create a collection" });
  const collectionName = `Browser tasks ${Date.now()}`;
  await collectionDialog.getByLabel("Name").fill(collectionName);
  await collectionDialog.locator('input[name="types"][value="task"]').check();
  await collectionDialog.getByLabel("Title contains").fill(title.slice(0, 12));
  await collectionDialog.getByLabel("View").selectOption("table");
  await collectionDialog.locator("label").filter({ hasText: "Status" }).getByRole("checkbox").check();
  await collectionDialog.getByRole("button", { name: "Create collection" }).click();
  await page.getByRole("button", { name: `Edit collection: ${collectionName}` }).click();
  const editCollectionDialog = page.getByRole("dialog", { name: "Edit collection" });
  const renamedCollection = `${collectionName} updated`;
  await editCollectionDialog.getByLabel("Name").fill(renamedCollection);
  await editCollectionDialog.getByLabel("Title contains").fill("Browser");
  await editCollectionDialog.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: `Open collection: ${renamedCollection}` }).click();
  const collectionRow = page.getByRole("row").filter({ hasText: title });
  await expect(collectionRow).toBeVisible();
  const collectionStatus = collectionRow.getByLabel(`${title} · Status`);
  await collectionStatus.selectOption("Done");
  await expect(collectionStatus).toHaveValue("Done");
  await collectionRow.getByRole("button", { name: `Open task: ${title}` }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByLabel("Status")).toHaveValue("Done");
  await page.getByRole("button", { name: "Back to items" }).click();
  await expect(page.getByRole("heading", { name: renamedCollection })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("button", { name: "New collection" }).click();
  const boardDialog = page.getByRole("dialog", { name: "Create a collection" });
  const boardName = `Browser task board ${Date.now()}`;
  await boardDialog.getByLabel("Name").fill(boardName);
  await boardDialog.locator('input[name="types"][value="task"]').check();
  await boardDialog.getByLabel("Title contains").fill(title.slice(0, 12));
  await boardDialog.getByLabel("View").selectOption("board");
  await boardDialog.getByRole("button", { name: "Create collection" }).click();
  await page.getByRole("button", { name: `Open collection: ${boardName}` }).click();
  await expect(page.locator(".collection-board-column h2")).toContainText("task");
  await expect(page.locator(".collection-board-card").filter({ hasText: title })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("button", { name: "New collection" }).click();
  const listDialog = page.getByRole("dialog", { name: "Create a collection" });
  const listName = `Browser task list ${Date.now()}`;
  await listDialog.getByLabel("Name").fill(listName);
  await listDialog.locator('input[name="types"][value="task"]').check();
  await listDialog.getByLabel("Title contains").fill(title.slice(-8));
  await listDialog.getByLabel("View").selectOption("list");
  await listDialog.getByRole("button", { name: "Create collection" }).click();
  await page.getByRole("button", { name: `Open collection: ${listName}` }).click();
  await expect(page.getByRole("list", { name: "Collection items" }).getByText(title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Delete collection: ${listName}` }).click();
  await expect(page.getByRole("button", { name: `Open collection: ${listName}` })).toHaveCount(0);

  const virtualPrefix = `Virtual row ${Date.now()} `;
  await page.evaluate(async ({ workspaceId, titlePrefix }) => {
    const session = await fetch("/api/auth/me").then((response) => response.json()) as { csrfToken: string };
    const responses = await Promise.all(Array.from({ length: 80 }, (_, index) => fetch("/api/nodes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ workspaceId, type: "task", title: `${titlePrefix}${String(index).padStart(3, "0")}` }),
    })));
    if (responses.some((response) => !response.ok)) throw new Error("could not prepare virtualized collection rows");
  }, { workspaceId: originalWorkspaceId, titlePrefix: virtualPrefix });
  await page.getByRole("button", { name: "New collection" }).click();
  const virtualDialog = page.getByRole("dialog", { name: "Create a collection" });
  const virtualName = `Virtualized collection ${Date.now()}`;
  await virtualDialog.getByLabel("Name").fill(virtualName);
  await virtualDialog.locator('input[name="types"][value="task"]').check();
  await virtualDialog.getByLabel("Title contains").fill(virtualPrefix);
  await virtualDialog.getByLabel("View").selectOption("table");
  await virtualDialog.getByLabel("Sort by").selectOption("title");
  await virtualDialog.getByRole("button", { name: "Create collection" }).click();
  await page.getByRole("button", { name: `Open collection: ${virtualName}` }).click();
  await page.getByRole("button", { name: "Load more collection items" }).click();
  await expect(page.getByRole("button", { name: "Load more collection items" })).toHaveCount(0);
  const virtualRows = page.getByRole("table", { name: "Collection table" }).getByRole("row");
  expect(await virtualRows.count()).toBeLessThan(50);
  const virtualScroll = page.locator(".collection-virtual-scroll");
  await virtualScroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
  await expect(virtualRows.filter({ hasText: `${virtualPrefix}000` })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("button", { name: `Edit collection: ${virtualName}` }).click();
  const editVirtualList = page.getByRole("dialog", { name: "Edit collection" });
  await editVirtualList.getByLabel("View").selectOption("list");
  await editVirtualList.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: `Open collection: ${virtualName}` }).click();
  const virtualList = page.getByRole("list", { name: "Collection items" });
  await page.getByRole("button", { name: "Load more collection items" }).click();
  expect(await virtualList.getByRole("listitem").count()).toBeLessThan(50);
  const virtualListScroll = page.locator(".collection-virtual-scroll");
  const lastVirtualListItem = virtualList.getByText(`${virtualPrefix}000`, { exact: true });
  await expect.poll(async () => {
    await virtualListScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    return lastVirtualListItem.count();
  }).toBe(1);
  await expect(lastVirtualListItem).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("button", { name: `Edit collection: ${virtualName}` }).click();
  const editVirtualBoard = page.getByRole("dialog", { name: "Edit collection" });
  await editVirtualBoard.getByLabel("View").selectOption("board");
  await editVirtualBoard.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: `Open collection: ${virtualName}` }).click();
  await page.getByRole("button", { name: "Load more collection items" }).click();
  const virtualBoard = page.getByRole("list", { name: "task collection items" });
  expect(await virtualBoard.getByRole("listitem").count()).toBeLessThan(50);
  const virtualBoardScroll = page.locator(".collection-virtual-scroll");
  await virtualBoardScroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
  await expect(virtualBoard.getByText(`${virtualPrefix}000`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();

  await item.getByRole("button", { name: "Open task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByLabel("Start date")).toHaveValue(calendarMovedDate);
  await page.getByLabel("Status").selectOption("Done");
  await expect(page.locator(".task-detail .document-save-state")).toContainText("Status saved");
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: "Open task" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("Done");
  const customPropertyName = `Effort note ${Date.now()}`;
  await page.getByRole("button", { name: /add property/i }).click();
  const propertyDialog = page.getByRole("dialog", { name: "Add a property" });
  await propertyDialog.getByLabel("Name").fill(customPropertyName);
  await propertyDialog.getByRole("button", { name: "Add property" }).click();
  const customProperty = page.getByLabel(customPropertyName);
  await customProperty.fill("Stored on the node");
  await customProperty.press("Tab");
  await expect(page.locator(".task-detail .document-save-state")).toContainText(`${customPropertyName} saved`);
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: "Open task" }).click();
  await expect(page.getByLabel(customPropertyName)).toHaveValue("Stored on the node");
  await page.locator("#workspace-select").selectOption(secondaryWorkspaceId);
  await expect(page.getByRole("heading", { name: secondaryWorkspaceName })).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toHaveCount(0);
  await page.locator("#workspace-select").selectOption(originalWorkspaceId);
  const searchBox = page.getByLabel("Search items and page content");
  await searchBox.fill(title);
  const searchedTask = page.getByRole("article").filter({ hasText: title });
  await expect(searchedTask).toBeVisible({ timeout: 15_000 });

  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(searchedTask).toContainText("task");
  await page.getByRole("link", { name: "Pages" }).click();
  await expect(page).toHaveURL(/#pages$/);
  await page.goBack();
  await expect(page).toHaveURL(/#tasks$/);
  await page.goForward();
  await expect(page).toHaveURL(/#pages$/);
  await page.getByRole("link", { name: "All items" }).click();
  await expect(page).toHaveURL(/#items$/);
  await searchedTask.getByRole("button", { name: `Archive ${title}` }).click();
  await expect(searchedTask).toHaveCount(0);
  await searchBox.fill("");
  const archive = page.locator("details.archive-section");
  await archive.locator("summary").click();
  const archivedItem = archive.getByRole("article").filter({ hasText: title });
  await expect(archivedItem).toBeVisible();
  await archivedItem.getByRole("button", { name: "Restore" }).click();
  await expect(item).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Choose workspace").nth(1)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  const mobileOverflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    elements: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 12)
      .map((element) => ({ tag: element.tagName, className: element.className, text: element.innerText.slice(0, 45), right: Math.round(element.getBoundingClientRect().right) })),
  }));
  expect(mobileOverflow.width, JSON.stringify(mobileOverflow)).toBeLessThanOrEqual(mobileOverflow.viewport);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByLabel("Item type", { exact: true }).selectOption("page");
  const pageTitle = `Browser page ${Date.now()}`;
  await page.getByLabel("Item title").fill(pageTitle);
  await page.getByRole("button", { name: "Add item" }).click();
  const pageRow = page.getByRole("article").filter({ hasText: pageTitle });
  await expect(pageRow).toBeVisible();
  await pageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByRole("heading", { name: pageTitle })).toBeVisible();
  await page.getByRole("button", { name: "Connection type" }).click();
  const connectionDialog = page.getByRole("dialog", { name: "Add a connection type" });
  const relationType = `references-${Date.now()}`;
  await connectionDialog.getByLabel("Type key").fill(relationType);
  await connectionDialog.getByLabel("Label from this item").fill("references");
  await connectionDialog.getByLabel("Inverse label").fill("is referenced by");
  await connectionDialog.getByRole("button", { name: "Add connection type" }).click();
  await page.getByLabel("Connection type", { exact: true }).selectOption(relationType);
  await page.getByLabel("Connect to item").selectOption({ label: `${title} · task` });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: title, exact: false })).toBeVisible();
  await expect(page.getByText(`Starts ${calendarMovedDate}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: title, exact: false }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("is referenced by")).toBeVisible();
  // Closing the linked task returns to the source page, then to the workspace list.
  await page.getByRole("button", { name: "Back to items" }).click();
  await expect(page.getByRole("heading", { name: pageTitle })).toBeVisible();
  await page.getByRole("button", { name: "Back to items" }).click();
  await pageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.getByRole("heading", { name: pageTitle })).toBeVisible();
  const editor = page.locator(".bn-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.insertText("Notes saved from the browser");
  await expect(page.locator(".page-detail-toolbar .document-save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  const [markdownDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export Markdown" }).click(),
  ]);
  expect(markdownDownload.suggestedFilename()).toBe(`${pageTitle.replace(/[^a-z0-9_-]+/gi, "-")}.md`);
  const markdownPath = await markdownDownload.path();
  expect(markdownPath).not.toBeNull();
  const exportedMarkdown = await readFile(markdownPath!, "utf8");
  expect(exportedMarkdown).toContain("Notes saved from the browser");
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.evaluate(async ({ title, workspaceId }) => {
    const results = await fetch(`/api/search?workspaceId=${encodeURIComponent(workspaceId)}&query=${encodeURIComponent(title)}`).then((response) => response.json()) as { items: Array<{ node: { id: string; title: string } }> };
    const node = results.items.find((item) => item.node.title === title)?.node;
    if (!node) throw new Error("page node missing from workspace list");
    const document = await fetch(`/api/nodes/${node.id}/document?workspaceId=${encodeURIComponent(workspaceId)}`).then((response) => response.json()) as { revision: number; content: unknown[] };
    const serialized = JSON.stringify(document.content);
    if (!serialized.includes("Notes saved from the browser")) throw new Error("expected persisted page content");
    const content = JSON.parse(serialized.replace("Notes saved from the browser", "Recovered local draft")) as unknown[];
    localStorage.setItem(`commonplace:page-draft:${workspaceId}:${node.id}`, JSON.stringify({ baseRevision: document.revision, content, savedAt: new Date().toISOString() }));
    return true;
  }, { title: pageTitle, workspaceId: originalWorkspaceId });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  await page.getByLabel("Search items and page content").fill(pageTitle);
  const recoveredPageRow = page.getByRole("article").filter({ hasText: pageTitle });
  await expect(recoveredPageRow).toBeVisible();
  await recoveredPageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.locator(".bn-editor")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".bn-editor")).toContainText("Recovered local draft", { timeout: 20_000 });
  await expect(page.locator(".page-detail-toolbar .document-save-state")).toHaveText("All changes saved", { timeout: 10_000 });
  const recoveredEditor = page.locator(".bn-editor[contenteditable='true']");
  await page.context().setOffline(true);
  await recoveredEditor.click();
  await page.keyboard.insertText(" Offline edit");
  await expect(page.locator(".page-detail-toolbar .document-save-state")).toHaveText("Save needs attention", { timeout: 10_000 });
  await page.context().setOffline(false);
  await expect(page.locator(".page-detail-toolbar .document-save-state")).toHaveText("All changes saved", { timeout: 15_000 });
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByRole("article").filter({ hasText: pageTitle }).getByRole("button", { name: "Open page" }).click();
  await expect(page.locator(".bn-editor")).toContainText("Recovered local draft Offline edit");
  await page.getByRole("button", { name: "Back to items" }).click();
  await page.getByLabel("Search items and page content").fill("Recovered local draft");
  const contentSearchResult = page.getByRole("article").filter({ hasText: pageTitle });
  await expect(contentSearchResult).toContainText("matched content");
  await contentSearchResult.getByRole("button", { name: "Open page" }).click();
  await expect(page.locator(".bn-editor")).toContainText("Recovered local draft Offline edit");
  await page.evaluate(async ({ title, workspaceId }) => {
    const session = await fetch("/api/auth/me").then((response) => response.json()) as { csrfToken: string };
    const search = await fetch(`/api/search?workspaceId=${encodeURIComponent(workspaceId)}&query=${encodeURIComponent(title)}`).then((response) => response.json()) as { items: Array<{ node: { id: string } }> };
    const nodeId = search.items[0]?.node.id;
    if (!nodeId) throw new Error("page missing before concurrent edit");
    const path = `/api/nodes/${nodeId}/document?workspaceId=${encodeURIComponent(workspaceId)}`;
    const document = await fetch(path).then((response) => response.json()) as { revision: number; content: unknown[] };
    const concurrentContent = JSON.parse(JSON.stringify(document.content).replace("Recovered local draft", "Remote concurrent edit")) as unknown[];
    const saved = await fetch(path, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ expectedRevision: document.revision, content: concurrentContent }),
    });
    if (!saved.ok) throw new Error("could not save concurrent server edit");
  }, { title: pageTitle, workspaceId: originalWorkspaceId });
  await page.locator(".bn-editor[contenteditable='true']").click();
  await page.keyboard.insertText(" Local concurrent edit");
  await expect(page.locator(".page-detail-toolbar .document-save-state")).toHaveText("Save needs attention", { timeout: 10_000 });
  await expect(page.getByRole("alert")).toContainText("changed in another session");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  await page.getByLabel("Search items and page content").fill(pageTitle);
  const conflictedPageRow = page.getByRole("article").filter({ hasText: pageTitle });
  await expect(conflictedPageRow).toBeVisible();
  await conflictedPageRow.getByRole("button", { name: "Open page" }).click();
  await expect(page.locator(".bn-editor")).toContainText("Remote concurrent edit");
  const preservedDraft = page.locator(".draft-recovery");
  await expect(preservedDraft).toContainText("Local draft preserved");
  const [conflictDraftDownload] = await Promise.all([
    page.waitForEvent("download"),
    preservedDraft.getByRole("button", { name: "Download draft" }).click(),
  ]);
  const conflictDraftPath = await conflictDraftDownload.path();
  expect(conflictDraftPath).not.toBeNull();
  expect(await readFile(conflictDraftPath!, "utf8")).toContain("Local concurrent edit");
});

test("create and reopen an Excalidraw canvas from the workspace interface", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByLabel("Email address").fill("owner@node-workspace-e2e.invalid");
  await page.getByLabel("Password").fill("E2E-only-password-never-use-elsewhere");
  if (await page.getByRole("button", { name: "Create owner account" }).isVisible()) {
    await page.getByLabel("Your name").fill("Workspace E2E Owner");
    await page.getByLabel("Workspace name").fill("Workspace E2E");
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else {
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  const title = `Canvas ${Date.now()}`;
  await page.getByLabel("Item type", { exact: true }).selectOption("canvas");
  await page.getByLabel("Item title").fill(title);
  await page.getByRole("button", { name: "Add item" }).click();
  const row = page.getByRole("article").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Open canvas" }).click();
  await expect(page.getByRole("region", { name: "Canvas editor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export .excalidraw" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Node link" })).toBeVisible();
  await expect(page.locator(".canvas-toolbar [role=status]")).toHaveText("Saved", { timeout: 20_000 });
});

test("explore a focused workspace graph", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByLabel("Email address").fill("owner@node-workspace-e2e.invalid");
  await page.getByLabel("Password").fill("E2E-only-password-never-use-elsewhere");
  if (await page.getByRole("button", { name: "Create owner account" }).isVisible()) {
    await page.getByLabel("Your name").fill("Workspace E2E Owner");
    await page.getByLabel("Workspace name").fill("Workspace E2E");
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else {
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Everything in one place" })).toBeVisible();
  const title = `Graph node ${Date.now()}`;
  await page.getByLabel("Item type", { exact: true }).selectOption("task");
  await page.getByLabel("Item title").fill(title);
  await page.getByRole("button", { name: "Add item" }).click();
  const node = await page.evaluate(async (nodeTitle) => {
    const workspaceId = (document.querySelector("#workspace-select") as HTMLSelectElement).value;
    const response = await fetch(`/api/search?workspaceId=${workspaceId}&query=${encodeURIComponent(nodeTitle)}&type=task`);
    const data = await response.json() as { items: Array<{ node: { id: string; title: string } }> };
    return data.items[0]?.node;
  }, title);
  expect(node?.title).toBe(title);
  await page.getByRole("link", { name: "Graph" }).click();
  const graph = page.getByRole("region", { name: "Workspace graph" });
  await expect(graph).toBeVisible();
  await graph.locator("#graph-root").selectOption(node!.id);
  await expect(graph.getByRole("img", { name: "Relationship links between workspace nodes" })).toBeVisible();
  await expect(graph.locator(".graph-node-actions")).toContainText(title);
});
