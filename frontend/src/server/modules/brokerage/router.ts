import { and, desc, eq, inArray, isNull, lte, ne, sql, gte } from "drizzle-orm";

import { applySearch, applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Router, type Ctx } from "../../core/router";
import { utcnow } from "../../core/security";
import { properties } from "../properties/schema";
import {
  AGREEMENT_STATUSES, COMMISSION_STRUCTURES, DEAL_SIDES, DEAL_STAGES, EXCLUSIVITY, INQUIRY_SOURCES, INQUIRY_STATUSES,
  INTEREST_LEVELS, LISTING_STATUSES, LISTING_TYPES, LOST_REASONS, MARKET_STATUSES, MARKETING_KINDS, MARKETING_STATUSES,
  MATCH_STATUSES, ONBOARDING_TEMPLATE, PROPOSAL_KINDS, PROPOSAL_STATUSES, PROSPECT_STAGES, RECRUIT_STAGES,
  REPORT_CADENCES, REQUIREMENT_STATUSES, SHOWING_STATUSES, STAGE_PROBABILITY, SYNDICATION_CHANNELS,
  SYNDICATION_STATUSES, brokerageDeals, engagementAgreements, inquiries, listingPriceHistory, listingProspects,
  listings, marketingItems, proposals, prospectPitches, recruits, repAgreements, requirementMatches,
  requirementProfiles, sellerReports, showings,
} from "./schema";
import {
  checklistToggleIn, convertIn, dealBase, dealUpdate, engagementBase, engagementUpdate, inquiryBase, inquiryUpdate,
  listingCreate, listingUpdate, marketingBase, marketingUpdate, matchUpdate, pitchIn, pitchUpdate, priceChangeIn,
  proposalBase, proposalUpdate, prospectBase, prospectUpdate, recruitBase, recruitUpdate, repAgreementBase,
  repAgreementUpdate, requirementBase, requirementUpdate, sellerReportGenerateIn, sellerReportUpdate, showingBase,
  showingUpdate, stageMoveIn, statusChangeIn,
} from "./schemas";
import * as service from "./service";
import type { DealFilters, ListingFilters, ProspectFilters } from "./service";

export const router = new Router();

const STATUS_EVENT_KEYS = ["id", "entity_type", "entity_id", "from_status", "to_status", "reason", "actor_name", "at"] as const;
const pickKeys = (row: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const statusEventOut = (r: Record<string, any>) => pickKeys(r, STATUS_EVENT_KEYS);

const PITCH_KEYS = [
  "kind", "pitched_on", "bov_id", "comp_set_id", "value_low", "value_point", "value_high", "recommended_price",
  "proposed_commission_rate", "outcome", "document_id", "notes", "id", "prospect_id", "valuation_method",
  "valuation_as_of", "created_at", "created_by_id",
] as const;
const pitchOut = (r: Record<string, any>) => pickKeys(r, PITCH_KEYS);

const PRICE_HISTORY_KEYS = [
  "id", "listing_id", "price", "previous_price", "rent_psf", "effective_on", "reason", "source", "actor_name", "at",
] as const;

const MARKETING_KEYS = [
  "kind", "title", "status", "channels", "syndication_status", "external_url", "document_ids", "notes", "id",
  "listing_id", "syndicated_at", "created_at", "updated_at",
] as const;
const marketingOut = (r: Record<string, any>, adReviewStatus: string | null | undefined) => ({
  ...pickKeys(r, MARKETING_KEYS), ad_review_status: adReviewStatus ?? null,
});

const REPORT_KEYS = [
  "id", "listing_id", "period_start", "period_end", "generated_at", "summary", "commentary", "status", "sent_at", "sent_to",
] as const;
const reportOut = (r: Record<string, any>) => pickKeys(r, REPORT_KEYS);

const INQUIRY_KEYS = [
  "listing_id", "property_id", "person_id", "organization_id", "contact_name", "contact_email", "contact_phone",
  "source", "received_at", "status", "message", "assigned_to_id", "follow_up_at", "notes", "id", "follow_up_task_id",
  "created_at",
] as const;
const SHOWING_KEYS = [
  "listing_id", "property_id", "inquiry_id", "tour_id", "person_id", "organization_id", "contact_name", "scheduled_at",
  "shown_by_id", "status", "interest_level", "feedback", "notes", "id", "created_at",
] as const;
const labelFields = () => ({ property_label: null, agent_name: null, person_label: null, organization_label: null });
const inquiryOut = (r: Record<string, any>) => ({ ...pickKeys(r, INQUIRY_KEYS), ...labelFields(), assigned_name: null });
const showingOut = (r: Record<string, any>) => ({ ...pickKeys(r, SHOWING_KEYS), ...labelFields(), shown_by_name: null });

const REQUIREMENT_KEYS = [
  "name", "rep_agreement_id", "client_person_id", "client_organization_id", "agent_id", "side", "status",
  "property_types", "min_size_sf", "max_size_sf", "min_acres", "max_acres", "min_price", "max_price", "states",
  "cities", "counties", "territory_id", "near_lat", "near_lng", "radius_miles", "features", "notes", "id",
  "last_matched_at", "created_at", "updated_at",
] as const;
const MATCH_KEYS = [
  "id", "requirement_id", "property_id", "listing_id", "status", "matched_at", "criteria_met", "notes",
] as const;
const matchOut = (m: Record<string, any>, p?: Record<string, any>) => ({
  ...pickKeys(m, MATCH_KEYS),
  property_label: p ? p.name || p.address_line : null, property_city: p?.city ?? null, property_state: p?.state ?? null,
  property_type: p?.property_type ?? null, building_area_sf: p?.building_area_sf ?? null, asking_price: p?.asking_price ?? null,
});

const PROPOSAL_KEYS = [
  "kind", "title", "brokerage_deal_id", "prospect_id", "listing_id", "requirement_id", "property_id",
  "recipient_person_id", "recipient_organization_id", "agent_id", "status", "price", "rent_psf", "term_months",
  "commission_rate", "terms", "sent_on", "response_due_on", "document_id", "notes", "id", "version",
  "parent_proposal_id", "created_at", "updated_at",
] as const;
const proposalOut = (r: Record<string, any>) => ({ ...pickKeys(r, PROPOSAL_KEYS), ...labelFields() });

const VIEW = "view";
const dateTodayStr = () => new Date().toISOString().slice(0, 10);

// ============================================================================ meta / workspace / documents

router.get("/brokerage/meta", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  return {
    prospect_stages: PROSPECT_STAGES, market_statuses: MARKET_STATUSES, lost_reasons: LOST_REASONS,
    exclusivity: EXCLUSIVITY, commission_structures: COMMISSION_STRUCTURES, agreement_statuses: AGREEMENT_STATUSES,
    listing_types: LISTING_TYPES, listing_statuses: LISTING_STATUSES, report_cadences: REPORT_CADENCES,
    marketing_kinds: MARKETING_KINDS, marketing_statuses: MARKETING_STATUSES, syndication_channels: SYNDICATION_CHANNELS,
    syndication_statuses: SYNDICATION_STATUSES, inquiry_sources: INQUIRY_SOURCES, inquiry_statuses: INQUIRY_STATUSES,
    showing_statuses: SHOWING_STATUSES, interest_levels: INTEREST_LEVELS, requirement_statuses: REQUIREMENT_STATUSES,
    match_statuses: MATCH_STATUSES, proposal_kinds: PROPOSAL_KINDS, proposal_statuses: PROPOSAL_STATUSES,
    deal_sides: DEAL_SIDES, deal_stages: DEAL_STAGES, stage_probability: STAGE_PROBABILITY,
    recruit_stages: RECRUIT_STAGES, onboarding_template: ONBOARDING_TEMPLATE.map(([key, label]) => ({ key, label })),
  };
});

/** The agent's personal pipeline; defaults to the signed-in agent. */
router.get("/brokerage/workspace", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const agentId = ctx.query.uuid("agent_id");
  const allAgents = ctx.query.bool("all_agents") ?? false;
  return service.workspace(ctx.db, allAgents ? null : agentId || user.id);
});

router.get("/brokerage/documents/options", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const q = ctx.query.str("q", { max: 200 });
  const pageSize = ctx.query.int("page_size", { le: 50 }) ?? 15;
  const items = await service.documentOptions(ctx.db, q, pageSize);
  return { items, total: items.length, page: 1, page_size: pageSize };
});

router.get("/brokerage/documents/options/{document_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  return service.documentOption(ctx.db, ctx.uuid("document_id"));
});

router.post("/brokerage/seller-reports/run-due", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  return { generated: await service.runDueReports(ctx.db, user) };
});

router.get("/brokerage/history/{entity_type}/{entity_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const entityType = ctx.param("entity_type");
  const entityId = ctx.uuid("entity_id");
  if (!["listing_prospect", "listing", "brokerage_deal", "recruit"].includes(entityType)) {
    throw new HttpError(404, "Unknown history type");
  }
  return (await service.statusHistory(ctx.db, entityType, entityId)).map(statusEventOut);
});

// ============================================================================ prospects

function prospectFilters(ctx: Ctx): ProspectFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    stage: q.strs("stage"),
    market_status: q.strs("market_status"),
    agent_id: q.uuids("agent_id"),
    property_id: q.uuid("property_id"),
    person_id: q.uuid("person_id"),
    organization_id: q.uuid("organization_id"),
    expiring_within_days: q.int("expiring_within_days", { ge: 0, le: 3650 }),
    mine: q.bool("mine"),
  };
}

const PROSPECT_SORTS = {
  title: listingProspects.title, stage: listingProspects.stage, competitor_expires_on: listingProspects.competitor_expires_on,
  next_action_at: listingProspects.next_action_at, estimated_value: listingProspects.estimated_value,
  updated_at: listingProspects.updated_at, created_at: listingProspects.created_at,
};

router.get("/listing-prospects", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const f = prospectFilters(ctx);
  const order = applySort(p.sort, PROSPECT_SORTS, desc(listingProspects.updated_at));
  const [rows, total] = await paginate(ctx.db, listingProspects, service.prospectQuery(f, user), order, p);
  return page(await service.prospectOuts(ctx.db, rows), total, p);
});

router.get("/listing-prospects/facets", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const f = prospectFilters(ctx);
  const t = listingProspects;
  const q = service.prospectQuery;
  return {
    stage: await facetCounts(ctx.db, t, q(f, user, new Set(["stage"])), t.stage),
    market_status: await facetCounts(ctx.db, t, q(f, user, new Set(["market_status"])), t.market_status),
    agent_id: await facetCounts(ctx.db, t, q(f, user, new Set(["agent_id"])), t.agent_id),
  };
});

router.post("/listing-prospects", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(prospectBase);
  const p = await service.createProspect(ctx.db, body, user);
  return created((await service.prospectOuts(ctx.db, [p]))[0]);
});

router.get("/listing-prospects/{prospect_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const p = await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect");
  return (await service.prospectOuts(ctx.db, [p]))[0];
});

router.patch("/listing-prospects/{prospect_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(prospectUpdate);
  let p = await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect");
  p = await service.updateProspect(ctx.db, p, body, user);
  return (await service.prospectOuts(ctx.db, [p]))[0];
});

router.delete("/listing-prospects/{prospect_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(
    ctx.db, listingProspects, await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect"),
    "listing_prospect", user,
  );
  return noContent();
});

router.post("/listing-prospects/{prospect_id}/move", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(stageMoveIn);
  const p = await service.moveProspect(
    ctx.db, await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect"), body, user,
  );
  return (await service.prospectOuts(ctx.db, [p]))[0];
});

router.get("/listing-prospects/{prospect_id}/pitches", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const t = prospectPitches;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.prospect_id, ctx.uuid("prospect_id")), isNull(t.deleted_at)))
    .orderBy(desc(t.pitched_on), desc(t.created_at));
  return rows.map(pitchOut);
});

router.post("/listing-prospects/{prospect_id}/pitches", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(pitchIn);
  const p = await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect");
  return created(pitchOut(await service.addPitch(ctx.db, p, body, user)));
});

router.patch("/prospect-pitches/{pitch_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(pitchUpdate);
  const pitch = await service.getOr404(ctx.db, prospectPitches, ctx.uuid("pitch_id"), "Pitch");
  return pitchOut(await service.updatePitch(ctx.db, pitch, body, user));
});

router.post("/listing-prospects/{prospect_id}/convert", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(convertIn);
  const p = await service.getOr404(ctx.db, listingProspects, ctx.uuid("prospect_id"), "Prospect");
  const listing = await service.convertProspect(ctx.db, p, body, user);
  return created((await service.listingOuts(ctx.db, [listing]))[0]);
});

// ============================================================================ engagement / representation agreements

router.get("/engagement-agreements", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = engagementAgreements;
  const expiring = q.int("expiring_within_days", { ge: 0, le: 3650 });
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.notes]),
    q.uuid("prospect_id") ? eq(t.prospect_id, q.uuid("prospect_id")!) : undefined,
    q.uuid("listing_id") ? eq(t.listing_id, q.uuid("listing_id")!) : undefined,
    q.uuid("property_id") ? eq(t.property_id, q.uuid("property_id")!) : undefined,
    inFilter(t.status, q.strs("status")),
    inFilter(t.agent_id, q.uuids("agent_id")),
    q.bool("mine") ? eq(t.agent_id, user.id) : undefined,
    expiring !== undefined ? lte(t.expires_on, new Date(Date.now() + expiring * 86_400_000).toISOString().slice(0, 10)) : undefined,
  );
  const order = applySort(p.sort, { expires_on: t.expires_on, status: t.status, updated_at: t.updated_at }, sql`${t.expires_on} asc nulls last`);
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.engagementOuts(ctx.db, rows), total, p);
});

router.post("/engagement-agreements", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(engagementBase);
  return created((await service.engagementOuts(ctx.db, [await service.saveEngagement(ctx.db, body, user)]))[0]);
});

router.get("/engagement-agreements/{agreement_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const ea = await service.getOr404(ctx.db, engagementAgreements, ctx.uuid("agreement_id"), "Engagement agreement");
  return (await service.engagementOuts(ctx.db, [ea]))[0];
});

router.patch("/engagement-agreements/{agreement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(engagementUpdate);
  const ea = await service.getOr404(ctx.db, engagementAgreements, ctx.uuid("agreement_id"), "Engagement agreement");
  return (await service.engagementOuts(ctx.db, [await service.saveEngagement(ctx.db, body, user, ea)]))[0];
});

router.delete("/engagement-agreements/{agreement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  const ea = await service.getOr404(ctx.db, engagementAgreements, ctx.uuid("agreement_id"), "Engagement agreement");
  await service.archiveRow(ctx.db, engagementAgreements, ea, "engagement_agreement", user);
  return noContent();
});

router.get("/rep-agreements", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = repAgreements;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.territory, t.notes]),
    inFilter(t.kind, q.strs("kind")),
    inFilter(t.status, q.strs("status")),
    inFilter(t.agent_id, q.uuids("agent_id")),
    q.uuid("person_id") ? eq(t.client_person_id, q.uuid("person_id")!) : undefined,
    q.uuid("organization_id") ? eq(t.client_organization_id, q.uuid("organization_id")!) : undefined,
    q.bool("mine") ? eq(t.agent_id, user.id) : undefined,
  );
  const order = applySort(
    p.sort, { expires_on: t.expires_on, status: t.status, kind: t.kind, updated_at: t.updated_at }, desc(t.updated_at),
  );
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.repOuts(ctx.db, rows), total, p);
});

router.post("/rep-agreements", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(repAgreementBase);
  return created((await service.repOuts(ctx.db, [await service.saveRepAgreement(ctx.db, body, user)]))[0]);
});

router.get("/rep-agreements/{agreement_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const ra = await service.getOr404(ctx.db, repAgreements, ctx.uuid("agreement_id"), "Representation agreement");
  return (await service.repOuts(ctx.db, [ra]))[0];
});

router.patch("/rep-agreements/{agreement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(repAgreementUpdate);
  const ra = await service.getOr404(ctx.db, repAgreements, ctx.uuid("agreement_id"), "Representation agreement");
  return (await service.repOuts(ctx.db, [await service.saveRepAgreement(ctx.db, body, user, ra)]))[0];
});

router.delete("/rep-agreements/{agreement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  const ra = await service.getOr404(ctx.db, repAgreements, ctx.uuid("agreement_id"), "Representation agreement");
  await service.archiveRow(ctx.db, repAgreements, ra, "rep_agreement", user);
  return noContent();
});

// ============================================================================ listings

function listingFilters(ctx: Ctx): ListingFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    listing_type: q.strs("listing_type"),
    agent_id: q.uuids("agent_id"),
    property_id: q.uuid("property_id"),
    mine: q.bool("mine"),
    min_price: q.num("min_price"),
    max_price: q.num("max_price"),
    min_dom: q.int("min_dom"),
    max_dom: q.int("max_dom"),
  };
}

const LISTING_SORTS = {
  asking_price: listings.asking_price, listed_on: listings.listed_on, status: listings.status,
  expires_on: listings.expires_on, days_on_market: service.domExpr(), updated_at: listings.updated_at,
  created_at: listings.created_at,
};

router.get("/listings", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const f = listingFilters(ctx);
  const order = applySort(p.sort, LISTING_SORTS, desc(listings.updated_at));
  const [rows, total] = await service.listingRows(ctx.db, service.listingWhere(f, user), order, p);
  return page(await service.listingOuts(ctx.db, rows), total, p);
});

router.get("/listings/facets", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const f = listingFilters(ctx);
  const q = service.listingWhere;
  return {
    status: await service.listingFacetCounts(ctx.db, q(f, user, new Set(["status"])), listings.status),
    listing_type: await service.listingFacetCounts(ctx.db, q(f, user, new Set(["listing_type"])), listings.listing_type),
    agent_id: await service.listingFacetCounts(ctx.db, q(f, user, new Set(["agent_id"])), listings.agent_id),
  };
});

router.post("/listings", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(listingCreate);
  const listing = await service.createListing(ctx.db, body, user);
  return created((await service.listingOuts(ctx.db, [listing]))[0]);
});

router.get("/listings/{listing_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const listing = await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing");
  return (await service.listingOuts(ctx.db, [listing]))[0];
});

router.patch("/listings/{listing_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(listingUpdate);
  const listing = await service.updateListing(
    ctx.db, await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing"), body, user,
  );
  return (await service.listingOuts(ctx.db, [listing]))[0];
});

router.delete("/listings/{listing_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  const listing = await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing");
  if (["active", "under_contract", "sold", "leased"].includes(listing.status)) {
    throw new HttpError(409, "Listings that went to market are retained with their history");
  }
  await service.archiveRow(ctx.db, listings, listing, "listing", user);
  return noContent();
});

router.post("/listings/{listing_id}/price", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(priceChangeIn);
  const listing = await service.changePrice(
    ctx.db, await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing"), body, user,
  );
  return (await service.listingOuts(ctx.db, [listing]))[0];
});

router.post("/listings/{listing_id}/status", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(statusChangeIn);
  const listing = await service.changeStatus(
    ctx.db, await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing"), body, user,
  );
  return (await service.listingOuts(ctx.db, [listing]))[0];
});

router.get("/listings/{listing_id}/price-history", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const t = listingPriceHistory;
  const rows = await ctx.db.select().from(t).where(eq(t.listing_id, ctx.uuid("listing_id"))).orderBy(desc(t.at));
  return rows.map((r) => pickKeys(r, PRICE_HISTORY_KEYS));
});

router.get("/listings/{listing_id}/status-history", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  return (await service.statusHistory(ctx.db, "listing", ctx.uuid("listing_id"))).map(statusEventOut);
});

router.get("/listings/{listing_id}/marketing", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const t = marketingItems;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.listing_id, ctx.uuid("listing_id")), isNull(t.deleted_at)))
    .orderBy(desc(t.created_at));
  const reviews = await service.adReviewStatuses(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => marketingOut(r, reviews.get(r.id)));
});

router.post("/listings/{listing_id}/marketing", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(marketingBase);
  const listing = await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing");
  return created(marketingOut(await service.saveMarketing(ctx.db, listing, body, user), null));
});

router.patch("/marketing-items/{item_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(marketingUpdate);
  let item = await service.getOr404(ctx.db, marketingItems, ctx.uuid("item_id"), "Marketing item");
  const listing = await service.getOr404(ctx.db, listings, item.listing_id as string, "Listing");
  item = await service.saveMarketing(ctx.db, listing, body, user, item);
  return marketingOut(item, (await service.adReviewStatuses(ctx.db, [item.id])).get(item.id));
});

router.delete("/marketing-items/{item_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(
    ctx.db, marketingItems, await service.getOr404(ctx.db, marketingItems, ctx.uuid("item_id"), "Marketing item"),
    "marketing_item", user,
  );
  return noContent();
});

router.get("/listings/{listing_id}/seller-reports", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const t = sellerReports;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.listing_id, ctx.uuid("listing_id")), isNull(t.deleted_at)))
    .orderBy(desc(t.period_end));
  return rows.map(reportOut);
});

router.post("/listings/{listing_id}/seller-reports", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(sellerReportGenerateIn);
  const listing = await service.getOr404(ctx.db, listings, ctx.uuid("listing_id"), "Listing");
  const report = await service.generateSellerReport(ctx.db, listing, user, {
    period_start: body.period_start, period_end: body.period_end, commentary: body.commentary,
  });
  return created(reportOut(report));
});

router.patch("/seller-reports/{report_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(sellerReportUpdate);
  const r = await service.getOr404(ctx.db, sellerReports, ctx.uuid("report_id"), "Seller report");
  return reportOut(await service.updateSellerReport(ctx.db, r, body, user));
});

// ============================================================================ inquiries & showings

const INQUIRY_SPEC: service.LabelSpec = {
  ...service.PARTY_SPEC,
  person_id: ["person", "person_label"],
  organization_id: ["organization", "organization_label"],
  assigned_to_id: ["user", "assigned_name"],
};

router.get("/inquiries", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = inquiries;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.contact_name, t.contact_email, t.message]),
    q.uuid("listing_id") ? eq(t.listing_id, q.uuid("listing_id")!) : undefined,
    q.uuid("property_id") ? eq(t.property_id, q.uuid("property_id")!) : undefined,
    inFilter(t.status, q.strs("status")),
    inFilter(t.source, q.strs("source")),
    inFilter(t.assigned_to_id, q.uuids("assigned_to_id")),
    q.bool("mine") ? eq(t.assigned_to_id, user.id) : undefined,
  );
  const order = applySort(p.sort, { received_at: t.received_at, status: t.status, source: t.source }, desc(t.received_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.enrich(ctx.db, rows.map(inquiryOut), INQUIRY_SPEC), total, p);
});

router.post("/inquiries", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(inquiryBase);
  const inq = await service.createInquiry(ctx.db, body, user);
  return created((await service.enrich(ctx.db, [inquiryOut(inq)], INQUIRY_SPEC))[0]);
});

router.patch("/inquiries/{inquiry_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(inquiryUpdate);
  const inq = await service.getOr404(ctx.db, inquiries, ctx.uuid("inquiry_id"), "Inquiry");
  const values = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => !(v === null && ["status", "source", "received_at"].includes(k))),
  );
  await service.patchRow(ctx.db, inquiries, inq, "inquiry", values, user);
  await ctx.db.commit();
  return (await service.enrich(ctx.db, [inquiryOut(inq)], INQUIRY_SPEC))[0];
});

router.delete("/inquiries/{inquiry_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(ctx.db, inquiries, await service.getOr404(ctx.db, inquiries, ctx.uuid("inquiry_id"), "Inquiry"), "inquiry", user);
  return noContent();
});

const SHOWING_SPEC: service.LabelSpec = {
  ...service.PARTY_SPEC,
  person_id: ["person", "person_label"],
  organization_id: ["organization", "organization_label"],
  shown_by_id: ["user", "shown_by_name"],
};

router.get("/showings", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = showings;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.contact_name, t.feedback, t.notes]),
    q.uuid("listing_id") ? eq(t.listing_id, q.uuid("listing_id")!) : undefined,
    q.uuid("property_id") ? eq(t.property_id, q.uuid("property_id")!) : undefined,
    q.uuid("tour_id") ? eq(t.tour_id, q.uuid("tour_id")!) : undefined,
    inFilter(t.status, q.strs("status")),
    q.bool("upcoming") ? gte(t.scheduled_at, utcnow()) : undefined,
    q.bool("mine") ? eq(t.shown_by_id, user.id) : undefined,
  );
  const order = applySort(p.sort, { scheduled_at: t.scheduled_at, status: t.status }, desc(t.scheduled_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.enrich(ctx.db, rows.map(showingOut), SHOWING_SPEC), total, p);
});

router.post("/showings", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(showingBase);
  const s = await service.saveShowing(ctx.db, body, user);
  return created((await service.enrich(ctx.db, [showingOut(s)], SHOWING_SPEC))[0]);
});

router.patch("/showings/{showing_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(showingUpdate);
  const s = await service.saveShowing(ctx.db, body, user, await service.getOr404(ctx.db, showings, ctx.uuid("showing_id"), "Showing"));
  return (await service.enrich(ctx.db, [showingOut(s)], SHOWING_SPEC))[0];
});

router.delete("/showings/{showing_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(ctx.db, showings, await service.getOr404(ctx.db, showings, ctx.uuid("showing_id"), "Showing"), "showing", user);
  return noContent();
});

// ============================================================================ requirements & matches

async function requirementOuts(ctx: Ctx, rows: Array<Record<string, any>>) {
  const counts = new Map<string, number>();
  if (rows.length) {
    const m = requirementMatches;
    const res = await ctx.db
      .select({ k: m.requirement_id, n: sql<number>`count(*)::int` })
      .from(m)
      .where(and(inArray(m.requirement_id, rows.map((r) => r.id)), isNull(m.deleted_at), ne(m.status, "rejected")))
      .groupBy(m.requirement_id);
    for (const r of res) counts.set(r.k as string, Number(r.n));
  }
  const outs = rows.map((r) => ({ ...pickKeys(r, REQUIREMENT_KEYS), ...labelFields(), match_count: counts.get(r.id) ?? 0 }));
  return service.enrich(ctx.db, outs, service.CLIENT_SPEC);
}

const cleanLists = (values: Record<string, any>, keys: readonly string[]) => {
  for (const k of keys) if (k in values && values[k] === null) values[k] = [];
  return values;
};

const REQ_LISTS = ["property_types", "states", "cities", "counties", "features"] as const;

router.get("/requirements", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = requirementProfiles;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.name, t.notes]),
    inFilter(t.status, q.strs("status")),
    inFilter(t.side, q.strs("side")),
    inFilter(t.agent_id, q.uuids("agent_id")),
    q.uuid("rep_agreement_id") ? eq(t.rep_agreement_id, q.uuid("rep_agreement_id")!) : undefined,
    q.bool("mine") ? eq(t.agent_id, user.id) : undefined,
  );
  const order = applySort(p.sort, { name: t.name, status: t.status, updated_at: t.updated_at }, desc(t.updated_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await requirementOuts(ctx, rows), total, p);
});

router.post("/requirements", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(requirementBase);
  const values: Record<string, any> = { ...body };
  values.agent_id = values.agent_id || user.id;
  if (values.rep_agreement_id && !(values.client_person_id || values.client_organization_id)) {
    const ra = await service.getOr404(ctx.db, repAgreements, values.rep_agreement_id, "Representation agreement");
    values.client_person_id = ra.client_person_id;
    values.client_organization_id = ra.client_organization_id;
  }
  const r = await service.createRow(ctx.db, requirementProfiles, "requirement", values, user, values.name);
  await ctx.db.commit();
  return created((await requirementOuts(ctx, [r]))[0]);
});

router.get("/requirements/{requirement_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const r = await service.getOr404(ctx.db, requirementProfiles, ctx.uuid("requirement_id"), "Requirement");
  return (await requirementOuts(ctx, [r]))[0];
});

router.patch("/requirements/{requirement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(requirementUpdate);
  const r = await service.getOr404(ctx.db, requirementProfiles, ctx.uuid("requirement_id"), "Requirement");
  const cleaned = cleanLists({ ...body }, REQ_LISTS);
  const values = Object.fromEntries(
    Object.entries(cleaned).filter(([k, v]) => !(v === null && ["name", "side", "status"].includes(k))),
  );
  await service.patchRow(ctx.db, requirementProfiles, r, "requirement", values, user);
  await ctx.db.commit();
  return (await requirementOuts(ctx, [r]))[0];
});

router.delete("/requirements/{requirement_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  const r = await service.getOr404(ctx.db, requirementProfiles, ctx.uuid("requirement_id"), "Requirement");
  await service.archiveRow(ctx.db, requirementProfiles, r, "requirement", user);
  return noContent();
});

router.post("/requirements/{requirement_id}/match", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const r = await service.getOr404(ctx.db, requirementProfiles, ctx.uuid("requirement_id"), "Requirement");
  const [added, total, criteria] = await service.runMatch(ctx.db, r, user);
  return { added, total, criteria };
});

router.get("/requirements/{requirement_id}/matches", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const m = requirementMatches;
  const rows = await ctx.db
    .select({ m, p: properties })
    .from(m)
    .innerJoin(properties, eq(properties.id, m.property_id))
    .where(
      and(eq(m.requirement_id, ctx.uuid("requirement_id")), isNull(m.deleted_at), inFilter(m.status, ctx.query.strs("status"))),
    )
    .orderBy(desc(m.matched_at))
    .limit(500);
  return rows.map((r) => matchOut(r.m, r.p));
});

router.patch("/requirement-matches/{match_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(matchUpdate);
  const m = await service.getOr404(ctx.db, requirementMatches, ctx.uuid("match_id"), "Match");
  const values = Object.fromEntries(Object.entries(body).filter(([k, v]) => !(k === "status" && v === null)));
  await service.patchRow(ctx.db, requirementMatches, m, "requirement_match", values, user);
  await ctx.db.commit();
  return matchOut(m);
});

// ============================================================================ proposals

const PROPOSAL_SPEC: service.LabelSpec = {
  ...service.PARTY_SPEC,
  recipient_person_id: ["person", "person_label"],
  recipient_organization_id: ["organization", "organization_label"],
};

router.get("/proposals", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = proposals;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.title, t.terms]),
    inFilter(t.kind, q.strs("kind")),
    inFilter(t.status, q.strs("status")),
    q.uuid("brokerage_deal_id") ? eq(t.brokerage_deal_id, q.uuid("brokerage_deal_id")!) : undefined,
    q.uuid("listing_id") ? eq(t.listing_id, q.uuid("listing_id")!) : undefined,
    q.uuid("prospect_id") ? eq(t.prospect_id, q.uuid("prospect_id")!) : undefined,
    q.uuid("requirement_id") ? eq(t.requirement_id, q.uuid("requirement_id")!) : undefined,
    q.uuid("property_id") ? eq(t.property_id, q.uuid("property_id")!) : undefined,
    (q.bool("include_superseded") ?? true) ? undefined : ne(t.status, "superseded"),
    q.bool("mine") ? eq(t.agent_id, user.id) : undefined,
  );
  const order = applySort(
    p.sort, { title: t.title, status: t.status, sent_on: t.sent_on, updated_at: t.updated_at }, desc(t.updated_at),
  );
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.enrich(ctx.db, rows.map(proposalOut), PROPOSAL_SPEC), total, p);
});

router.post("/proposals", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(proposalBase);
  const values: Record<string, any> = { ...body };
  values.agent_id = values.agent_id || user.id;
  const p = await service.createRow(ctx.db, proposals, "proposal", values, user, values.title);
  await service.linkDocument(ctx.db, p.document_id, "proposal", p.id, user);
  await ctx.db.commit();
  return created((await service.enrich(ctx.db, [proposalOut(p)], PROPOSAL_SPEC))[0]);
});

router.get("/proposals/{proposal_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const p = await service.getOr404(ctx.db, proposals, ctx.uuid("proposal_id"), "Proposal");
  return (await service.enrich(ctx.db, [proposalOut(p)], PROPOSAL_SPEC))[0];
});

router.patch("/proposals/{proposal_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(proposalUpdate);
  const p = await service.getOr404(ctx.db, proposals, ctx.uuid("proposal_id"), "Proposal");
  if (p.status === "superseded") throw new HttpError(409, "Superseded versions are retained as history and cannot be edited");
  const values: Record<string, any> = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => !(v === null && ["kind", "title", "status"].includes(k))),
  );
  if (values.status === "superseded") throw new HttpError(422, "Use revise to supersede a proposal");
  if (values.status === "sent" && !(values.sent_on || p.sent_on)) values.sent_on = dateTodayStr();
  await service.patchRow(ctx.db, proposals, p, "proposal", values, user);
  await ctx.db.commit();
  return (await service.enrich(ctx.db, [proposalOut(p)], PROPOSAL_SPEC))[0];
});

router.post("/proposals/{proposal_id}/revise", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(proposalUpdate);
  const parent = await service.getOr404(ctx.db, proposals, ctx.uuid("proposal_id"), "Proposal");
  const child = await service.reviseProposal(ctx.db, parent, body, user);
  return created((await service.enrich(ctx.db, [proposalOut(child)], PROPOSAL_SPEC))[0]);
});

router.delete("/proposals/{proposal_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(ctx.db, proposals, await service.getOr404(ctx.db, proposals, ctx.uuid("proposal_id"), "Proposal"), "proposal", user);
  return noContent();
});

// ============================================================================ brokerage deals

function dealFilters(ctx: Ctx): DealFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    stage: q.strs("stage"),
    side: q.strs("side"),
    agent_id: q.uuids("agent_id"),
    property_id: q.uuid("property_id"),
    listing_id: q.uuid("listing_id"),
    mine: q.bool("mine"),
    closing_before: q.date("closing_before"),
  };
}

const DEAL_SORTS = {
  title: brokerageDeals.title, stage: brokerageDeals.stage, side: brokerageDeals.side,
  expected_close_on: brokerageDeals.expected_close_on, probability: brokerageDeals.probability,
  deal_value: brokerageDeals.deal_value, gross_commission_estimate: brokerageDeals.gross_commission_estimate,
  updated_at: brokerageDeals.updated_at,
};

router.get("/brokerage-deals", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const f = dealFilters(ctx);
  const order = applySort(p.sort, DEAL_SORTS, sql`${brokerageDeals.expected_close_on} asc nulls last`);
  const [rows, total] = await paginate(ctx.db, brokerageDeals, service.dealQuery(f, user), order, p);
  return page(await service.dealOuts(ctx.db, rows), total, p);
});

router.get("/brokerage-deals/facets", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const f = dealFilters(ctx);
  const t = brokerageDeals;
  const q = service.dealQuery;
  return {
    stage: await facetCounts(ctx.db, t, q(f, user, new Set(["stage"])), t.stage),
    side: await facetCounts(ctx.db, t, q(f, user, new Set(["side"])), t.side),
    agent_id: await facetCounts(ctx.db, t, q(f, user, new Set(["agent_id"])), t.agent_id),
  };
});

router.get("/brokerage-deals/board", async (ctx) => {
  const user = await ctx.require("brokerage", VIEW);
  const f = dealFilters(ctx);
  const perStage = ctx.query.int("per_stage", { ge: 1, le: 200 }) ?? 50;
  return service.dealBoard(ctx.db, f, user, perStage);
});

router.post("/brokerage-deals", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(dealBase);
  return created((await service.dealOuts(ctx.db, [await service.createDeal(ctx.db, body, user)]))[0]);
});

router.get("/brokerage-deals/{deal_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const d = await service.getOr404(ctx.db, brokerageDeals, ctx.uuid("deal_id"), "Deal");
  return (await service.dealOuts(ctx.db, [d], { with_file: true }))[0];
});

router.patch("/brokerage-deals/{deal_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(dealUpdate);
  const d = await service.updateDeal(ctx.db, await service.getOr404(ctx.db, brokerageDeals, ctx.uuid("deal_id"), "Deal"), body, user);
  return (await service.dealOuts(ctx.db, [d], { with_file: true }))[0];
});

router.post("/brokerage-deals/{deal_id}/move", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(stageMoveIn);
  const d = await service.moveDeal(ctx.db, await service.getOr404(ctx.db, brokerageDeals, ctx.uuid("deal_id"), "Deal"), body, user);
  return (await service.dealOuts(ctx.db, [d], { with_file: true }))[0];
});

router.delete("/brokerage-deals/{deal_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  const d = await service.getOr404(ctx.db, brokerageDeals, ctx.uuid("deal_id"), "Deal");
  if (["under_contract", "closing", "closed"].includes(d.stage)) {
    throw new HttpError(409, "Deals under contract or closed are retained with their transaction file");
  }
  await service.archiveRow(ctx.db, brokerageDeals, d, "brokerage_deal", user);
  return noContent();
});

// ============================================================================ recruits

router.get("/recruits", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  const p = ctx.listParams();
  const q = ctx.query;
  const t = recruits;
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.full_name, t.email, t.current_brokerage, t.specialty]),
    inFilter(t.stage, q.strs("stage")),
    inFilter(t.recruiter_id, q.uuids("recruiter_id")),
  );
  const order = applySort(
    p.sort,
    { full_name: t.full_name, stage: t.stage, annual_production: t.annual_production, next_action_at: t.next_action_at, updated_at: t.updated_at },
    desc(t.updated_at),
  );
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.recruitOuts(ctx.db, rows), total, p);
});

router.post("/recruits", async (ctx) => {
  const user = await ctx.require("brokerage", "create");
  const body = await ctx.body(recruitBase);
  return created((await service.recruitOuts(ctx.db, [await service.createRecruit(ctx.db, body, user)]))[0]);
});

router.get("/recruits/{recruit_id}", async (ctx) => {
  await ctx.require("brokerage", VIEW);
  return (await service.recruitOuts(ctx.db, [await service.getOr404(ctx.db, recruits, ctx.uuid("recruit_id"), "Recruit")]))[0];
});

router.patch("/recruits/{recruit_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(recruitUpdate);
  const r = await service.getOr404(ctx.db, recruits, ctx.uuid("recruit_id"), "Recruit");
  const values = Object.fromEntries(Object.entries(body).filter(([k, v]) => !(k === "full_name" && !v)));
  await service.patchRow(ctx.db, recruits, r, "recruit", values, user);
  await ctx.db.commit();
  return (await service.recruitOuts(ctx.db, [r]))[0];
});

router.post("/recruits/{recruit_id}/move", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(stageMoveIn);
  const r = await service.moveRecruit(ctx.db, await service.getOr404(ctx.db, recruits, ctx.uuid("recruit_id"), "Recruit"), body, user);
  return (await service.recruitOuts(ctx.db, [r]))[0];
});

router.post("/recruits/{recruit_id}/checklist/{key}", async (ctx) => {
  const user = await ctx.require("brokerage", "edit");
  const body = await ctx.body(checklistToggleIn);
  let r = await service.getOr404(ctx.db, recruits, ctx.uuid("recruit_id"), "Recruit");
  r = await service.toggleChecklist(ctx.db, r, ctx.param("key"), body.done, body.note, user);
  return (await service.recruitOuts(ctx.db, [r]))[0];
});

router.delete("/recruits/{recruit_id}", async (ctx) => {
  const user = await ctx.require("brokerage", "delete");
  await service.archiveRow(ctx.db, recruits, await service.getOr404(ctx.db, recruits, ctx.uuid("recruit_id"), "Recruit"), "recruit", user);
  return noContent();
});
