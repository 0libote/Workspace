import type { SQL } from "bun";
import type { User, UserId } from "@workspace/domain";

const sessionCookieName = "workspace_session";
const sessionDurationSeconds = 60 * 60 * 24 * 7;

export interface AuthenticatedSession {
  readonly id: string;
  readonly user: User;
  readonly csrfToken: string;
}

interface SessionRow {
  readonly session_id: string;
  readonly csrf_token: string;
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createSecretToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function persistSession(
  transaction: SQL,
  userId: UserId,
  token: string,
  csrfToken: string,
  now: Date,
): Promise<{ readonly id: string; readonly expiresAt: string }> {
  const id = crypto.randomUUID();
  const expires = new Date(now.getTime() + sessionDurationSeconds * 1000);
  const expiresAt = expires.toISOString();
  await transaction`
    INSERT INTO auth_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at)
    VALUES (
      ${id}::uuid, ${userId}::uuid, ${hashToken(token)}, ${csrfToken},
      ${now.toISOString()}::timestamptz, ${expiresAt}::timestamptz
    )
  `;
  return { id, expiresAt };
}

export async function findSession(database: SQL, request: Request): Promise<AuthenticatedSession | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await database<SessionRow[]>`
    SELECT session.id AS session_id, session.csrf_token,
      app_users.id, app_users.email, app_users.display_name, app_users.created_at
    FROM auth_sessions AS session
    JOIN app_users ON app_users.id = session.user_id
    WHERE session.token_hash = ${tokenHash}
      AND session.revoked_at IS NULL
      AND session.expires_at > CURRENT_TIMESTAMP
      AND app_users.deactivated_at IS NULL
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.session_id,
    csrfToken: row.csrf_token,
    user: {
      id: row.id as UserId,
      email: row.email,
      displayName: row.display_name,
      createdAt: iso(row.created_at),
    },
  };
}

function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === sessionCookieName) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieIsSecure(request: Request): boolean {
  const configuredUrl = Bun.env.APP_URL;
  return new URL(configuredUrl ?? request.url).protocol === "https:";
}

export function sessionCookie(request: Request, token: string): string {
  const secure = cookieIsSecure(request) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDurationSeconds}${secure}`;
}

export function expiredSessionCookie(request: Request): string {
  const secure = cookieIsSecure(request) ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function validCsrfToken(session: AuthenticatedSession, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const expectedOrigin = new URL(Bun.env.APP_URL ?? request.url).origin;
      if (new URL(origin).origin !== expectedOrigin) return false;
    } catch {
      return false;
    }
  }

  const token = request.headers.get("x-csrf-token");
  if (!token) return false;
  const expectedBytes = Buffer.from(session.csrfToken);
  const actualBytes = Buffer.from(token);
  return expectedBytes.byteLength === actualBytes.byteLength && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

export function sessionDuration(): number {
  return sessionDurationSeconds;
}
