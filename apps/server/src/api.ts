import type { SQL } from "bun";
import { EMPTY_CANVAS_SCENE, validateCanvasBindings, validateCanvasScene } from "@workspace/canvas";
import {
  createNode,
  createMembership,
  createRelation,
  createUser,
  createWorkspace,
  DomainError,
  PROPERTY_TYPES,
  type MembershipRole,
  type CollectionQuery,
  type NodeId,
  type WorkspaceNode,
  type NodeType,
  type PropertyDefinition,
  type PropertyDefinitionId,
  type PropertyType,
  type RelationDefinition,
  type RelationDefinitionId,
  type NodeRelation,
  validatePropertyValue,
  validateNodeDocumentContent,
  createSavedCollection,
  updateSavedCollection,
  type UserId,
  type WorkspaceId,
  type SavedCollectionId,
  type PropertyValue,
} from "@workspace/domain";
import {
  PostgresCalendarRepository,
  PostgresNodeCanvasRepository,
  PostgresWorkspaceExportRepository,
  PostgresWorkspaceGraphRepository,
  PostgresNodeDocumentRepository,
  PostgresWorkspaceRepository,
  PostgresSavedCollectionRepository,
  PostgresNodeTypeDefinitionRepository,
  PostgresNodeRepository,
  PostgresNodePropertyRepository,
  PostgresPropertyDefinitionRepository,
  PostgresNodeRelationRepository,
  PostgresRelationDefinitionRepository,
} from "@workspace/db";
import { formatInstantInTimeZone, projectNodeSchedule, resolveLocalDateTime, serializeCalendarIcs, startOfLocalDate, type CalendarEvent, type ScheduleDateValue } from "@workspace/calendar";
import {
  createSecretToken,
  expiredSessionCookie,
  findSession,
  persistSession,
  sessionCookie,
  validCsrfToken,
  type AuthenticatedSession,
} from "./auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dummyPasswordHash = { value: undefined as Promise<string> | undefined };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request, maxBytes = 1_048_576): Promise<JsonRecord> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) throw new HttpError(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new HttpError(400, "invalid_json"); }
  if (!isJsonRecord(value)) throw new HttpError(400, "invalid_json");
  return value;
}

function requiredString(record: JsonRecord, key: string, maxLength = 256): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > maxLength) throw new HttpError(400, `invalid_${key}`);
  return value;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function jsonError(status: number, code: string): Response {
  return json({ error: code }, status);
}

function addSessionCookie(response: Response, request: Request, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", sessionCookie(request, token));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function addExpiredCookie(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", expiredSessionCookie(request));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function requireSession(database: SQL, request: Request): Promise<AuthenticatedSession> {
  const session = await findSession(database, request);
  if (!session) throw new HttpError(401, "unauthorized");
  return session;
}

function requireCsrf(session: AuthenticatedSession, request: Request): void {
  if (!validCsrfToken(session, request)) throw new HttpError(403, "csrf_validation_failed");
}

function scheduleValue(dateTime: string | undefined, date: string | undefined): ScheduleDateValue | null {
  if (dateTime) return { type: "dateTime", value: dateTime };
  if (date) return { type: "date", value: date };
  return null;
}

async function requireWorkspaceRole(
  database: SQL,
  workspaceId: WorkspaceId,
  userId: UserId,
  required: "read" | "write",
): Promise<MembershipRole> {
  const rows = await database<{ role: MembershipRole }[]>`
    SELECT membership.role
    FROM workspace_memberships AS membership
    JOIN workspaces ON workspaces.id = membership.workspace_id
    WHERE membership.workspace_id = ${workspaceId}::uuid
      AND membership.user_id = ${userId}::uuid
      AND workspaces.archived_at IS NULL
  `;
  const role = rows[0]?.role;
  if (!role || required === "write" && role === "viewer") throw new HttpError(404, "workspace_not_found");
  return role;
}

function pathUuid(value: string | undefined): string {
  if (!value || !uuidPattern.test(value)) throw new HttpError(404, "not_found");
  return value;
}

async function setupStatus(database: SQL): Promise<Response> {
  const rows = await database<{ setup_required: boolean }[]>`
    SELECT NOT EXISTS (SELECT 1 FROM app_users) AS setup_required
  `;
  return json({ setupRequired: rows[0]?.setup_required ?? true });
}

async function insertDefaultTaskProperties(database: SQL, workspaceId: WorkspaceId): Promise<void> {
  const definitions = [
    { name: "Status", type: "status", options: ["Todo", "In progress", "Done"] },
    { name: "Priority", type: "select", options: ["Low", "Normal", "High", "Urgent"] },
    { name: "Start date", type: "date" },
    { name: "Due date", type: "date" },
    { name: "Start time", type: "dateTime" },
    { name: "Due time", type: "dateTime" },
    { name: "Duration", type: "duration" },
  ] as const;
  for (const definition of definitions) {
    const options = "options" in definition ? { values: definition.options } : null;
    await database`
      INSERT INTO property_definitions (id, workspace_id, name, property_type, required, options)
      VALUES (
        ${crypto.randomUUID()}::uuid, ${workspaceId}::uuid, ${definition.name}, ${definition.type},
        FALSE, (${options}::jsonb -> 'values')
      )
    `;
  }
}

async function setup(request: Request, database: SQL): Promise<Response> {
  const input = await readJson(request);
  const email = requiredString(input, "email", 320);
  const password = requiredString(input, "password", 256);
  const displayName = requiredString(input, "displayName", 120);
  const workspaceName = requiredString(input, "workspaceName", 120);
  if (password.length < 12) throw new HttpError(400, "password_too_short");
  const existingUsers = await database<{ setup_required: boolean }[]>`
    SELECT NOT EXISTS (SELECT 1 FROM app_users) AS setup_required
  `;
  if (!existingUsers[0]?.setup_required) throw new HttpError(409, "setup_already_complete");

  const now = new Date();
  const nowIso = now.toISOString();
  const user = createUser({ id: crypto.randomUUID() as UserId, email, displayName, now: nowIso });
  const workspace = createWorkspace({
    id: crypto.randomUUID() as WorkspaceId,
    name: workspaceName,
    ...(typeof input.timeZone === "string" ? { timeZone: input.timeZone } : {}),
    now: nowIso,
  });
  const membership = createMembership(workspace.id, user.id, "owner", nowIso);
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const token = createSecretToken();
  const csrfToken = createSecretToken();

  const created = await database.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('node-workspace:initial-setup', 0))`;
    const rows = await transaction<{ setup_required: boolean }[]>`
      SELECT NOT EXISTS (SELECT 1 FROM app_users) AS setup_required
    `;
    if (!rows[0]?.setup_required) return false;

    await transaction`
      INSERT INTO app_users (id, email, display_name, created_at)
      VALUES (${user.id}::uuid, ${user.email}, ${user.displayName}, ${user.createdAt}::timestamptz)
    `;
    await transaction`
      INSERT INTO user_credentials (user_id, password_hash, created_at, updated_at)
      VALUES (${user.id}::uuid, ${passwordHash}, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
    `;
    await transaction`
      INSERT INTO workspaces (id, name, time_zone, created_at, updated_at)
      VALUES (${workspace.id}::uuid, ${workspace.name}, ${workspace.timeZone}, ${workspace.createdAt}::timestamptz, ${workspace.updatedAt}::timestamptz)
    `;
    await insertDefaultTaskProperties(transaction, workspace.id);
    await transaction`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
      VALUES (${membership.workspaceId}::uuid, ${membership.userId}::uuid, ${membership.role}, ${membership.joinedAt}::timestamptz)
    `;
    await persistSession(transaction, user.id, token, csrfToken, now);
    return true;
  });

  if (!created) throw new HttpError(409, "setup_already_complete");
  return addSessionCookie(json({ user, workspace, csrfToken }, 201), request, token);
}

async function login(request: Request, database: SQL): Promise<Response> {
  const input = await readJson(request);
  const email = requiredString(input, "email", 320).trim().toLowerCase();
  const password = requiredString(input, "password", 256);
  const rows = await database<{
    id: string;
    email: string;
    display_name: string;
    created_at: Date | string;
    password_hash: string;
  }[]>`
    SELECT app_users.id, app_users.email, app_users.display_name, app_users.created_at, user_credentials.password_hash
    FROM app_users
    JOIN user_credentials ON user_credentials.user_id = app_users.id
    WHERE app_users.email = ${email} AND app_users.deactivated_at IS NULL
  `;
  const row = rows[0];
  if (!row) {
    dummyPasswordHash.value ??= Bun.password.hash("workspace-invalid-login-sentinel", { algorithm: "argon2id" });
    await Bun.password.verify(password, await dummyPasswordHash.value);
    throw new HttpError(401, "invalid_credentials");
  }
  if (!await Bun.password.verify(password, row.password_hash)) throw new HttpError(401, "invalid_credentials");

  const token = createSecretToken();
  const csrfToken = createSecretToken();
  const now = new Date();
  const session = await persistSession(database, row.id as UserId, token, csrfToken, now);
  const user = {
    id: row.id as UserId,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
  return addSessionCookie(json({ user, csrfToken, expiresAt: session.expiresAt }), request, token);
}

async function logout(request: Request, database: SQL, session: AuthenticatedSession): Promise<Response> {
  requireCsrf(session, request);
  await database`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ${session.id}::uuid`;
  return addExpiredCookie(new Response(null, { status: 204 }), request);
}

async function listWorkspaces(database: SQL, session: AuthenticatedSession): Promise<Response> {
  const rows = await database<{
    id: string;
    name: string;
    created_at: Date | string;
    updated_at: Date | string;
    time_zone: string;
    role: MembershipRole;
  }[]>`
    SELECT workspaces.id, workspaces.name, workspaces.time_zone, workspaces.created_at, workspaces.updated_at, membership.role
    FROM workspace_memberships AS membership
    JOIN workspaces ON workspaces.id = membership.workspace_id
    WHERE membership.user_id = ${session.user.id}::uuid AND workspaces.archived_at IS NULL
    ORDER BY workspaces.created_at, workspaces.id
  `;
  return json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    role: row.role,
  })));
}

async function exportWorkspace(request: Request, database: SQL, session: AuthenticatedSession, workspaceId: WorkspaceId): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
  const snapshot = await new PostgresWorkspaceExportRepository(database).exportWorkspace(workspaceId, new Date().toISOString());
  if (!snapshot) throw new HttpError(404, "workspace_not_found");
  return new Response(JSON.stringify(snapshot), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="astryx-workspace-export.json"',
      "cache-control": "no-store",
    },
  });
}

async function updateWorkspaceSettings(
  request: Request,
  database: SQL,
  session: AuthenticatedSession,
  workspaceId: WorkspaceId,
): Promise<Response> {
  requireCsrf(session, request);
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const input = await readJson(request);
  const updated = await new PostgresWorkspaceRepository(database).updateTimeZone(
    workspaceId,
    requiredString(input, "timeZone", 100),
    new Date().toISOString(),
  );
  return updated ? json(updated) : jsonError(404, "workspace_not_found");
}

async function createWorkspaceForSession(request: Request, database: SQL, session: AuthenticatedSession): Promise<Response> {
  requireCsrf(session, request);
  const input = await readJson(request);
  const now = new Date().toISOString();
  const workspace = createWorkspace({
    id: crypto.randomUUID() as WorkspaceId,
    name: requiredString(input, "name", 120),
    ...(typeof input.timeZone === "string" ? { timeZone: input.timeZone } : {}),
    now,
  });
  const membership = createMembership(workspace.id, session.user.id, "owner", now);
  await database.begin(async (transaction) => {
    await transaction`
      INSERT INTO workspaces (id, name, time_zone, created_at, updated_at)
      VALUES (${workspace.id}::uuid, ${workspace.name}, ${workspace.timeZone}, ${workspace.createdAt}::timestamptz, ${workspace.updatedAt}::timestamptz)
    `;
    await insertDefaultTaskProperties(transaction, workspace.id);
    await transaction`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
      VALUES (${membership.workspaceId}::uuid, ${membership.userId}::uuid, ${membership.role}, ${membership.joinedAt}::timestamptz)
    `;
  });
  return json(workspace, 201);
}

async function createWorkspaceNode(request: Request, database: SQL, session: AuthenticatedSession): Promise<Response> {
  requireCsrf(session, request);
  const input = await readJson(request);
  const workspaceId = requiredString(input, "workspaceId") as WorkspaceId;
  if (!uuidPattern.test(workspaceId)) throw new HttpError(400, "invalid_workspace_id");
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const type = requiredString(input, "type", 80) as NodeType;
  const registeredTypes = await new PostgresNodeTypeDefinitionRepository(database).getForWorkspace(workspaceId);
  const node = createNode({
    id: crypto.randomUUID() as NodeId,
    workspaceId,
    type,
    title: requiredString(input, "title", 500),
    actorId: session.user.id,
    now: new Date().toISOString(),
    registeredTypes,
  });
  const created = await new PostgresNodeRepository(database).create(node);
  return json(created, 201);
}

async function listWorkspaceNodes(url: URL, database: SQL, session: AuthenticatedSession): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, "read");

  const rawLimit = url.searchParams.get("limit") ?? "50";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_page_size");
  const after = url.searchParams.get("after");
  if (after && !uuidPattern.test(after)) throw new HttpError(400, "invalid_cursor");
  const type = url.searchParams.get("type");
  if (type && !/^[a-z][a-z0-9_-]*$/.test(type)) throw new HttpError(400, "invalid_node_type");

  const page = await new PostgresNodeRepository(database).listByWorkspace(workspaceId, {
    limit,
    ...(after ? { afterId: after as NodeId } : {}),
    ...(type ? { type: type as NodeType } : {}),
  });
  if (url.searchParams.get("includeTaskStatus") === "true") {
    const definitions = await new PostgresPropertyDefinitionRepository(database).getForWorkspace(workspaceId);
    const statusDefinition = definitions.find((definition) => definition.name === "Status" &&
      (definition.type === "status" || definition.type === "select"));
    if (!statusDefinition) return json({ ...page, taskStatusDefinition: null, taskStatuses: [] });
    const taskNodes = page.items.filter((node) => node.type === "task");
    const properties = await new PostgresNodePropertyRepository(database).getForNodes(
      workspaceId,
      taskNodes.map((node) => node.id),
      statusDefinition.id,
    );
    const valueByNodeId = new Map(properties.map((property) => [property.nodeId, property.value.value]));
    return json({
      ...page,
      taskStatusDefinition: {
        id: statusDefinition.id,
        type: statusDefinition.type,
        options: statusDefinition.options ?? [],
      },
      taskStatuses: taskNodes.map((node) => {
        const value = valueByNodeId.get(node.id);
        return { nodeId: node.id, value: typeof value === "string" ? value : null };
      }),
    });
  }
  return json(page);
}

function calendarDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

async function calendarRange(url: URL, database: SQL, session: AuthenticatedSession): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
  const from = calendarDate(url.searchParams.get("from"));
  const to = calendarDate(url.searchParams.get("to"));
  if (!from || !to || from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 62 * 86_400_000) {
    throw new HttpError(400, "invalid_calendar_range");
  }
  const workspace = await new PostgresWorkspaceRepository(database).getById(workspaceId);
  if (!workspace) throw new HttpError(404, "workspace_not_found");
  const collectionIdValue = url.searchParams.get("collectionId");
  let collectionQuery: CollectionQuery | undefined;
  if (collectionIdValue !== null) {
    if (!uuidPattern.test(collectionIdValue)) throw new HttpError(400, "invalid_collection_id");
    const collection = await new PostgresSavedCollectionRepository(database).getById(workspaceId, collectionIdValue as SavedCollectionId);
    if (!collection) throw new HttpError(404, "collection_not_found");
    collectionQuery = collection.query;
  }
  const toExclusive = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = await new PostgresCalendarRepository(database).listRange(workspaceId, {
    dateFrom: from,
    dateToExclusive: toExclusive,
    instantFrom: startOfLocalDate(from, workspace.timeZone),
    instantTo: startOfLocalDate(toExclusive, workspace.timeZone),
    ...(collectionQuery ? { collectionQuery } : {}),
  });
  const startDefinition = (await new PostgresPropertyDefinitionRepository(database).getForWorkspace(workspaceId))
    .find((definition) => definition.name === "Start date" && (definition.type === "date" || definition.type === "dateTime"));
  const events = rows.flatMap(({ node, properties }) => {
    const start = properties["Start time"] ?? properties["Start date"];
    const due = properties["Due time"] ?? properties["Due date"];
    const duration = properties.Duration;
    const asDateValue = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value) || !("value" in value)) return null;
      const { type, value: raw } = value as { type: unknown; value: unknown };
      return (type === "date" || type === "dateTime") && typeof raw === "string" ? { type, value: raw } as const : null;
    };
    const schedule = projectNodeSchedule({
      start: asDateValue(start),
      due: asDateValue(due),
      durationMinutes: typeof duration === "object" && duration !== null && "value" in duration &&
        typeof (duration as { value?: unknown }).value === "number" ? (duration as { value: number }).value : null,
    });
    return schedule && schedule.kind !== "invalid" ? [{ node, schedule }] : [];
  });
  return json({
    events,
    truncated: rows.length === 500,
    startProperty: startDefinition ? { id: startDefinition.id, type: startDefinition.type } : null,
  });
}

async function calendarIcs(request: Request, url: URL, database: SQL, session: AuthenticatedSession): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  const jsonUrl = new URL(url);
  jsonUrl.pathname = "/api/calendar";
  const response = await calendarRange(jsonUrl, database, session);
  if (!response.ok) return response;
  const body = await response.json() as { readonly events: readonly CalendarEvent[] };
  const from = url.searchParams.get("from")!;
  const to = url.searchParams.get("to")!;
  return new Response(serializeCalendarIcs(body.events), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="astryx-calendar-${from}-${to}.ics"`,
      "cache-control": "no-store",
    },
  });
}

function shiftCalendarDate(date: string, offset: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offset);
  return shifted.toISOString().slice(0, 10);
}

function calendarDayOffset(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

async function moveCalendarNode(request: Request, url: URL, database: SQL, session: AuthenticatedSession, nodeId: NodeId): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  requireCsrf(session, request);
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const input = await readJson(request);
  const targetDate = calendarDate(typeof input.date === "string" ? input.date : null);
  if (!targetDate) throw new HttpError(400, "invalid_calendar_date");
  const node = await new PostgresNodeRepository(database).getById(workspaceId, nodeId);
  if (!node || node.archivedAt) throw new HttpError(404, "node_not_found");
  const workspace = await new PostgresWorkspaceRepository(database).getById(workspaceId);
  if (!workspace) throw new HttpError(404, "workspace_not_found");
  const definitions = await new PostgresPropertyDefinitionRepository(database).getForWorkspace(workspaceId);
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const current = await new PostgresNodePropertyRepository(database).getForNode(workspaceId, nodeId);
  const propertyByName = new Map(current.map((property) => [property.definitionId, property.value]));
  const propertyNamed = (name: string) => {
    const definition = definitionByName.get(name);
    return definition ? propertyByName.get(definition.id) : undefined;
  };
  const valueAsDate = (value: PropertyValue | undefined, type: "date" | "dateTime"): string | undefined =>
    value?.type === type ? value.value : undefined;
  const startDate = valueAsDate(propertyNamed("Start date"), "date");
  const dueDate = valueAsDate(propertyNamed("Due date"), "date");
  const startTime = valueAsDate(propertyNamed("Start time"), "dateTime");
  const dueTime = valueAsDate(propertyNamed("Due time"), "dateTime");
  const durationValue = propertyNamed("Duration");
  const schedule = projectNodeSchedule({
    start: scheduleValue(startTime, startDate),
    due: scheduleValue(dueTime, dueDate),
    durationMinutes: durationValue?.type === "duration" ? durationValue.value : null,
  });
  if (!schedule || schedule.kind === "invalid") throw new HttpError(409, "node_not_scheduled");

  const updates = new Map<PropertyDefinitionId, PropertyValue>();
  const addUpdate = (name: string, value: PropertyValue) => {
    const definition = definitionByName.get(name);
    if (definition && definition.type === value.type) updates.set(definition.id, value);
  };
  if (schedule.kind === "allDay") {
    const dayOffset = calendarDayOffset(schedule.startDate, targetDate);
    if (startDate !== undefined) addUpdate("Start date", { type: "date", value: targetDate });
    if (dueDate !== undefined) addUpdate("Due date", { type: "date", value: shiftCalendarDate(dueDate, dayOffset) });
    if (startDate === undefined && dueDate !== undefined) addUpdate("Due date", { type: "date", value: targetDate });
  } else {
    const originalStart = startTime ?? dueTime;
    if (!originalStart) throw new HttpError(409, "calendar_time_property_missing");
    const originalStartLocal = formatInstantInTimeZone(originalStart, workspace.timeZone);
    const newStart = resolveLocalDateTime(`${targetDate}T${originalStartLocal.slice(11)}`, workspace.timeZone);
    if (newStart.kind === "nonexistent") throw new HttpError(400, "nonexistent_local_time");
    if (startTime !== undefined) {
      addUpdate("Start time", { type: "dateTime", value: newStart.instant });
      if (startDate !== undefined) addUpdate("Start date", { type: "date", value: targetDate });
    }
    if (startTime === undefined && dueTime !== undefined) {
      addUpdate("Due time", { type: "dateTime", value: newStart.instant });
      if (dueDate !== undefined) addUpdate("Due date", { type: "date", value: targetDate });
    } else if (dueTime !== undefined) {
      const dueLocal = formatInstantInTimeZone(dueTime, workspace.timeZone);
      const dueDateTarget = shiftCalendarDate(targetDate, calendarDayOffset(originalStartLocal.slice(0, 10), dueLocal.slice(0, 10)));
      const newDue = resolveLocalDateTime(`${dueDateTarget}T${dueLocal.slice(11)}`, workspace.timeZone);
      if (newDue.kind === "nonexistent") throw new HttpError(400, "nonexistent_local_time");
      addUpdate("Due time", { type: "dateTime", value: newDue.instant });
      if (dueDate !== undefined) addUpdate("Due date", { type: "date", value: dueDateTarget });
    }
  }
  if (updates.size === 0) throw new HttpError(409, "calendar_property_missing");
  await database.begin(async (transaction) => {
    for (const [definitionId, value] of updates) {
      await transaction`
        INSERT INTO node_properties (workspace_id, node_id, property_definition_id, value_type, value)
        VALUES (${workspaceId}::uuid, ${nodeId}::uuid, ${definitionId}::uuid, ${value.type}, ${value}::jsonb)
        ON CONFLICT (node_id, property_definition_id) DO UPDATE
        SET value_type = EXCLUDED.value_type, value = EXCLUDED.value
      `;
    }
  });
  const moved = await new PostgresNodePropertyRepository(database).getForNode(workspaceId, nodeId);
  const movedByName = new Map(moved.map((property) => [property.definitionId, property.value]));
  const movedValue = (name: string) => {
    const definition = definitionByName.get(name);
    return definition ? movedByName.get(definition.id) : undefined;
  };
  const movedStartTime = valueAsDate(movedValue("Start time"), "dateTime");
  const movedDueTime = valueAsDate(movedValue("Due time"), "dateTime");
  const movedStartDate = valueAsDate(movedValue("Start date"), "date");
  const movedDueDate = valueAsDate(movedValue("Due date"), "date");
  const movedDuration = movedValue("Duration");
  const movedSchedule = projectNodeSchedule({
    start: scheduleValue(movedStartTime, movedStartDate),
    due: scheduleValue(movedDueTime, movedDueDate),
    durationMinutes: movedDuration?.type === "duration" ? movedDuration.value : null,
  });
  return json({ node, schedule: movedSchedule });
}

async function searchWorkspaceNodes(url: URL, database: SQL, session: AuthenticatedSession): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
  const query = (url.searchParams.get("query") ?? "").trim();
  if (query.length < 2 || query.length > 200) throw new HttpError(400, "invalid_search_query");
  const typeValue = url.searchParams.get("type");
  if (typeValue && !/^[a-z][a-z0-9_-]*$/.test(typeValue)) throw new HttpError(400, "invalid_node_type");
  const rawPage = url.searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new HttpError(400, "invalid_page");
  return json(await new PostgresNodeRepository(database).searchByWorkspace(workspaceId, {
    query,
    ...(typeValue ? { type: typeValue as NodeType } : {}),
    page,
    pageSize: 20,
  }));
}

async function workspaceGraph(url: URL, database: SQL, session: AuthenticatedSession): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
  const nodeIdValue = url.searchParams.get("nodeId");
  if (nodeIdValue && !uuidPattern.test(nodeIdValue)) throw new HttpError(400, "invalid_node_id");
  if (nodeIdValue) {
    const node = await new PostgresNodeRepository(database).getById(workspaceId, nodeIdValue as NodeId);
    if (!node || node.archivedAt) throw new HttpError(404, "node_not_found");
  }
  const depthValue = url.searchParams.get("depth") ?? "1";
  if (depthValue !== "1" && depthValue !== "2") throw new HttpError(400, "invalid_graph_depth");
  const limitValue = url.searchParams.get("limit") ?? "100";
  if (!/^\d{1,3}$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 250) throw new HttpError(400, "invalid_graph_limit");
  return json(await new PostgresWorkspaceGraphRepository(database).query({
    workspaceId,
    nodeId: nodeIdValue ? nodeIdValue as NodeId : undefined,
    depth: Number(depthValue) as 1 | 2,
    limit: Number(limitValue),
  }));
}

async function workspacePropertyDefinitions(
  request: Request,
  database: SQL,
  session: AuthenticatedSession,
  workspaceId: WorkspaceId,
): Promise<Response> {
  const repository = new PostgresPropertyDefinitionRepository(database);
  if (request.method === "GET") {
    await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
    return json(await repository.getForWorkspace(workspaceId));
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireCsrf(session, request);
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const input = await readJson(request);
  const propertyType = requiredString(input, "type", 32);
  if (!PROPERTY_TYPES.includes(propertyType as PropertyType)) throw new HttpError(400, "invalid_property_type");
  const name = requiredString(input, "name", 120).trim();
  if (!name) throw new HttpError(400, "invalid_property_name");
  const required = input.required ?? false;
  if (typeof required !== "boolean") throw new HttpError(400, "invalid_required_flag");
  let options: readonly string[] | undefined;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length > 100 ||
        !input.options.every((option) => typeof option === "string" && option.trim().length > 0 && option.length <= 100)) {
      throw new HttpError(400, "invalid_property_options");
    }
    options = input.options.map((option: string) => option.trim());
  }
  const definition: PropertyDefinition = {
    id: crypto.randomUUID() as PropertyDefinitionId,
    workspaceId,
    name,
    type: propertyType as PropertyType,
    required,
    ...(options ? { options } : {}),
  };
  return json(await repository.create(definition), 201);
}

async function workspaceCollections(
  request: Request,
  database: SQL,
  session: AuthenticatedSession,
  workspaceId: WorkspaceId,
): Promise<Response> {
  const repository = new PostgresSavedCollectionRepository(database);
  if (request.method === "GET") {
    await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
    return json(await repository.listByWorkspace(workspaceId));
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireCsrf(session, request);
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const input = await readJson(request);
  const collection = createSavedCollection({
    id: crypto.randomUUID() as SavedCollectionId,
    workspaceId,
    name: requiredString(input, "name", 120),
    query: input.query ?? {},
    view: input.view ?? {},
    actorId: session.user.id,
    now: new Date().toISOString(),
  });
  return json(await repository.create(collection), 201);
}

async function collectionOperation(
  request: Request,
  url: URL,
  database: SQL,
  session: AuthenticatedSession,
  collectionId: SavedCollectionId,
  itemsRoute: boolean,
): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, request.method === "GET" ? "read" : "write");
  const collections = new PostgresSavedCollectionRepository(database);
  const collection = await collections.getById(workspaceId, collectionId);
  if (!collection) throw new HttpError(404, "collection_not_found");
  if (itemsRoute) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const rawPage = url.searchParams.get("page") ?? "1";
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new HttpError(400, "invalid_page");
    const result = await new PostgresNodeRepository(database).queryCollection(workspaceId, collection.query, { page, pageSize: 50 });
    const propertyDefinitionIds = collection.view.columns.filter((column) => uuidPattern.test(column)) as PropertyDefinitionId[];
    const propertyDefinitions = (await new PostgresPropertyDefinitionRepository(database).getForWorkspace(workspaceId))
      .filter((definition) => propertyDefinitionIds.includes(definition.id));
    const properties = await new PostgresNodePropertyRepository(database).getForNodesAndDefinitions(
      workspaceId,
      result.items.map((node) => node.id),
      propertyDefinitions.map((definition) => definition.id),
    );
    return json({ collection, ...result, propertyDefinitions, properties });
  }
  if (request.method === "GET") return json(collection);
  requireCsrf(session, request);
  if (request.method === "DELETE") {
    await collections.remove(workspaceId, collectionId);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed");
  const input = await readJson(request);
  const updated = updateSavedCollection(collection, {
    name: requiredString(input, "name", 120),
    query: input.query,
    view: input.view,
    actorId: session.user.id,
    now: new Date().toISOString(),
  });
  const saved = await collections.update(updated);
  return saved ? json(saved) : jsonError(404, "collection_not_found");
}

async function nodeProperties(
  request: Request,
  url: URL,
  database: SQL,
  session: AuthenticatedSession,
  nodeId: NodeId,
  definitionId?: PropertyDefinitionId,
): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, request.method === "GET" ? "read" : "write");
  const nodeRepository = new PostgresNodeRepository(database);
  if (!await nodeRepository.getById(workspaceId, nodeId)) throw new HttpError(404, "node_not_found");

  const repository = new PostgresNodePropertyRepository(database);
  if (request.method === "GET" && !definitionId) return json(await repository.getForNode(workspaceId, nodeId));
  if (!definitionId) throw new HttpError(404, "not_found");
  requireCsrf(session, request);
  if (request.method === "DELETE") {
    const removed = await repository.remove(workspaceId, nodeId, definitionId);
    if (!removed) throw new HttpError(404, "property_value_not_found");
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  const input = await readJson(request);
  const definitions = new PostgresPropertyDefinitionRepository(database);
  const definition = await definitions.getById(workspaceId, definitionId);
  if (!definition) throw new HttpError(404, "property_definition_not_found");
  validatePropertyValue(definition, input.value);
  const value: PropertyValue = input.value.type === "dateTime"
    ? { type: "dateTime", value: new Date(input.value.value).toISOString() }
    : input.value;
  return json(await repository.set(workspaceId, { nodeId, definitionId, value }));
}

async function workspaceRelationDefinitions(
  request: Request,
  database: SQL,
  session: AuthenticatedSession,
  workspaceId: WorkspaceId,
): Promise<Response> {
  const repository = new PostgresRelationDefinitionRepository(database);
  if (request.method === "GET") {
    await requireWorkspaceRole(database, workspaceId, session.user.id, "read");
    return json(await repository.getForWorkspace(workspaceId));
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireCsrf(session, request);
  await requireWorkspaceRole(database, workspaceId, session.user.id, "write");
  const input = await readJson(request);
  const type = requiredString(input, "type", 80);
  const fromLabel = requiredString(input, "fromLabel", 120).trim();
  const toLabel = requiredString(input, "toLabel", 120).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(type) || !fromLabel || !toLabel) throw new HttpError(400, "invalid_relation_definition");
  const allowSelfRelation = input.allowSelfRelation ?? false;
  if (typeof allowSelfRelation !== "boolean") throw new HttpError(400, "invalid_relation_definition");
  const definition: RelationDefinition = {
    id: crypto.randomUUID() as RelationDefinitionId,
    workspaceId,
    type,
    fromLabel,
    toLabel,
    allowSelfRelation,
  };
  return json(await repository.create(definition), 201);
}

async function nodeRelations(
  request: Request,
  url: URL,
  database: SQL,
  session: AuthenticatedSession,
  nodeId: NodeId,
  direction: "backlinks" | "outgoing",
): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, request.method === "GET" ? "read" : "write");
  const nodes = new PostgresNodeRepository(database);
  if (!await nodes.getById(workspaceId, nodeId)) throw new HttpError(404, "node_not_found");
  const repository = new PostgresNodeRelationRepository(database);
  if (request.method === "GET") {
    return json(direction === "backlinks"
      ? await repository.getBacklinks(workspaceId, nodeId)
      : await repository.getOutgoing(workspaceId, nodeId));
  }
  if (direction !== "outgoing" || request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireCsrf(session, request);
  const input = await readJson(request);
  const targetId = requiredString(input, "toNodeId", 36);
  const relationType = requiredString(input, "type", 80);
  if (!uuidPattern.test(targetId)) throw new HttpError(400, "invalid_node_id");
  if (!await nodes.getById(workspaceId, targetId as NodeId)) throw new HttpError(404, "node_not_found");
  const definition = await new PostgresRelationDefinitionRepository(database).getByType(workspaceId, relationType);
  if (!definition) throw new HttpError(400, "invalid_relation_type");
  const relation: NodeRelation = createRelation({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId: nodeId,
    toNodeId: targetId as NodeId,
    actorId: session.user.id,
    now: new Date().toISOString(),
  }, definition);
  return json(await repository.create(relation), 201);
}

async function nodeOperation(
  request: Request,
  database: SQL,
  session: AuthenticatedSession,
  nodeId: NodeId,
  workspaceId: WorkspaceId,
  action: "read" | "rename" | "archive" | "restore",
): Promise<Response> {
  await requireWorkspaceRole(database, workspaceId, session.user.id, action === "read" ? "read" : "write");
  const repository = new PostgresNodeRepository(database);
  let node: WorkspaceNode | null;
  switch (action) {
    case "read":
      node = await repository.getById(workspaceId, nodeId);
      break;
    case "rename":
      node = await repository.updateTitle(workspaceId, nodeId, requiredString(await readJson(request), "title", 500), session.user.id, new Date().toISOString());
      break;
    case "archive":
      node = await repository.archive(workspaceId, nodeId, session.user.id, new Date().toISOString());
      break;
    case "restore":
      node = await repository.restore(workspaceId, nodeId, session.user.id, new Date().toISOString());
      break;
  }
  if (!node) throw new HttpError(404, "node_not_found");
  return json(node);
}

async function nodeCanvasOperation(
  request: Request,
  url: URL,
  database: SQL,
  session: AuthenticatedSession,
  nodeId: NodeId,
): Promise<Response> {
  const workspaceIdValue = url.searchParams.get("workspaceId");
  if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
  const workspaceId = workspaceIdValue as WorkspaceId;
  await requireWorkspaceRole(database, workspaceId, session.user.id, request.method === "GET" ? "read" : "write");
  const node = await new PostgresNodeRepository(database).getById(workspaceId, nodeId);
  if (!node || node.type !== "canvas") throw new HttpError(404, "canvas_not_found");
  const repository = new PostgresNodeCanvasRepository(database);
  if (request.method === "GET") {
    const canvas = await repository.get(workspaceId, nodeId);
    return json(canvas ?? { workspaceId, nodeId, scene: EMPTY_CANVAS_SCENE, bindings: [], revision: 0, updatedAt: null, updatedBy: null });
  }
  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  requireCsrf(session, request);
  const input = await readJson(request, 9_000_000);
  if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new HttpError(400, "invalid_canvas_revision");
  }
  let scene: ReturnType<typeof validateCanvasScene>;
  let bindings: ReturnType<typeof validateCanvasBindings>;
  try {
    scene = validateCanvasScene(input.scene);
    bindings = validateCanvasBindings(input.bindings, scene);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid_canvas_scene");
  }
  if (JSON.stringify(scene).length > 8_000_000) throw new HttpError(413, "canvas_too_large");
  const nodeIds = [...new Set(bindings.map(({ nodeId }) => nodeId))];
  if (nodeIds.some((id) => !uuidPattern.test(id))) throw new HttpError(400, "invalid_canvas_node_binding");
  if (nodeIds.length > 0) {
    const linkedNodes = await database<{ id: string }[]>`
      SELECT id FROM nodes
      WHERE workspace_id = ${workspaceId}::uuid
        AND id = ANY(${database.array(nodeIds, "uuid")})
        AND archived_at IS NULL
    `;
    if (linkedNodes.length !== nodeIds.length) throw new HttpError(400, "invalid_canvas_node_binding");
  }
  const saved = await repository.save({
    workspaceId,
    nodeId,
    scene,
    bindings,
    expectedRevision: input.expectedRevision,
    actorId: session.user.id,
    now: new Date().toISOString(),
  });
  if (!saved) throw new HttpError(409, "canvas_revision_conflict");
  return json(saved);
}

export function createAppHandler(database: SQL | null): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", version: "0.0.0" });
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      if (!database) return jsonError(503, "database_unavailable");
      try {
        await database`SELECT 1`;
        return json({ status: "ready" });
      } catch {
        return jsonError(503, "database_unavailable");
      }
    }
    if (!database) return jsonError(503, "database_unavailable");

    try {
      if (url.pathname === "/api/setup/status" && request.method === "GET") return await setupStatus(database);
      if (url.pathname === "/api/setup" && request.method === "POST") return await setup(request, database);
      if (url.pathname === "/api/auth/login" && request.method === "POST") return await login(request, database);

      const session = await requireSession(database, request);
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        return json({ user: session.user, csrfToken: session.csrfToken });
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await logout(request, database, session);
      if (url.pathname === "/api/workspaces" && request.method === "GET") return await listWorkspaces(database, session);
      if (url.pathname === "/api/workspaces" && request.method === "POST") return await createWorkspaceForSession(request, database, session);
      const workspaceExportRoute = /^\/api\/workspaces\/([^/]+)\/export$/.exec(url.pathname);
      if (workspaceExportRoute) {
        return await exportWorkspace(request, database, session, pathUuid(workspaceExportRoute[1]) as WorkspaceId);
      }
      const workspaceSettingsRoute = /^\/api\/workspaces\/([^/]+)\/settings$/.exec(url.pathname);
      if (workspaceSettingsRoute) {
        if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed");
        const workspaceId = pathUuid(workspaceSettingsRoute[1]) as WorkspaceId;
        return await updateWorkspaceSettings(request, database, session, workspaceId);
      }
      const propertyDefinitionsRoute = /^\/api\/workspaces\/([^/]+)\/properties$/.exec(url.pathname);
      if (propertyDefinitionsRoute) {
        const workspaceId = pathUuid(propertyDefinitionsRoute[1]) as WorkspaceId;
        return await workspacePropertyDefinitions(request, database, session, workspaceId);
      }
      const relationDefinitionsRoute = /^\/api\/workspaces\/([^/]+)\/relations$/.exec(url.pathname);
      if (relationDefinitionsRoute) {
        const workspaceId = pathUuid(relationDefinitionsRoute[1]) as WorkspaceId;
        return await workspaceRelationDefinitions(request, database, session, workspaceId);
      }
      const collectionsRoute = /^\/api\/workspaces\/([^/]+)\/collections$/.exec(url.pathname);
      if (collectionsRoute) {
        const workspaceId = pathUuid(collectionsRoute[1]) as WorkspaceId;
        return await workspaceCollections(request, database, session, workspaceId);
      }
      const collectionRoute = /^\/api\/collections\/([^/]+)(\/items)?$/.exec(url.pathname);
      if (collectionRoute) {
        const collectionId = pathUuid(collectionRoute[1]) as SavedCollectionId;
        return await collectionOperation(request, url, database, session, collectionId, Boolean(collectionRoute[2]));
      }
      const canvasRoute = /^\/api\/nodes\/([^/]+)\/canvas$/.exec(url.pathname);
      if (canvasRoute) {
        return await nodeCanvasOperation(request, url, database, session, pathUuid(canvasRoute[1]) as NodeId);
      }
      const documentRoute = /^\/api\/nodes\/([^/]+)\/document$/.exec(url.pathname);
      if (documentRoute) {
        const nodeId = pathUuid(documentRoute[1]) as NodeId;
        const workspaceIdValue = url.searchParams.get("workspaceId");
        if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
        const workspaceId = workspaceIdValue as WorkspaceId;
        await requireWorkspaceRole(database, workspaceId, session.user.id, request.method === "GET" ? "read" : "write");
        const node = await new PostgresNodeRepository(database).getById(workspaceId, nodeId);
        if (!node || node.type !== "page") throw new HttpError(404, "page_not_found");
        const repository = new PostgresNodeDocumentRepository(database);
        if (request.method === "GET") {
          const document = await repository.get(workspaceId, nodeId);
          return json(document ?? {
            workspaceId,
            nodeId,
            content: [],
            revision: 0,
            updatedAt: null,
            updatedBy: null,
          });
        }
        if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
        requireCsrf(session, request);
        const input = await readJson(request);
        const expectedRevision = input.expectedRevision;
        if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
          throw new HttpError(400, "invalid_document_revision");
        }
        const content = validateNodeDocumentContent(input.content);
        const saved = await repository.save({
          workspaceId,
          nodeId,
          content,
          expectedRevision,
          actorId: session.user.id,
          now: new Date().toISOString(),
        });
        if (!saved) throw new HttpError(409, "document_revision_conflict");
        return json(saved);
      }
      if (url.pathname === "/api/nodes" && request.method === "GET") return await listWorkspaceNodes(url, database, session);
      if (url.pathname === "/api/nodes" && request.method === "POST") return await createWorkspaceNode(request, database, session);
      if (url.pathname === "/api/calendar.ics") return await calendarIcs(request, url, database, session);
      if (url.pathname === "/api/calendar" && request.method === "GET") return await calendarRange(url, database, session);
      if (url.pathname === "/api/graph") {
        if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
        return await workspaceGraph(url, database, session);
      }
      const calendarMoveRoute = /^\/api\/calendar\/([^/]+)\/move$/.exec(url.pathname);
      if (calendarMoveRoute) {
        if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed");
        return await moveCalendarNode(request, url, database, session, pathUuid(calendarMoveRoute[1]) as NodeId);
      }
      if (url.pathname === "/api/search" && request.method === "GET") return await searchWorkspaceNodes(url, database, session);

      const relationsRoute = /^\/api\/nodes\/([^/]+)\/(backlinks|relations)$/.exec(url.pathname);
      if (relationsRoute) {
        const nodeId = pathUuid(relationsRoute[1]) as NodeId;
        return await nodeRelations(
          request,
          url,
          database,
          session,
          nodeId,
          relationsRoute[2] === "backlinks" ? "backlinks" : "outgoing",
        );
      }

      const propertiesRoute = /^\/api\/nodes\/([^/]+)\/properties(?:\/([^/]+))?$/.exec(url.pathname);
      if (propertiesRoute) {
        const nodeId = pathUuid(propertiesRoute[1]) as NodeId;
        const definitionId = propertiesRoute[2] ? pathUuid(propertiesRoute[2]) as PropertyDefinitionId : undefined;
        return await nodeProperties(request, url, database, session, nodeId, definitionId);
      }

      const nodeRoute = /^\/api\/nodes\/([^/]+)(?:\/(archive|restore))?$/.exec(url.pathname);
      if (nodeRoute) {
        const nodeId = pathUuid(nodeRoute[1]) as NodeId;
        const workspaceIdValue = url.searchParams.get("workspaceId");
        if (!workspaceIdValue || !uuidPattern.test(workspaceIdValue)) throw new HttpError(400, "invalid_workspace_id");
        const workspaceId = workspaceIdValue as WorkspaceId;
        if (request.method === "GET" && !nodeRoute[2]) {
          return await nodeOperation(request, database, session, nodeId, workspaceId, "read");
        }
        requireCsrf(session, request);
        if (request.method === "PATCH" && !nodeRoute[2]) {
          return await nodeOperation(request, database, session, nodeId, workspaceId, "rename");
        }
        if (request.method === "DELETE" && !nodeRoute[2]) {
          return await nodeOperation(request, database, session, nodeId, workspaceId, "archive");
        }
        if (request.method === "POST" && nodeRoute[2] === "restore") {
          return await nodeOperation(request, database, session, nodeId, workspaceId, "restore");
        }
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code);
      if (error instanceof DomainError) return jsonError(400, error.code);
      console.error({
        event: "http_request_failed",
        path: url.pathname,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return jsonError(500, "internal_error");
    }
  };
}
