import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { applySort, facetCounts, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { properties } from "../properties/schema";
import {
  EXCEPTION_STATES,
  OPERATORS,
  REQUIREMENTS,
  RESULTS,
  STRATEGY_SUGGESTIONS,
  buyBoxes,
  buyboxEvaluations,
  buyboxVersions,
} from "./schema";
import {
  buyBoxCreate,
  buyBoxUpdate,
  criteriaReplace,
  criterionIn,
  exceptionDecisionIn,
  exceptionRequestIn,
} from "./schemas";
import * as service from "./service";
import type { BuyBoxFilters } from "./service";

export const router = new Router();

const t = buyBoxes;
const SORTS = {
  name: t.name, strategy: t.strategy, version: t.version, is_active: t.is_active, active_from: t.active_from,
  active_to: t.active_to, updated_at: t.updated_at, created_at: t.created_at,
};
const E = buyboxEvaluations;
const EVAL_SORTS = { result: E.result, evaluated_at: E.evaluated_at, buy_box_version: E.buy_box_version };

function filters(ctx: Ctx): BuyBoxFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    strategy: q.strs("strategy"),
    is_active: q.bool("is_active"),
    owner_id: q.uuid("owner_id"),
    result: q.strs("result"),
  };
}

router.get("/buy-boxes", async (ctx) => {
  await ctx.require("buybox", "view");
  const p = ctx.listParams();
  const where = service.buildWhere(filters(ctx));
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const [{ n: total }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(t).where(where);
  const items = await ctx.db
    .select()
    .from(t)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(await service.toItems(ctx.db, items), total, p);
});

router.get("/buy-boxes/facets", async (ctx) => {
  await ctx.require("buybox", "view");
  const f = filters(ctx);
  const active = await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["is_active"])), t.is_active);
  const boxIds = ctx.db.select({ id: t.id }).from(t).where(service.buildWhere(f, new Set(["result"])));
  const rows = await ctx.db
    .select({ r: E.result, n: sql<number>`count(*)::int` })
    .from(E)
    .where(and(eq(E.is_current, true), inArray(E.buy_box_id, boxIds)))
    .groupBy(E.result);
  return {
    strategy: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["strategy"])), t.strategy),
    is_active: Object.fromEntries(Object.entries(active).map(([k, v]) => [k.toLowerCase(), v])),
    result: Object.fromEntries(rows.map((r) => [r.r, Number(r.n)])),
  };
});

router.get("/buy-boxes/meta", async (ctx) => {
  await ctx.require("buybox", "view");
  return {
    operators: OPERATORS,
    operator_labels: service.OP_TEXT,
    requirements: REQUIREMENTS,
    results: RESULTS,
    exception_states: EXCEPTION_STATES,
    strategies: STRATEGY_SUGGESTIONS,
    fields: service.fieldMeta(),
  };
});

router.post("/buy-boxes", async (ctx) => {
  const user = await ctx.require("buybox", "create");
  const body = await ctx.body(buyBoxCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/buy-boxes/{box_id}", async (ctx) => {
  await ctx.require("buybox", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("box_id")));
});

router.patch("/buy-boxes/{box_id}", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const body = await ctx.body(buyBoxUpdate);
  const box = await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("box_id")), body, user);
  return service.toOut(ctx.db, box);
});

router.delete("/buy-boxes/{box_id}", async (ctx) => {
  const user = await ctx.require("buybox", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("box_id")), user);
  return noContent();
});

router.put("/buy-boxes/{box_id}/criteria", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const body = await ctx.body(criteriaReplace);
  const box = await service.replaceCriteria(
    ctx.db, await service.get(ctx.db, ctx.uuid("box_id")), body.criteria, user, body.change_note ?? null,
  );
  return service.toOut(ctx.db, box);
});

router.post("/buy-boxes/{box_id}/criteria", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const body = await ctx.body(criterionIn);
  let box = await service.get(ctx.db, ctx.uuid("box_id"));
  const [items] = await service.currentInputs(ctx.db, box);
  box = await service.replaceCriteria(ctx.db, box, [...items, body], user, `Added ${body.field}`);
  return created(await service.toOut(ctx.db, box));
});

router.patch("/buy-boxes/{box_id}/criteria/{criterion_id}", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const body = await ctx.body(criterionIn);
  const criterionId = ctx.uuid("criterion_id");
  let box = await service.get(ctx.db, ctx.uuid("box_id"));
  const [items, rows] = await service.currentInputs(ctx.db, box);
  const idx = rows.findIndex((r) => r.id === criterionId);
  if (idx < 0) throw new HttpError(404, "Criterion not found");
  items[idx] = body;
  box = await service.replaceCriteria(ctx.db, box, items, user, `Changed ${body.field}`);
  return service.toOut(ctx.db, box);
});

router.delete("/buy-boxes/{box_id}/criteria/{criterion_id}", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const criterionId = ctx.uuid("criterion_id");
  let box = await service.get(ctx.db, ctx.uuid("box_id"));
  const [items, rows] = await service.currentInputs(ctx.db, box);
  const idx = rows.findIndex((r) => r.id === criterionId);
  if (idx < 0) throw new HttpError(404, "Criterion not found");
  const [removed] = items.splice(idx, 1);
  box = await service.replaceCriteria(ctx.db, box, items, user, `Removed ${removed.field}`);
  return service.toOut(ctx.db, box);
});

router.get("/buy-boxes/{box_id}/versions", async (ctx) => {
  await ctx.require("buybox", "view");
  const boxId = ctx.uuid("box_id");
  await service.get(ctx.db, boxId);
  const rows = await ctx.db
    .select()
    .from(buyboxVersions)
    .where(eq(buyboxVersions.buy_box_id, boxId))
    .orderBy(desc(buyboxVersions.version));
  const names = await service.userNames(ctx.db, rows.map((r) => r.created_by_id));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    criteria: r.criteria,
    change_note: r.change_note,
    created_at: r.created_at,
    created_by_id: r.created_by_id,
    created_by_name: r.created_by_id ? (names.get(r.created_by_id) ?? null) : null,
  }));
});

router.post("/buy-boxes/{box_id}/evaluate-all", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  return service.evaluateAll(ctx.db, await service.get(ctx.db, ctx.uuid("box_id")), user);
});

router.get("/buy-boxes/{box_id}/evaluations", async (ctx) => {
  await ctx.require("buybox", "view");
  const boxId = ctx.uuid("box_id");
  const p = ctx.listParams();
  const result = ctx.query.strs("result");
  const exceptionStatus = ctx.query.strs("exception_status");
  const currentOnly = ctx.query.bool("current_only") ?? true;
  await service.get(ctx.db, boxId);
  const where = service.evaluationsWhere(boxId, {
    result, exception_status: exceptionStatus, current_only: currentOnly, q: p.q,
  });
  const order = applySort(p.sort, EVAL_SORTS, desc(E.evaluated_at));
  const [{ n: total }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(E)
    .innerJoin(properties, eq(properties.id, E.property_id))
    .where(where);
  const rows = await ctx.db
    .select({ e: E })
    .from(E)
    .innerJoin(properties, eq(properties.id, E.property_id))
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(await service.evalOuts(ctx.db, rows.map((r) => r.e)), total, p);
});

router.get("/properties/{property_id}/buybox-evaluations", async (ctx) => {
  await ctx.require("buybox", "view");
  const propertyId = ctx.uuid("property_id");
  const history = ctx.query.bool("history") ?? false;
  const rows = await ctx.db
    .select()
    .from(E)
    .where(
      and(
        eq(E.property_id, propertyId),
        history
          ? undefined
          : and(
              eq(E.is_current, true),
              inArray(E.buy_box_id, ctx.db.select({ id: buyBoxes.id }).from(buyBoxes).where(isNull(buyBoxes.deleted_at))),
            ),
      ),
    )
    .orderBy(desc(E.evaluated_at))
    .limit(500);
  return service.evalOuts(ctx.db, rows);
});

router.post("/properties/{property_id}/buybox-evaluations/run", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const evals = await service.evaluateProperty(ctx.db, ctx.uuid("property_id"), {
    trigger: "manual", actor_id: user.id, skip_unchanged: false,
  });
  await ctx.db.commit();
  return service.evalOuts(ctx.db, evals);
});

router.get("/buybox-evaluations/{eval_id}", async (ctx) => {
  await ctx.require("buybox", "view");
  return (await service.evalOuts(ctx.db, [await service.getEvaluation(ctx.db, ctx.uuid("eval_id"))]))[0];
});

router.post("/buybox-evaluations/{eval_id}/exception-request", async (ctx) => {
  const user = await ctx.require("buybox", "edit");
  const body = await ctx.body(exceptionRequestIn);
  const ev = await service.requestException(ctx.db, await service.getEvaluation(ctx.db, ctx.uuid("eval_id")), body.reason, user);
  return (await service.evalOuts(ctx.db, [ev]))[0];
});

router.post("/buybox-evaluations/{eval_id}/exception-decision", async (ctx) => {
  const user = await ctx.require("buybox", "approve");
  const body = await ctx.body(exceptionDecisionIn);
  const ev = await service.decideException(
    ctx.db, await service.getEvaluation(ctx.db, ctx.uuid("eval_id")), body.approve, body.reason, user,
  );
  return (await service.evalOuts(ctx.db, [ev]))[0];
});
