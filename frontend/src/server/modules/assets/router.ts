import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { properties } from "../properties/schema";
import { normKey, todayStr } from "./calc";
import {
  ASSET_STATUSES, assetFinancials, assetMilestones, assets, CONCENTRATION_DIMENSIONS, concentrationLimits,
  FIN_CATEGORIES, GROUP_BYS, MILESTONE_STATUSES, tenantProfiles, varianceExplanations, WATCH_TRIGGERS, watchlistEntries,
  type AssetFinancial, type ConcentrationLimit, type TenantProfile,
} from "./schema";
import {
  assetCreate, assetUpdate, explainIn, explanationText, financialBulkIn, financialIn, limitIn, milestoneIn,
  milestoneUpdate, reviewIn, settingsIn, tenantProfileIn, verifyPeriodsIn, watchResolveIn,
} from "./schemas";
import * as service from "./service";
import type { AssetFilters } from "./service";

export const router = new Router();

const SORTS = {
  property: properties.name, address_line: properties.address_line, status: assets.status,
  property_type: properties.property_type, state: properties.state, acquired_on: assets.acquired_on,
  basis: assets.basis, current_value: assets.current_value, updated_at: assets.updated_at,
};

function filters(ctx: Ctx): AssetFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    property_type: q.strs("property_type"),
    state: q.strs("state"),
    manager_id: q.uuids("manager_id"),
    ids: q.uuids("ids"),
    property_id: q.uuid("property_id"),
    watchlist: q.bool("watchlist"),
  };
}

// ---- Out mappers (response_model equivalents) ----

const financialOut = (f: AssetFinancial) => ({
  id: f.id, asset_id: f.asset_id, period: f.period, account: f.account, category: f.category, amount: f.amount,
  source: f.source, verified: f.verified, verified_at: f.verified_at, is_current: f.is_current, notes: f.notes,
  created_at: f.created_at, created_by_id: f.created_by_id,
});

const limitOut = (l: ConcentrationLimit) => ({
  dimension: l.dimension, key: l.key, max_pct: l.max_pct, severity: l.severity, is_active: l.is_active, notes: l.notes,
  id: l.id, updated_at: l.updated_at,
});

const tenantProfileOut = (t: TenantProfile) => ({
  tenant_name: t.tenant_name, organization_id: t.organization_id, brand: t.brand, industry: t.industry,
  credit_rating: t.credit_rating, credit_watch: t.credit_watch, notes: t.notes,
  id: t.id, tenant_key: t.tenant_key, updated_at: t.updated_at,
});

router.get("/assets", async (ctx) => {
  await ctx.require("assets", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, desc(assets.updated_at));
  const total = await service.countAssets(ctx.db, f);
  const rows = await service.listAssets(ctx.db, f, order, { limit: p.page_size, offset: (p.page - 1) * p.page_size });
  return page(await service.toItems(ctx.db, rows), total, p);
});

router.get("/assets/facets", async (ctx) => {
  await ctx.require("assets", "view");
  const f = filters(ctx);
  return {
    status: await service.facetCounts(ctx.db, f, "status", assets.status),
    property_type: await service.facetCounts(ctx.db, f, "property_type", properties.property_type),
    state: await service.facetCounts(ctx.db, f, "state", properties.state),
  };
});

router.get("/assets/meta", async (ctx) => {
  await ctx.require("assets", "view");
  return {
    statuses: ASSET_STATUSES, categories: FIN_CATEGORIES, group_bys: GROUP_BYS, dimensions: CONCENTRATION_DIMENSIONS,
    milestone_statuses: MILESTONE_STATUSES, watch_triggers: WATCH_TRIGGERS,
  };
});

router.get("/assets/portfolio", async (ctx) => {
  await ctx.require("assets", "view");
  const groupBy = ctx.query.str("group_by") ?? "property_type";
  const f = filters(ctx);
  if (!(GROUP_BYS as readonly string[]).includes(groupBy)) {
    throw new HttpError(422, `group_by must be one of ${GROUP_BYS.join(", ")}`);
  }
  return service.portfolio(ctx.db, f, groupBy);
});

router.get("/assets/portfolio/cash-flow", async (ctx) => {
  await ctx.require("assets", "view");
  const months = ctx.query.int("months", { ge: 1, le: 60 }) ?? 12;
  const end = ctx.query.date("end");
  const f = filters(ctx);
  if (!f.status || !f.status.length) f.status = ["active", "held_for_sale"];
  const rows = await service.listAssets(ctx.db, f);
  return service.cashFlow(ctx.db, rows, months, end);
});

router.get("/assets/concentration", async (ctx) => {
  await ctx.require("assets", "view");
  return service.concentration(ctx.db);
});

router.post("/assets/concentration/check", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const breaches = await service.checkConcentration(ctx.db);
  await audit.record(ctx.db, {
    actor: user, action: "asset.concentration_checked", entity_type: "concentration_limit",
    summary: `${breaches.length} breaches`, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return { breaches };
});

// ---------------------------------------------------------------- concentration limits

router.get("/assets/concentration-limits", async (ctx) => {
  await ctx.require("assets", "view");
  const rows = await ctx.db
    .select()
    .from(concentrationLimits)
    .where(isNull(concentrationLimits.deleted_at))
    .orderBy(asc(concentrationLimits.dimension), asc(concentrationLimits.key));
  return rows.map(limitOut);
});

router.post("/assets/concentration-limits", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  const body = await ctx.body(limitIn);
  const [lim] = await ctx.db
    .insert(concentrationLimits)
    .values({ ...body, created_by_id: user.id, updated_by_id: user.id })
    .returning();
  await audit.record(ctx.db, {
    actor: user, action: "concentration_limit.created", entity_type: "concentration_limit", entity_id: lim.id,
    changes: body, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return created(limitOut(lim));
});

async function getLimit(ctx: Ctx, limitId: string) {
  const [lim] = await ctx.db.select().from(concentrationLimits).where(eq(concentrationLimits.id, limitId)).limit(1);
  if (!lim || lim.deleted_at) throw new HttpError(404, "Limit not found");
  return lim;
}

router.patch("/assets/concentration-limits/{limit_id}", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  const limitId = ctx.uuid("limit_id");
  const body = await ctx.body(limitIn);
  const lim = await getLimit(ctx, limitId);
  const changes = audit.diff(lim, body);
  const [updated] = await ctx.db
    .update(concentrationLimits)
    .set({ ...body, updated_by_id: user.id })
    .where(eq(concentrationLimits.id, lim.id))
    .returning();
  await audit.record(ctx.db, {
    actor: user, action: "concentration_limit.updated", entity_type: "concentration_limit", entity_id: lim.id, changes,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return limitOut(updated);
});

router.delete("/assets/concentration-limits/{limit_id}", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  const lim = await getLimit(ctx, ctx.uuid("limit_id"));
  await ctx.db
    .update(concentrationLimits)
    .set({ deleted_at: new Date(), updated_by_id: user.id })
    .where(eq(concentrationLimits.id, lim.id));
  await audit.record(ctx.db, {
    actor: user, action: "concentration_limit.deleted", entity_type: "concentration_limit", entity_id: lim.id,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return noContent();
});

// ---------------------------------------------------------------- tenant profiles

router.get("/assets/tenant-profiles", async (ctx) => {
  await ctx.require("assets", "view");
  const q = ctx.query.str("q");
  const rows = await ctx.db
    .select()
    .from(tenantProfiles)
    .where(and(isNull(tenantProfiles.deleted_at), q ? ilike(tenantProfiles.tenant_name, `%${q}%`) : undefined))
    .orderBy(asc(tenantProfiles.tenant_name))
    .limit(500);
  return rows.map(tenantProfileOut);
});

router.post("/assets/tenant-profiles", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const body = await ctx.body(tenantProfileIn);
  const key = normKey(body.tenant_name);
  const [existing] = await ctx.db.select().from(tenantProfiles).where(eq(tenantProfiles.tenant_key, key)).limit(1);
  let tp: TenantProfile;
  let changes: Record<string, any>;
  if (!existing) {
    const [row] = await ctx.db
      .insert(tenantProfiles)
      .values({ tenant_key: key, ...body, created_by_id: user.id, updated_by_id: user.id })
      .returning();
    tp = row;
    changes = body;
  } else {
    changes = audit.diff(existing, body);
    const [row] = await ctx.db
      .update(tenantProfiles)
      .set({ ...body, deleted_at: null, updated_by_id: user.id })
      .where(eq(tenantProfiles.id, existing.id))
      .returning();
    tp = row;
  }
  await audit.record(ctx.db, {
    actor: user, action: "tenant_profile.saved", entity_type: "tenant_profile", entity_id: tp.id, summary: tp.tenant_name,
    changes, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return created(tenantProfileOut(tp));
});

// ---------------------------------------------------------------- settings

router.get("/assets/settings", async (ctx) => {
  await ctx.require("assets", "view");
  return service.getSettings(ctx.db);
});

router.put("/assets/settings", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  return service.saveSettings(ctx.db, await ctx.body(settingsIn), user);
});

// ---------------------------------------------------------------- watchlist

router.get("/assets/watchlist", async (ctx) => {
  await ctx.require("assets", "view");
  const status = ctx.query.strs("status");
  const assetId = ctx.query.uuid("asset_id");
  const trigger = ctx.query.strs("trigger");
  const limit = ctx.query.int("limit", { ge: 1, le: 1000 }) ?? 200;
  const t = watchlistEntries;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        isNull(t.deleted_at),
        status?.length ? inArray(t.status, status) : undefined,
        trigger?.length ? inArray(t.trigger, trigger) : undefined,
        assetId ? eq(t.asset_id, assetId) : undefined,
      ),
    )
    .orderBy(desc(t.last_detected_at))
    .limit(limit);
  return service.watchItems(ctx.db, rows);
});

router.post("/assets/watchlist/scan", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.query.uuid("asset_id");
  const result = await service.scanWatchlist(ctx.db, user, assetId ? [assetId] : null);
  await ctx.db.commit();
  return result;
});

router.post("/assets/watchlist/{entry_id}/resolve", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const entryId = ctx.uuid("entry_id");
  const body = await ctx.body(watchResolveIn);
  const [e] = await ctx.db.select().from(watchlistEntries).where(eq(watchlistEntries.id, entryId)).limit(1);
  if (!e || e.deleted_at) throw new HttpError(404, "Watchlist entry not found");
  const resolved = await service.resolveWatch(ctx.db, e, body.status, body.note, user);
  return (await service.watchItems(ctx.db, [resolved]))[0];
});

// ---------------------------------------------------------------- variances

router.get("/assets/variances", async (ctx) => {
  await ctx.require("assets", "view");
  const status = ctx.query.strs("status");
  const unexplained = ctx.query.bool("unexplained") ?? false;
  const assetId = ctx.query.uuid("asset_id");
  const limit = ctx.query.int("limit", { ge: 1, le: 1000 }) ?? 200;
  const t = varianceExplanations;
  let statusCond: SQL | undefined;
  if (unexplained) statusCond = inArray(t.status, ["required", "rejected"]);
  else if (status?.length) statusCond = inArray(t.status, status);
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(isNull(t.deleted_at), statusCond, assetId ? eq(t.asset_id, assetId) : undefined))
    .orderBy(desc(t.period), desc(t.created_at))
    .limit(limit);
  return service.varianceItems(ctx.db, rows);
});

async function getVariance(ctx: Ctx, varianceId: string) {
  const [v] = await ctx.db.select().from(varianceExplanations).where(eq(varianceExplanations.id, varianceId)).limit(1);
  if (!v || v.deleted_at) throw new HttpError(404, "Variance record not found");
  return v;
}

router.post("/assets/variances/{variance_id}/submit", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const varianceId = ctx.uuid("variance_id");
  const body = await ctx.body(explanationText);
  const v = await service.submitExplanation(ctx.db, await getVariance(ctx, varianceId), body.explanation, user);
  return (await service.varianceItems(ctx.db, [v]))[0];
});

router.post("/assets/variances/{variance_id}/review", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  const varianceId = ctx.uuid("variance_id");
  const body = await ctx.body(reviewIn);
  const v = await service.reviewExplanation(ctx.db, await getVariance(ctx, varianceId), body.decision, body.note, user);
  return (await service.varianceItems(ctx.db, [v]))[0];
});

// ---------------------------------------------------------------- milestones / financial rows by id

router.patch("/assets/milestones/{milestone_id}", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const milestoneId = ctx.uuid("milestone_id");
  const body = await ctx.body(milestoneUpdate);
  const [m0] = await ctx.db.select().from(assetMilestones).where(eq(assetMilestones.id, milestoneId)).limit(1);
  if (!m0 || m0.deleted_at) throw new HttpError(404, "Milestone not found");
  const m = await service.updateMilestone(ctx.db, m0, body, user);
  return (await service.milestoneItems(ctx.db, [m]))[0];
});

router.delete("/assets/financials/{financial_id}", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const financialId = ctx.uuid("financial_id");
  const [f] = await ctx.db.select().from(assetFinancials).where(eq(assetFinancials.id, financialId)).limit(1);
  if (!f || f.deleted_at) throw new HttpError(404, "Financial row not found");
  if (f.verified && !user.can("assets", "approve")) {
    throw new HttpError(403, "Deleting a verified actual requires approval permission");
  }
  await service.deleteFinancial(ctx.db, f, user);
  return noContent();
});

router.get("/assets/by-property/{property_id}", async (ctx) => {
  await ctx.require("assets", "view");
  const a = await service.byProperty(ctx.db, ctx.uuid("property_id"));
  if (!a) throw new HttpError(404, "This property has no asset record");
  return service.toOut(ctx.db, a);
});

// ---------------------------------------------------------------- asset record

router.post("/assets", async (ctx) => {
  const user = await ctx.require("assets", "create");
  const body = await ctx.body(assetCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/assets/{asset_id}", async (ctx) => {
  await ctx.require("assets", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("asset_id")));
});

router.patch("/assets/{asset_id}", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(assetUpdate);
  const a = await service.update(ctx.db, await service.get(ctx.db, assetId), body, user);
  return service.toOut(ctx.db, a);
});

router.delete("/assets/{asset_id}", async (ctx) => {
  const user = await ctx.require("assets", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("asset_id")), user);
  return noContent();
});

router.get("/assets/{asset_id}/history", async (ctx) => {
  await ctx.require("assets", "view");
  return provenance.history(ctx.db, service.ENTITY, ctx.uuid("asset_id"), ctx.query.str("field"));
});

router.get("/assets/{asset_id}/financials", async (ctx) => {
  await ctx.require("assets", "view");
  const assetId = ctx.uuid("asset_id");
  const periodFrom = ctx.query.date("period_from");
  const periodTo = ctx.query.date("period_to");
  const category = ctx.query.strs("category");
  const account = ctx.query.str("account");
  const includeHistory = ctx.query.bool("include_history") ?? false;
  await service.get(ctx.db, assetId);
  const t = assetFinancials;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.asset_id, assetId),
        // history = superseded and deleted rows too (is_current=False)
        includeHistory ? undefined : and(eq(t.is_current, true), isNull(t.deleted_at)),
        periodFrom ? sql`${t.period} >= ${periodFrom}` : undefined,
        periodTo ? sql`${t.period} <= ${periodTo}` : undefined,
        category?.length ? inArray(t.category, category) : undefined,
        account ? eq(t.account, account) : undefined,
      ),
    )
    .orderBy(desc(t.period), asc(t.category), asc(t.account), desc(t.created_at))
    .limit(5000);
  return rows.map(financialOut);
});

router.post("/assets/{asset_id}/financials", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(financialIn);
  const f = await service.addFinancial(ctx.db, await service.get(ctx.db, assetId), body, user);
  return created(financialOut(f));
});

router.post("/assets/{asset_id}/financials/bulk", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(financialBulkIn);
  return service.bulkFinancials(ctx.db, await service.get(ctx.db, assetId), body.rows, body.source, user);
});

router.post("/assets/{asset_id}/financials/verify", async (ctx) => {
  const user = await ctx.require("assets", "approve");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(verifyPeriodsIn);
  const n = await service.verifyFinancials(ctx.db, await service.get(ctx.db, assetId), body.period_from, body.period_to, user);
  return { verified: n };
});

router.get("/assets/{asset_id}/performance", async (ctx) => {
  await ctx.require("assets", "view");
  const assetId = ctx.uuid("asset_id");
  const year = ctx.query.int("year", { ge: 1990, le: 2100 });
  const month = ctx.query.int("month", { ge: 1, le: 12 });
  return service.performance(
    ctx.db, await service.get(ctx.db, assetId), year ?? Number(todayStr().slice(0, 4)), month,
  );
});

router.post("/assets/{asset_id}/variances/scan", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const year = ctx.query.int("year", { ge: 1990, le: 2100 });
  const month = ctx.query.int("month", { ge: 1, le: 12 });
  const a = await service.get(ctx.db, assetId);
  const n = await service.detectVariances(ctx.db, a, year ?? Number(todayStr().slice(0, 4)), month, user);
  await audit.record(ctx.db, {
    actor: user, action: "asset.variances_scanned", entity_type: "asset", entity_id: a.id,
    summary: `${n} explanations required`, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return { created: n };
});

router.post("/assets/{asset_id}/variances/explain", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(explainIn);
  const v = await service.explain(ctx.db, await service.get(ctx.db, assetId), body, user);
  return (await service.varianceItems(ctx.db, [v]))[0];
});

router.get("/assets/{asset_id}/cash-flow", async (ctx) => {
  await ctx.require("assets", "view");
  const assetId = ctx.uuid("asset_id");
  const months = ctx.query.int("months", { ge: 1, le: 60 }) ?? 12;
  const end = ctx.query.date("end");
  return service.cashFlow(ctx.db, [await service.get(ctx.db, assetId)], months, end);
});

router.get("/assets/{asset_id}/milestones", async (ctx) => {
  await ctx.require("assets", "view");
  const assetId = ctx.uuid("asset_id");
  const t = assetMilestones;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.asset_id, assetId), isNull(t.deleted_at)))
    .orderBy(sql`${t.due_on} asc nulls last`, asc(t.created_at));
  return service.milestoneItems(ctx.db, rows);
});

router.post("/assets/{asset_id}/milestones", async (ctx) => {
  const user = await ctx.require("assets", "edit");
  const assetId = ctx.uuid("asset_id");
  const body = await ctx.body(milestoneIn);
  const m = await service.createMilestone(ctx.db, await service.get(ctx.db, assetId), body, user);
  return created((await service.milestoneItems(ctx.db, [m]))[0]);
});
