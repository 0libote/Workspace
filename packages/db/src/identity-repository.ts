import {
  archiveWorkspace,
  BUILTIN_NODE_TYPES,
  deactivateUser,
  registerNodeType,
  updateWorkspaceTimeZone,
  type NodeTypeDefinition,
  type NodeTypeDefinitionRepository,
  type User,
  type UserId,
  type UserRepository,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMembership,
  type WorkspaceMembershipRepository,
  type WorkspaceRepository,
} from "@workspace/domain";
import type { SQL } from "bun";

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly time_zone: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly archived_at: Date | string | null;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly created_at: Date | string;
  readonly deactivated_at: Date | string | null;
}

interface MembershipRow {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly role: WorkspaceMembership["role"];
  readonly joined_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id as WorkspaceId,
    name: row.name,
    timeZone: row.time_zone,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.archived_at === null ? {} : { archivedAt: iso(row.archived_at) }),
  };
}

function fromUserRow(row: UserRow): User {
  return {
    id: row.id as UserId,
    email: row.email,
    displayName: row.display_name,
    createdAt: iso(row.created_at),
    ...(row.deactivated_at === null ? {} : { deactivatedAt: iso(row.deactivated_at) }),
  };
}

function fromMembershipRow(row: MembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    userId: row.user_id as UserId,
    role: row.role,
    joinedAt: iso(row.joined_at),
  };
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: SQL) {}

  async create(workspace: Workspace): Promise<Workspace> {
    const rows = await this.database<WorkspaceRow[]>`
      INSERT INTO workspaces (id, name, time_zone, created_at, updated_at, archived_at)
      VALUES (
        ${workspace.id}::uuid, ${workspace.name}, ${workspace.timeZone}, ${workspace.createdAt}::timestamptz,
        ${workspace.updatedAt}::timestamptz, ${workspace.archivedAt ?? null}::timestamptz
      )
      RETURNING id, name, time_zone, created_at, updated_at, archived_at
    `;
    return fromWorkspaceRow(rows[0]);
  }

  async getById(workspaceId: WorkspaceId): Promise<Workspace | null> {
    const rows = await this.database<WorkspaceRow[]>`
      SELECT id, name, time_zone, created_at, updated_at, archived_at FROM workspaces WHERE id = ${workspaceId}::uuid
    `;
    return rows[0] ? fromWorkspaceRow(rows[0]) : null;
  }

  async archive(workspaceId: WorkspaceId, now: string): Promise<Workspace | null> {
    const rows = await this.database<WorkspaceRow[]>`
      SELECT id, name, time_zone, created_at, updated_at, archived_at FROM workspaces WHERE id = ${workspaceId}::uuid
    `;
    if (!rows[0]) return null;
    const archived = archiveWorkspace(fromWorkspaceRow(rows[0]), now);
    const updated = await this.database<WorkspaceRow[]>`
      UPDATE workspaces SET updated_at = ${archived.updatedAt}::timestamptz, archived_at = ${archived.archivedAt}::timestamptz
      WHERE id = ${workspaceId}::uuid
      RETURNING id, name, time_zone, created_at, updated_at, archived_at
    `;
    return updated[0] ? fromWorkspaceRow(updated[0]) : null;
  }

  async updateTimeZone(workspaceId: WorkspaceId, timeZone: string, now: string): Promise<Workspace | null> {
    const rows = await this.database<WorkspaceRow[]>`
      SELECT id, name, time_zone, created_at, updated_at, archived_at FROM workspaces WHERE id = ${workspaceId}::uuid
    `;
    if (!rows[0]) return null;
    const updatedWorkspace = updateWorkspaceTimeZone(fromWorkspaceRow(rows[0]), timeZone, now);
    const updated = await this.database<WorkspaceRow[]>`
      UPDATE workspaces SET time_zone = ${updatedWorkspace.timeZone}, updated_at = ${updatedWorkspace.updatedAt}::timestamptz
      WHERE id = ${workspaceId}::uuid
      RETURNING id, name, time_zone, created_at, updated_at, archived_at
    `;
    return updated[0] ? fromWorkspaceRow(updated[0]) : null;
  }
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly database: SQL) {}

  async create(user: User): Promise<User> {
    const rows = await this.database<UserRow[]>`
      INSERT INTO app_users (id, email, display_name, created_at, deactivated_at)
      VALUES (${user.id}::uuid, ${user.email}, ${user.displayName}, ${user.createdAt}::timestamptz, ${user.deactivatedAt ?? null}::timestamptz)
      RETURNING id, email, display_name, created_at, deactivated_at
    `;
    return fromUserRow(rows[0]);
  }

  async getById(userId: UserId): Promise<User | null> {
    const rows = await this.database<UserRow[]>`
      SELECT id, email, display_name, created_at, deactivated_at FROM app_users WHERE id = ${userId}::uuid
    `;
    return rows[0] ? fromUserRow(rows[0]) : null;
  }

  async deactivate(userId: UserId, now: string): Promise<User | null> {
    const current = await this.getById(userId);
    if (!current) return null;
    const deactivated = deactivateUser(current, now);
    const rows = await this.database<UserRow[]>`
      UPDATE app_users SET deactivated_at = ${deactivated.deactivatedAt}::timestamptz
      WHERE id = ${userId}::uuid
      RETURNING id, email, display_name, created_at, deactivated_at
    `;
    return rows[0] ? fromUserRow(rows[0]) : null;
  }
}

export class PostgresWorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  constructor(private readonly database: SQL) {}

  async create(membership: WorkspaceMembership): Promise<WorkspaceMembership> {
    const rows = await this.database<MembershipRow[]>`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
      VALUES (
        ${membership.workspaceId}::uuid, ${membership.userId}::uuid, ${membership.role},
        ${membership.joinedAt}::timestamptz
      )
      RETURNING workspace_id, user_id, role, joined_at
    `;
    return fromMembershipRow(rows[0]);
  }

  async get(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | null> {
    const rows = await this.database<MembershipRow[]>`
      SELECT workspace_id, user_id, role, joined_at FROM workspace_memberships
      WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
    `;
    return rows[0] ? fromMembershipRow(rows[0]) : null;
  }
}

interface NodeTypeRow {
  readonly type: string;
  readonly label: string;
  readonly workspace_id: string;
}

export class PostgresNodeTypeDefinitionRepository implements NodeTypeDefinitionRepository {
  constructor(private readonly database: SQL) {}

  async register(definition: Extract<NodeTypeDefinition, { source: "workspace" }>): Promise<NodeTypeDefinition> {
    const workspaceId = definition.workspaceId;
    const existing = await this.getForWorkspace(workspaceId);
    registerNodeType(definition, existing);
    const rows = await this.database<NodeTypeRow[]>`
      INSERT INTO workspace_node_types (workspace_id, type, label)
      VALUES (${workspaceId}::uuid, ${definition.type}, ${definition.label.trim()})
      RETURNING workspace_id, type, label
    `;
    return {
      type: rows[0].type as NodeTypeDefinition["type"],
      label: rows[0].label,
      source: "workspace",
      workspaceId: rows[0].workspace_id as WorkspaceId,
    };
  }

  async getForWorkspace(workspaceId: WorkspaceId): Promise<readonly NodeTypeDefinition[]> {
    const rows = await this.database<NodeTypeRow[]>`
      SELECT workspace_id, type, label FROM workspace_node_types
      WHERE workspace_id = ${workspaceId}::uuid ORDER BY label
    `;
    return [
      ...BUILTIN_NODE_TYPES,
      ...rows.map((row): NodeTypeDefinition => ({
        type: row.type as NodeTypeDefinition["type"],
        label: row.label,
        source: "workspace",
        workspaceId: row.workspace_id as WorkspaceId,
      })),
    ];
  }
}
