import { desc } from "drizzle-orm";

import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import * as engine from "./engine";
import { today } from "./pyutil";
import { UW_STATUSES, uwModels } from "./schema";
import { assumptionsIn, decisionIn, modelCreate, modelUpdate, newVersionIn, scenariosIn, simulateIn } from "./schemas";
import * as service from "./service";
import type { ModelFilters } from "./service";
import { PROPERTY_TYPE_TEMPLATE, seed, TEMPLATES } from "./templates";

export const router = new Router();

const t = uwModels;
const SORTS = {
  name: t.name, status: t.status, template: t.template, version: t.version,
  updated_at: t.updated_at, created_at: t.created_at, approved_at: t.approved_at,
};

function filters(ctx: Ctx): ModelFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    template: q.strs("template"),
    property_id: q.uuid("property_id"),
    opportunity_id: q.uuid("opportunity_id"),
    root_id: q.uuid("root_id"),
    latest_only: q.bool("latest_only") ?? true,
    locked: q.bool("locked"),
  };
}

router.get("/uw-models", async (ctx) => {
  await ctx.require("underwriting", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const [items, total] = await paginate(ctx.db, t, service.buildWhere(f), applySort(p.sort, SORTS, desc(t.updated_at)), p);
  return page(await service.toItems(ctx.db, items), total, p);
});

router.get("/uw-models/facets", async (ctx) => {
  await ctx.require("underwriting", "view");
  const f = filters(ctx);
  return {
    status: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["status"])), t.status),
    template: await facetCounts(ctx.db, t, service.buildWhere(f, new Set(["template"])), t.template),
  };
});

router.get("/uw-models/meta", async (ctx) => {
  await ctx.require("underwriting", "view");
  return {
    statuses: UW_STATUSES,
    templates: Object.entries(TEMPLATES).map(([k, v]) => ({ key: k, ...v })),
    property_type_template: PROPERTY_TYPE_TEMPLATE,
    material_paths: engine.MATERIAL_PATHS.map(([path, label]) => ({ path, label })),
    land_material_paths: engine.LAND_MATERIAL_PATHS.map(([path, label]) => ({ path, label })),
    sensitivity_vars: engine.SENSITIVITY_VARS,
    simulation_max_iterations: 2000,
  };
});

router.get("/uw-models/templates/{template}", async (ctx) => {
  await ctx.require("underwriting", "view");
  const a = seed(ctx.param("template"), { start: today() });
  delete a.scenarios_seed;
  return a;
});

router.post("/uw-models", async (ctx) => {
  const user = await ctx.require("underwriting", "create");
  const body = await ctx.body(modelCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user), user));
});

router.get("/uw-models/{model_id}", async (ctx) => {
  const user = await ctx.require("underwriting", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), user);
});

router.patch("/uw-models/{model_id}", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const body = await ctx.body(modelUpdate);
  const m = await service.updateMeta(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user);
  return service.toOut(ctx.db, m, user);
});

router.delete("/uw-models/{model_id}", async (ctx) => {
  const user = await ctx.require("underwriting", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), user);
  return noContent();
});

// Drafts change in place; any other version spawns a new draft version (response id differs).
router.put("/uw-models/{model_id}/assumptions", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const body = await ctx.body(assumptionsIn);
  const m = await service.saveAssumptions(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user);
  return service.toOut(ctx.db, m, user);
});

router.put("/uw-models/{model_id}/scenarios", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const body = await ctx.body(scenariosIn);
  const m = await service.saveScenarios(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user);
  return service.toOut(ctx.db, m, user);
});

router.post("/uw-models/{model_id}/recalculate", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const m = await service.recalculate(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), user);
  return service.toOut(ctx.db, m, user);
});

router.post("/uw-models/{model_id}/versions", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const body = await ctx.body(newVersionIn);
  const m = await service.newVersion(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), user, { note: body.change_note });
  return created(await service.toOut(ctx.db, m, user));
});

router.get("/uw-models/{model_id}/versions", async (ctx) => {
  await ctx.require("underwriting", "view");
  return service.versions(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")));
});

router.get("/uw-models/{model_id}/diff", async (ctx) => {
  await ctx.require("underwriting", "view");
  const against = ctx.query.uuid("against");
  return service.diff(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), against);
});

router.get("/uw-models/{model_id}/events", async (ctx) => {
  await ctx.require("underwriting", "view");
  return service.eventsFor(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")));
});

router.post("/uw-models/{model_id}/submit", async (ctx) => {
  const user = await ctx.require("underwriting", "edit");
  const body = await ctx.body(decisionIn);
  return service.toOut(ctx.db, await service.submit(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user), user);
});

router.post("/uw-models/{model_id}/approve", async (ctx) => {
  const user = await ctx.require("underwriting", "approve");
  const body = await ctx.body(decisionIn);
  return service.toOut(ctx.db, await service.approve(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user), user);
});

router.post("/uw-models/{model_id}/reject", async (ctx) => {
  const user = await ctx.require("underwriting", "approve");
  const body = await ctx.body(decisionIn);
  return service.toOut(ctx.db, await service.reject(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user), user);
});

// Tornado data: one-way sensitivities of `metric` to price, NOI, interest rate, exit cap and hold period.
router.get("/uw-models/{model_id}/sensitivity", async (ctx) => {
  await ctx.require("underwriting", "view");
  const q = ctx.query;
  const metric = q.str("metric", { pattern: /^[a-z_]+$/ }) ?? "irr";
  const scenario = q.str("scenario");
  const price_step = q.num("price_step", { gt: 0, le: 50 });
  const noi_step = q.num("noi_step", { gt: 0, le: 50 });
  const rate_step = q.num("rate_step", { gt: 0, le: 500 });
  const exit_cap_step = q.num("exit_cap_step", { gt: 0, le: 500 });
  const hold_step = q.num("hold_step", { gt: 0, le: 10 });
  const steps = Object.fromEntries(
    Object.entries({ price: price_step, noi: noi_step, rate: rate_step, exit_cap: exit_cap_step, hold: hold_step }).filter(
      ([, v]) => v !== undefined,
    ),
  ) as Record<string, number>;
  return service.sensitivity(await service.get(ctx.db, ctx.uuid("model_id")), metric, scenario, steps);
});

router.post("/uw-models/{model_id}/simulate", async (ctx) => {
  const user = await ctx.require("underwriting", "view");
  const body = await ctx.body(simulateIn);
  return service.simulate(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")), body, user);
});

router.get("/uw-models/{model_id}/variance", async (ctx) => {
  await ctx.require("underwriting", "view");
  return service.variance(ctx.db, await service.get(ctx.db, ctx.uuid("model_id")));
});
