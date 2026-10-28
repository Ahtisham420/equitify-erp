import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { addDays, diffDays } from "./dates";
import {
  CONTRACT_STATUSES, CONTRACT_TYPES, CRITICAL_DATE_SOURCES, CRITICAL_DATE_STATUSES, DATE_TYPES, DD_STATUSES,
  DECISION_KINDS, ESTOPPEL_KINDS, ESTOPPEL_STATUSES, EXCEPTION_KINDS, EXCEPTION_SOURCES, EXCEPTION_STATUSES,
  PARTY_ROLES, REPORT_STATUSES, REPORT_TYPES, RISK_CATEGORIES, RISK_DECISIONS, RISK_STATUSES, SEVERITIES,
  contractDecisions, contracts, criticalDates, ddItems, estoppels, holidayCalendars, riskItems, thirdPartyReports,
  titleExceptions,
} from "./schema";
import {
  applyTemplateIn, bulkDatesIn, confirmIn, contractCreate, contractUpdate, criticalDateCreate, criticalDateUpdate,
  ddItemCreate, ddItemUpdate, ddTemplateCreate, ddTemplateUpdate, decisionCreate, escalateIn, estoppelCreate,
  estoppelUpdate, executeIn, holidayCalendarCreate, holidayIn, noteIn, reportCreate, reportUpdate, requiredNoteIn,
  rescheduleIn, riskCreate, riskDecideIn, riskUpdate, titleExceptionCreate, titleExceptionUpdate,
} from "./schemas";
import * as service from "./service";
import type { ContractFilters, DateFilters } from "./service";

export const router = new Router();

// =========================================================================== contracts

const CONTRACT_SORTS = {
  title: contracts.title, status: contracts.status, effective_on: contracts.effective_on,
  purchase_price: contracts.purchase_price, updated_at: contracts.updated_at, created_at: contracts.created_at,
};

function contractFilters(ctx: Ctx): ContractFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    contract_type: q.strs("contract_type"),
    owner_id: q.uuids("owner_id"),
    property_id: q.uuid("property_id"),
    opportunity_id: q.uuid("opportunity_id"),
    effective_from: q.date("effective_from"),
    effective_to: q.date("effective_to"),
  };
}

/** Required query param (FastAPI 422 when missing). */
const missing = (name: string) => new HttpError(422, [{ loc: ["query", name], msg: "Field required", type: "missing" }]);
function needDate(ctx: Ctx, name: string): string {
  const v = ctx.query.date(name);
  if (v === undefined) throw missing(name);
  return v;
}

router.get("/contracts", async (ctx) => {
  await ctx.require("contracts", "view");
  const p = ctx.listParams();
  const f = contractFilters(ctx);
  const order = applySort(p.sort, CONTRACT_SORTS, desc(contracts.updated_at));
  const [rows, total] = await paginate(ctx.db, contracts, service.buildContractQuery(f), order, p);
  return page(await service.contractItems(ctx.db, rows), total, p);
});

router.get("/contracts/facets", async (ctx) => {
  await ctx.require("contracts", "view");
  const f = contractFilters(ctx);
  const q = (skip: string) => service.buildContractQuery(f, new Set([skip]));
  return {
    status: await facetCounts(ctx.db, contracts, q("status"), contracts.status),
    contract_type: await facetCounts(ctx.db, contracts, q("contract_type"), contracts.contract_type),
    owner_id: await facetCounts(ctx.db, contracts, q("owner_id"), contracts.owner_id),
  };
});

router.get("/contracts/meta", async (ctx) => {
  await ctx.require("contracts", "view");
  return {
    statuses: CONTRACT_STATUSES, types: CONTRACT_TYPES, party_roles: PARTY_ROLES,
    term_keys: service.TERM_KEYS, term_defaults: service.TERM_DEFAULTS, rule_anchors: service.RULE_ANCHORS,
    date_types: DATE_TYPES, date_statuses: CRITICAL_DATE_STATUSES, date_sources: CRITICAL_DATE_SOURCES,
    dd_statuses: DD_STATUSES, severities: SEVERITIES, report_types: REPORT_TYPES,
    report_statuses: REPORT_STATUSES, exception_kinds: EXCEPTION_KINDS, exception_sources: EXCEPTION_SOURCES,
    exception_statuses: EXCEPTION_STATUSES, estoppel_kinds: ESTOPPEL_KINDS, estoppel_statuses: ESTOPPEL_STATUSES,
    risk_categories: RISK_CATEGORIES, risk_statuses: RISK_STATUSES, risk_decisions: RISK_DECISIONS,
    decision_kinds: DECISION_KINDS,
  };
});

router.post("/contracts", async (ctx) => {
  const user = await ctx.require("contracts", "create");
  const body = await ctx.body(contractCreate);
  return created(await service.contractOut(ctx.db, await service.createContract(ctx.db, body, user)));
});

router.get("/contracts/{contract_id}", async (ctx) => {
  await ctx.require("contracts", "view");
  return service.contractOut(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")));
});

router.patch("/contracts/{contract_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(contractUpdate);
  const c = await service.updateContract(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return service.contractOut(ctx.db, c);
});

router.delete("/contracts/{contract_id}", async (ctx) => {
  const user = await ctx.require("contracts", "delete");
  await service.archiveContract(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), user);
  return noContent();
});

router.post("/contracts/{contract_id}/execute", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(executeIn);
  const c = await service.executeContract(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return service.contractOut(ctx.db, c);
});

router.get("/contracts/{contract_id}/status", async (ctx) => {
  await ctx.require("contracts", "view");
  return service.contractStatus(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")));
});

router.get("/contracts/{contract_id}/rules", async (ctx) => {
  await ctx.require("contracts", "view");
  return service.contractRules(await service.getContract(ctx.db, ctx.uuid("contract_id")));
});

router.get("/contracts/{contract_id}/critical-dates", async (ctx) => {
  await ctx.require("contracts", "view");
  const id = ctx.uuid("contract_id");
  await service.getContract(ctx.db, id);
  return service.dateOuts(ctx.db, await service.contractDates(ctx.db, id));
});

router.post("/contracts/{contract_id}/generate-dates", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const rows = await service.regenerateDates(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), user);
  return service.dateOuts(ctx.db, rows);
});

router.post("/contracts/{contract_id}/propose-from-extracted", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  return service.proposeFromExtracted(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), user);
});

router.get("/contracts/{contract_id}/activity", async (ctx) => {
  await ctx.require("contracts", "view");
  const limit = ctx.query.int("limit", { ge: 1, le: 500 }) ?? 200;
  return service.contractActivity(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), limit);
});

// --------------------------------------------------------------------------- DD items

router.post("/contracts/{contract_id}/apply-template", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(applyTemplateIn);
  const items = await service.applyTemplateCommit(
    ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body.template_id, user,
  );
  return service.ddOuts(ctx.db, items);
});

router.get("/contracts/{contract_id}/dd-items", async (ctx) => {
  await ctx.require("contracts", "view");
  const rows = await ctx.db
    .select()
    .from(ddItems)
    .where(and(eq(ddItems.contract_id, ctx.uuid("contract_id")), isNull(ddItems.deleted_at)))
    .orderBy(asc(ddItems.category), asc(ddItems.sort_order), asc(ddItems.created_at));
  return service.ddOuts(ctx.db, rows);
});

router.post("/contracts/{contract_id}/dd-items", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(ddItemCreate);
  const i = await service.createDdItem(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return created((await service.ddOuts(ctx.db, [i]))[0]);
});

router.patch("/dd-items/{item_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(ddItemUpdate);
  const i = await service.updateDdItem(ctx.db, await service.getDdItem(ctx.db, ctx.uuid("item_id")), body, user);
  return (await service.ddOuts(ctx.db, [i]))[0];
});

router.post("/dd-items/{item_id}/escalate", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(escalateIn);
  const i = await service.escalateDdItem(ctx.db, await service.getDdItem(ctx.db, ctx.uuid("item_id")), body.note, user);
  return (await service.ddOuts(ctx.db, [i]))[0];
});

router.delete("/dd-items/{item_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  await service.deleteDdItem(ctx.db, await service.getDdItem(ctx.db, ctx.uuid("item_id")), user);
  return noContent();
});

// --------------------------------------------------------------------------- third-party reports

router.get("/contracts/{contract_id}/reports", async (ctx) => {
  await ctx.require("contracts", "view");
  const t = thirdPartyReports;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.contract_id, ctx.uuid("contract_id")), isNull(t.deleted_at)))
    .orderBy(sql`${t.expected_on} asc nulls last`, asc(t.created_at));
  return service.reportOuts(ctx.db, rows);
});

router.post("/contracts/{contract_id}/reports", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(reportCreate);
  const r = await service.createReport(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return created((await service.reportOuts(ctx.db, [r]))[0]);
});

router.patch("/third-party-reports/{report_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(reportUpdate);
  const r = await service.child(ctx.db, thirdPartyReports, ctx.uuid("report_id"), "Report");
  return (await service.reportOuts(ctx.db, [await service.updateReport(ctx.db, r, body, user)]))[0];
});

router.delete("/third-party-reports/{report_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const r = await service.child(ctx.db, thirdPartyReports, ctx.uuid("report_id"), "Report");
  await service.softDelete(ctx.db, thirdPartyReports, r, "third_party_report", r.report_type, user);
  return noContent();
});

// --------------------------------------------------------------------------- title & survey

router.get("/contracts/{contract_id}/title-exceptions", async (ctx) => {
  await ctx.require("contracts", "view");
  const t = titleExceptions;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.contract_id, ctx.uuid("contract_id")), isNull(t.deleted_at)))
    .orderBy(asc(t.source), asc(t.schedule_ref), asc(t.created_at));
  return service.exceptionOuts(ctx.db, rows);
});

router.post("/contracts/{contract_id}/title-exceptions", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(titleExceptionCreate);
  const x = await service.createException(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return created((await service.exceptionOuts(ctx.db, [x]))[0]);
});

router.patch("/title-exceptions/{exception_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(titleExceptionUpdate);
  const x = await service.child(ctx.db, titleExceptions, ctx.uuid("exception_id"), "Title exception");
  return (await service.exceptionOuts(ctx.db, [await service.updateException(ctx.db, x, body, user)]))[0];
});

router.delete("/title-exceptions/{exception_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const x = await service.child(ctx.db, titleExceptions, ctx.uuid("exception_id"), "Title exception");
  await service.softDelete(ctx.db, titleExceptions, x, "title_exception", x.description.slice(0, 200), user);
  return noContent();
});

// --------------------------------------------------------------------------- estoppels / SNDA

router.get("/contracts/{contract_id}/estoppels", async (ctx) => {
  await ctx.require("contracts", "view");
  const t = estoppels;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.contract_id, ctx.uuid("contract_id")), isNull(t.deleted_at)))
    .orderBy(asc(t.tenant_name), asc(t.kind));
  return rows.map(service.estoppelOut);
});

router.post("/contracts/{contract_id}/estoppels", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(estoppelCreate);
  const e = await service.createEstoppel(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return created(service.estoppelOut(e));
});

router.patch("/estoppels/{estoppel_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(estoppelUpdate);
  const e = await service.child(ctx.db, estoppels, ctx.uuid("estoppel_id"), "Estoppel");
  return service.estoppelOut(await service.updateEstoppel(ctx.db, e, body, user));
});

router.post("/estoppels/{estoppel_id}/resolve", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(requiredNoteIn);
  const e = await service.child(ctx.db, estoppels, ctx.uuid("estoppel_id"), "Estoppel");
  return service.estoppelOut(await service.resolveEstoppel(ctx.db, e, body.note, user));
});

router.delete("/estoppels/{estoppel_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const e = await service.child(ctx.db, estoppels, ctx.uuid("estoppel_id"), "Estoppel");
  await service.softDelete(ctx.db, estoppels, e, "estoppel", e.tenant_name, user);
  return noContent();
});

// --------------------------------------------------------------------------- risks & decisions

router.get("/contracts/{contract_id}/risks", async (ctx) => {
  await ctx.require("contracts", "view");
  const rows = await ctx.db
    .select()
    .from(riskItems)
    .where(and(eq(riskItems.contract_id, ctx.uuid("contract_id")), isNull(riskItems.deleted_at)))
    .orderBy(asc(riskItems.created_at));
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  rows.sort(
    (a, b) => Number(a.status === "closed") - Number(b.status === "closed") || (order[a.severity] ?? 4) - (order[b.severity] ?? 4),
  );
  return service.riskOuts(ctx.db, rows);
});

router.post("/contracts/{contract_id}/risks", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(riskCreate);
  const r = await service.createRisk(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user);
  return created((await service.riskOuts(ctx.db, [r]))[0]);
});

router.patch("/risks/{risk_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(riskUpdate);
  const r = await service.child(ctx.db, riskItems, ctx.uuid("risk_id"), "Risk");
  return (await service.riskOuts(ctx.db, [await service.updateRisk(ctx.db, r, body, user)]))[0];
});

router.post("/risks/{risk_id}/decide", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(riskDecideIn);
  const r = await service.child(ctx.db, riskItems, ctx.uuid("risk_id"), "Risk");
  return (await service.riskOuts(ctx.db, [await service.decideRisk(ctx.db, r, body, user)]))[0];
});

router.delete("/risks/{risk_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const r = await service.child(ctx.db, riskItems, ctx.uuid("risk_id"), "Risk");
  if (r.decision) throw new HttpError(409, "Decided risks are retained; close the risk instead");
  await service.softDelete(ctx.db, riskItems, r, "risk_item", r.title, user);
  return noContent();
});

router.get("/contracts/{contract_id}/decisions", async (ctx) => {
  await ctx.require("contracts", "view");
  return ctx.db
    .select()
    .from(contractDecisions)
    .where(eq(contractDecisions.contract_id, ctx.uuid("contract_id")))
    .orderBy(desc(contractDecisions.decided_at));
});

router.post("/contracts/{contract_id}/decisions", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(decisionCreate);
  return created(await service.recordDecision(ctx.db, await service.getContract(ctx.db, ctx.uuid("contract_id")), body, user));
});

// =========================================================================== DD templates

router.get("/dd-templates", async (ctx) => {
  await ctx.require("contracts", "view");
  const rows = await service.ensureTemplates(ctx.db);
  await ctx.db.commit();
  return rows.map(service.ddTemplateOut);
});

router.post("/dd-templates", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(ddTemplateCreate);
  return created(service.ddTemplateOut(await service.saveTemplate(ctx.db, null, body, user)));
});

router.get("/dd-templates/{template_id}", async (ctx) => {
  await ctx.require("contracts", "view");
  return service.ddTemplateOut(await service.getTemplate(ctx.db, ctx.uuid("template_id")));
});

router.patch("/dd-templates/{template_id}", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(ddTemplateUpdate);
  const t = await service.getTemplate(ctx.db, ctx.uuid("template_id"));
  return service.ddTemplateOut(await service.saveTemplate(ctx.db, t, body, user));
});

// =========================================================================== critical dates (global)

const DATE_SORTS = {
  due_on: criticalDates.due_on, label: criticalDates.label, status: criticalDates.status,
  date_type: criticalDates.date_type, related_type: criticalDates.related_type, updated_at: criticalDates.updated_at,
};

function dateFilters(ctx: Ctx): DateFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    related_type: q.strs("related_type"),
    related_id: q.uuid("related_id"),
    property_id: q.uuid("property_id"),
    owner_id: q.uuids("owner_id"),
    status: q.strs("status"),
    date_type: q.strs("date_type"),
    source: q.strs("source"),
    window: q.str("window", { pattern: /^(overdue|7|30|90)$/ }),
    blocking: q.bool("blocking"),
    due_from: q.date("due_from"),
    due_to: q.date("due_to"),
    mine: q.bool("mine"),
  };
}

router.get("/critical-dates", async (ctx) => {
  const user = await ctx.require("contracts", "view");
  const p = ctx.listParams();
  const f = dateFilters(ctx);
  const order = applySort(p.sort, DATE_SORTS, asc(criticalDates.due_on));
  const [rows, total] = await paginate(ctx.db, criticalDates, service.buildDateQuery(f, { user_id: user.id }), order, p);
  return page(await service.dateOuts(ctx.db, rows), total, p);
});

router.get("/critical-dates/facets", async (ctx) => {
  const user = await ctx.require("contracts", "view");
  const f = dateFilters(ctx);
  const q = (skip: string) => service.buildDateQuery(f, { skip: new Set([skip]), user_id: user.id });
  return {
    status: await facetCounts(ctx.db, criticalDates, q("status"), criticalDates.status),
    related_type: await facetCounts(ctx.db, criticalDates, q("related_type"), criticalDates.related_type),
    date_type: await facetCounts(ctx.db, criticalDates, q("date_type"), criticalDates.date_type),
    owner_id: await facetCounts(ctx.db, criticalDates, q("owner_id"), criticalDates.owner_id),
  };
});

router.get("/critical-dates/summary", async (ctx) => {
  const user = await ctx.require("contracts", "view");
  return service.dateSummary(ctx.db, dateFilters(ctx), user.id);
});

router.get("/critical-dates/calendar", async (ctx) => {
  const user = await ctx.require("contracts", "view");
  const start = needDate(ctx, "start");
  const end = needDate(ctx, "end");
  const f = dateFilters(ctx);
  if (diffDays(end, start) > 62 || end < start) throw new HttpError(422, "Calendar range must be between 0 and 62 days");
  f.due_from = start;
  f.due_to = end;
  const rows = await ctx.db
    .select()
    .from(criticalDates)
    .where(service.buildDateQuery(f, { user_id: user.id }))
    .orderBy(asc(criticalDates.due_on))
    .limit(2000);
  return service.dateOuts(ctx.db, rows);
});

router.get("/critical-dates/meta", async (ctx) => {
  await ctx.require("contracts", "view");
  return { statuses: CRITICAL_DATE_STATUSES, sources: CRITICAL_DATE_SOURCES, date_types: DATE_TYPES };
});

router.post("/critical-dates", async (ctx) => {
  const user = await ctx.require("contracts", "create");
  const body = await ctx.body(criticalDateCreate);
  return created((await service.dateOuts(ctx.db, [await service.createManualDate(ctx.db, body, user)]))[0]);
});

router.post("/critical-dates/scan", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const result = await service.scanCriticalDates(ctx.db, user);
  await ctx.db.commit();
  return result;
});

router.post("/critical-dates/bulk", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(bulkDatesIn);
  return service.bulkDates(ctx.db, body.ids, body.action, body.note, user);
});

router.get("/critical-dates/{date_id}", async (ctx) => {
  await ctx.require("contracts", "view");
  return (await service.dateOuts(ctx.db, [await service.getDate(ctx.db, ctx.uuid("date_id"))]))[0];
});

router.patch("/critical-dates/{date_id}", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(criticalDateUpdate);
  const cd = await service.updateDate(ctx.db, await service.getDate(ctx.db, ctx.uuid("date_id")), body, user);
  return (await service.dateOuts(ctx.db, [cd]))[0];
});

router.post("/critical-dates/{date_id}/confirm", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(confirmIn);
  const cd = await service.confirmDate(ctx.db, await service.getDate(ctx.db, ctx.uuid("date_id")), body, user);
  return (await service.dateOuts(ctx.db, [cd]))[0];
});

router.post("/critical-dates/{date_id}/complete", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(noteIn);
  const cd = await service.completeDate(ctx.db, await service.getDate(ctx.db, ctx.uuid("date_id")), body.note, user);
  return (await service.dateOuts(ctx.db, [cd]))[0];
});

router.post("/critical-dates/{date_id}/waive", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(requiredNoteIn);
  const cd = await service.waiveDate(ctx.db, await service.getDate(ctx.db, ctx.uuid("date_id")), body.note, user);
  return (await service.dateOuts(ctx.db, [cd]))[0];
});

router.post("/critical-dates/{date_id}/reschedule", async (ctx) => {
  const user = await ctx.require("contracts", "edit");
  const body = await ctx.body(rescheduleIn);
  const cd = await service.rescheduleDate(
    ctx.db, await service.getDate(ctx.db, ctx.uuid("date_id")), body.due_on, body.reason, user,
  );
  return (await service.dateOuts(ctx.db, [cd]))[0];
});

router.get("/critical-dates/{date_id}/events", async (ctx) => {
  await ctx.require("contracts", "view");
  const id = ctx.uuid("date_id");
  await service.getDate(ctx.db, id);
  return (await service.dateEvents(ctx.db, id)).map(service.dateEventOut);
});

// =========================================================================== holiday calendars

const HOLIDAY_CAL_KEYS = ["id", "code", "name", "description", "weekend_days", "is_default", "rule_set", "seeded_years"] as const;
const calendarOut = (c: Record<string, any>) => Object.fromEntries(HOLIDAY_CAL_KEYS.map((k) => [k, c[k] ?? null]));
const holidayOut = (h: Record<string, any>) =>
  Object.fromEntries(["id", "calendar_id", "holiday_on", "name", "source"].map((k) => [k, h[k] ?? null]));

async function liveCalendar(ctx: Ctx) {
  const cal = await ctx.db
    .select()
    .from(holidayCalendars)
    .where(eq(holidayCalendars.id, ctx.uuid("calendar_id")))
    .limit(1)
    .then((r) => r[0]);
  if (!cal || cal.deleted_at) throw new HttpError(404, "Calendar not found");
  return cal;
}

router.get("/holiday-calendars", async (ctx) => {
  await ctx.require("contracts", "view");
  await service.ensureDefaultCalendar(ctx.db);
  await ctx.db.commit();
  const rows = await ctx.db
    .select()
    .from(holidayCalendars)
    .where(isNull(holidayCalendars.deleted_at))
    .orderBy(desc(holidayCalendars.is_default), asc(holidayCalendars.name));
  return rows.map(calendarOut);
});

router.post("/holiday-calendars", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(holidayCalendarCreate);
  return created(calendarOut(await service.createCalendar(ctx.db, body, user)));
});

router.get("/holiday-calendars/{calendar_id}/holidays", async (ctx) => {
  await ctx.require("contracts", "view");
  const year = ctx.query.int("year", { ge: 1990, le: 2100 });
  if (year === undefined) throw missing("year");
  const cal = await liveCalendar(ctx);
  return (await service.listHolidays(ctx.db, cal, year)).map(holidayOut);
});

router.post("/holiday-calendars/{calendar_id}/holidays", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const body = await ctx.body(holidayIn);
  const cal = await liveCalendar(ctx);
  return created(holidayOut(await service.addHoliday(ctx.db, cal, body.holiday_on, body.name, user)));
});

router.delete("/holiday-calendars/{calendar_id}/holidays/{holiday_id}", async (ctx) => {
  const user = await ctx.require("contracts", "approve");
  const cal = await liveCalendar(ctx);
  await service.deleteHoliday(ctx.db, cal, ctx.uuid("holiday_id"), user);
  return noContent();
});

/** Preview of the date engine: `start` + `days` business (or calendar) days. */
router.get("/business-days", async (ctx) => {
  await ctx.require("contracts", "view");
  const start = needDate(ctx, "start");
  const days = ctx.query.int("days", { ge: -3650, le: 3650 });
  if (days === undefined) throw missing("days");
  const business = ctx.query.bool("business") ?? true;
  const cal = await service.getCalendar(ctx.db, ctx.query.uuid("calendar_id"));
  const result = business ? await service.addBusinessDays(ctx.db, start, days, cal.id) : addDays(start, days);
  await ctx.db.commit();
  return { start, days, business_days: business, result, calendar_id: cal.id };
});
