import type { JsonValue, PropertyType, PropertyValue } from "@workspace/domain";
import type { CalendarEvent } from "@workspace/calendar";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string;
  readonly role: "owner" | "editor" | "viewer";
}

export interface WorkspaceNode {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface RelationDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: string;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly allowSelfRelation: boolean;
}

export interface NodeRelation {
  readonly id: string;
  readonly workspaceId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface NodePage {
  readonly items: readonly WorkspaceNode[];
  readonly nextCursor: string | null;
  readonly taskStatusDefinition?: TaskStatusDefinition | null;
  readonly taskStatuses?: readonly TaskStatusSummary[];
}

export interface NodeSearchPage {
  readonly items: readonly { readonly node: WorkspaceNode; readonly matchedIn: "title" | "content" }[];
  readonly page: number;
  readonly hasMore: boolean;
}

export interface CalendarRange {
  readonly events: readonly CalendarEvent[];
  readonly truncated: boolean;
  readonly startProperty: { readonly id: string; readonly type: "date" | "dateTime" } | null;
}

export interface SavedCollection {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly query: {
    readonly version: 1;
    readonly types: readonly string[];
    readonly titleContains: string;
    readonly sortBy: "title" | "createdAt" | "updatedAt";
    readonly sortDirection: "asc" | "desc";
    readonly groupBy: "type" | null;
  };
  readonly view: { readonly version: 1; readonly layout: "table" | "list" | "board" | "calendar"; readonly columns: readonly string[] };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly updatedBy: string;
}

export interface CollectionItemsPage {
  readonly collection: SavedCollection;
  readonly items: readonly WorkspaceNode[];
  readonly propertyDefinitions: readonly PropertyDefinition[];
  readonly properties: readonly NodeProperty[];
  readonly page: number;
  readonly hasMore: boolean;
}

export interface TaskStatusDefinition {
  readonly id: string;
  readonly type: "status" | "select";
  readonly options: readonly string[];
}

export interface TaskStatusSummary {
  readonly nodeId: string;
  readonly value: string | null;
}

export interface PageDocument {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly content: readonly JsonValue[];
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface PropertyDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly type: PropertyType;
  readonly required: boolean;
  readonly options?: readonly string[];
}

export interface NodeProperty {
  readonly nodeId: string;
  readonly definitionId: string;
  readonly value: PropertyValue;
}

export interface Session {
  readonly user: { readonly id: string; readonly email: string; readonly displayName?: string };
  readonly csrfToken: string;
}

interface ApiFailure {
  readonly error?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const requestUrl = new URL(path, window.location.origin);
  if (requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith("/api/")) {
    throw new ApiError("invalid_api_path", 400);
  }
  const response = await fetch(requestUrl, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiFailure;
    throw new ApiError(payload.error ?? "request_failed", response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
