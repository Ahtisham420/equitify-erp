import { and, desc, eq, ilike, isNull } from "drizzle-orm";

import { applySort, page } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { properties } from "../properties/schema";
import {
  CANDIDATE_STATUSES, EXCHANGE_STATUSES, EXCHANGE_TYPES, FINANCING_TYPES, IDENTIFICATION_RULES, OFFER_STATUSES,
  PROGRESSION, RETRADE_DECISIONS, RETRADE_OUTCOMES, RETRADE_REASONS, STAGES,
  dispositionEvents, dispositionOffers, dispositions, exchangeCandidates, exchanges1031, retrades,
} from "./schema";
import {
  candidateIn, compareIn, dispositionCreate, dispositionUpdate, exchangeIn, moveIn, offerIn, retradeDecisionIn, retradeIn,
} from "./schemas";
import * as service from "./service";
import type { DispositionFilters } from "./service";

export const router = new Router();

const t = dispositions;
const SORTS = {
  name: t.name, stage: t.stage, stage_entered_at: t.stage_entered_at, target_price: t.target_price,
  contract_price: t.contract_price, target_closing_on: t.target_closing_on, property: properties.name,
  updated_at: t.updated_at,
};

function filters(ctx: Ctx): DispositionFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    stage: q.strs("stage"),
    owner_id: q.uuids("owner_id"),
    is_1031: q.strs("is_1031"),
    asset_id: q.uuid("asset_id"),
    property_id: q.uuid("property_id"),
    active_only: q.bool("active_only"),
  };
}

router.get("/dispositions", async (ctx) => {
  await ctx.require("dispositions", "view");
  const p = ctx.listParams();
  const where = service.buildWhere(filters(ctx));
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const total = await service.countDispositions(ctx.db, where);
  const rows = await service
    .selectDispositions(ctx.db, where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(await service.toItems(ctx.db, rows.map((r) => r.d)), total, p);
});

router.get("/dispositions/facets", async (ctx) => {
  await ctx.require("dispositions", "view");
  const f = filters(ctx);
  const flags = await service.facet(ctx.db, service.buildWhere(f, new Set(["is_1031"])), t.is_1031);
  return {
    stage: await service.facet(ctx.db, service.buildWhere(f, new Set(["stage"])), t.stage),
    owner_id: await service.facet(ctx.db, service.buildWhere(f, new Set(["owner_id"])), t.owner_id),
    is_1031: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k.toLowerCase(), v])),
  };
});

router.get("/dispositions/meta", async (ctx) => {
  await ctx.require("dispositions", "view");
  return {
    stages: STAGES, progression: PROGRESSION, offer_statuses: OFFER_STATUSES, financing_types: FINANCING_TYPES,
    retrade_reasons: RETRADE_REASONS, retrade_decisions: RETRADE_DECISIONS, retrade_outcomes: RETRADE_OUTCOMES,
    exchange_types: EXCHANGE_TYPES, exchange_statuses: EXCHANGE_STATUSES, identification_rules: IDENTIFICATION_RULES,
    candidate_statuses: CANDIDATE_STATUSES, tax_note: service.TAX_NOTE,
  };
});

router.get("/dispositions/queue", async (ctx) => {
  await ctx.require("dispositions", "view");
  return service.queue(ctx.db);
});

router.get("/dispositions/buyers", async (ctx) => {
  await ctx.require("dispositions", "view");
  return service.buyerPerformance(ctx.db, ctx.query.str("q"));
});

router.get("/dispositions/retrades", async (ctx) => {
  await ctx.require("dispositions", "view");
  const buyer = ctx.query.str("buyer");
  const org = ctx.query.uuid("buyer_organization_id");
  const rows = await ctx.db
    .select()
    .from(retrades)
    .where(
      and(
        isNull(retrades.deleted_at),
        buyer ? ilike(retrades.buyer_name, `%${buyer}%`) : undefined,
        org ? eq(retrades.buyer_organization_id, org) : undefined,
      ),
    )
    .orderBy(desc(retrades.requested_on))
    .limit(500);
  return service.retradeItems(ctx.db, rows);
});

// ---------------------------------------------------------------- sub-resources by id

async function loadOffer(ctx: Ctx, offer_id: string) {
  const [o] = await ctx.db.select().from(dispositionOffers).where(eq(dispositionOffers.id, offer_id)).limit(1);
  if (!o || o.deleted_at) throw new HttpError(404, "Offer not found");
  return o;
}

const OFFER_OUT = [
  "id", "disposition_id", "buyer_name", "buyer_organization_id", "buyer_person_id", "broker_name", "price", "earnest_money",
  "dd_days", "closing_days", "financing_type", "contingencies", "received_on", "expires_on", "status", "outcome", "notes",
  "created_at",
] as const;
const offerOut = (o: Record<string, any>) => Object.fromEntries(OFFER_OUT.map((k) => [k, o[k]]));

router.patch("/dispositions/offers/{offer_id}", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(offerIn);
  const o = await loadOffer(ctx, ctx.uuid("offer_id"));
  if (o.status === "accepted" && body.status !== "withdrawn") {
    throw new HttpError(409, "The accepted offer can only be withdrawn; record price changes as a retrade");
  }
  return offerOut(await service.updateOffer(ctx.db, o, body, user));
});

router.post("/dispositions/offers/{offer_id}/accept", async (ctx) => {
  const user = await ctx.require("dispositions", "approve");
  const o = await loadOffer(ctx, ctx.uuid("offer_id"));
  const d = await service.acceptOffer(ctx.db, await service.get(ctx.db, o.disposition_id), o, user);
  return service.toOut(ctx.db, d);
});

router.patch("/dispositions/retrades/{retrade_id}", async (ctx) => {
  const user = await ctx.require("dispositions", "approve");
  const body = await ctx.body(retradeDecisionIn);
  const [found] = await ctx.db.select().from(retrades).where(eq(retrades.id, ctx.uuid("retrade_id"))).limit(1);
  if (!found || found.deleted_at) throw new HttpError(404, "Retrade not found");
  const r = await service.decideRetrade(ctx.db, found, body, user);
  return (await service.retradeItems(ctx.db, [r]))[0];
});

router.patch("/dispositions/exchange-candidates/{candidate_id}", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(candidateIn);
  const [c] = await ctx.db.select().from(exchangeCandidates).where(eq(exchangeCandidates.id, ctx.uuid("candidate_id"))).limit(1);
  if (!c || c.deleted_at) throw new HttpError(404, "Candidate not found");
  const [ex] = await ctx.db.select().from(exchanges1031).where(eq(exchanges1031.id, c.exchange_id)).limit(1);
  await service.saveCandidate(ctx.db, ex, body, user, c);
  return service.exchangeOut(ctx.db, ex);
});

// ---------------------------------------------------------------- disposition record

router.post("/dispositions", async (ctx) => {
  const user = await ctx.require("dispositions", "create");
  const body = await ctx.body(dispositionCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.get("/dispositions/{disposition_id}", async (ctx) => {
  await ctx.require("dispositions", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")));
});

router.patch("/dispositions/{disposition_id}", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(dispositionUpdate);
  return service.toOut(ctx.db, await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), body, user));
});

router.delete("/dispositions/{disposition_id}", async (ctx) => {
  const user = await ctx.require("dispositions", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), user);
  return noContent();
});

router.get("/dispositions/{disposition_id}/gates", async (ctx) => {
  const user = await ctx.require("dispositions", "view");
  const d = await service.get(ctx.db, ctx.uuid("disposition_id"));
  const stages: Array<{ stage: string; ready: boolean; requirements: unknown[] }> = [];
  if (d.stage !== "closed") {
    for (const s of PROGRESSION) {
      if (s === d.stage) continue;
      const reqs = await service.checkGate(ctx.db, d, s);
      stages.push({ stage: s, ready: !service.unmetOf(reqs).length, requirements: reqs });
    }
  }
  return {
    current_stage: d.stage, next_stage: service.nextStage(d.stage), can_override: user.can("dispositions", "approve"), stages,
  };
});

router.post("/dispositions/{disposition_id}/move", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(moveIn);
  return service.toOut(ctx.db, await service.move(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), body, user));
});

router.get("/dispositions/{disposition_id}/events", async (ctx) => {
  await ctx.require("dispositions", "view");
  const disposition_id = ctx.uuid("disposition_id");
  await service.get(ctx.db, disposition_id);
  const rows = await ctx.db
    .select()
    .from(dispositionEvents)
    .where(eq(dispositionEvents.disposition_id, disposition_id))
    .orderBy(desc(dispositionEvents.at));
  return rows.map((e) => ({
    id: e.id, from_stage: e.from_stage, to_stage: e.to_stage, at: e.at, actor_name: e.actor_name, reason: e.reason,
    override: e.override, unmet: e.unmet,
  }));
});

router.get("/dispositions/{disposition_id}/compare", async (ctx) => {
  await ctx.require("dispositions", "view");
  const d = await service.get(ctx.db, ctx.uuid("disposition_id"));
  return Object.keys(d.comparison ?? {}).length ? d.comparison : null;
});

router.post("/dispositions/{disposition_id}/compare", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(compareIn);
  return service.compare(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), body, user);
});

router.get("/dispositions/{disposition_id}/proceeds", async (ctx) => {
  await ctx.require("dispositions", "view");
  return service.proceeds(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")));
});

router.get("/dispositions/{disposition_id}/offers", async (ctx) => {
  await ctx.require("dispositions", "view");
  const o = dispositionOffers;
  const rows = await ctx.db
    .select()
    .from(o)
    .where(and(eq(o.disposition_id, ctx.uuid("disposition_id")), isNull(o.deleted_at)))
    .orderBy(desc(o.received_on), desc(o.price));
  return rows.map(offerOut);
});

router.post("/dispositions/{disposition_id}/offers", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(offerIn);
  const d = await service.get(ctx.db, ctx.uuid("disposition_id"));
  if (d.stage === "closed" || d.stage === "withdrawn") throw new HttpError(409, "Disposition is closed or withdrawn");
  return created(offerOut(await service.addOffer(ctx.db, d, body, user)));
});

router.get("/dispositions/{disposition_id}/retrades", async (ctx) => {
  await ctx.require("dispositions", "view");
  const rows = await ctx.db
    .select()
    .from(retrades)
    .where(and(eq(retrades.disposition_id, ctx.uuid("disposition_id")), isNull(retrades.deleted_at)))
    .orderBy(desc(retrades.requested_on));
  return service.retradeItems(ctx.db, rows);
});

router.post("/dispositions/{disposition_id}/retrades", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(retradeIn);
  const r = await service.addRetrade(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), body, user);
  return created((await service.retradeItems(ctx.db, [r]))[0]);
});

router.get("/dispositions/{disposition_id}/exchange", async (ctx) => {
  await ctx.require("dispositions", "view");
  const ex = await service.getExchange(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")));
  return ex ? await service.exchangeOut(ctx.db, ex) : null;
});

router.put("/dispositions/{disposition_id}/exchange", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(exchangeIn);
  const ex = await service.upsertExchange(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")), body, user);
  return service.exchangeOut(ctx.db, ex);
});

router.post("/dispositions/{disposition_id}/exchange/candidates", async (ctx) => {
  const user = await ctx.require("dispositions", "edit");
  const body = await ctx.body(candidateIn);
  const ex = await service.getExchange(ctx.db, await service.get(ctx.db, ctx.uuid("disposition_id")));
  if (!ex) throw new HttpError(409, "Set up the 1031 exchange first");
  await service.saveCandidate(ctx.db, ex, body, user);
  return created(await service.exchangeOut(ctx.db, ex));
});
