import { and, desc, eq, inArray, isNull, lt, lte, notInArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { applySearch, applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { patch } from "../../db/orm";
import { brokerageDeals } from "../brokerage/schema";
import {
  ACCESS_ACTIONS, AD_CHECKLIST, AD_REVIEW_STATUSES, adReviews, agentLicenses, dealRoomAccess, dealRoomFolders, dealRooms,
  DELIVERY_METHODS, DISCLOSURE_STATUSES, DISCLOSURE_TYPES, disclosures, FILE_CATEGORIES, FILE_ITEM_STATUSES,
  FINANCING_TYPES, INTEREST_LEVELS, LICENSE_STATUSES, LICENSE_TYPES, NDA_STATUSES, ndas, OFFER_STATUSES,
  offerSubmissions, ROOM_STATUSES, STOP_STATUSES, TOUR_STATUSES, tourFeedback, tourStops, tours,
  transactionFileItems, transactionFiles,
  type AdReview, type Disclosure, type OfferSubmission, type Tour,
} from "./schema";
import {
  accessIn, accessUpdate, acknowledgeIn, adDecisionIn, adReviewBase, deliverIn, disclosureBase, disclosureUpdate,
  feedbackIn, fileItemIn, fileItemUpdate, fileStartIn, folderIn, folderUpdate, licenseBase, licenseUpdate, ndaBase,
  ndaUpdate, offerIn, offerReviewIn, roomCreate, roomUpdate, stopIn, stopUpdate, tourCreate, tourUpdate, waiveIn,
} from "./schemas";
import * as service from "./service";
import { labels, pick } from "./service";

export const router = new Router();

/** Rows tied to a listing / brokerage deal are only visible with brokerage view permission. */
function recordScope(table: any, user: CurrentUser): SQL | undefined {
  if (user.can("brokerage", "view")) return undefined;
  return and(...["listing_id", "brokerage_deal_id"].filter((c) => c in table).map((c) => isNull(table[c])));
}

router.get("/dealroom/meta", async (ctx) => {
  await ctx.require("dealroom", "view");
  return {
    tour_statuses: TOUR_STATUSES, stop_statuses: STOP_STATUSES, interest_levels: INTEREST_LEVELS,
    nda_statuses: NDA_STATUSES, room_statuses: ROOM_STATUSES, access_actions: ACCESS_ACTIONS,
    offer_statuses: OFFER_STATUSES, financing_types: FINANCING_TYPES, license_types: LICENSE_TYPES,
    license_statuses: LICENSE_STATUSES, disclosure_types: DISCLOSURE_TYPES,
    disclosure_statuses: DISCLOSURE_STATUSES, delivery_methods: DELIVERY_METHODS,
    ad_review_statuses: AD_REVIEW_STATUSES, ad_checklist: AD_CHECKLIST.map(([key, label]) => ({ key, label })),
    file_item_statuses: FILE_ITEM_STATUSES, file_categories: FILE_CATEGORIES,
  };
});

router.get("/dealroom/compliance-summary", async (ctx) => {
  await ctx.require("dealroom", "view");
  const db = ctx.db;
  const today = service.today();
  const lic = await db.select().from(agentLicenses).where(isNull(agentLicenses.deleted_at));
  const discs = await db.select().from(disclosures).where(isNull(disclosures.deleted_at));
  const openDiscs = discs.filter((d) => !service.disclosureSatisfied(d));
  const files = await db
    .select()
    .from(transactionFiles)
    .where(and(isNull(transactionFiles.deleted_at), sql`${transactionFiles.status} <> 'approved'`));
  let incomplete = 0;
  for (const f of files) {
    const [, blockers] = await service.evaluateFile(db, f);
    incomplete += blockers.length ? 1 : 0;
  }
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adReviews)
    .where(and(isNull(adReviews.deleted_at), eq(adReviews.status, "pending")));
  return {
    licenses_expiring: lic.filter((x) => ["warning", "critical"].includes(service.licenseAlertLevel(x) ?? "")).length,
    licenses_expired: lic.filter((x) => service.licenseAlertLevel(x) === "expired").length,
    disclosures_open: openDiscs.length,
    disclosures_overdue: openDiscs.filter((d) => d.due_on && d.due_on < today).length,
    ad_reviews_pending: Number(pending?.n ?? 0),
    files_incomplete: incomplete,
  };
});

// ============================================================================ tours

const TOUR_SPEC: Record<string, [string, string]> = {
  agent_id: ["user", "agent_name"], client_person_id: ["person", "person_label"],
  client_organization_id: ["organization", "organization_label"],
};

async function tourOuts(ctx: Ctx, rows: Tour[]) {
  if (!rows.length) return [];
  const db = ctx.db;
  const ids = rows.map((r) => r.id);
  const stops = new Map(
    (
      await db
        .select({ k: tourStops.tour_id, n: sql<number>`count(*)::int` })
        .from(tourStops)
        .where(and(inArray(tourStops.tour_id, ids), isNull(tourStops.deleted_at)))
        .groupBy(tourStops.tour_id)
    ).map((r) => [r.k, Number(r.n)]),
  );
  const fbs = new Map(
    (
      await db
        .select({ k: tourFeedback.tour_id, n: sql<number>`count(*)::int` })
        .from(tourFeedback)
        .where(and(inArray(tourFeedback.tour_id, ids), isNull(tourFeedback.deleted_at)))
        .groupBy(tourFeedback.tour_id)
    ).map((r) => [r.k, Number(r.n)]),
  );
  const outs = rows.map((r) => ({
    ...pick(r, [
      "title", "agent_id", "client_person_id", "client_organization_id", "brokerage_deal_id", "requirement_id",
      "scheduled_on", "start_time", "status", "start_label", "start_lat", "start_lng", "participants", "notes",
    ]),
    participants: r.participants ?? [],
    ...labels(),
    id: r.id,
    total_distance_miles: r.total_distance_miles,
    optimized_at: r.optimized_at,
    stop_count: stops.get(r.id) ?? 0,
    feedback_count: fbs.get(r.id) ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return service.enrich(ctx.db, outs, TOUR_SPEC);
}

interface TourFilters {
  q?: string;
  status?: string[];
  agent_id?: string[];
  mine?: boolean;
  from_date?: string;
  to_date?: string;
  brokerage_deal_id?: string;
}

function tourFilters(ctx: Ctx): TourFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    agent_id: q.uuids("agent_id"),
    mine: q.bool("mine"),
    from_date: q.date("from_date"),
    to_date: q.date("to_date"),
    brokerage_deal_id: q.uuid("brokerage_deal_id"),
  };
}

function tourWhere(user: CurrentUser, f: TourFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = tours;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.notes, t.start_label]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("agent_id") ? undefined : inFilter(t.agent_id, f.agent_id),
    f.mine ? eq(t.agent_id, user.id) : undefined,
    f.from_date ? sql`${t.scheduled_on} >= ${f.from_date}` : undefined,
    f.to_date ? sql`${t.scheduled_on} <= ${f.to_date}` : undefined,
    f.brokerage_deal_id ? eq(t.brokerage_deal_id, f.brokerage_deal_id) : undefined,
  );
}

router.get("/tours", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, {
    scheduled_on: tours.scheduled_on, title: tours.title, status: tours.status,
    total_distance_miles: tours.total_distance_miles, updated_at: tours.updated_at,
  }, desc(tours.scheduled_on));
  const [rows, total] = await paginate(ctx.db, tours, tourWhere(user, tourFilters(ctx)), order, p);
  return page(await tourOuts(ctx, rows), total, p);
});

router.get("/tours/facets", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const f = tourFilters(ctx);
  return {
    status: await facetCounts(ctx.db, tours, tourWhere(user, f, new Set(["status"])), tours.status),
    agent_id: await facetCounts(ctx.db, tours, tourWhere(user, f, new Set(["agent_id"])), tours.agent_id),
  };
});

router.post("/tours", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(tourCreate);
  return created((await tourOuts(ctx, [await service.createTour(ctx.db, body, user)]))[0]);
});

router.get("/tours/{tour_id}", async (ctx) => {
  await ctx.require("dealroom", "view");
  return (await tourOuts(ctx, [await service.getOr404(ctx.db, tours, ctx.uuid("tour_id"), "Tour")]))[0];
});

router.patch("/tours/{tour_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(tourUpdate);
  const tour = await service.updateTour(ctx.db, await service.getOr404(ctx.db, tours, ctx.uuid("tour_id"), "Tour"), body, user);
  return (await tourOuts(ctx, [tour]))[0];
});

router.delete("/tours/{tour_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "delete");
  await service.archiveRow(ctx.db, tours, await service.getOr404(ctx.db, tours, ctx.uuid("tour_id"), "Tour"), "tour", user);
  return noContent();
});

router.get("/tours/{tour_id}/stops", async (ctx) => {
  await ctx.require("dealroom", "view");
  const id = ctx.uuid("tour_id");
  await service.getOr404(ctx.db, tours, id, "Tour");
  return service.stopOuts(ctx.db, id);
});

router.post("/tours/{tour_id}/stops", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(stopIn);
  const id = ctx.uuid("tour_id");
  const tour = await service.getOr404(ctx.db, tours, id, "Tour");
  await service.addStop(ctx.db, tour, body, user);
  return created(await service.stopOuts(ctx.db, id));
});

router.post("/tours/{tour_id}/optimize", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const id = ctx.uuid("tour_id");
  const tour = await service.getOr404(ctx.db, tours, id, "Tour");
  const unlocated = await service.optimizeRoute(ctx.db, tour, user);
  await ctx.db.commit();
  return { total_distance_miles: tour.total_distance_miles || 0, unlocated, stops: await service.stopOuts(ctx.db, id) };
});

router.patch("/tour-stops/{stop_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(stopUpdate);
  const stop = await service.updateStop(ctx.db, await service.getOr404(ctx.db, tourStops, ctx.uuid("stop_id"), "Stop"), body, user);
  return service.stopOuts(ctx.db, stop.tour_id);
});

router.delete("/tour-stops/{stop_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  await service.removeStop(ctx.db, await service.getOr404(ctx.db, tourStops, ctx.uuid("stop_id"), "Stop"), user);
  return noContent();
});

const FEEDBACK_SPEC: Record<string, [string, string]> = {
  property_id: ["property", "property_label"], person_id: ["person", "person_label"],
};

const feedbackOut = (r: any) => ({
  ...pick(r, ["stop_id", "property_id", "person_id", "rating", "interest_level", "feedback", "objections", "next_action", "next_action_at"]),
  ...labels(),
  id: r.id,
  tour_id: r.tour_id,
  listing_id: r.listing_id,
  follow_up_task_id: r.follow_up_task_id,
  showing_id: r.showing_id,
  created_at: r.created_at,
});

router.get("/tours/{tour_id}/feedback", async (ctx) => {
  await ctx.require("dealroom", "view");
  const rows = await ctx.db
    .select()
    .from(tourFeedback)
    .where(and(eq(tourFeedback.tour_id, ctx.uuid("tour_id")), isNull(tourFeedback.deleted_at)))
    .orderBy(desc(tourFeedback.created_at));
  return service.enrich(ctx.db, rows.map(feedbackOut), FEEDBACK_SPEC);
});

router.post("/tours/{tour_id}/feedback", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(feedbackIn);
  const tour = await service.getOr404(ctx.db, tours, ctx.uuid("tour_id"), "Tour");
  const fb = await service.addFeedback(ctx.db, tour, body, user);
  return created((await service.enrich(ctx.db, [feedbackOut(fb)], FEEDBACK_SPEC))[0]);
});

// ============================================================================ NDAs

router.get("/ndas", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = ndas;
  const eqIf = (col: any, v: string | undefined) => (v ? eq(col, v) : undefined);
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.signer_name, t.signer_email, t.notes]),
    inFilter(t.status, q.strs("status")),
    eqIf(t.person_id, q.uuid("person_id")),
    eqIf(t.organization_id, q.uuid("organization_id")),
    eqIf(t.deal_room_id, q.uuid("deal_room_id")),
    eqIf(t.listing_id, q.uuid("listing_id")),
    recordScope(t, user),
  );
  const order = applySort(p.sort, {
    status: t.status, signed_at: t.signed_at, expires_on: t.expires_on, updated_at: t.updated_at,
  }, desc(t.updated_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.ndaOuts(ctx.db, rows), total, p);
});

router.post("/ndas", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(ndaBase);
  return created((await service.ndaOuts(ctx.db, [await service.saveNda(ctx.db, body, user)]))[0]);
});

router.patch("/ndas/{nda_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(ndaUpdate);
  const n = await service.getOr404(ctx.db, ndas, ctx.uuid("nda_id"), "NDA");
  return (await service.ndaOuts(ctx.db, [await service.saveNda(ctx.db, body, user, n)]))[0];
});

router.delete("/ndas/{nda_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "delete");
  await service.archiveRow(ctx.db, ndas, await service.getOr404(ctx.db, ndas, ctx.uuid("nda_id"), "NDA"), "nda", user);
  return noContent();
});

// ============================================================================ deal rooms (internal)

router.get("/deal-rooms", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = dealRooms;
  const eqIf = (col: any, v: string | undefined) => (v ? eq(col, v) : undefined);
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.name, t.description]),
    inFilter(t.status, q.strs("status")),
    eqIf(t.listing_id, q.uuid("listing_id")),
    eqIf(t.brokerage_deal_id, q.uuid("brokerage_deal_id")),
    eqIf(t.property_id, q.uuid("property_id")),
    recordScope(t, user),
  );
  const order = applySort(p.sort, { name: t.name, status: t.status, updated_at: t.updated_at }, desc(t.updated_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.roomOuts(ctx.db, rows), total, p);
});

router.post("/deal-rooms", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(roomCreate);
  return created((await service.roomOuts(ctx.db, [await service.createRoom(ctx.db, body, user)]))[0]);
});

router.get("/deal-rooms/{room_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  return (await service.roomOuts(ctx.db, [await service.internalRoom(ctx.db, ctx.uuid("room_id"), user)]))[0];
});

router.patch("/deal-rooms/{room_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(roomUpdate);
  const room = await service.updateRoom(ctx.db, await service.internalRoom(ctx.db, ctx.uuid("room_id"), user), body, user);
  return (await service.roomOuts(ctx.db, [room]))[0];
});

router.get("/deal-rooms/{room_id}/folders", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  return service.folderOuts(ctx.db, await service.internalRoom(ctx.db, ctx.uuid("room_id"), user));
});

router.post("/deal-rooms/{room_id}/folders", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(folderIn);
  const room = await service.internalRoom(ctx.db, ctx.uuid("room_id"), user);
  const folder = await service.saveFolder(ctx.db, room, body, user);
  return created((await service.folderOuts(ctx.db, room)).find((f) => f.id === folder.id));
});

router.patch("/deal-room-folders/{folder_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(folderUpdate);
  const folder = await service.getOr404(ctx.db, dealRoomFolders, ctx.uuid("folder_id"), "Folder");
  const room = await service.internalRoom(ctx.db, folder.room_id, user);
  await service.saveFolder(ctx.db, room, body, user, folder);
  return (await service.folderOuts(ctx.db, room)).find((f) => f.id === folder.id);
});

router.delete("/deal-room-folders/{folder_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "delete");
  const folder = await service.getOr404(ctx.db, dealRoomFolders, ctx.uuid("folder_id"), "Folder");
  await service.internalRoom(ctx.db, folder.room_id, user);
  await service.archiveRow(ctx.db, dealRoomFolders, folder, "deal_room_folder", user);
  return noContent();
});

router.get("/deal-rooms/{room_id}/access", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const room = await service.internalRoom(ctx.db, ctx.uuid("room_id"), user);
  const rows = await ctx.db
    .select()
    .from(dealRoomAccess)
    .where(and(eq(dealRoomAccess.room_id, room.id), isNull(dealRoomAccess.deleted_at)))
    .orderBy(desc(dealRoomAccess.created_at));
  return service.accessOuts(ctx.db, room, rows);
});

router.post("/deal-rooms/{room_id}/access", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(accessIn);
  const room = await service.internalRoom(ctx.db, ctx.uuid("room_id"), user);
  const g = await service.grantAccess(ctx.db, room, body, user);
  return created((await service.accessOuts(ctx.db, room, [g]))[0]);
});

router.patch("/deal-room-access/{access_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(accessUpdate);
  const g = await service.getOr404(ctx.db, dealRoomAccess, ctx.uuid("access_id"), "Access grant");
  const room = await service.internalRoom(ctx.db, g.room_id, user);
  const values: Record<string, any> = { ...body };
  for (const k of ["can_download", "can_submit_offers"]) if (k in values && values[k] === null) delete values[k];
  if ("folder_ids" in values) values.folder_ids = values.folder_ids || [];
  await service.patchRow(ctx.db, dealRoomAccess, g, "deal_room_access", values, user);
  await ctx.db.commit();
  return (await service.accessOuts(ctx.db, room, [g]))[0];
});

router.post("/deal-room-access/{access_id}/revoke", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const g = await service.getOr404(ctx.db, dealRoomAccess, ctx.uuid("access_id"), "Access grant");
  const room = await service.internalRoom(ctx.db, g.room_id, user);
  return (await service.accessOuts(ctx.db, room, [await service.revokeAccess(ctx.db, g, user)]))[0];
});

router.get("/deal-rooms/{room_id}/analytics", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  return service.analytics(ctx.db, await service.internalRoom(ctx.db, ctx.uuid("room_id"), user));
});

const ACTION_RE = /^(view|download)$/;

router.post("/deal-rooms/{room_id}/documents/{document_id}/open", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const action = ctx.query.str("action", { pattern: ACTION_RE }) ?? "view";
  const room = await service.internalRoom(ctx.db, ctx.uuid("room_id"), user);
  const documentId = ctx.uuid("document_id");
  const url = await service.openDocument(ctx.db, room, documentId, action, user, null);
  return { document_id: documentId, url, action };
});

router.post("/deal-rooms/{room_id}/offers", async (ctx) => {
  // Internal users record an offer received outside the portal on behalf of the counterparty.
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(offerIn);
  const room = await service.internalRoom(ctx.db, ctx.uuid("room_id"), user);
  return created((await offerOuts(ctx, [await service.submitOffer(ctx.db, room, body, user, null)]))[0]);
});

// ============================================================================ counterparty portal (grant-based)

router.get("/deal-room-portal", async (ctx) => {
  const user = await ctx.authed();
  const grants = await ctx.db
    .select()
    .from(dealRoomAccess)
    .where(and(eq(dealRoomAccess.user_id, user.id), isNull(dealRoomAccess.deleted_at), eq(dealRoomAccess.status, "active")));
  const rooms = new Map<string, any>();
  for (const g of grants) {
    const [room] = await ctx.db.select().from(dealRooms).where(eq(dealRooms.id, g.room_id)).limit(1);
    if (room && !room.deleted_at && !(await service.grantProblem(ctx.db, room, g))) rooms.set(room.id, room);
  }
  return service.roomOuts(ctx.db, [...rooms.values()]);
});

router.get("/deal-room-portal/{room_id}", async (ctx) => {
  const user = await ctx.authed();
  const room = await service.getOr404(ctx.db, dealRooms, ctx.uuid("room_id"), "Deal room");
  const grant = await service.portalGrant(ctx.db, room, user);
  await service.logAccess(ctx.db, room, grant, user, "view_room", { is_internal: false });
  const folders = await service.folderOuts(ctx.db, room, grant);
  await ctx.db.commit();
  const roomOut = (await service.roomOuts(ctx.db, [room]))[0];
  return {
    room: roomOut, access_id: grant.id, can_download: grant.can_download,
    can_submit_offers: grant.can_submit_offers && room.allow_offers, folders,
  };
});

router.post("/deal-room-portal/{room_id}/documents/{document_id}/open", async (ctx) => {
  const user = await ctx.authed();
  const action = ctx.query.str("action", { pattern: ACTION_RE }) ?? "view";
  const room = await service.getOr404(ctx.db, dealRooms, ctx.uuid("room_id"), "Deal room");
  const grant = await service.portalGrant(ctx.db, room, user);
  const documentId = ctx.uuid("document_id");
  const url = await service.openDocument(ctx.db, room, documentId, action, user, grant);
  return { document_id: documentId, url, action };
});

router.post("/deal-room-portal/{room_id}/offers", async (ctx) => {
  const user = await ctx.authed();
  const body = await ctx.body(offerIn);
  const room = await service.getOr404(ctx.db, dealRooms, ctx.uuid("room_id"), "Deal room");
  const grant = await service.portalGrant(ctx.db, room, user);
  const offer = await service.submitOffer(ctx.db, room, body, user, grant);
  return created(offerOut(offer));
});

// ============================================================================ offers (review)

const OFFER_SPEC: Record<string, [string, string]> = {
  property_id: ["property", "property_label"], submitter_person_id: ["person", "person_label"],
  submitter_organization_id: ["organization", "organization_label"], reviewed_by_id: ["user", "reviewer_name"],
};

const offerOut = (r: OfferSubmission) => ({
  ...pick(r, [
    "submitter_person_id", "submitter_organization_id", "submitter_name", "submitter_email", "buyer_entity", "price",
    "earnest_money", "due_diligence_days", "closing_days", "financing_type", "terms", "expires_at", "document_id",
    "parent_submission_id",
  ]),
  contingencies: r.contingencies ?? [],
  ...labels(),
  id: r.id,
  room_id: r.room_id,
  listing_id: r.listing_id,
  brokerage_deal_id: r.brokerage_deal_id,
  property_id: r.property_id,
  access_id: r.access_id,
  version: r.version,
  status: r.status,
  submitted_at: r.submitted_at,
  reviewed_by_id: r.reviewed_by_id,
  reviewed_at: r.reviewed_at,
  reviewer_name: null as string | null,
});

async function offerOuts(ctx: Ctx, rows: OfferSubmission[]) {
  return service.enrich(ctx.db, rows.map(offerOut), OFFER_SPEC);
}

router.get("/offer-submissions", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = offerSubmissions;
  const eqIf = (col: any, v: string | undefined) => (v ? eq(col, v) : undefined);
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.submitter_name, t.buyer_entity, t.terms]),
    eqIf(t.room_id, q.uuid("room_id")),
    eqIf(t.listing_id, q.uuid("listing_id")),
    eqIf(t.brokerage_deal_id, q.uuid("brokerage_deal_id")),
    eqIf(t.property_id, q.uuid("property_id")),
    inFilter(t.status, q.strs("status")),
    recordScope(t, user),
  );
  const order = applySort(p.sort, { price: t.price, submitted_at: t.submitted_at, status: t.status }, desc(t.submitted_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await offerOuts(ctx, rows), total, p);
});

router.post("/offer-submissions/{offer_id}/review", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(offerReviewIn);
  let offer = await service.getOr404(ctx.db, offerSubmissions, ctx.uuid("offer_id"), "Offer");
  if (offer.room_id) await service.internalRoom(ctx.db, offer.room_id, user);
  offer = await service.reviewOffer(ctx.db, offer, body.status, body.review_notes, user);
  return (await offerOuts(ctx, [offer]))[0];
});

// ============================================================================ licenses

router.get("/agent-licenses", async (ctx) => {
  await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = agentLicenses;
  const expiring = q.int("expiring_within_days", { ge: 0, le: 3650 });
  const userId = q.uuid("user_id");
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.holder_name, t.license_number, t.sponsoring_broker]),
    inFilter(t.status, q.strs("status")),
    inFilter(t.state, q.strs("state")),
    userId ? eq(t.user_id, userId) : undefined,
    expiring !== undefined
      ? lte(t.expires_on, new Date(Date.parse(service.today()) + expiring * 86_400_000).toISOString().slice(0, 10))
      : undefined,
  );
  const order = applySort(p.sort, {
    expires_on: t.expires_on, holder_name: t.holder_name, state: t.state, status: t.status,
  }, sql`${t.expires_on} asc nulls last`);
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await service.licenseOuts(ctx.db, rows), total, p);
});

router.post("/agent-licenses/scan", async (ctx) => {
  // Expiration alerts for licenses and disclosure deadlines. Idempotent; safe to schedule.
  const user = await ctx.require("dealroom", "edit");
  return service.scanCompliance(ctx.db, user);
});

router.post("/agent-licenses", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(licenseBase);
  return created((await service.licenseOuts(ctx.db, [await service.saveLicense(ctx.db, body, user)]))[0]);
});

router.patch("/agent-licenses/{license_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(licenseUpdate);
  const lic = await service.getOr404(ctx.db, agentLicenses, ctx.uuid("license_id"), "License");
  return (await service.licenseOuts(ctx.db, [await service.saveLicense(ctx.db, body, user, lic)]))[0];
});

router.delete("/agent-licenses/{license_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "delete");
  await service.archiveRow(
    ctx.db, agentLicenses, await service.getOr404(ctx.db, agentLicenses, ctx.uuid("license_id"), "License"), "agent_license", user,
  );
  return noContent();
});

// ============================================================================ disclosures

const DISCLOSURE_SPEC: Record<string, [string, string]> = {
  property_id: ["property", "property_label"], owner_id: ["user", "agent_name"],
  recipient_person_id: ["person", "person_label"], recipient_organization_id: ["organization", "organization_label"],
};

async function disclosureOuts(ctx: Ctx, rows: Disclosure[]) {
  const outs = rows.map((r) => {
    const satisfied = service.disclosureSatisfied(r);
    return {
      ...pick(r, [
        "brokerage_deal_id", "listing_id", "property_id", "disclosure_type", "title", "recipient_person_id",
        "recipient_organization_id", "recipient_name", "due_on", "is_blocking", "requires_acknowledgement", "owner_id",
        "evidence_note",
      ]),
      ...labels(),
      id: r.id,
      status: r.status,
      delivered_at: r.delivered_at,
      delivery_method: r.delivery_method,
      evidence_document_id: r.evidence_document_id,
      acknowledged_at: r.acknowledged_at,
      acknowledged_by_name: r.acknowledged_by_name,
      acknowledgement_document_id: r.acknowledgement_document_id,
      waived_reason: r.waived_reason,
      critical_date_id: r.critical_date_id,
      is_overdue: Boolean(r.due_on && r.due_on < service.today() && !satisfied),
      is_satisfied: satisfied,
      created_at: r.created_at,
    };
  });
  return service.enrich(ctx.db, outs, DISCLOSURE_SPEC);
}

router.get("/disclosures", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = disclosures;
  const deal = q.uuid("brokerage_deal_id");
  const listing = q.uuid("listing_id");
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.title, t.recipient_name]),
    inFilter(t.status, q.strs("status")),
    inFilter(t.disclosure_type, q.strs("disclosure_type")),
    deal ? eq(t.brokerage_deal_id, deal) : undefined,
    listing ? eq(t.listing_id, listing) : undefined,
    q.bool("overdue") ? and(lt(t.due_on, service.today()), notInArray(t.status, ["waived", "acknowledged"])) : undefined,
    recordScope(t, user),
  );
  const order = applySort(p.sort, { due_on: t.due_on, status: t.status, title: t.title }, sql`${t.due_on} asc nulls last`);
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await disclosureOuts(ctx, rows), total, p);
});

router.post("/disclosures", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(disclosureBase);
  return created((await disclosureOuts(ctx, [await service.createDisclosure(ctx.db, body, user)]))[0]);
});

router.patch("/disclosures/{disclosure_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(disclosureUpdate);
  const d = await service.getOr404(ctx.db, disclosures, ctx.uuid("disclosure_id"), "Disclosure");
  return (await disclosureOuts(ctx, [await service.updateDisclosure(ctx.db, d, body, user)]))[0];
});

router.post("/disclosures/{disclosure_id}/deliver", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(deliverIn);
  const d = await service.getOr404(ctx.db, disclosures, ctx.uuid("disclosure_id"), "Disclosure");
  return (await disclosureOuts(ctx, [await service.deliverDisclosure(ctx.db, d, body, user)]))[0];
});

router.post("/disclosures/{disclosure_id}/acknowledge", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(acknowledgeIn);
  const d = await service.getOr404(ctx.db, disclosures, ctx.uuid("disclosure_id"), "Disclosure");
  return (await disclosureOuts(ctx, [await service.acknowledgeDisclosure(ctx.db, d, body, user)]))[0];
});

router.post("/disclosures/{disclosure_id}/waive", async (ctx) => {
  const user = await ctx.require("dealroom", "approve");
  const body = await ctx.body(waiveIn);
  const d = await service.getOr404(ctx.db, disclosures, ctx.uuid("disclosure_id"), "Disclosure");
  return (await disclosureOuts(ctx, [await service.waiveDisclosure(ctx.db, d, body.reason, user)]))[0];
});

router.delete("/disclosures/{disclosure_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "delete");
  const d = await service.getOr404(ctx.db, disclosures, ctx.uuid("disclosure_id"), "Disclosure");
  if (["delivered", "acknowledged"].includes(d.status)) {
    throw new HttpError(409, "Delivered disclosures are retained as compliance evidence");
  }
  await service.archiveRow(ctx.db, disclosures, d, "disclosure", user);
  return noContent();
});

// ============================================================================ advertising review

async function adOuts(ctx: Ctx, rows: AdReview[]) {
  const users = await service.names(ctx.db, "user", [...rows.map((r) => r.submitted_by_id), ...rows.map((r) => r.reviewer_id)]);
  return rows.map((r) => ({
    ...pick(r, ["title", "listing_id", "marketing_item_id", "brokerage_deal_id", "channel", "content_summary", "document_id"]),
    id: r.id,
    submitted_by_id: r.submitted_by_id,
    submitted_at: r.submitted_at,
    status: r.status,
    checklist: r.checklist ?? [],
    reviewer_id: r.reviewer_id,
    reviewed_at: r.reviewed_at,
    review_notes: r.review_notes,
    submitted_by_name: r.submitted_by_id ? (users[r.submitted_by_id] ?? null) : null,
    reviewer_name: r.reviewer_id ? (users[r.reviewer_id] ?? null) : null,
    property_label: null,
  }));
}

router.get("/ad-reviews", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const t = adReviews;
  const listing = q.uuid("listing_id");
  const item = q.uuid("marketing_item_id");
  const where = and(
    isNull(t.deleted_at),
    applySearch(p.q, [t.title, t.channel, t.content_summary]),
    inFilter(t.status, q.strs("status")),
    listing ? eq(t.listing_id, listing) : undefined,
    item ? eq(t.marketing_item_id, item) : undefined,
    recordScope(t, user),
  );
  const order = applySort(p.sort, { submitted_at: t.submitted_at, status: t.status, title: t.title }, desc(t.submitted_at));
  const [rows, total] = await paginate(ctx.db, t, where, order, p);
  return page(await adOuts(ctx, rows), total, p);
});

router.post("/ad-reviews", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(adReviewBase);
  return created((await adOuts(ctx, [await service.submitAdReview(ctx.db, body, user)]))[0]);
});

router.post("/ad-reviews/{review_id}/decision", async (ctx) => {
  const user = await ctx.require("dealroom", "approve");
  const body = await ctx.body(adDecisionIn);
  const r = await service.getOr404(ctx.db, adReviews, ctx.uuid("review_id"), "Advertising review");
  return (await adOuts(ctx, [await service.decideAdReview(ctx.db, r, body, user)]))[0];
});

// ============================================================================ transaction files

router.get("/transaction-files", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  const p = ctx.listParams();
  if (!user.can("brokerage", "view")) throw new HttpError(403, "Brokerage access is required to view transaction files");
  const tf = transactionFiles;
  const bd = brokerageDeals;
  const where = and(
    isNull(tf.deleted_at),
    isNull(bd.deleted_at),
    applySearch(p.q, [bd.title]),
    inFilter(tf.status, ctx.query.strs("status")),
    ctx.query.bool("mine") ? eq(bd.agent_id, user.id) : undefined,
  );
  const order = applySort(p.sort, { status: tf.status, updated_at: tf.updated_at, deal: bd.title }, desc(tf.updated_at));
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(tf)
    .innerJoin(bd, eq(bd.id, tf.brokerage_deal_id))
    .where(where);
  const rows = await ctx.db
    .select({ f: tf })
    .from(tf)
    .innerJoin(bd, eq(bd.id, tf.brokerage_deal_id))
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  const items = [];
  for (const r of rows) items.push(await service.fileOut(ctx.db, r.f, { with_items: false }));
  return page(items, Number(n), p);
});

router.post("/transaction-files", async (ctx) => {
  const user = await ctx.require("dealroom", "create");
  const body = await ctx.body(fileStartIn);
  if (!user.can("brokerage", "view")) throw new HttpError(403, "Brokerage access is required");
  const deal = await service.getOr404(ctx.db, brokerageDeals, body.brokerage_deal_id, "Deal");
  const f = await service.ensureTransactionFile(ctx.db, deal, user);
  await ctx.db.commit();
  return created(await service.fileOut(ctx.db, f));
});

router.get("/transaction-files/check/{brokerage_deal_id}", async (ctx) => {
  await ctx.require("dealroom", "view");
  const id = ctx.uuid("brokerage_deal_id");
  const [ok, blockers] = await service.transactionFileComplete(ctx.db, id);
  return { brokerage_deal_id: id, complete: ok, blockers };
});

router.get("/transaction-files/by-deal/{brokerage_deal_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  if (!user.can("brokerage", "view")) throw new HttpError(403, "Brokerage access is required");
  const [f] = await ctx.db
    .select()
    .from(transactionFiles)
    .where(and(eq(transactionFiles.brokerage_deal_id, ctx.uuid("brokerage_deal_id")), isNull(transactionFiles.deleted_at)))
    .limit(1);
  if (!f) throw new HttpError(404, "No transaction file for this deal yet");
  return service.fileOut(ctx.db, f);
});

router.get("/transaction-files/{file_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "view");
  if (!user.can("brokerage", "view")) throw new HttpError(403, "Brokerage access is required");
  return service.fileOut(ctx.db, await service.getOr404(ctx.db, transactionFiles, ctx.uuid("file_id"), "Transaction file"));
});

router.post("/transaction-files/{file_id}/items", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(fileItemIn);
  const f = await service.getOr404(ctx.db, transactionFiles, ctx.uuid("file_id"), "Transaction file");
  const [{ n }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactionFileItems)
    .where(eq(transactionFileItems.file_id, f.id));
  const key = "custom_" + randomUUID().replace(/-/g, "").slice(0, 8);
  await service.createRow(ctx.db, transactionFileItems, "transaction_file_item", {
    ...body, file_id: f.id, key, sort_order: (Number(n || 0) + 1) * 10, status: "missing",
  }, user, body.label);
  if (f.status === "complete" && body.is_required) {
    await patch(ctx.db, transactionFiles, f, { status: "open" });
  }
  await ctx.db.commit();
  return created(await service.fileOut(ctx.db, f));
});

router.patch("/transaction-file-items/{item_id}", async (ctx) => {
  const user = await ctx.require("dealroom", "edit");
  const body = await ctx.body(fileItemUpdate);
  let item = await service.getOr404(ctx.db, transactionFileItems, ctx.uuid("item_id"), "Checklist item");
  item = await service.updateFileItem(ctx.db, item, body, user);
  const [f] = await ctx.db.select().from(transactionFiles).where(eq(transactionFiles.id, item.file_id)).limit(1);
  const out = await service.fileOut(ctx.db, f);
  return out.items.find((i: any) => i.id === item.id);
});

router.post("/transaction-files/{file_id}/approve", async (ctx) => {
  const user = await ctx.require("dealroom", "approve");
  const f = await service.getOr404(ctx.db, transactionFiles, ctx.uuid("file_id"), "Transaction file");
  return service.fileOut(ctx.db, await service.approveFile(ctx.db, f, user));
});
