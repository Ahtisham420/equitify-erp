import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import { applySort, inFilter, page, paginate } from "../../common/query";
import { Router, type Ctx } from "../../core/router";
import type { Db } from "../../db";
import { get } from "../../db/orm";
import { ACTIVE_STAGES, DEAD_REASONS, opportunities } from "../pipeline/schema";
import { REACTIVATION_SPEC } from "../pipeline/service";
import {
  ITEM_STATUSES,
  REVISIT_DAYS_BY_REASON,
  TRIGGER_STATUSES,
  reactivationItems,
  reactivationTriggers,
} from "./schema";
import { armIn, cancelIn, dismissIn, reactivateIn, snoozeIn, triggerUpdate } from "./schemas";
import * as service from "./service";
import type { ItemFilters } from "./service";

export const router = new Router();

const ITEM_SORTS = {
  fired_at: reactivationItems.fired_at, trigger_type: reactivationItems.trigger_type,
  status: reactivationItems.status, score_after: reactivationItems.score_after,
  snoozed_until: reactivationItems.snoozed_until,
};

router.get("/reactivation/meta", async (ctx) => {
  await ctx.require("reactivation", "view");
  return {
    trigger_types: Object.entries(service.TYPE_LABELS).map(([k, v]) => {
      const { label: _label, ...rest } = (REACTIVATION_SPEC as Record<string, Record<string, any>>)[k] ?? {};
      return { type: k, label: v, ...rest };
    }),
    item_statuses: ITEM_STATUSES, trigger_statuses: TRIGGER_STATUSES,
    reactivate_stages: [...ACTIVE_STAGES, "nurture"], dead_reasons: DEAD_REASONS,
    revisit_days_by_reason: REVISIT_DAYS_BY_REASON,
    property_fields: service.propertyFields(), field_operators: service.FIELD_OPERATORS,
  };
});

// ----------------------------------------------------------------------------- queue

function itemFilters(ctx: Ctx, actorId: string): ItemFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status_: q.strs("status"),
    trigger_type: q.strs("trigger_type"),
    owner_id: q.strs("owner_id"),
    opportunity_id: q.uuid("opportunity_id"),
    property_id: q.uuid("property_id"),
    actor_id: actorId,
  };
}

const joined = (db: Db) =>
  db.select({ i: reactivationItems }).from(reactivationItems).innerJoin(opportunities, eq(opportunities.id, reactivationItems.opportunity_id));

async function itemFacet(db: Db, where: SQL | undefined, expr: SQL | any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: expr, n: sql<number>`count(*)::int` })
    .from(reactivationItems)
    .innerJoin(opportunities, eq(opportunities.id, reactivationItems.opportunity_id))
    .where(where)
    .groupBy(expr);
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ k: unknown; n: number }>) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

router.get("/reactivation/items", async (ctx) => {
  const user = await ctx.require("reactivation", "view");
  const params = ctx.listParams();
  const where = service.itemWhere(itemFilters(ctx, user.id));
  const order = applySort(params.sort, ITEM_SORTS, desc(reactivationItems.fired_at));
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(reactivationItems)
    .innerJoin(opportunities, eq(opportunities.id, reactivationItems.opportunity_id))
    .where(where);
  const rows = await joined(ctx.db)
    .where(where)
    .orderBy(...order)
    .limit(params.page_size)
    .offset((params.page - 1) * params.page_size);
  return page(await service.itemOuts(ctx.db, rows.map((r) => r.i)), Number(n), params);
});

router.get("/reactivation/items/facets", async (ctx) => {
  const user = await ctx.require("reactivation", "view");
  const f = itemFilters(ctx, user.id);
  return {
    status: await itemFacet(ctx.db, service.itemWhere(f, new Set(["status"])), service.effectiveStatusExpr()),
    trigger_type: await itemFacet(ctx.db, service.itemWhere(f, new Set(["trigger_type"])), reactivationItems.trigger_type),
    owner_id: await itemFacet(ctx.db, service.itemWhere(f, new Set(["owner_id"])), reactivationItems.owner_id),
  };
});

router.get("/reactivation/items/{item_id}", async (ctx) => {
  await ctx.require("reactivation", "view");
  return (await service.itemOuts(ctx.db, [await service.getItem(ctx.db, ctx.uuid("item_id"))]))[0];
});

router.post("/reactivation/items/{item_id}/reactivate", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(reactivateIn);
  const item0 = await service.reactivate(
    ctx.db, await service.getItem(ctx.db, ctx.uuid("item_id")), body.to_stage, body.override_reason, body.note, body.fields, user,
  );
  const item = (await get(ctx.db, reactivationItems, item0.id)) ?? item0;
  return (await service.itemOuts(ctx.db, [item]))[0];
});

router.post("/reactivation/items/{item_id}/snooze", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(snoozeIn);
  const item = await service.snooze(ctx.db, await service.getItem(ctx.db, ctx.uuid("item_id")), body.until, body.reason, user);
  return (await service.itemOuts(ctx.db, [item]))[0];
});

router.post("/reactivation/items/{item_id}/dismiss", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(dismissIn);
  const item = await service.dismiss(ctx.db, await service.getItem(ctx.db, ctx.uuid("item_id")), body.reason, body.rearm, user);
  return (await service.itemOuts(ctx.db, [item]))[0];
});

// ----------------------------------------------------------------------------- triggers

router.get("/reactivation/triggers", async (ctx) => {
  await ctx.require("reactivation", "view");
  const params = ctx.listParams();
  const q = ctx.query;
  const t = reactivationTriggers;
  const opportunityId = q.uuid("opportunity_id");
  const propertyId = q.uuid("property_id");
  const where = and(
    isNull(t.deleted_at),
    inFilter(t.status, q.strs("status")),
    inFilter(t.trigger_type, q.strs("trigger_type")),
    opportunityId ? eq(t.opportunity_id, opportunityId) : undefined,
    propertyId ? eq(t.property_id, propertyId) : undefined,
  );
  const order = applySort(
    params.sort,
    { armed_at: t.armed_at, fire_on: t.fire_on, last_checked_at: t.last_checked_at, trigger_type: t.trigger_type },
    desc(t.armed_at),
  );
  const [rows, total] = await paginate(ctx.db, t, where, order, params);
  return page(await service.triggerOuts(ctx.db, rows), total, params);
});

router.patch("/reactivation/triggers/{trigger_id}", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(triggerUpdate);
  const t = await service.updateTrigger(ctx.db, await service.getTrigger(ctx.db, ctx.uuid("trigger_id")), body.params, user);
  return (await service.triggerOuts(ctx.db, [t]))[0];
});

router.post("/reactivation/triggers/{trigger_id}/cancel", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(cancelIn);
  const t = await service.cancelTrigger(ctx.db, await service.getTrigger(ctx.db, ctx.uuid("trigger_id")), body.reason, user);
  return (await service.triggerOuts(ctx.db, [t]))[0];
});

router.post("/reactivation/opportunities/{opportunity_id}/arm", async (ctx) => {
  const user = await ctx.require("reactivation", "edit");
  const body = await ctx.body(armIn);
  const rows = await service.armManual(ctx.db, ctx.uuid("opportunity_id"), body.trigger_type, body.params, user);
  return service.triggerOuts(ctx.db, rows);
});

// ----------------------------------------------------------------------------- scan & analytics

router.post("/reactivation/scan", async (ctx) => {
  const user = await ctx.require("reactivation", "approve");
  return service.scan(ctx.db, user);
});

router.get("/reactivation/analytics", async (ctx) => {
  await ctx.require("reactivation", "view");
  return service.analytics(ctx.db, ctx.query.int("since_days", { ge: 1, le: 3650 }));
});
