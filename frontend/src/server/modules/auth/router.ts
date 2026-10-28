import { and, desc, eq, isNull } from "drizzle-orm";

import { applySearch, applySort, inFilter, page, paginate, rangeFilter } from "../../common/query";
import { auditEvents } from "../../common/schema";
import { created, HttpError, noContent } from "../../core/http";
import { Router } from "../../core/router";
import { get } from "../../db/orm";
import { ACTIONS, MODULES } from "./permissions";
import { credentialIn, deactivateIn, loginIn, mfaVerifyIn, roleIn, roleUpdate, teamIn, userCreate, userUpdate } from "./schemas";
import * as service from "./service";
import { roles, serviceCredentials, teams, userSessions, users } from "./schema";

export const router = new Router();

// --- Auth -----------------------------------------------------------------------------------

router.post("/auth/login", async (ctx) => {
  const body = await ctx.body(loginIn);
  return service.login(ctx.db, body.email, body.password, ctx.ip, ctx.userAgent);
});

router.post("/auth/mfa/verify", async (ctx) => {
  const body = await ctx.body(mfaVerifyIn);
  return service.verifyMfa(ctx.db, body.mfa_token, body.code, ctx.ip, ctx.userAgent);
});

router.post("/auth/logout", async (ctx) => {
  await service.logout(ctx.db, await ctx.authed());
  return noContent();
});

router.get("/auth/me", async (ctx) => service.meOut((await ctx.authed()).user));

router.get("/auth/permissions", async (ctx) => {
  await ctx.authed();
  return { modules: MODULES, actions: ACTIONS };
});

// --- Users ----------------------------------------------------------------------------------

router.get("/users", async (ctx) => {
  await ctx.require("users", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const where = and(
    isNull(users.deleted_at),
    applySearch(p.q, [users.full_name, users.email, users.job_title]),
    inFilter(users.role_id, q.uuids("role_id")),
    inFilter(users.team_id, q.uuids("team_id")),
    inFilter(users.status, q.strs("status")),
    q.bool("is_service") !== undefined ? eq(users.is_service, q.bool("is_service")!) : undefined,
  );
  const order = applySort(
    p.sort,
    { full_name: users.full_name, email: users.email, status: users.status, last_login_at: users.last_login_at, created_at: users.created_at },
    users.full_name,
  );
  const [rows, total] = await paginate(ctx.db, users, where, order, p);
  const items = await withRoles(ctx.db, rows);
  return page(items, total, p);
});

async function withRoles(db: any, rows: (typeof users.$inferSelect)[]) {
  const roleRows = new Map((await db.select().from(roles)).map((r: any) => [r.id, r]));
  return rows.map((u) => service.userOut({ ...u, role: roleRows.get(u.role_id) as any }));
}

/** Lightweight list of active users for owner/assignee pickers. */
router.get("/users/options", async (ctx) => {
  await ctx.authed();
  const rows = await ctx.db
    .select()
    .from(users)
    .where(and(isNull(users.deleted_at), eq(users.status, "active"), eq(users.is_service, false)))
    .orderBy(users.full_name);
  return withRoles(ctx.db, rows);
});

router.post("/users", async (ctx) => {
  const actor = await ctx.require("users", "create");
  const body = await ctx.body(userCreate);
  return created(service.userOut(await service.createUser(ctx.db, body, actor)));
});

router.get("/users/{user_id}", async (ctx) => {
  await ctx.require("users", "view");
  return service.userOut(await service.getUser(ctx.db, ctx.uuid("user_id")));
});

router.patch("/users/{user_id}", async (ctx) => {
  const actor = await ctx.require("users", "edit");
  const body = await ctx.body(userUpdate);
  const user = await service.getUser(ctx.db, ctx.uuid("user_id"));
  return service.userOut(await service.updateUser(ctx.db, user, body, actor));
});

router.post("/users/{user_id}/deactivate", async (ctx) => {
  const actor = await ctx.require("users", "edit");
  const body = await ctx.body(deactivateIn);
  const user = await service.getUser(ctx.db, ctx.uuid("user_id"));
  return service.userOut(await service.deactivateUser(ctx.db, user, body, actor));
});

router.post("/users/{user_id}/reactivate", async (ctx) => {
  const actor = await ctx.require("users", "edit");
  const user = await service.getUser(ctx.db, ctx.uuid("user_id"));
  return service.userOut(await service.reactivateUser(ctx.db, user, actor));
});

router.post("/users/{user_id}/reset-mfa", async (ctx) => {
  const actor = await ctx.require("users", "edit");
  await service.resetMfa(ctx.db, await service.getUser(ctx.db, ctx.uuid("user_id")), actor);
  return noContent();
});

router.get("/users/{user_id}/sessions", async (ctx) => {
  await ctx.require("users", "view");
  return ctx.db
    .select()
    .from(userSessions)
    .where(eq(userSessions.user_id, ctx.uuid("user_id")))
    .orderBy(desc(userSessions.created_at))
    .limit(50);
});

// --- Roles & teams --------------------------------------------------------------------------

router.get("/roles", async (ctx) => {
  await ctx.authed();
  const counts = await service.roleUserCounts(ctx.db);
  const rows = await ctx.db.select().from(roles).where(isNull(roles.deleted_at)).orderBy(roles.name);
  return rows.map((r) => service.roleOut(r, counts.get(r.id) ?? 0));
});

router.post("/roles", async (ctx) => {
  const actor = await ctx.require("users", "approve");
  const body = await ctx.body(roleIn);
  return created(service.roleOut(await service.createRole(ctx.db, body, actor)));
});

router.patch("/roles/{role_id}", async (ctx) => {
  const actor = await ctx.require("users", "approve");
  const body = await ctx.body(roleUpdate);
  const role = await get(ctx.db, roles, ctx.uuid("role_id"));
  if (!role) throw new HttpError(404, "Role not found");
  return service.roleOut(await service.updateRole(ctx.db, role, body, actor));
});

router.get("/teams", async (ctx) => {
  await ctx.authed();
  const counts = await service.teamMemberCounts(ctx.db);
  const rows = await ctx.db.select().from(teams).where(isNull(teams.deleted_at)).orderBy(teams.name);
  return rows.map((t) => ({ id: t.id, name: t.name, description: t.description, member_count: counts.get(t.id) ?? 0 }));
});

router.post("/teams", async (ctx) => {
  const actor = await ctx.require("users", "create");
  const body = await ctx.body(teamIn);
  const t = await service.createTeam(ctx.db, body.name, body.description, actor);
  return created({ id: t.id, name: t.name, description: t.description, member_count: 0 });
});

// --- Service credentials ----------------------------------------------------------------------

router.get("/service-credentials", async (ctx) => {
  await ctx.require("users", "view");
  const rows = await ctx.db.select().from(serviceCredentials).orderBy(desc(serviceCredentials.created_at));
  return rows.map(service.credentialOut);
});

router.post("/service-credentials", async (ctx) => {
  const actor = await ctx.require("users", "approve");
  const body = await ctx.body(credentialIn);
  const { cred, plain } = await service.createCredential(ctx.db, body, actor);
  return created({ ...service.credentialOut(cred), api_key: plain });
});

router.post("/service-credentials/{cred_id}/revoke", async (ctx) => {
  const actor = await ctx.require("users", "approve");
  const cred = await get(ctx.db, serviceCredentials, ctx.uuid("cred_id"));
  if (!cred) throw new HttpError(404, "Credential not found");
  return service.credentialOut(await service.revokeCredential(ctx.db, cred, actor));
});

// --- Audit ----------------------------------------------------------------------------------

router.get("/audit", async (ctx) => {
  await ctx.require("audit", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const where = and(
    applySearch(p.q, [auditEvents.summary, auditEvents.action, auditEvents.actor_name]),
    inFilter(auditEvents.entity_type, q.strs("entity_type")),
    inFilter(auditEvents.action, q.strs("action")),
    q.uuid("entity_id") ? eq(auditEvents.entity_id, q.uuid("entity_id")!) : undefined,
    q.uuid("actor_id") ? eq(auditEvents.actor_id, q.uuid("actor_id")!) : undefined,
    rangeFilter(auditEvents.occurred_at, q.datetime("date_from"), q.datetime("date_to")),
  );
  const order = applySort(p.sort, { occurred_at: auditEvents.occurred_at, action: auditEvents.action }, desc(auditEvents.occurred_at));
  const [items, total] = await paginate(ctx.db, auditEvents, where, order, p);
  return page(items, total, p);
});

/** Change history shown on any record page. Viewing a record already required module permission. */
router.get("/timeline/{entity_type}/{entity_id}", async (ctx) => {
  await ctx.authed();
  const limit = ctx.query.int("limit", { le: 500 }) ?? 100;
  return ctx.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.entity_type, ctx.param("entity_type")), eq(auditEvents.entity_id, ctx.uuid("entity_id"))))
    .orderBy(desc(auditEvents.occurred_at))
    .limit(limit);
});
