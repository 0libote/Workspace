export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type UserId = string & { readonly __brand: "UserId" };
export type NodeId = string & { readonly __brand: "NodeId" };
export type PropertyDefinitionId = string & { readonly __brand: "PropertyDefinitionId" };
export type RelationDefinitionId = string & { readonly __brand: "RelationDefinitionId" };
export type SavedCollectionId = string & { readonly __brand: "SavedCollectionId" };
export type MembershipRole = "owner" | "editor" | "viewer";

export type NodeType = string & { readonly __brand: "NodeType" };

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly timeZone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface WorkspaceRepository {
  create(workspace: Workspace): Promise<Workspace>;
  getById(workspaceId: WorkspaceId): Promise<Workspace | null>;
  archive(workspaceId: WorkspaceId, now: string): Promise<Workspace | null>;
  updateTimeZone(workspaceId: WorkspaceId, timeZone: string, now: string): Promise<Workspace | null>;
}

export interface User {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly deactivatedAt?: string;
}

export interface UserRepository {
  create(user: User): Promise<User>;
  getById(userId: UserId): Promise<User | null>;
  deactivate(userId: UserId, now: string): Promise<User | null>;
}

export interface WorkspaceMembership {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly joinedAt: string;
}

export interface WorkspaceMembershipRepository {
  create(membership: WorkspaceMembership): Promise<WorkspaceMembership>;
  get(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | null>;
}

export interface WorkspaceNode {
  readonly id: NodeId;
  readonly workspaceId: WorkspaceId;
  readonly type: NodeType;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: UserId;
  readonly updatedBy: UserId;
  readonly archivedAt?: string;
}

export interface NodeRepository {
  create(node: WorkspaceNode): Promise<WorkspaceNode>;
  getById(workspaceId: WorkspaceId, nodeId: NodeId): Promise<WorkspaceNode | null>;
  listByWorkspace(
    workspaceId: WorkspaceId,
    options: { readonly afterId?: NodeId; readonly limit: number; readonly type?: NodeType },
  ): Promise<{ readonly items: readonly WorkspaceNode[]; readonly nextCursor?: NodeId }>;
  searchByWorkspace(
    workspaceId: WorkspaceId,
    options: { readonly query: string; readonly type?: NodeType; readonly page: number; readonly pageSize: number },
  ): Promise<{ readonly items: readonly { node: WorkspaceNode; matchedIn: "title" | "content" }[]; readonly page: number; readonly hasMore: boolean }>;
  queryCollection(
    workspaceId: WorkspaceId,
    query: CollectionQuery,
    options: { readonly page: number; readonly pageSize: number },
  ): Promise<{ readonly items: readonly WorkspaceNode[]; readonly page: number; readonly hasMore: boolean }>;
  updateTitle(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    title: string,
    actorId: UserId,
    now: string,
  ): Promise<WorkspaceNode | null>;
  archive(workspaceId: WorkspaceId, nodeId: NodeId, actorId: UserId, now: string): Promise<WorkspaceNode | null>;
  restore(workspaceId: WorkspaceId, nodeId: NodeId, actorId: UserId, now: string): Promise<WorkspaceNode | null>;
}

export interface CollectionQuery {
  readonly version: 1;
  readonly types: readonly NodeType[];
  readonly titleContains: string;
  readonly sortBy: "title" | "createdAt" | "updatedAt";
  readonly sortDirection: "asc" | "desc";
  readonly groupBy: "type" | null;
}

export interface CollectionViewConfiguration {
  readonly version: 1;
  readonly layout: "table" | "list" | "board" | "calendar";
  readonly columns: readonly string[];
}

export interface SavedCollection {
  readonly id: SavedCollectionId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly query: CollectionQuery;
  readonly view: CollectionViewConfiguration;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: UserId;
  readonly updatedBy: UserId;
}

export interface SavedCollectionRepository {
  create(collection: SavedCollection): Promise<SavedCollection>;
  getById(workspaceId: WorkspaceId, id: SavedCollectionId): Promise<SavedCollection | null>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly SavedCollection[]>;
  update(collection: SavedCollection): Promise<SavedCollection | null>;
  remove(workspaceId: WorkspaceId, id: SavedCollectionId): Promise<boolean>;
}

export type PropertyType =
  (typeof PROPERTY_TYPES)[number];

export const PROPERTY_TYPES = [
  "text", "number", "boolean", "date", "dateTime", "dateRange", "select", "multiSelect", "user",
  "relation", "url", "email", "phone", "file", "formula", "status", "duration",
] as const;

export interface PropertyDefinition {
  readonly id: PropertyDefinitionId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly type: PropertyType;
  readonly required: boolean;
  readonly options?: readonly string[];
}

export interface PropertyDefinitionRepository {
  create(definition: PropertyDefinition): Promise<PropertyDefinition>;
  getById(workspaceId: WorkspaceId, definitionId: PropertyDefinitionId): Promise<PropertyDefinition | null>;
  getForWorkspace(workspaceId: WorkspaceId): Promise<readonly PropertyDefinition[]>;
}

export type PropertyValue =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "date"; readonly value: string }
  | { readonly type: "dateTime"; readonly value: string }
  | { readonly type: "dateRange"; readonly value: { readonly start: string; readonly end: string } }
  | { readonly type: "select" | "status"; readonly value: string }
  | { readonly type: "multiSelect"; readonly value: readonly string[] }
  | { readonly type: "user"; readonly value: UserId }
  | { readonly type: "relation"; readonly value: readonly NodeId[] }
  | { readonly type: "url" | "email" | "phone" | "file"; readonly value: string }
  | { readonly type: "formula"; readonly value: string | number | boolean | null }
  | { readonly type: "duration"; readonly value: number };

export interface NodeProperty {
  readonly nodeId: NodeId;
  readonly definitionId: PropertyDefinitionId;
  readonly value: PropertyValue;
}

export interface NodePropertyRepository {
  set(workspaceId: WorkspaceId, property: NodeProperty): Promise<NodeProperty>;
  getForNode(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeProperty[]>;
  getForNodes(workspaceId: WorkspaceId, nodeIds: readonly NodeId[], definitionId: PropertyDefinitionId): Promise<readonly NodeProperty[]>;
  getForNodesAndDefinitions(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
    definitionIds: readonly PropertyDefinitionId[],
  ): Promise<readonly NodeProperty[]>;
  remove(workspaceId: WorkspaceId, nodeId: NodeId, definitionId: PropertyDefinitionId): Promise<boolean>;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface NodeDocument {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly content: readonly JsonValue[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: UserId;
}

export interface SaveNodeDocumentInput {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly content: readonly JsonValue[];
  readonly expectedRevision: number;
  readonly actorId: UserId;
  readonly now: string;
}

export interface NodeDocumentRepository {
  get(workspaceId: WorkspaceId, nodeId: NodeId): Promise<NodeDocument | null>;
  save(input: SaveNodeDocumentInput): Promise<NodeDocument | null>;
}

export interface CanvasNodeBinding {
  readonly elementId: string;
  readonly nodeId: NodeId;
}

export interface NodeCanvasDocument {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly scene: JsonValue;
  readonly bindings: readonly CanvasNodeBinding[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: UserId;
}

export interface SaveNodeCanvasInput {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly scene: JsonValue;
  readonly bindings: readonly CanvasNodeBinding[];
  readonly expectedRevision: number;
  readonly actorId: UserId;
  readonly now: string;
}

export interface NodeCanvasRepository {
  get(workspaceId: WorkspaceId, nodeId: NodeId): Promise<NodeCanvasDocument | null>;
  save(input: SaveNodeCanvasInput): Promise<NodeCanvasDocument | null>;
}

export interface NodeRelation {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
  readonly type: string;
  readonly createdAt: string;
  readonly createdBy: UserId;
}

export interface RelationDefinitionRepository {
  create(definition: RelationDefinition): Promise<RelationDefinition>;
  getByType(workspaceId: WorkspaceId, type: string): Promise<RelationDefinition | null>;
  getForWorkspace(workspaceId: WorkspaceId): Promise<readonly RelationDefinition[]>;
}

export interface NodeRelationRepository {
  create(relation: NodeRelation): Promise<NodeRelation>;
  getOutgoing(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeRelation[]>;
  getBacklinks(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly NodeRelation[]>;
}

export interface WorkspaceGraphNode {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly title: string;
}

export interface WorkspaceGraphEdge {
  readonly id: string;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly type: string;
}

export interface WorkspaceGraph {
  readonly nodes: readonly WorkspaceGraphNode[];
  readonly edges: readonly WorkspaceGraphEdge[];
  readonly truncated: boolean;
}

export interface WorkspaceGraphQuery {
  readonly workspaceId: WorkspaceId;
  readonly nodeId?: NodeId;
  readonly depth: 1 | 2;
  readonly limit: number;
}

export interface WorkspaceGraphRepository {
  query(query: WorkspaceGraphQuery): Promise<WorkspaceGraph>;
}

export type SyncDocumentKind = "page" | "canvas";

export interface GetSyncDocumentStateInput {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly stateVector: Uint8Array;
}

export interface SyncDocumentState {
  readonly update: Uint8Array;
  readonly revision: number;
}

export interface ApplySyncDocumentUpdateInput {
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  readonly documentKind: SyncDocumentKind;
  readonly actorId: UserId;
  readonly mutationId: string;
  readonly update: Uint8Array;
  readonly now: string;
}

export interface ApplySyncDocumentUpdateResult {
  readonly revision: number;
  readonly duplicate: boolean;
}

export interface SyncDocumentRepository {
  getState(input: GetSyncDocumentStateInput): Promise<SyncDocumentState>;
  applyUpdate(input: ApplySyncDocumentUpdateInput): Promise<ApplySyncDocumentUpdateResult>;
}

export interface WorkspaceExportActor {
  readonly id: UserId;
  readonly displayName: string;
}

export interface WorkspaceExportNode {
  readonly node: WorkspaceNode;
  readonly properties: readonly NodeProperty[];
  readonly document?: NodeDocument;
  readonly canvas?: NodeCanvasDocument;
}

export interface WorkspaceExport {
  readonly format: "astryx-workspace-export";
  readonly version: 1;
  readonly exportedAt: string;
  readonly workspace: Workspace;
  readonly actors: readonly WorkspaceExportActor[];
  readonly memberships: readonly WorkspaceMembership[];
  readonly nodeTypes: readonly Extract<NodeTypeDefinition, { source: "workspace" }>[];
  readonly propertyDefinitions: readonly PropertyDefinition[];
  readonly relationDefinitions: readonly RelationDefinition[];
  readonly nodes: readonly WorkspaceExportNode[];
  readonly relations: readonly NodeRelation[];
  readonly collections: readonly SavedCollection[];
}

export interface WorkspaceExportRepository {
  exportWorkspace(workspaceId: WorkspaceId, exportedAt: string): Promise<WorkspaceExport | null>;
}

export interface RelationDefinition {
  readonly id: RelationDefinitionId;
  readonly workspaceId: WorkspaceId;
  readonly type: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly allowSelfRelation: boolean;
}

export type NodeTypeDefinition =
  | { readonly type: NodeType; readonly label: string; readonly source: "builtin" }
  | { readonly type: NodeType; readonly label: string; readonly source: "workspace"; readonly workspaceId: WorkspaceId };

export interface NodeTypeDefinitionRepository {
  register(definition: Extract<NodeTypeDefinition, { source: "workspace" }>): Promise<NodeTypeDefinition>;
  getForWorkspace(workspaceId: WorkspaceId): Promise<readonly NodeTypeDefinition[]>;
}

export const BUILTIN_NODE_TYPES: readonly NodeTypeDefinition[] = [
  { type: "page" as NodeType, label: "Page", source: "builtin" },
  { type: "task" as NodeType, label: "Task", source: "builtin" },
  { type: "project" as NodeType, label: "Project", source: "builtin" },
  { type: "person" as NodeType, label: "Person", source: "builtin" },
  { type: "event" as NodeType, label: "Event", source: "builtin" },
  { type: "canvas" as NodeType, label: "Canvas", source: "builtin" },
  { type: "bookmark" as NodeType, label: "Bookmark", source: "builtin" },
];

export interface CreateNodeInput {
  readonly id: NodeId;
  readonly workspaceId: WorkspaceId;
  readonly type: NodeType;
  readonly title: string;
  readonly actorId: UserId;
  readonly now: string;
  readonly registeredTypes?: readonly NodeTypeDefinition[];
}

export type DomainErrorCode =
  | "invalid_title"
  | "invalid_node_type"
  | "invalid_timestamp"
  | "invalid_property_value"
  | "invalid_workspace"
  | "invalid_user"
  | "duplicate_node_type"
  | "invalid_relation"
  | "invalid_page"
  | "invalid_document"
  | "invalid_collection_query"
  | "invalid_collection_view"
  | "invalid_collection_name"
  | "invalid_time_zone";

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((child) => isJsonValue(child, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((child) => isJsonValue(child, depth + 1));
}

export function validateNodeDocumentContent(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value) || value.length > 1_000 || !value.every((block) => {
    if (!isJsonValue(block) || typeof block !== "object" || block === null || Array.isArray(block)) return false;
    const record = block as Readonly<Record<string, JsonValue>>;
    return typeof record.id === "string" && record.id.length > 0 &&
      typeof record.type === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(record.type);
  })) {
    throw new DomainError("invalid_document", "Document content must be a JSON array of valid blocks.");
  }
  return value;
}

const isValidTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));

export interface CreateWorkspaceInput {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly timeZone?: string;
  readonly now: string;
}

export function normalizeTimeZone(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.length > 100) {
    throw new DomainError("invalid_time_zone", "A workspace time zone must be a valid IANA identifier.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    throw new DomainError("invalid_time_zone", "A workspace time zone must be a valid IANA identifier.");
  }
}

export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const name = input.name.trim();
  if (!name) throw new DomainError("invalid_workspace", "A workspace name must contain at least one non-space character.");
  if (!isValidTimestamp(input.now)) throw new DomainError("invalid_timestamp", "The workspace timestamp must be a valid date-time.");
  return { id: input.id, name, timeZone: normalizeTimeZone(input.timeZone ?? "UTC"), createdAt: input.now, updatedAt: input.now };
}

export function updateWorkspaceTimeZone(workspace: Workspace, timeZone: string, now: string): Workspace {
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The workspace timestamp must be a valid date-time.");
  return { ...workspace, timeZone: normalizeTimeZone(timeZone), updatedAt: now };
}

export interface CreateUserInput {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly now: string;
}

export function createUser(input: CreateUserInput): User {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName) {
    throw new DomainError("invalid_user", "A user requires a valid email address and non-empty display name.");
  }
  if (!isValidTimestamp(input.now)) throw new DomainError("invalid_timestamp", "The user timestamp must be a valid date-time.");
  return { id: input.id, email, displayName, createdAt: input.now };
}

export function deactivateUser(user: User, now: string): User {
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The deactivation timestamp must be a valid date-time.");
  return { ...user, deactivatedAt: now };
}

export function archiveWorkspace(workspace: Workspace, now: string): Workspace {
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The archive timestamp must be a valid date-time.");
  return { ...workspace, updatedAt: now, archivedAt: now };
}

export function registerNodeType(
  definition: Extract<NodeTypeDefinition, { source: "workspace" }>,
  existing: readonly NodeTypeDefinition[],
): readonly NodeTypeDefinition[] {
  const normalizedLabel = definition.label.trim().toLocaleLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.type) || !normalizedLabel) {
    throw new DomainError("invalid_node_type", "Custom node types require a type, label, and owning workspace.");
  }
  const isDuplicate = existing.some((candidate) =>
    (candidate.type === definition.type &&
      (candidate.source === "builtin" || candidate.workspaceId === definition.workspaceId)) ||
    (candidate.label.trim().toLocaleLowerCase() === normalizedLabel &&
      (candidate.source === "builtin" || candidate.workspaceId === definition.workspaceId)),
  );
  if (isDuplicate) throw new DomainError("duplicate_node_type", `Node type ${definition.type} is already registered.`);
  return [...existing, definition];
}

export function createMembership(
  workspaceId: WorkspaceId,
  userId: UserId,
  role: MembershipRole,
  joinedAt: string,
): WorkspaceMembership {
  if (!isValidTimestamp(joinedAt)) throw new DomainError("invalid_timestamp", "The membership timestamp must be a valid date-time.");
  return { workspaceId, userId, role, joinedAt };
}

const isValidDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day);
};

export function createNode(input: CreateNodeInput): WorkspaceNode {
  const title = input.title.trim();
  if (!title) throw new DomainError("invalid_title", "A node title must contain at least one non-space character.");
  if (!/^[a-z][a-z0-9_-]*$/.test(input.type)) throw new DomainError("invalid_node_type", "Node types use a lowercase identifier format.");
  const types = input.registeredTypes ?? BUILTIN_NODE_TYPES;
  const registered = types.some((type) => type.type === input.type &&
    (type.source === "builtin" || type.workspaceId === input.workspaceId));
  if (!registered) throw new DomainError("invalid_node_type", `Node type ${input.type} is not registered for this workspace.`);
  if (!isValidTimestamp(input.now)) throw new DomainError("invalid_timestamp", "The node timestamp must be a valid date-time.");

  return {
    id: input.id,
    workspaceId: input.workspaceId,
    type: input.type,
    title,
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.actorId,
    updatedBy: input.actorId,
  };
}

export function archiveNode(node: WorkspaceNode, actorId: UserId, now: string): WorkspaceNode {
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The archive timestamp must be a valid date-time.");
  return { ...node, updatedAt: now, updatedBy: actorId, archivedAt: now };
}

export function renameNode(node: WorkspaceNode, title: string, actorId: UserId, now: string): WorkspaceNode {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new DomainError("invalid_title", "A node title must contain at least one non-space character.");
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The update timestamp must be a valid date-time.");
  return { ...node, title: normalizedTitle, updatedAt: now, updatedBy: actorId };
}

export function restoreNode(node: WorkspaceNode, actorId: UserId, now: string): WorkspaceNode {
  if (!isValidTimestamp(now)) throw new DomainError("invalid_timestamp", "The restore timestamp must be a valid date-time.");
  const { archivedAt: _archivedAt, ...activeNode } = node;
  return { ...activeNode, updatedAt: now, updatedBy: actorId };
}

export function validateCollectionQuery(value: unknown): CollectionQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid_collection_query", "A collection query must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate.version ?? 1;
  const types = candidate.types ?? [];
  const titleContains = candidate.titleContains ?? "";
  const sortBy = candidate.sortBy ?? "updatedAt";
  const sortDirection = candidate.sortDirection ?? "desc";
  const groupBy = candidate.groupBy ?? null;
  if (version !== 1) throw new DomainError("invalid_collection_query", "This collection query version is not supported.");
  if (!Array.isArray(types) || types.length > 20 || !types.every((type) => typeof type === "string" && /^[a-z][a-z0-9_-]*$/.test(type))) {
    throw new DomainError("invalid_collection_query", "Collection type filters must contain up to 20 valid node types.");
  }
  if (new Set(types).size !== types.length) throw new DomainError("invalid_collection_query", "Collection type filters cannot repeat a node type.");
  if (typeof titleContains !== "string" || titleContains.length > 120) {
    throw new DomainError("invalid_collection_query", "Collection title filters must be 120 characters or fewer.");
  }
  if (sortBy !== "title" && sortBy !== "createdAt" && sortBy !== "updatedAt") {
    throw new DomainError("invalid_collection_query", "Collections can sort by title, creation time, or update time.");
  }
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new DomainError("invalid_collection_query", "Collection sort direction must be asc or desc.");
  }
  if (groupBy !== null && groupBy !== "type") {
    throw new DomainError("invalid_collection_query", "Collections can group nodes by type.");
  }
  return {
    version: 1,
    types: [...types] as NodeType[],
    titleContains: titleContains.trim(),
    sortBy,
    sortDirection,
    groupBy,
  };
}

export function validateCollectionView(value: unknown): CollectionViewConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid_collection_view", "A collection view must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate.version ?? 1;
  const layout = candidate.layout ?? "table";
  const columns = candidate.columns ?? ["title", "type", "updatedAt"];
  const validColumn = (column: unknown): column is string =>
    column === "title" || column === "type" || column === "createdAt" || column === "updatedAt" ||
    typeof column === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(column);
  if (version !== 1) throw new DomainError("invalid_collection_view", "This collection view version is not supported.");
  if (layout !== "table" && layout !== "list" && layout !== "board" && layout !== "calendar") {
    throw new DomainError("invalid_collection_view", "Collection layout must be table, list, board, or calendar.");
  }
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 20 || !columns.every(validColumn)) {
    throw new DomainError("invalid_collection_view", "Collection columns must contain between 1 and 20 supported node fields.");
  }
  if (new Set(columns).size !== columns.length) throw new DomainError("invalid_collection_view", "Collection columns cannot repeat.");
  if (!columns.includes("title")) throw new DomainError("invalid_collection_view", "The title column is required.");
  return { version: 1, layout, columns: [...columns] };
}

export function createSavedCollection(input: {
  readonly id: SavedCollectionId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly query: unknown;
  readonly view: unknown;
  readonly actorId: UserId;
  readonly now: string;
}): SavedCollection {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new DomainError("invalid_collection_name", "Collection names must contain 1 to 120 characters.");
  if (!isValidTimestamp(input.now)) throw new DomainError("invalid_timestamp", "The collection timestamp must be a valid date-time.");
  const query = validateCollectionQuery(input.query);
  const view = validateCollectionView(input.view);
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name,
    query: view.layout === "board" && query.groupBy === null ? { ...query, groupBy: "type" } : query,
    view,
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.actorId,
    updatedBy: input.actorId,
  };
}

export function updateSavedCollection(
  collection: SavedCollection,
  input: { readonly name: string; readonly query: unknown; readonly view: unknown; readonly actorId: UserId; readonly now: string },
): SavedCollection {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new DomainError("invalid_collection_name", "Collection names must contain 1 to 120 characters.");
  if (!isValidTimestamp(input.now)) throw new DomainError("invalid_timestamp", "The collection timestamp must be a valid date-time.");
  const query = validateCollectionQuery(input.query);
  const view = validateCollectionView(input.view);
  return {
    ...collection,
    name,
    query: view.layout === "board" && query.groupBy === null ? { ...query, groupBy: "type" } : query,
    view,
    updatedAt: input.now,
    updatedBy: input.actorId,
  };
}

export interface CreateRelationInput {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
  readonly actorId: UserId;
  readonly now: string;
}

export function createRelation(input: CreateRelationInput, definition: RelationDefinition): NodeRelation {
  if (input.workspaceId !== definition.workspaceId || !definition.type.trim()) {
    throw new DomainError("invalid_relation", "A relation and its definition must belong to the same workspace and have a type.");
  }
  if (input.fromNodeId === input.toNodeId && !definition.allowSelfRelation) {
    throw new DomainError("invalid_relation", "This relation does not allow a node to relate to itself.");
  }
  if (!definition.fromLabel.trim() || !definition.toLabel.trim() || !isValidTimestamp(input.now)) {
    throw new DomainError("invalid_relation", "Relations require labels and a valid creation timestamp.");
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    type: definition.type,
    createdAt: input.now,
    createdBy: input.actorId,
  };
}

export function getRelationLabel(
  relation: NodeRelation,
  nodeId: NodeId,
  definition: RelationDefinition,
): string | undefined {
  if (relation.type !== definition.type || relation.workspaceId !== definition.workspaceId) return undefined;
  if (relation.fromNodeId === nodeId) return definition.fromLabel;
  if (relation.toNodeId === nodeId) return definition.toLabel;
  return undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isPropertyValue(value: unknown): value is PropertyValue {
  if (typeof value !== "object" || value === null || !("type" in value) || !("value" in value)) return false;
  const candidate = value as { type: unknown; value: unknown };
  switch (candidate.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
    case "file":
    case "select":
    case "status":
    case "date":
    case "dateTime":
      return typeof candidate.value === "string";
    case "number":
    case "duration":
      return typeof candidate.value === "number" && Number.isFinite(candidate.value);
    case "boolean":
      return typeof candidate.value === "boolean";
    case "dateRange":
      return typeof candidate.value === "object" && candidate.value !== null &&
        "start" in candidate.value && "end" in candidate.value &&
        typeof candidate.value.start === "string" && typeof candidate.value.end === "string";
    case "multiSelect":
    case "relation":
      return isStringArray(candidate.value);
    case "user":
      return typeof candidate.value === "string";
    case "formula":
      return candidate.value === null || typeof candidate.value === "string" ||
        typeof candidate.value === "number" && Number.isFinite(candidate.value) ||
        typeof candidate.value === "boolean";
    default:
      return false;
  }
}

export function validatePropertyValue(definition: PropertyDefinition, value: unknown): asserts value is PropertyValue {
  if (!isPropertyValue(value)) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} has a malformed value.`);
  }
  if (definition.type !== value.type) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} expects ${definition.type}, received ${value.type}.`);
  }

  if ((value.type === "date" && !isValidDate(value.value)) ||
      (value.type === "dateTime" && !isValidTimestamp(value.value))) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} has an invalid date value.`);
  }

  if (value.type === "dateRange" &&
      (!isValidTimestamp(value.value.start) || !isValidTimestamp(value.value.end) ||
        Date.parse(value.value.start) > Date.parse(value.value.end))) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} has an invalid date range.`);
  }

  if ((value.type === "select" || value.type === "status") && definition.options && !definition.options.includes(value.value)) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} must use one of its configured options.`);
  }

  if (value.type === "multiSelect" && definition.options && value.value.some((option) => !definition.options?.includes(option))) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} contains an unconfigured option.`);
  }

  if (value.type === "number" && !Number.isFinite(value.value)) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} must be a finite number.`);
  }

  if (value.type === "duration" && value.value < 0) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} must be zero or more.`);
  }

  if (value.type === "url") {
    try {
      const parsed = new URL(value.value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      throw new DomainError("invalid_property_value", `Property ${definition.name} must be an absolute HTTP or HTTPS URL.`);
    }
  }

  if (value.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.value)) {
    throw new DomainError("invalid_property_value", `Property ${definition.name} must contain a valid email address.`);
  }
}

export function getBacklinks(nodeId: NodeId, relations: readonly NodeRelation[]): readonly NodeRelation[] {
  return relations.filter((relation) => relation.toNodeId === nodeId);
}
