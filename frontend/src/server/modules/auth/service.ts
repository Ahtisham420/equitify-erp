import { and, eq, isNull, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { settings } from "../../config";
import { CurrentUser, loadUser, type UserWithRole } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import {
  createToken,
  decodeToken,
  hashPassword,
  newApiKey,
  newTotpSecret,
  totpUri,
  utcnow,
  verifyPassword,
  verifyTotp,
} from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import { DEFAULT_ROLES } from "./permissions";
import type { CredentialIn, DeactivateIn, RoleIn, RoleUpdate, UserCreate, UserUpdate } from "./schemas";
import { roles, serviceCredentials, teams, userSessions, users } from "./schema";

type RoleRow = typeof roles.$inferSelect;

export function userOut(u: UserWithRole) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    job_title: u.job_title,
    phone: u.phone,
    role: { id: u.role.id, key: u.role.key, name: u.role.name },
    team_id: u.team_id,
    manager_id: u.manager_id,
    status: u.status,
    is_service: u.is_service,
    mfa_enabled: u.mfa_enabled,
    last_login_at: u.last_login_at,
    deactivated_at: u.deactivated_at,
    created_at: u.created_at,
  };
}

export function meOut(u: UserWithRole) {
  return { ...userOut(u), permissions: u.role.permissions ?? {}, approval_limits: u.role.approval_limits ?? {} };
}

export function roleOut(r: RoleRow, userCount = 0) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    approval_limits: r.approval_limits,
    is_system: r.is_system,
    user_count: userCount,
  };
}

// --- Authentication -------------------------------------------------------------------------

export async function login(db: Db, email: string, password: string, ip: string | null, agent: string | null) {
  const [found] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.deleted_at)))
    .limit(1);
  const user = found ? await loadUser(db, found.id) : undefined;
  if (!user || user.is_service || !verifyPassword(password, user.password_hash)) {
    await audit.record(db, {
      actor: user, action: "auth.login_failed", entity_type: "user", entity_id: user?.id ?? null, summary: email, ip_address: ip,
    });
    await db.commit();
    throw new HttpError(401, "Invalid email or password");
  }
  if (user.status !== "active") throw new HttpError(403, "This account is deactivated");

  if (!settings.MFA_ENFORCED) {
    const token = await startSession(db, user, ip, agent);
    return { status: "ok", access_token: token, user: meOut(user) };
  }

  const mfaToken = createToken(user.id, "mfa", settings.MFA_TOKEN_MINUTES);
  if (user.mfa_enabled) return { status: "mfa_required", mfa_token: mfaToken };

  let secret = user.mfa_secret;
  if (!secret) {
    secret = newTotpSecret();
    await db.update(users).set({ mfa_secret: secret }).where(eq(users.id, user.id));
    await db.commit();
  }
  return { status: "mfa_setup", mfa_token: mfaToken, mfa_secret: secret, otpauth_url: totpUri(secret, user.email) };
}

export async function verifyMfa(db: Db, mfaToken: string, code: string, ip: string | null, agent: string | null) {
  let payload: Record<string, any>;
  try {
    payload = decodeToken(mfaToken);
  } catch {
    throw new HttpError(401, "Verification expired, sign in again");
  }
  if (payload.purpose !== "mfa") throw new HttpError(401, "Invalid verification token");
  const user = await loadUser(db, payload.sub);
  if (!user || user.status !== "active" || !user.mfa_secret) throw new HttpError(401, "Invalid verification token");
  if (!verifyTotp(user.mfa_secret, code)) {
    await audit.record(db, { actor: user, action: "auth.mfa_failed", entity_type: "user", entity_id: user.id, ip_address: ip });
    await db.commit();
    throw new HttpError(401, "Incorrect code");
  }
  if (!user.mfa_enabled) {
    await db.update(users).set({ mfa_enabled: true }).where(eq(users.id, user.id));
    user.mfa_enabled = true;
    await audit.record(db, { actor: user, action: "auth.mfa_enrolled", entity_type: "user", entity_id: user.id, ip_address: ip });
  }
  const token = await startSession(db, user, ip, agent);
  return { status: "ok", access_token: token, user: meOut(user) };
}

async function startSession(db: Db, user: UserWithRole, ip: string | null, agent: string | null): Promise<string> {
  const session = await insert(db, userSessions, {
    user_id: user.id,
    expires_at: new Date(Date.now() + settings.ACCESS_TOKEN_MINUTES * 60_000),
    ip_address: ip,
    user_agent: (agent ?? "").slice(0, 400),
  });
  const now = utcnow();
  await db.update(users).set({ last_login_at: now }).where(eq(users.id, user.id));
  user.last_login_at = now;
  await audit.record(db, { actor: user, action: "auth.login", entity_type: "user", entity_id: user.id, ip_address: ip });
  await db.commit();
  return createToken(user.id, "access", settings.ACCESS_TOKEN_MINUTES, session.id);
}

export async function logout(db: Db, current: CurrentUser): Promise<void> {
  if (current.session_id) {
    await db
      .update(userSessions)
      .set({ revoked_at: utcnow() })
      .where(and(eq(userSessions.id, current.session_id), isNull(userSessions.revoked_at)));
  }
  await audit.record(db, {
    actor: current, action: "auth.logout", entity_type: "user", entity_id: current.id, ip_address: current.ip_address,
  });
  await db.commit();
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ revoked_at: utcnow() })
    .where(and(eq(userSessions.user_id, userId), isNull(userSessions.revoked_at)));
}

// --- Users ----------------------------------------------------------------------------------

export async function getUser(db: Db, userId: string): Promise<UserWithRole> {
  const user = await loadUser(db, userId);
  if (!user || user.deleted_at) throw new HttpError(404, "User not found");
  return user;
}

export async function createUser(db: Db, data: UserCreate, actor: CurrentUser) {
  const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${data.email.toLowerCase()}`).limit(1);
  if (exists) throw new HttpError(409, "A user with this email already exists");
  if (!(await get(db, roles, data.role_id))) throw new HttpError(422, "Role not found");
  if (!data.is_service && !data.password) throw new HttpError(422, "Password is required for human users");
  const { password, email, ...rest } = data;
  const user = await insert(db, users, {
    ...rest,
    email: email.toLowerCase(),
    password_hash: password ? hashPassword(password) : null,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "user.created", entity_type: "user", entity_id: user.id,
    summary: `${user.full_name} <${user.email}>`, ip_address: actor.ip_address,
  });
  await db.commit();
  return getUser(db, user.id);
}

export async function updateUser(db: Db, user: UserWithRole, data: UserUpdate, actor: CurrentUser) {
  const { password, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const changes = audit.diff(user, values);
  const set: Record<string, any> = { ...values, updated_by_id: actor.id };
  if (password) {
    set.password_hash = hashPassword(password);
    changes.password = { from: "***", to: "***" };
    await revokeAllSessions(db, user.id);
  }
  await db.update(users).set(set).where(eq(users.id, user.id));
  if (Object.keys(changes).length) {
    const action = "role_id" in changes ? "user.permissions_changed" : "user.updated";
    await audit.record(db, { actor, action, entity_type: "user", entity_id: user.id, changes, ip_address: actor.ip_address });
  }
  await db.commit();
  return getUser(db, user.id);
}

export async function deactivateUser(db: Db, user: UserWithRole, data: DeactivateIn, actor: CurrentUser) {
  if (user.id === actor.id) throw new HttpError(400, "You cannot deactivate your own account");
  if (data.reassign_to_id) {
    const target = await getUser(db, data.reassign_to_id);
    if (target.status !== "active") throw new HttpError(422, "Reassignment target is not active");
  }
  await db
    .update(users)
    .set({ status: "inactive", deactivated_at: utcnow(), updated_by_id: actor.id })
    .where(eq(users.id, user.id));
  await revokeAllSessions(db, user.id);
  await db
    .update(serviceCredentials)
    .set({ revoked_at: utcnow() })
    .where(and(eq(serviceCredentials.user_id, user.id), isNull(serviceCredentials.revoked_at)));
  // Modules that own records (opportunities, tasks, territories...) reassign on this event.
  await events.emit(db, "user.deactivated", { user_id: user.id, reassign_to_id: data.reassign_to_id ?? null, actor });
  await audit.record(db, {
    actor, action: "user.deactivated", entity_type: "user", entity_id: user.id, summary: data.reason,
    changes: { reassigned_to: data.reassign_to_id ?? null }, ip_address: actor.ip_address,
  });
  await db.commit();
  return getUser(db, user.id);
}

export async function reactivateUser(db: Db, user: UserWithRole, actor: CurrentUser) {
  await db.update(users).set({ status: "active", deactivated_at: null, updated_by_id: actor.id }).where(eq(users.id, user.id));
  await audit.record(db, { actor, action: "user.reactivated", entity_type: "user", entity_id: user.id, ip_address: actor.ip_address });
  await db.commit();
  return getUser(db, user.id);
}

export async function resetMfa(db: Db, user: UserWithRole, actor: CurrentUser): Promise<void> {
  await db.update(users).set({ mfa_enabled: false, mfa_secret: null }).where(eq(users.id, user.id));
  await revokeAllSessions(db, user.id);
  await audit.record(db, { actor, action: "user.mfa_reset", entity_type: "user", entity_id: user.id, ip_address: actor.ip_address });
  await db.commit();
}

// --- Roles & teams --------------------------------------------------------------------------

export async function createRole(db: Db, data: RoleIn, actor: CurrentUser) {
  const [exists] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, data.key)).limit(1);
  if (exists) throw new HttpError(409, "Role key already exists");
  const role = await insert(db, roles, { ...data, created_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "role.created", entity_type: "role", entity_id: role.id, summary: role.name,
    changes: { permissions: data.permissions }, ip_address: actor.ip_address,
  });
  await db.commit();
  return role;
}

export async function updateRole(db: Db, role: RoleRow, data: RoleUpdate, actor: CurrentUser) {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if (role.key === "admin" && "permissions" in values) throw new HttpError(400, "Admin permissions cannot be changed");
  const changes = audit.diff(role, values);
  await patch(db, roles, role, { ...values, updated_by_id: actor.id });
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "role.permissions_changed", entity_type: "role", entity_id: role.id, summary: role.name,
      changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return role;
}

export async function roleUserCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ k: users.role_id, n: sql<number>`count(*)::int` })
    .from(users)
    .where(isNull(users.deleted_at))
    .groupBy(users.role_id);
  return new Map(rows.map((r) => [r.k, Number(r.n)]));
}

export async function teamMemberCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ k: users.team_id, n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(isNull(users.deleted_at), sql`${users.team_id} is not null`))
    .groupBy(users.team_id);
  return new Map(rows.map((r) => [r.k as string, Number(r.n)]));
}

export async function createTeam(db: Db, name: string, description: string | null | undefined, actor: CurrentUser) {
  const team = await insert(db, teams, { name, description: description ?? null, created_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, { actor, action: "team.created", entity_type: "team", entity_id: team.id, summary: name });
  await db.commit();
  return team;
}

// --- Service credentials ----------------------------------------------------------------------

export async function createCredential(db: Db, data: CredentialIn, actor: CurrentUser) {
  const user = await getUser(db, data.user_id);
  if (!user.is_service) throw new HttpError(422, "Credentials can only be issued to service users");
  const [plain, prefix, keyHash] = newApiKey();
  const cred = await insert(db, serviceCredentials, {
    name: data.name, user_id: user.id, key_prefix: prefix, key_hash: keyHash, scopes: data.scopes,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "credential.created", entity_type: "service_credential", entity_id: cred.id,
    summary: data.name, changes: { scopes: data.scopes }, ip_address: actor.ip_address,
  });
  await db.commit();
  return { cred, plain };
}

export async function revokeCredential(db: Db, cred: typeof serviceCredentials.$inferSelect, actor: CurrentUser) {
  await patch(db, serviceCredentials, cred, { revoked_at: utcnow() });
  await audit.record(db, {
    actor, action: "credential.revoked", entity_type: "service_credential", entity_id: cred.id,
    summary: cred.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return cred;
}

export function credentialOut(c: typeof serviceCredentials.$inferSelect) {
  return {
    id: c.id, name: c.name, user_id: c.user_id, key_prefix: c.key_prefix, scopes: c.scopes,
    last_used_at: c.last_used_at, revoked_at: c.revoked_at, created_at: c.created_at,
  };
}

// --- Seed -----------------------------------------------------------------------------------

export async function seed(db: Db): Promise<void> {
  const existing = new Map((await db.select().from(roles)).map((r) => [r.key, r]));
  for (const spec of DEFAULT_ROLES) {
    if (!existing.has(spec.key)) existing.set(spec.key, await insert(db, roles, { ...spec, is_system: true }));
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if (!n) {
    await insert(db, users, {
      email: settings.SEED_ADMIN_EMAIL.toLowerCase(),
      full_name: "System Administrator",
      password_hash: hashPassword(settings.SEED_ADMIN_PASSWORD),
      job_title: "Administrator",
      role_id: existing.get("admin")!.id,
    });
  }
  await db.commit();
}
