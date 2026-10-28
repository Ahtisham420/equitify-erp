import { desc, eq } from "drizzle-orm";

import { applySort, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  ACTIVE_STAGES,
  DEAD_REASONS,
  DEFAULT_STALL_DAYS,
  PRIORITIES,
  STAGES,
  TERMINAL_STAGES,
  opportunities,
  opportunityEvents,
} from "./schema";
import { moveIn, opportunityCreate, opportunityUpdate, stageSettingsIn } from "./schemas";
import * as service from "./service";
import type { OpportunityFilters } from "./service";

export const router = new Router();

const t = opportunities;
const SORTS = {
  title: t.title, stage: t.stage, priority: t.priority, stage_entered_at: t.stage_entered_at,
  next_action_at: t.next_action_at, price_expectation: t.price_expectation, value: service.valueExpr(),
  updated_at: t.updated_at, created_at: t.created_at,
};

function filters(ctx: Ctx): OpportunityFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    stage: q.strs("stage"),
    owner_id: q.uuids("owner_id"),
    priority: q.strs("priority"),
    source: q.strs("source"),
    dead_reason: q.strs("dead_reason"),
    property_id: q.uuid("property_id"),
    stalled: q.bool("stalled"),
    overdue: q.bool("overdue"),
    min_value: q.num("min_value"),
    max_value: q.num("max_value"),
  };
}

router.get("/opportunities", async (ctx) => {
  await ctx.require("pipeline", "view");
  const p = ctx.listParams();
  const thresholds = await service.getThresholds(ctx.db);
  const where = service.buildWhere(filters(ctx), thresholds);
  const { items, total } = await service.listPage(
    ctx.db, where, applySort(p.sort, SORTS, desc(t.updated_at)), p.page, p.page_size,
  );
  return page(await service.toItems(ctx.db, items, thresholds), total, p);
});

router.get("/opportunities/facets", async (ctx) => {
  await ctx.require("pipeline", "view");
  const f = filters(ctx);
  const th = await service.getThresholds(ctx.db);
  const q = (skip: string) => service.buildWhere(f, th, new Set([skip]));
  return {
    stage: await service.facet(ctx.db, q("stage"), t.stage),
    priority: await service.facet(ctx.db, q("priority"), t.priority),
    owner_id: await service.facet(ctx.db, q("owner_id"), t.owner_id),
    source: await service.facet(ctx.db, q("source"), t.source),
    dead_reason: await service.facet(ctx.db, q("dead_reason"), t.dead_reason),
  };
});

router.get("/opportunities/meta", async (ctx) => {
  await ctx.require("pipeline", "view");
  return {
    stages: STAGES,
    active_stages: ACTIVE_STAGES,
    terminal_stages: TERMINAL_STAGES,
    dead_reasons: DEAD_REASONS,
    priorities: PRIORITIES,
    reactivation_types: Object.entries(service.REACTIVATION_SPEC).map(([type, v]) => ({ type, ...v })),
    default_stall_days: DEFAULT_STALL_DAYS,
  };
});

router.get("/opportunities/board", async (ctx) => {
  await ctx.require("pipeline", "view");
  const f = filters(ctx);
  const stages = ctx.query.strs("stages");
  const perStage = ctx.query.int("per_stage", { ge: 1, le: 200 }) ?? 50;
  const cols = (stages ?? ACTIVE_STAGES).filter((s) => (STAGES as readonly string[]).includes(s));
  return service.board(ctx.db, f, await service.getThresholds(ctx.db), cols, perStage);
});

router.get("/opportunities/metrics", async (ctx) => {
  await ctx.require("pipeline", "view");
  const ownerId = ctx.query.uuids("owner_id");
  return service.metrics(ctx.db, await service.getThresholds(ctx.db), ownerId);
});

router.get("/opportunities/stage-settings", async (ctx) => {
  await ctx.require("pipeline", "view");
  return service.getThresholds(ctx.db);
});

router.put("/opportunities/stage-settings", async (ctx) => {
  const user = await ctx.require("pipeline", "approve");
  const body = await ctx.body(stageSettingsIn);
  return service.saveThresholds(ctx.db, body.stall_days, user);
});

router.post("/opportunities", async (ctx) => {
  const user = await ctx.require("pipeline", "create");
  const body = await ctx.body(opportunityCreate);
  const force = ctx.query.bool("force") ?? false;
  if (force && !user.can("pipeline", "approve")) {
    throw new HttpError(403, "Creating a second opportunity for a property requires approval permission");
  }
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user, { force })));
});

router.get("/opportunities/{opportunity_id}", async (ctx) => {
  await ctx.require("pipeline", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("opportunity_id")));
});

router.patch("/opportunities/{opportunity_id}", async (ctx) => {
  const user = await ctx.require("pipeline", "edit");
  const body = await ctx.body(opportunityUpdate);
  const o = await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("opportunity_id")), body, user);
  return service.toOut(ctx.db, o);
});

router.delete("/opportunities/{opportunity_id}", async (ctx) => {
  const user = await ctx.require("pipeline", "view");
  const o = await service.get(ctx.db, ctx.uuid("opportunity_id"));
  if (o.stage === "dead") throw new HttpError(409, "Dead opportunities are retained for reactivation and cannot be deleted");
  if (!user.can("pipeline", "delete")) throw new HttpError(403, "Missing permission pipeline:delete");
  await service.archive(ctx.db, o, user);
  return noContent();
});

router.get("/opportunities/{opportunity_id}/gates", async (ctx) => {
  const user = await ctx.require("pipeline", "view");
  const o = await service.get(ctx.db, ctx.uuid("opportunity_id"));
  const stages = [];
  if (o.stage !== "closed") {
    for (const s of STAGES) {
      if (s === o.stage) continue;
      const reqs = await service.checkGate(ctx.db, o, s);
      stages.push({ stage: s, ready: !service.unmetOf(reqs).length, requirements: reqs });
    }
  }
  return {
    current_stage: o.stage,
    next_stage: service.nextStage(o.stage),
    can_override: user.can("pipeline", "approve"),
    stages,
  };
});

router.post("/opportunities/{opportunity_id}/move", async (ctx) => {
  const user = await ctx.require("pipeline", "edit");
  const body = await ctx.body(moveIn);
  const o = await service.move(ctx.db, await service.get(ctx.db, ctx.uuid("opportunity_id")), body, user);
  return service.toOut(ctx.db, o);
});

router.get("/opportunities/{opportunity_id}/events", async (ctx) => {
  await ctx.require("pipeline", "view");
  const id = ctx.uuid("opportunity_id");
  await service.get(ctx.db, id);
  return ctx.db
    .select()
    .from(opportunityEvents)
    .where(eq(opportunityEvents.opportunity_id, id))
    .orderBy(desc(opportunityEvents.at));
});
