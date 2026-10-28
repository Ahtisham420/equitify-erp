import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { type Ctx, Router } from "../../core/router";
import type { CurrentUser } from "../../core/deps";
import { utcnow } from "../../core/security";
import { get, patch } from "../../db/orm";
import {
  CALL_ITEM_STATUSES, capitalAccountEntries, capitalEventAllocations, capitalEvents, capitalEventVersions,
  capitalPartners, COMM_CHANNELS, COMPONENTS, DAY_COUNTS, ENTRY_TYPES, EVENT_STATUSES, EVENT_TYPES, HURDLE_TYPES,
  PACKAGE_TYPES, PARTNER_STATUSES, PARTNER_TYPES, REPORT_FREQUENCIES, reportPackages, reportSchedules, TIER_TYPES,
  waterfalls,
} from "./schema";
import {
  decisionIn, defaultIn, eventCreate, eventPreviewIn, eventUpdate, fundIn, incomeAllocationIn, investmentCreate,
  investmentUpdate, packageCreate, partnerCreate, partnerUpdate, reverseIn, scheduleIn, scheduleUpdate, waterfallIn,
} from "./schemas";
import * as service from "./service";
import type { EventFilters, PartnerFilters } from "./service";

export const router = new Router();

const VIEW = ["investors", "view"] as const;
const CREATE = ["investors", "create"] as const;
const EDIT = ["investors", "edit"] as const;
const APPROVE = ["investors", "approve"] as const;
const DELETE = ["investors", "delete"] as const;

/** Permission check plus portal exclusion: capital-partner users never reach internal endpoints. */
async function staff(ctx: Ctx, perm: readonly [string, string]): Promise<CurrentUser> {
  const user = await ctx.require(perm[0], perm[1]);
  service.denyPortal(user);
  return user;
}

const today = () => new Date().toISOString().slice(0, 10);

router.get("/investors/meta", async (ctx) => {
  await ctx.require(...VIEW);
  return {
    partner_types: PARTNER_TYPES, partner_statuses: PARTNER_STATUSES, day_counts: DAY_COUNTS, tier_types: TIER_TYPES,
    hurdle_types: HURDLE_TYPES, event_types: EVENT_TYPES, event_statuses: EVENT_STATUSES, entry_types: ENTRY_TYPES,
    components: COMPONENTS, call_item_statuses: CALL_ITEM_STATUSES, package_types: PACKAGE_TYPES,
    report_frequencies: REPORT_FREQUENCIES, channels: COMM_CHANNELS,
  };
});

// --------------------------------------------------------------------------- portal

router.get("/investors/portal/me", async (ctx) => {
  const user = await ctx.require(...VIEW);
  return service.portal(ctx.db, user);
});

// --------------------------------------------------------------------------- partners

const P = capitalPartners;
const PARTNER_SORTS = { name: P.name, type: P.type, status: P.status, updated_at: P.updated_at, created_at: P.created_at };

function partnerFilters(ctx: Ctx): PartnerFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    type: q.strs("type"),
    status: q.strs("status"),
    owner_id: q.uuids("owner_id"),
    asset_id: q.uuid("asset_id"),
    in_default: q.bool("in_default"),
  };
}

router.get("/investors/partners", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const p = ctx.listParams();
  const f = partnerFilters(ctx);
  const ids = await service.scopeIds(ctx.db, user);
  const [rows, total] = await paginate(ctx.db, P, service.buildPartnerWhere(f, ids), applySort(p.sort, PARTNER_SORTS, asc(P.name)), p);
  return page(await service.partnerItems(ctx.db, rows), total, p);
});

router.get("/investors/partners/facets", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const f = partnerFilters(ctx);
  const ids = await service.scopeIds(ctx.db, user);
  return {
    type: await facetCounts(ctx.db, P, service.buildPartnerWhere(f, ids, new Set(["type"])), P.type),
    status: await facetCounts(ctx.db, P, service.buildPartnerWhere(f, ids, new Set(["status"])), P.status),
  };
});

router.post("/investors/partners", async (ctx) => {
  const user = await staff(ctx, CREATE);
  const body = await ctx.body(partnerCreate);
  return created(await service.partnerOut(ctx.db, await service.createPartner(ctx.db, body, user)));
});

router.get("/investors/partners/{partner_id}", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const out = await service.partnerOut(ctx.db, await service.getPartner(ctx.db, ctx.uuid("partner_id"), user));
  if (service.isPortal(user)) return { ...out, notes: null }; // internal relationship notes are not shown in the portal
  return out;
});

router.patch("/investors/partners/{partner_id}", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const body = await ctx.body(partnerUpdate);
  const p = await service.updatePartner(ctx.db, await service.getPartner(ctx.db, ctx.uuid("partner_id"), user), body, user);
  return service.partnerOut(ctx.db, p);
});

router.delete("/investors/partners/{partner_id}", async (ctx) => {
  const user = await staff(ctx, DELETE);
  await service.archivePartner(ctx.db, await service.getPartner(ctx.db, ctx.uuid("partner_id"), user), user);
  return noContent();
});

router.get("/investors/partners/{partner_id}/statement", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const asOf = ctx.query.date("as_of");
  return service.statement(ctx.db, await service.getPartner(ctx.db, ctx.uuid("partner_id"), user), asOf ?? today());
});

// --------------------------------------------------------------------------- investments

router.get("/investors/investments", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const rows = await service.listInvestments(ctx.db, user, ctx.query.uuid("partner_id"), ctx.query.uuid("asset_id"));
  return service.investmentOuts(ctx.db, rows);
});

router.post("/investors/investments", async (ctx) => {
  const user = await staff(ctx, CREATE);
  const body = await ctx.body(investmentCreate);
  return created((await service.investmentOuts(ctx.db, [await service.createInvestment(ctx.db, body, user)]))[0]);
});

router.get("/investors/investments/{investment_id}", async (ctx) => {
  const user = await ctx.require(...VIEW);
  return (await service.investmentOuts(ctx.db, [await service.getInvestment(ctx.db, ctx.uuid("investment_id"), user)]))[0];
});

router.patch("/investors/investments/{investment_id}", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const body = await ctx.body(investmentUpdate);
  const inv = await service.updateInvestment(ctx.db, await service.getInvestment(ctx.db, ctx.uuid("investment_id"), user), body, user);
  return (await service.investmentOuts(ctx.db, [inv]))[0];
});

router.get("/investors/investments/{investment_id}/history", async (ctx) => {
  const user = await staff(ctx, VIEW);
  const id = ctx.uuid("investment_id");
  await service.getInvestment(ctx.db, id, user);
  return provenance.history(ctx.db, "investment", id);
});

router.get("/investors/asset-options", async (ctx) => {
  await staff(ctx, VIEW);
  return service.assetOptions(ctx.db, ctx.query.str("q", { max: 200 }));
});

router.post("/investors/assets/{asset_id}/allocate-income", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(incomeAllocationIn);
  return { entries: await service.allocateIncome(ctx.db, ctx.uuid("asset_id"), body, user) };
});

// --------------------------------------------------------------------------- ledger

router.get("/investors/entries", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const t = capitalAccountEntries;
  const partner_id = ctx.query.uuid("partner_id");
  const investment_id = ctx.query.uuid("investment_id");
  const event_id = ctx.query.uuid("event_id");
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(
      service.scoped(t.partner_id, await service.scopeIds(ctx.db, user)),
      partner_id ? eq(t.partner_id, partner_id) : undefined,
      investment_id ? eq(t.investment_id, investment_id) : undefined,
      event_id ? eq(t.event_id, event_id) : undefined,
    ))
    .orderBy(desc(t.effective_on), desc(t.created_at))
    .limit(2000);
  return service.entryOuts(ctx.db, rows);
});

router.post("/investors/entries/{entry_id}/reverse", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(reverseIn);
  const e = await service.reverseEntry(ctx.db, ctx.uuid("entry_id"), body.reason, user);
  return (await service.entryOuts(ctx.db, [e]))[0];
});

// --------------------------------------------------------------------------- waterfalls

router.get("/investors/waterfalls", async (ctx) => {
  await staff(ctx, VIEW);
  const asset_id = ctx.query.uuid("asset_id");
  const rows = await ctx.db
    .select()
    .from(waterfalls)
    .where(and(
      isNull(waterfalls.deleted_at),
      asset_id ? or(eq(waterfalls.asset_id, asset_id), isNull(waterfalls.asset_id)) : undefined,
    ))
    .orderBy(asc(waterfalls.name));
  const out = [];
  for (const w of rows) out.push(await service.waterfallOut(ctx.db, w));
  return out;
});

router.post("/investors/waterfalls", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(waterfallIn);
  return created(await service.waterfallOut(ctx.db, await service.saveWaterfall(ctx.db, null, body, user)));
});

router.get("/investors/waterfalls/{waterfall_id}", async (ctx) => {
  await staff(ctx, VIEW);
  return service.waterfallOut(ctx.db, await service.getWaterfall(ctx.db, ctx.uuid("waterfall_id")));
});

router.put("/investors/waterfalls/{waterfall_id}", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(waterfallIn);
  const w = await service.saveWaterfall(ctx.db, await service.getWaterfall(ctx.db, ctx.uuid("waterfall_id")), body, user);
  return service.waterfallOut(ctx.db, w);
});

// --------------------------------------------------------------------------- capital events

const E = capitalEvents;
const EVENT_SORTS = {
  event_date: E.event_date, amount: E.amount, status: E.status, event_type: E.event_type, name: E.name,
  updated_at: E.updated_at,
};

function eventFilters(ctx: Ctx): EventFilters {
  const q = ctx.query;
  return { q: q.str("q", { max: 200 }), event_type: q.strs("event_type"), status: q.strs("status"), asset_id: q.uuid("asset_id") };
}

router.get("/investors/capital-events", async (ctx) => {
  await staff(ctx, VIEW);
  const p = ctx.listParams();
  const f = eventFilters(ctx);
  const [rows, total] = await paginate(ctx.db, E, service.buildEventWhere(f), applySort(p.sort, EVENT_SORTS, desc(E.event_date)), p);
  const labels = await service.assetLabels(ctx.db, rows.map((e) => [e.asset_id, e.property_id]));
  return page(rows.map((e) => service.eventListItem(e, labels.get(e.asset_id))), total, p);
});

router.get("/investors/capital-events/facets", async (ctx) => {
  await staff(ctx, VIEW);
  const f = eventFilters(ctx);
  return {
    event_type: await facetCounts(ctx.db, E, service.buildEventWhere(f, new Set(["event_type"])), E.event_type),
    status: await facetCounts(ctx.db, E, service.buildEventWhere(f, new Set(["status"])), E.status),
  };
});

router.post("/investors/capital-events/preview", async (ctx) => {
  await staff(ctx, CREATE);
  const body = await ctx.body(eventPreviewIn);
  const [amount, calc] = await service.compute(ctx.db, body);
  return { event_type: body.event_type, amount, calc };
});

router.post("/investors/capital-events", async (ctx) => {
  const user = await staff(ctx, CREATE);
  const body = await ctx.body(eventCreate);
  return created(await service.eventOut(ctx.db, await service.createEvent(ctx.db, body, user), user));
});

router.get("/investors/capital-events/{event_id}", async (ctx) => {
  const user = await staff(ctx, VIEW);
  return service.eventOut(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), user);
});

router.patch("/investors/capital-events/{event_id}", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const body = await ctx.body(eventUpdate);
  const e = await service.recalculate(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), body, user);
  return service.eventOut(ctx.db, e, user);
});

router.post("/investors/capital-events/{event_id}/recalculate", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const e = await service.recalculate(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), null, user);
  return service.eventOut(ctx.db, e, user);
});

router.get("/investors/capital-events/{event_id}/versions", async (ctx) => {
  await staff(ctx, VIEW);
  const id = ctx.uuid("event_id");
  await service.getEvent(ctx.db, id);
  return ctx.db
    .select()
    .from(capitalEventVersions)
    .where(eq(capitalEventVersions.event_id, id))
    .orderBy(desc(capitalEventVersions.version));
});

router.post("/investors/capital-events/{event_id}/submit", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const e = await service.submitEvent(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), user);
  return service.eventOut(ctx.db, e, user);
});

router.post("/investors/capital-events/{event_id}/approve", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(decisionIn);
  const e = await service.decideEvent(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), true, body.note, user);
  return service.eventOut(ctx.db, e, user);
});

router.post("/investors/capital-events/{event_id}/reject", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(decisionIn);
  const e = await service.decideEvent(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), false, body.note, user);
  return service.eventOut(ctx.db, e, user);
});

router.post("/investors/capital-events/{event_id}/post", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const e = await service.postEvent(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), user);
  return service.eventOut(ctx.db, e, user);
});

router.post("/investors/capital-events/{event_id}/reverse", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(reverseIn);
  const e = await service.reverseEvent(ctx.db, await service.getEvent(ctx.db, ctx.uuid("event_id")), body.reason, user);
  return service.eventOut(ctx.db, e, user);
});

router.delete("/investors/capital-events/{event_id}", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const e = await service.getEvent(ctx.db, ctx.uuid("event_id"));
  if (e.status !== "draft" && e.status !== "rejected") {
    throw new HttpError(409, "Only draft or rejected events can be discarded; posted events are reversed");
  }
  await patch(ctx.db, capitalEvents, e, { deleted_at: utcnow(), updated_by_id: user.id });
  await audit.record(ctx.db, {
    actor: user, action: "capital_event.discarded", entity_type: "capital_event", entity_id: e.id, summary: e.name,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return noContent();
});

// --------------------------------------------------------------------------- allocations: calls & distributions

router.get("/investors/allocations", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const t = capitalEventAllocations;
  const event_id = ctx.query.uuid("event_id");
  const partner_id = ctx.query.uuid("partner_id");
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(
      isNull(t.deleted_at),
      service.scoped(t.partner_id, await service.scopeIds(ctx.db, user)),
      event_id ? eq(t.event_id, event_id) : undefined,
      partner_id ? eq(t.partner_id, partner_id) : undefined,
      inFilter(t.event_type, ctx.query.strs("event_type")),
      inFilter(t.status, ctx.query.strs("status")),
    ))
    .orderBy(desc(t.created_at))
    .limit(1000);
  return service.allocationOuts(ctx.db, rows);
});

router.post("/investors/allocations/run-defaults", async (ctx) => {
  await staff(ctx, EDIT);
  return service.runDefaults(ctx.db, ctx.query.date("as_of") ?? today());
});

router.get("/investors/allocations/{alloc_id}", async (ctx) => {
  const user = await ctx.require(...VIEW);
  return (await service.allocationOuts(ctx.db, [await service.getAllocation(ctx.db, ctx.uuid("alloc_id"), user)]))[0];
});

router.post("/investors/allocations/{alloc_id}/fund", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const body = await ctx.body(fundIn);
  const a = await service.fundCall(ctx.db, await service.getAllocation(ctx.db, ctx.uuid("alloc_id"), user), body, user);
  return (await service.allocationOuts(ctx.db, [a]))[0];
});

router.post("/investors/allocations/{alloc_id}/default", async (ctx) => {
  const user = await staff(ctx, APPROVE);
  const body = await ctx.body(defaultIn);
  const a = await service.markDefault(
    ctx.db, await service.getAllocation(ctx.db, ctx.uuid("alloc_id"), user), body.default_flag, body.penalty_flag,
    body.note, user,
  );
  return (await service.allocationOuts(ctx.db, [a]))[0];
});

// --------------------------------------------------------------------------- reporting packages

router.get("/investors/report-packages", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const p = ctx.listParams();
  const t = reportPackages;
  const ids = await service.scopeIds(ctx.db, user);
  const partner_id = ctx.query.uuid("partner_id");
  const where = and(
    isNull(t.deleted_at),
    service.scoped(t.partner_id, ids),
    ids !== null ? eq(t.status, "issued") : undefined,
    partner_id ? eq(t.partner_id, partner_id) : undefined,
    inFilter(t.status, ctx.query.strs("status")),
    p.q ? ilike(t.title, `%${p.q}%`) : undefined,
  );
  const sorts = { period_end: t.period_end, generated_at: t.generated_at, title: t.title };
  const [rows, total] = await paginate(ctx.db, t, where, applySort(p.sort, sorts, desc(t.generated_at)), p);
  return page(await service.packageItems(ctx.db, rows), total, p);
});

router.post("/investors/report-packages", async (ctx) => {
  const user = await staff(ctx, CREATE);
  const body = await ctx.body(packageCreate);
  return created(await service.packageItems(ctx.db, await service.generatePackages(ctx.db, body, user)));
});

router.get("/investors/report-packages/{package_id}", async (ctx) => {
  const user = await ctx.require(...VIEW);
  const pkg = await get(ctx.db, reportPackages, ctx.uuid("package_id"));
  const ids = await service.scopeIds(ctx.db, user);
  if (!pkg || pkg.deleted_at || (ids !== null && (!ids.includes(pkg.partner_id) || pkg.status !== "issued"))) {
    throw new HttpError(404, "Report package not found");
  }
  const item = (await service.packageItems(ctx.db, [pkg]))[0];
  return { ...item, snapshot: pkg.snapshot || {}, excluded: pkg.excluded || [] };
});

router.post("/investors/report-packages/{package_id}/issue", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const pkg = await get(ctx.db, reportPackages, ctx.uuid("package_id"));
  if (!pkg || pkg.deleted_at) throw new HttpError(404, "Report package not found");
  return (await service.packageItems(ctx.db, [await service.issuePackage(ctx.db, pkg, user)]))[0];
});

router.get("/investors/report-schedules", async (ctx) => {
  await staff(ctx, VIEW);
  const rows = await ctx.db
    .select()
    .from(reportSchedules)
    .where(isNull(reportSchedules.deleted_at))
    .orderBy(asc(reportSchedules.next_run_on));
  const ids = [...new Set(rows.map((r) => r.partner_id).filter((i): i is string => !!i))];
  const names = new Map<string, string>();
  if (ids.length) {
    const found = await ctx.db
      .select({ id: capitalPartners.id, name: capitalPartners.name })
      .from(capitalPartners)
      .where(inArray(capitalPartners.id, ids));
    for (const r of found) names.set(r.id, r.name);
  }
  return rows.map((r) => ({
    id: r.id, name: r.name, partner_id: r.partner_id, partner_name: r.partner_id ? (names.get(r.partner_id) ?? null) : null,
    asset_id: r.asset_id, package_types: r.package_types, frequency: r.frequency, next_run_on: r.next_run_on,
    is_active: r.is_active, auto_issue: r.auto_issue, last_run_at: r.last_run_at,
  }));
});

router.post("/investors/report-schedules", async (ctx) => {
  const user = await staff(ctx, CREATE);
  const body = await ctx.body(scheduleIn);
  // Like the Python route, the create/patch responses do not resolve partner_name.
  return created({ ...(await service.scheduleOut(ctx.db, await service.saveSchedule(ctx.db, null, body, user))), partner_name: null });
});

router.post("/investors/report-schedules/run-due", async (ctx) => {
  const user = await staff(ctx, EDIT);
  return service.runDueSchedules(ctx.db, ctx.query.date("as_of") ?? today(), user);
});

router.patch("/investors/report-schedules/{schedule_id}", async (ctx) => {
  const user = await staff(ctx, EDIT);
  const body = await ctx.body(scheduleUpdate);
  const s = await get(ctx.db, reportSchedules, ctx.uuid("schedule_id"));
  if (!s || s.deleted_at) throw new HttpError(404, "Schedule not found");
  return { ...(await service.scheduleOut(ctx.db, await service.saveSchedule(ctx.db, s, body, user))), partner_name: null };
});
