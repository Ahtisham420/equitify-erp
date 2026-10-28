import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, countWhere, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, HttpError } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import type { Db } from "../../db";
import { get } from "../../db/orm";
import { properties } from "../properties/schema";
import { COMPONENT_LABELS, COMPONENTS, opportunityScores, scoreConfigs, scoreOutcomes } from "./schema";
import { configIn, outcomeIn, rejectIn } from "./schemas";
import * as service from "./service";
import type { RankingFilters } from "./service";

export const router = new Router();

const SORTS = {
  score: opportunityScores.score, confidence: opportunityScores.confidence,
  adjusted_score: opportunityScores.adjusted_score, computed_at: opportunityScores.computed_at,
  band: service.BAND_ORDER,
};

function filters(ctx: Ctx): RankingFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    band: q.strs("band"),
    property_type: q.strs("property_type"),
    min_score: q.num("min_score", { ge: 0, le: 100 }),
    max_score: q.num("max_score", { ge: 0, le: 100 }),
    min_confidence: q.num("min_confidence", { ge: 0, le: 1 }),
    territory_id: q.uuid("territory_id"),
    needs_research: q.bool("needs_research"),
  };
}

async function rankingFacet(db: Db, where: SQL | undefined, column: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(opportunityScores)
    .innerJoin(properties, eq(properties.id, opportunityScores.property_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ k: unknown; n: number }>) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

router.get("/scoring/meta", async (ctx) => {
  await ctx.require("scoring", "view");
  const cfg = await service.activeConfig(ctx.db);
  await ctx.db.commit();
  return {
    components: COMPONENTS.map((k) => ({ key: k, label: COMPONENT_LABELS[k] })),
    bands: ["high", "medium", "low"], active_version: cfg.version, min_outcomes: service.MIN_OUTCOMES,
  };
});

// ----------------------------------------------------------------------------- rankings

router.get("/scoring/rankings", async (ctx) => {
  await ctx.require("scoring", "view");
  const params = ctx.listParams();
  const where = service.rankingsWhere(filters(ctx));
  // Default: rank by score within confidence band (High, then Medium, then Low).
  const order = params.sort
    ? applySort(params.sort, SORTS, desc(opportunityScores.score))
    : [service.BAND_ORDER, desc(opportunityScores.score), desc(opportunityScores.confidence)];
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunityScores)
    .innerJoin(properties, eq(properties.id, opportunityScores.property_id))
    .where(where);
  const rows = await ctx.db
    .select({ s: opportunityScores })
    .from(opportunityScores)
    .innerJoin(properties, eq(properties.id, opportunityScores.property_id))
    .where(where)
    .orderBy(...order)
    .limit(params.page_size)
    .offset((params.page - 1) * params.page_size);
  const items = await service.rankingItems(ctx.db, rows.map((r) => r.s), (params.page - 1) * params.page_size);
  return page(items, Number(n), params);
});

router.get("/scoring/rankings/facets", async (ctx) => {
  await ctx.require("scoring", "view");
  const f = filters(ctx);
  return {
    band: await rankingFacet(ctx.db, service.rankingsWhere(f, new Set(["band"])), opportunityScores.band),
    property_type: await rankingFacet(ctx.db, service.rankingsWhere(f, new Set(["property_type"])), properties.property_type),
  };
});

router.post("/scoring/rescore-all", async (ctx) => {
  const user = await ctx.require("scoring", "approve");
  const n = await service.rescoreAll(ctx.db, { actor: user, trigger: "manual_bulk", alerts: true });
  await audit.record(ctx.db, {
    actor: user, action: "scoring.rescored_all", entity_type: "scoring", summary: `${n} properties`, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return { rescored: n };
});

// ----------------------------------------------------------------------------- property

async function propertyScore(db: Db, propertyId: string) {
  const [eligible, rows] = await service.eligibility(db, propertyId);
  const cur = await service.currentScore(db, propertyId);
  const history = await service.propertyHistory(db, propertyId);
  return {
    property_id: propertyId, eligible, eligibility: rows,
    score: cur ? service.scoreOut(cur) : null, history: history.map(service.historyPoint),
  };
}

router.get("/scoring/properties/{property_id}", async (ctx) => {
  await ctx.require("scoring", "view");
  return propertyScore(ctx.db, ctx.uuid("property_id"));
});

router.get("/scoring/properties/{property_id}/history", async (ctx) => {
  await ctx.require("scoring", "view");
  return (await service.propertyHistory(ctx.db, ctx.uuid("property_id"))).map(service.scoreOut);
});

router.get("/scoring/scores/{score_id}", async (ctx) => {
  await ctx.require("scoring", "view");
  const row = await get(ctx.db, opportunityScores, ctx.uuid("score_id"));
  if (!row) throw new HttpError(404, "Score not found");
  return service.scoreOut(row);
});

router.post("/scoring/properties/{property_id}/rescore", async (ctx) => {
  const user = await ctx.require("scoring", "edit");
  const propertyId = ctx.uuid("property_id");
  const p = await get(ctx.db, properties, propertyId);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  const row = await service.rescoreProperty(ctx.db, propertyId, user, { trigger: "manual" });
  await audit.record(ctx.db, {
    actor: user, action: "property.rescored", entity_type: "property", entity_id: propertyId,
    summary: row ? `Score ${row.score} · ${row.band} confidence` : "Not eligible for scoring", ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return propertyScore(ctx.db, propertyId);
});

// ----------------------------------------------------------------------------- configs

router.get("/scoring/configs", async (ctx) => {
  await ctx.require("scoring", "view");
  await service.activeConfig(ctx.db);
  await ctx.db.commit();
  const rows = await ctx.db.select().from(scoreConfigs).where(isNull(scoreConfigs.deleted_at)).orderBy(desc(scoreConfigs.version));
  return rows.map(service.configOut);
});

router.post("/scoring/configs", async (ctx) => {
  const user = await ctx.require("scoring", "edit");
  return created(service.configOut(await service.createConfig(ctx.db, await ctx.body(configIn), user)));
});

router.post("/scoring/configs/recalibrate", async (ctx) => {
  const user = await ctx.require("scoring", "edit");
  return created(service.configOut(await service.proposeRecalibration(ctx.db, user)));
});

router.get("/scoring/configs/{config_id}", async (ctx) => {
  await ctx.require("scoring", "view");
  return service.configOut(await service.getConfig(ctx.db, ctx.uuid("config_id")));
});

router.put("/scoring/configs/{config_id}", async (ctx) => {
  const user = await ctx.require("scoring", "edit");
  const body = await ctx.body(configIn);
  const cfg = await service.updateConfig(ctx.db, await service.getConfig(ctx.db, ctx.uuid("config_id")), body, user);
  return service.configOut(cfg);
});

router.post("/scoring/configs/{config_id}/activate", async (ctx) => {
  const user = await ctx.require("scoring", "approve");
  const cfg = await service.activateConfig(ctx.db, await service.getConfig(ctx.db, ctx.uuid("config_id")), user);
  return service.configOut(cfg);
});

router.post("/scoring/configs/{config_id}/reject", async (ctx) => {
  const user = await ctx.require("scoring", "approve");
  const body = await ctx.body(rejectIn);
  const cfg = await service.rejectConfig(ctx.db, await service.getConfig(ctx.db, ctx.uuid("config_id")), body.reason, user);
  return service.configOut(cfg);
});

// ----------------------------------------------------------------------------- outcomes

router.get("/scoring/outcomes", async (ctx) => {
  await ctx.require("scoring", "view");
  const params = ctx.listParams();
  const q = ctx.query;
  const t = scoreOutcomes;
  const propertyId = q.uuid("property_id");
  const where = and(
    isNull(t.deleted_at),
    inFilter(t.result, q.strs("result")),
    inFilter(t.disposition, q.strs("disposition")),
    inFilter(t.band_at_decision, q.strs("band")),
    propertyId ? eq(t.property_id, propertyId) : undefined,
  );
  const order = applySort(
    params.sort,
    { decided_at: t.decided_at, score_at_decision: t.score_at_decision, elapsed_days: t.elapsed_days },
    desc(t.decided_at),
  );
  const [rows, total] = await paginate(ctx.db, t, where, order, params);
  let labels = new Map<string, string | null>();
  if (rows.length) {
    const ps = await ctx.db
      .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
      .from(properties)
      .where(inArray(properties.id, [...new Set(rows.map((r) => r.property_id))]));
    labels = new Map(ps.map((p) => [p.id, p.name || p.address_line]));
  }
  return page(rows.map((r) => service.outcomeOut(r, labels.get(r.property_id) ?? null)), total, params);
});

router.get("/scoring/outcomes/summary", async (ctx) => {
  await ctx.require("scoring", "view");
  return service.outcomeSummary(ctx.db);
});

router.get("/scoring/outcomes/facets", async (ctx) => {
  await ctx.require("scoring", "view");
  const base = isNull(scoreOutcomes.deleted_at);
  return {
    result: await facetCounts(ctx.db, scoreOutcomes, base, scoreOutcomes.result),
    disposition: await facetCounts(ctx.db, scoreOutcomes, base, scoreOutcomes.disposition),
    band: await facetCounts(ctx.db, scoreOutcomes, base, scoreOutcomes.band_at_decision),
    total: await countWhere(ctx.db, scoreOutcomes, base),
  };
});

router.post("/scoring/outcomes", async (ctx) => {
  const user = await ctx.require("scoring", "edit");
  const row = await service.createManualOutcome(ctx.db, await ctx.body(outcomeIn), user);
  return created(service.outcomeOut(row));
});
