/**
 * Authentication + authorization. Every API request is authorized here, independently of the UI.
 *
 *   const user = await ctx.require("properties", "view");   // Depends(require(...))
 *   const user = await ctx.authed();                         // Authed
 */
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../db";
import { get } from "../db/orm";
import { allows, scopesToPermissions } from "../modules/auth/permissions";
import { roles, serviceCredentials, userSessions, users } from "../modules/auth/schema";
import { HttpError } from "./http";
import { decodeToken, hashApiKey, utcnow } from "./security";

export type UserRow = typeof users.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type UserWithRole = UserRow & { role: RoleRow };

export class CurrentUser {
  constructor(
    public user: UserWithRole,
    public permissions: Record<string, string[]>,
    public approval_limits: Record<string, number | null> = {},
    public session_id: string | null = null,
    public ip_address: string | null = null,
  ) {}

  get id(): string {
    return this.user.id;
  }
  get full_name(): string {
    return this.user.full_name;
  }
  get is_admin(): boolean {
    return (this.permissions["*"] ?? []).includes("*");
  }
  can(module: string, action: string): boolean {
    return allows(this.permissions, module, action);
  }
  canApprove(kind: string, amount: number | null | undefined): boolean {
    if (this.is_admin) return true;
    if (!(kind in this.approval_limits)) return false;
    const limit = this.approval_limits[kind];
    return limit === null || (amount !== null && amount !== undefined && amount <= limit);
  }
}

const unauthorized = () => new HttpError(401, "Not authenticated", { "WWW-Authenticate": "Bearer" });

export async function loadUser(db: Db, id: string): Promise<UserWithRole | undefined> {
  const [row] = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.id, id))
    .limit(1);
  return row ? { ...row.user, role: row.role } : undefined;
}

export async function getCurrentUser(db: Db, req: Request, ip: string | null): Promise<CurrentUser> {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const [cred] = await db
      .select()
      .from(serviceCredentials)
      .where(and(eq(serviceCredentials.key_hash, hashApiKey(apiKey)), isNull(serviceCredentials.revoked_at)))
      .limit(1);
    if (!cred) throw unauthorized();
    const user = await loadUser(db, cred.user_id);
    if (!user || user.status !== "active") throw unauthorized();
    await db.update(serviceCredentials).set({ last_used_at: utcnow() }).where(eq(serviceCredentials.id, cred.id));
    await db.commit();
    return new CurrentUser(user, scopesToPermissions(cred.scopes as string[]), {}, null, ip);
  }

  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw unauthorized();
  let payload: Record<string, any>;
  try {
    payload = decodeToken(token);
  } catch {
    throw unauthorized();
  }
  if (payload.purpose !== "access" || !("sid" in payload)) throw unauthorized();

  const session = await get(db, userSessions, payload.sid);
  if (!session || session.revoked_at || session.expires_at < utcnow()) throw unauthorized();
  const user = await loadUser(db, payload.sub);
  if (!user || user.status !== "active" || user.deleted_at) throw unauthorized();
  return new CurrentUser(
    user,
    (user.role.permissions as Record<string, string[]>) ?? {},
    (user.role.approval_limits as Record<string, number | null>) ?? {},
    session.id,
    ip,
  );
}

export function requireUser(user: CurrentUser, module: string, action = "view"): CurrentUser {
  if (!user.can(module, action)) throw new HttpError(403, `Missing permission ${module}:${action}`);
  return user;
}
