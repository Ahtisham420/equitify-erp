import { and, desc, eq } from "drizzle-orm";

import { applySort, page } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { opportunities } from "../pipeline/schema";
import { OFFER_STATUSES, ORIGINS, OUTCOMES, STRUCTURES, TERM_FIELDS, offerApprovals, offers } from "./schema";
import {
  approvalIn, counterIn, offerCreate, offerSettingsIn, offerTerms, respondIn, sendIn, winningPriceIn,
} from "./schemas";
import * as service from "./service";
import type { OfferFilters } from "./service";

export const router = new Router();

const SORTS = {
  price: offers.price, status: offers.status, version: offers.version, sent_at: offers.sent_at,
  response_due_at: offers.response_due_at, deviation_pct: offers.deviation_pct,
  created_at: offers.created_at, updated_at: offers.updated_at,
};

function filters(ctx: Ctx): OfferFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    origin: q.strs("origin"),
    opportunity_id: q.uuid("opportunity_id"),
    property_id: q.uuid("property_id"),
    uw_model_id: q.uuid("uw_model_id"),
    owner_id: q.uuids("owner_id"),
    root_offer_id: q.uuid("root_offer_id"),
    latest_only: q.bool("latest_only") ?? true,
    due: q.str("due", { pattern: /^(overdue|24h|72h)$/ }),
    min_price: q.num("min_price"),
    max_price: q.num("max_price"),
  };
}

router.get("/offers", async (ctx) => {
  await ctx.require("offers", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  await service.expireDue(ctx.db, null); // expired offers surface immediately, never silently linger
  const order = applySort(p.sort, SORTS, desc(offers.updated_at));
  const [items, total] = await service.listOffers(ctx.db, service.buildWhere(f), order, p);
  return page(await service.toItems(ctx.db, items), total, p);
});

router.get("/offers/facets", async (ctx) => {
  await ctx.require("offers", "view");
  const f = filters(ctx);
  return {
    status: await service.facet(ctx.db, service.buildWhere(f, { skip: new Set(["status"]) }), offers.status),
    origin: await service.facet(ctx.db, service.buildWhere(f, { skip: new Set(["origin"]) }), offers.origin),
    due: await service.dueCounts(ctx.db, f),
  };
});

router.get("/offers/meta", async (ctx) => {
  await ctx.require("offers", "view");
  return {
    statuses: OFFER_STATUSES, origins: ORIGINS, structures: STRUCTURES, outcomes: OUTCOMES,
    terms: Object.entries(TERM_FIELDS).map(([key, label]) => ({ key, label })),
  };
});

router.get("/offers/settings", async (ctx) => {
  await ctx.require("offers", "view");
  return service.settingsOut(await service.getSettings(ctx.db));
});

router.put("/offers/settings", async (ctx) => {
  const user = await ctx.require("offers", "approve");
  const body = await ctx.body(offerSettingsIn);
  return service.settingsOut(await service.saveSettings(ctx.db, body, user));
});

router.get("/offers/approved-models", async (ctx) => {
  await ctx.require("offers", "view");
  const opportunityId = ctx.query.uuid("opportunity_id");
  let propertyId = ctx.query.uuid("property_id");
  if (opportunityId && !propertyId) {
    const [opp] = await ctx.db.select().from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1);
    propertyId = opp ? (opp as Record<string, any>).property_id ?? undefined : undefined;
  }
  return service.approvedModels(ctx.db, { opportunity_id: opportunityId, property_id: propertyId });
});

/** Periodic job (also run on read): expire offers whose response clock has run out. */
router.post("/offers/expire-scan", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const ids = await service.expireDue(ctx.db, user);
  return { expired: ids.length, offer_ids: ids };
});

router.post("/offers", async (ctx) => {
  const user = await ctx.require("offers", "create");
  const body = await ctx.body(offerCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user), user));
});

router.get("/offers/{offer_id}", async (ctx) => {
  const user = await ctx.require("offers", "view");
  const offerId = ctx.uuid("offer_id");
  await service.expireDue(ctx.db, null);
  const o = await service.get(ctx.db, offerId);
  return service.toOut(ctx.db, o, user);
});

router.patch("/offers/{offer_id}", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const body = await ctx.body(offerTerms);
  const o = await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return service.toOut(ctx.db, o, user);
});

router.delete("/offers/{offer_id}", async (ctx) => {
  const user = await ctx.require("offers", "delete");
  await service.withdrawOrDeleteDraft(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), user);
  return noContent();
});

router.post("/offers/{offer_id}/submit", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const o = await service.submit(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), user);
  return service.toOut(ctx.db, o, user);
});

router.post("/offers/{offer_id}/approve", async (ctx) => {
  const user = await ctx.require("offers", "approve");
  const body = await ctx.body(approvalIn);
  const o = await service.decide(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return service.toOut(ctx.db, o, user);
});

router.get("/offers/{offer_id}/approvals", async (ctx) => {
  await ctx.require("offers", "view");
  const offerId = ctx.uuid("offer_id");
  await service.get(ctx.db, offerId);
  return ctx.db
    .select()
    .from(offerApprovals)
    .where(and(eq(offerApprovals.offer_id, offerId)))
    .orderBy(desc(offerApprovals.decided_at));
});

router.get("/offers/{offer_id}/versions", async (ctx) => {
  await ctx.require("offers", "view");
  const o = await service.get(ctx.db, ctx.uuid("offer_id"));
  return service.toItems(ctx.db, await service.chain(ctx.db, o));
});

router.get("/offers/{offer_id}/delta", async (ctx) => {
  await ctx.require("offers", "view");
  const offerId = ctx.uuid("offer_id");
  const against = ctx.query.uuid("against");
  return service.delta(ctx.db, await service.get(ctx.db, offerId), against);
});

router.post("/offers/{offer_id}/counter", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const body = await ctx.body(counterIn);
  const o = await service.counter(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return created(await service.toOut(ctx.db, o, user));
});

router.get("/offers/{offer_id}/loi", async (ctx) => {
  await ctx.require("offers", "view");
  return service.loi(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")));
});

router.post("/offers/{offer_id}/send", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const body = await ctx.body(sendIn);
  const o = await service.send(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return service.toOut(ctx.db, o, user);
});

router.post("/offers/{offer_id}/respond", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const body = await ctx.body(respondIn);
  const o = await service.respond(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return service.toOut(ctx.db, o, user);
});

router.post("/offers/{offer_id}/winning-price", async (ctx) => {
  const user = await ctx.require("offers", "edit");
  const body = await ctx.body(winningPriceIn);
  const o = await service.recordWinningPrice(ctx.db, await service.get(ctx.db, ctx.uuid("offer_id")), body, user);
  return service.toOut(ctx.db, o, user);
});
