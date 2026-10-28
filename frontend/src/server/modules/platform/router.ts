import { and, desc, eq, inArray } from "drizzle-orm";

import { applySearch, page, paginate } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Router } from "../../core/router";
import * as ai from "../documents/ai";
import * as aiFeatures from "./ai_features";
import {
  INTEGRATION_CATEGORIES, jobRuns, webhookDeliveries, webhookSubscriptions, type LegalHold,
} from "./schema";
import {
  acceptIn, backupIn, credentialsIn, flagCreate, flagUpdate, holdIn, integrationCreate, integrationUpdate, nlQueryIn,
  releaseIn, retentionIn, subscriptionCreate, subscriptionUpdate,
} from "./schemas";
import * as service from "./service";

export const router = new Router();

const VIEW = ["platform", "view"] as const;
const ADMIN = ["platform", "approve"] as const; // admin-only writes (admins hold every permission)

const holdOut = (h: LegalHold, placedByName: string | null = null) => ({
  id: h.id,
  entity_type: h.entity_type,
  entity_id: h.entity_id,
  reason: h.reason,
  matter: h.matter,
  placed_by_id: h.placed_by_id,
  placed_by_name: placedByName,
  placed_at: h.placed_at,
  released_at: h.released_at,
  released_by_id: h.released_by_id,
  release_reason: h.release_reason,
});

const retentionOut = (r: Awaited<ReturnType<typeof service.listRetention>>[number]) => ({
  id: r.id,
  entity_type: r.entity_type,
  retain_days: r.retain_days,
  action: r.action,
  description: r.description,
  is_active: r.is_active,
  updated_at: r.updated_at,
});

const flagOut = (f: Awaited<ReturnType<typeof service.listFlags>>[number]) => ({
  id: f.id,
  key: f.key,
  description: f.description,
  enabled: f.enabled,
  is_sensitive: f.is_sensitive,
  rollout_roles: f.rollout_roles,
  rollout_user_ids: f.rollout_user_ids,
  updated_at: f.updated_at,
  updated_by_id: f.updated_by_id,
});

// --- Overview -------------------------------------------------------------------------------------

router.get("/platform/health", async (ctx) => {
  await ctx.require(...VIEW);
  return service.health(ctx.db);
});

router.get("/platform/environment", async (ctx) => {
  await ctx.require(...VIEW);
  return service.environmentInfo();
});

/** Versioned API (/api/v1) and the scopes available to service credentials (MODULES x ACTIONS). */
router.get("/platform/api", async (ctx) => {
  await ctx.require(...VIEW);
  return service.apiCatalog();
});

// --- Integrations ---------------------------------------------------------------------------------

router.get("/platform/integrations", async (ctx) => {
  await ctx.require(...VIEW);
  return service.listCatalog(ctx.db);
});

router.get("/platform/integrations/categories", async (ctx) => {
  await ctx.require(...VIEW);
  return Object.entries(INTEGRATION_CATEGORIES).map(([key, label]) => ({ key, label }));
});

router.post("/platform/integrations", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(integrationCreate);
  return created(service.integrationOut(await service.createIntegration(ctx.db, body, user)));
});

router.patch("/platform/integrations/{integration_id}", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(integrationUpdate);
  const row = await service.getIntegration(ctx.db, ctx.uuid("integration_id"));
  return service.integrationOut(await service.updateIntegration(ctx.db, row, body, user));
});

router.put("/platform/integrations/{integration_id}/credentials", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(credentialsIn);
  const row = await service.getIntegration(ctx.db, ctx.uuid("integration_id"));
  return service.integrationOut(await service.rotateCredentials(ctx.db, row, body, user));
});

router.post("/platform/integrations/{integration_id}/test", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const row = await service.getIntegration(ctx.db, ctx.uuid("integration_id"));
  const [ok, message, missing] = await service.testIntegration(ctx.db, row, user);
  return { ok, message, missing, integration: service.integrationOut(row) };
});

router.delete("/platform/integrations/{integration_id}", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  await service.archiveIntegration(ctx.db, await service.getIntegration(ctx.db, ctx.uuid("integration_id")), user);
  return noContent();
});

// --- Feature flags --------------------------------------------------------------------------------

router.get("/platform/flags", async (ctx) => {
  await ctx.require(...VIEW);
  return (await service.listFlags(ctx.db)).map(flagOut);
});

/** Any signed-in user may ask whether a flag is on for them. */
router.get("/platform/flags/check/{key}", async (ctx) => {
  const user = await ctx.authed();
  const key = ctx.param("key");
  return { key, enabled: await service.flagEnabled(ctx.db, key, user) };
});

router.post("/platform/flags", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(flagCreate);
  return created(flagOut(await service.createFlag(ctx.db, body, user)));
});

router.patch("/platform/flags/{flag_id}", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(flagUpdate);
  return flagOut(await service.updateFlag(ctx.db, await service.getFlag(ctx.db, ctx.uuid("flag_id")), body, user));
});

// --- Webhooks -------------------------------------------------------------------------------------

router.get("/platform/webhooks/events", async (ctx) => {
  await ctx.require(...VIEW);
  return service.WEBHOOK_EVENTS;
});

router.get("/platform/webhooks/subscriptions", async (ctx) => {
  await ctx.require(...VIEW);
  return (await service.listSubscriptions(ctx.db)).map((s) => service.subscriptionOut(s));
});

router.post("/platform/webhooks/subscriptions", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(subscriptionCreate);
  return created(await service.createSubscription(ctx.db, body, user));
});

router.patch("/platform/webhooks/subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(subscriptionUpdate);
  const s = await service.updateSubscription(ctx.db, await service.getSubscription(ctx.db, ctx.uuid("sub_id")), body, user);
  return service.subscriptionOut(s);
});

router.post("/platform/webhooks/subscriptions/{sub_id}/rotate-secret", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  return service.rotateSecret(ctx.db, await service.getSubscription(ctx.db, ctx.uuid("sub_id")), user);
});

router.post("/platform/webhooks/subscriptions/{sub_id}/test", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  return { queued: await service.sendTest(ctx.db, await service.getSubscription(ctx.db, ctx.uuid("sub_id")), user) };
});

router.delete("/platform/webhooks/subscriptions/{sub_id}", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  await service.archiveSubscription(ctx.db, await service.getSubscription(ctx.db, ctx.uuid("sub_id")), user);
  return noContent();
});

router.get("/platform/webhooks/deliveries", async (ctx) => {
  await ctx.require(...VIEW);
  const p = ctx.listParams();
  const status = ctx.query.strs("status");
  const event = ctx.query.strs("event");
  const subscriptionId = ctx.query.uuid("subscription_id");
  const d = webhookDeliveries;
  const where = and(
    status ? inArray(d.status, status) : undefined,
    event ? inArray(d.event, event) : undefined,
    subscriptionId ? eq(d.subscription_id, subscriptionId) : undefined,
    applySearch(p.q, [d.event, d.last_error]),
  );
  const [rows, total] = await paginate(ctx.db, d, where, [desc(d.created_at)], p);
  const names = new Map<string, string>();
  if (rows.length) {
    const s = webhookSubscriptions;
    const subs = await ctx.db
      .select({ id: s.id, name: s.name })
      .from(s)
      .where(inArray(s.id, [...new Set(rows.map((r) => r.subscription_id as string))]));
    for (const r of subs) names.set(r.id, r.name);
  }
  return page(rows.map((r) => ({ ...r, subscription_name: names.get(r.subscription_id as string) ?? null })), total, p);
});

router.post("/platform/webhooks/deliveries/{delivery_id}/retry", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const r = await service.retryDelivery(ctx.db, ctx.uuid("delivery_id"), user);
  return { ...r, subscription_name: null };
});

/** Delivery worker: call from a scheduler (service credential with platform:approve) or manually. */
router.post("/platform/webhooks/deliver-pending", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const limit = ctx.query.int("limit", { ge: 1, le: 500 }) ?? 50;
  return service.deliverPending(ctx.db, user, limit);
});

// --- Jobs -----------------------------------------------------------------------------------------

router.get("/platform/jobs", async (ctx) => {
  await ctx.require(...VIEW);
  const p = ctx.listParams();
  const status = ctx.query.strs("status");
  const jobKey = ctx.query.strs("job_key");
  const j = jobRuns;
  const where = and(
    status ? inArray(j.status, status) : undefined,
    jobKey ? inArray(j.job_key, jobKey) : undefined,
    applySearch(p.q, [j.job_key, j.error]),
  );
  const [rows, total] = await paginate(ctx.db, j, where, [desc(j.started_at)], p);
  return page(rows, total, p);
});

router.get("/platform/jobs/summary", async (ctx) => {
  await ctx.require(...VIEW);
  return service.jobSummary(ctx.db, ctx.query.int("days", { ge: 1, le: 90 }) ?? 7);
});

// --- Bulk-export monitor --------------------------------------------------------------------------

router.get("/platform/exports", async (ctx) => {
  await ctx.require(...VIEW);
  const p = ctx.listParams();
  const days = ctx.query.int("days", { ge: 1, le: 3650 }) ?? 30;
  const actorId = ctx.query.uuid("actor_id");
  const [rows, total] = await service.listExports(ctx.db, p, days, actorId);
  const items = rows.map((e) => ({
    id: e.id, occurred_at: e.occurred_at, actor_id: e.actor_id, actor_name: e.actor_name, action: e.action,
    entity_type: e.entity_type, summary: e.summary, rows: service.exportRows(e), ip_address: e.ip_address,
  }));
  return page(items, total, p);
});

router.get("/platform/exports/by-user", async (ctx) => {
  await ctx.require(...VIEW);
  return service.exportsByUser(ctx.db, ctx.query.int("days", { ge: 1, le: 3650 }) ?? 30);
});

// --- Retention & legal holds ----------------------------------------------------------------------

router.get("/platform/retention", async (ctx) => {
  await ctx.require(...VIEW);
  return (await service.listRetention(ctx.db)).map(retentionOut);
});

router.post("/platform/retention", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(retentionIn);
  return retentionOut(await service.upsertRetention(ctx.db, body, user));
});

router.get("/platform/legal-holds", async (ctx) => {
  await ctx.require(...VIEW);
  const rows = await service.listHolds(ctx.db, ctx.query.bool("active") ?? true);
  const names = await service.userNames(ctx.db, rows.map((h) => h.placed_by_id));
  return rows.map((h) => holdOut(h, h.placed_by_id ? names[h.placed_by_id] ?? null : null));
});

router.get("/platform/legal-holds/check", async (ctx) => {
  await ctx.authed();
  const entityType = ctx.query.need("entity_type");
  const entityId = ctx.query.uuid("entity_id") ?? null;
  return { entity_type: entityType, entity_id: entityId, on_hold: await service.onLegalHold(ctx.db, entityType, entityId) };
});

router.post("/platform/legal-holds", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(holdIn);
  const h = await service.placeHold(ctx.db, body, user);
  return created(holdOut(h, user.full_name));
});

router.post("/platform/legal-holds/{hold_id}/release", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(releaseIn);
  return holdOut(await service.releaseHold(ctx.db, ctx.uuid("hold_id"), body.reason, user));
});

// --- Backups --------------------------------------------------------------------------------------

router.get("/platform/backups", async (ctx) => {
  await ctx.require(...VIEW);
  return (await service.listBackups(ctx.db, ctx.query.str("kind"))).map(service.backupOut);
});

router.post("/platform/backups", async (ctx) => {
  const user = await ctx.require(...ADMIN);
  const body = await ctx.body(backupIn);
  return created(service.backupOut(await service.recordBackup(ctx.db, body, user)));
});

// --- AI (Release 6) -------------------------------------------------------------------------------

router.get("/platform/ai/status", async (ctx) => {
  await ctx.authed();
  return ai.providerStatus();
});

router.post("/platform/ai/nl-query", async (ctx) => {
  const user = await ctx.require("properties", "view");
  const body = await ctx.body(nlQueryIn);
  return aiFeatures.nlQuery(ctx.db, body.question.trim(), body.page, body.page_size, user);
});

router.get("/platform/ai/interactions/{interaction_id}/suggestions", async (ctx) => {
  await ctx.require("outreach", "view");
  return (await aiFeatures.listSuggestions(ctx.db, "interaction", ctx.uuid("interaction_id"))).map(aiFeatures.suggestionOut);
});

router.post("/platform/ai/interactions/{interaction_id}/summarize", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  return aiFeatures.summarizeInteraction(ctx.db, ctx.uuid("interaction_id"), user);
});

router.post("/platform/ai/suggestions/{suggestion_id}/accept", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  const body = await ctx.body(acceptIn);
  return aiFeatures.suggestionOut(await aiFeatures.acceptSuggestion(ctx.db, ctx.uuid("suggestion_id"), body, user));
});

router.post("/platform/ai/suggestions/{suggestion_id}/reject", async (ctx) => {
  const user = await ctx.require("outreach", "edit");
  return aiFeatures.suggestionOut(await aiFeatures.rejectSuggestion(ctx.db, ctx.uuid("suggestion_id"), user));
});

router.get("/platform/ai/talking-points/{person_id}", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  return aiFeatures.talkingPoints(ctx.db, ctx.uuid("person_id"), user);
});
