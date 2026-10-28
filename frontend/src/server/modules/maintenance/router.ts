import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  FINDING_STATUSES, INSPECTION_STATUSES, inspections, inspectionTemplates, PM_FREQUENCIES, pmSchedules, SEVERITIES,
  WO_CATEGORIES, WO_PRIORITIES, WO_SOURCES, WO_STATUSES, workOrders,
} from "./schema";
import {
  approvalIn, assignIn, bulkWorkOrderIn, costIn, evidenceIn, findingIn, findingUpdate, inspectionCreate,
  inspectionStatusIn, inspectionUpdate, pmScheduleIn, responsesIn, responsibilityIn, satisfactionIn, settingsIn,
  templateIn, transitionIn, workOrderCreate, workOrderUpdate,
} from "./schemas";
import * as service from "./service";
import type { InspectionFilters, WorkOrderFilters } from "./service";

export const router = new Router();

const WO_SORTS = {
  number: workOrders.number, title: workOrders.title, priority: workOrders.priority, status: workOrders.status,
  category: workOrders.category, due_on: workOrders.due_on, estimate_amount: workOrders.estimate_amount,
  actual_cost: workOrders.actual_cost, created_at: workOrders.created_at, updated_at: workOrders.updated_at,
  completed_at: workOrders.completed_at,
};

function woFilters(ctx: Ctx): WorkOrderFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    priority: q.strs("priority"),
    category: q.strs("category"),
    source: q.strs("source"),
    approval_status: q.strs("approval_status"),
    tenant_responsibility: q.strs("tenant_responsibility"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    space_id: q.uuid("space_id"),
    vendor_id: q.uuid("vendor_id"),
    assigned_user_id: q.uuid("assigned_user_id"),
    pm_schedule_id: q.uuid("pm_schedule_id"),
    inspection_id: q.uuid("inspection_id"),
    due_from: q.date("due_from"),
    due_to: q.date("due_to"),
    min_cost: q.num("min_cost"),
    max_cost: q.num("max_cost"),
    overdue: q.bool("overdue"),
    open_only: q.bool("open_only"),
  };
}

// ======================================================================= work orders

router.get("/work-orders", async (ctx) => {
  await ctx.require("maintenance", "view");
  const p = ctx.listParams();
  const f = woFilters(ctx);
  const order = applySort(p.sort, WO_SORTS, desc(workOrders.created_at));
  const [rows, total] = await paginate(ctx.db, workOrders, service.buildQuery(f), order, p);
  return page(await service.decorate(ctx.db, rows), total, p);
});

router.get("/work-orders/facets", async (ctx) => {
  await ctx.require("maintenance", "view");
  const f = woFilters(ctx);
  const out: Record<string, Record<string, number>> = {};
  for (const key of ["status", "priority", "category", "source", "approval_status"] as const) {
    out[key] = await facetCounts(ctx.db, workOrders, service.buildQuery(f, new Set([key])), workOrders[key]);
  }
  return out;
});

router.get("/work-orders/meta", async (ctx) => {
  await ctx.require("maintenance", "view");
  return {
    statuses: WO_STATUSES, priorities: WO_PRIORITIES, categories: WO_CATEGORIES, sources: WO_SOURCES,
    frequencies: [...Object.keys(PM_FREQUENCIES), "custom"], severities: SEVERITIES,
    inspection_statuses: INSPECTION_STATUSES, finding_statuses: FINDING_STATUSES,
  };
});

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get("/work-orders/export", async (ctx) => {
  const user = await ctx.require("maintenance", "export");
  const p = ctx.listParams();
  const f = woFilters(ctx);
  const order = applySort(p.sort, WO_SORTS, desc(workOrders.created_at));
  const rows = await ctx.db.select().from(workOrders).where(service.buildQuery(f)).orderBy(...order).limit(50_000);
  const items = await service.decorate(ctx.db, rows);
  const cols = [
    "number", "title", "property_name", "source", "category", "priority", "status", "vendor_name", "assignee_name",
    "estimate_amount", "actual_cost", "approval_status", "tenant_responsibility", "due_on", "satisfaction_rating",
    "created_at", "completed_at", "verified_at",
  ];
  const lines = [cols.join(","), ...items.map((r) => cols.map((c) => csvCell((r as Record<string, any>)[c])).join(","))];
  await audit.record(ctx.db, {
    actor: user, action: "work_order.exported", entity_type: "work_order", summary: `${items.length} rows`,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=work-orders.csv" },
  });
});

const settingsOut = (s: { approval_threshold: number; finding_auto_wo_severity: string; pm_default_lead_days: number }) => ({
  approval_threshold: s.approval_threshold,
  finding_auto_wo_severity: s.finding_auto_wo_severity,
  pm_default_lead_days: s.pm_default_lead_days,
});

router.get("/work-orders/settings", async (ctx) => {
  await ctx.require("maintenance", "view");
  const s = await service.getSettings(ctx.db);
  await ctx.db.commit();
  return settingsOut(s);
});

router.put("/work-orders/settings", async (ctx) => {
  const user = await ctx.require("maintenance", "approve");
  const body = await ctx.body(settingsIn);
  return settingsOut(await service.updateSettings(ctx.db, body, user));
});

router.get("/work-orders/service-history", async (ctx) => {
  await ctx.require("maintenance", "view");
  return service.serviceHistory(ctx.db, {
    asset_id: ctx.query.uuid("asset_id"),
    property_id: ctx.query.uuid("property_id"),
    system: ctx.query.str("system"),
  });
});

router.post("/work-orders", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  const body = await ctx.body(workOrderCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user)));
});

router.post("/work-orders/bulk", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(bulkWorkOrderIn);
  return { updated: await service.bulkUpdate(ctx.db, body.ids, body.priority, body.assigned_user_id, user) };
});

router.get("/work-orders/{wo_id}", async (ctx) => {
  await ctx.require("maintenance", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")));
});

router.patch("/work-orders/{wo_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(workOrderUpdate);
  return service.toOut(ctx.db, await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body, user));
});

router.delete("/work-orders/{wo_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "delete");
  await service.archive(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), user);
  return noContent();
});

router.post("/work-orders/{wo_id}/assign", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(assignIn);
  return service.toOut(ctx.db, await service.assign(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body, user));
});

router.post("/work-orders/{wo_id}/transition", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(transitionIn);
  return service.toOut(ctx.db, await service.transition(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body, user));
});

router.post("/work-orders/{wo_id}/costs", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(costIn);
  return service.toOut(ctx.db, await service.setCosts(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body, user));
});

router.post("/work-orders/{wo_id}/approval", async (ctx) => {
  const user = await ctx.require("maintenance", "approve");
  const body = await ctx.body(approvalIn);
  const wo = await service.decideApproval(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body.decision, body.note, user);
  return service.toOut(ctx.db, wo);
});

router.post("/work-orders/{wo_id}/responsibility", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(responsibilityIn);
  const wo = await service.determineResponsibility(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body, user);
  return service.toOut(ctx.db, wo);
});

router.post("/work-orders/{wo_id}/chargeback", async (ctx) => {
  const user = await ctx.require("maintenance", "approve");
  return service.toOut(ctx.db, await service.createChargeback(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), user));
});

router.post("/work-orders/{wo_id}/satisfaction", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(satisfactionIn);
  const wo = await service.rate(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body.rating, body.comment, user);
  return service.toOut(ctx.db, wo);
});

router.post("/work-orders/{wo_id}/evidence", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(evidenceIn);
  const wo = await service.addEvidence(ctx.db, await service.get(ctx.db, ctx.uuid("wo_id")), body.document_ids, user);
  return service.toOut(ctx.db, wo);
});

// ======================================================================= preventive maintenance

const PM_SORTS = {
  next_service_on: pmSchedules.next_service_on, last_service_on: pmSchedules.last_service_on, title: pmSchedules.title,
  system: pmSchedules.system, frequency: pmSchedules.frequency, updated_at: pmSchedules.updated_at,
};

router.get("/pm-schedules", async (ctx) => {
  await ctx.require("maintenance", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const where = service.pmQuery(
    p.q, q.uuid("property_id"), q.uuid("asset_id"), q.bool("active"), q.strs("frequency"), q.int("due_within_days", { ge: 0 }),
  );
  const [rows, total] = await paginate(ctx.db, pmSchedules, where, applySort(p.sort, PM_SORTS, asc(pmSchedules.next_service_on)), p);
  return page(await service.pmOut(ctx.db, rows), total, p);
});

router.post("/pm-schedules/scan", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  return service.generatePmWorkOrders(ctx.db, user, { property_id: ctx.query.uuid("property_id") });
});

router.post("/pm-schedules", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  const body = await ctx.body(pmScheduleIn);
  return created((await service.pmOut(ctx.db, [await service.savePm(ctx.db, body, user)]))[0]);
});

router.get("/pm-schedules/{pm_id}", async (ctx) => {
  await ctx.require("maintenance", "view");
  return (await service.pmOut(ctx.db, [await service.getPm(ctx.db, ctx.uuid("pm_id"))]))[0];
});

router.put("/pm-schedules/{pm_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(pmScheduleIn);
  const s = await service.savePm(ctx.db, body, user, await service.getPm(ctx.db, ctx.uuid("pm_id")));
  return (await service.pmOut(ctx.db, [s]))[0];
});

router.delete("/pm-schedules/{pm_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "delete");
  await service.archivePm(ctx.db, await service.getPm(ctx.db, ctx.uuid("pm_id")), user);
  return noContent();
});

// ======================================================================= inspection templates

router.get("/inspection-templates", async (ctx) => {
  await ctx.require("maintenance", "view");
  const t = inspectionTemplates;
  const q = ctx.query.str("q");
  const propertyType = ctx.query.str("property_type");
  const active = ctx.query.bool("active");
  const rows = await ctx.db
    .select()
    .from(t)
    .where(and(
      isNull(t.deleted_at),
      q ? sql`${t.name} ilike ${`%${q}%`}` : undefined,
      propertyType ? or(eq(t.property_type, propertyType), isNull(t.property_type)) : undefined,
      active !== undefined ? eq(t.is_active, active) : undefined,
    ))
    .orderBy(asc(t.name));
  return rows.map(service.templateOut);
});

router.post("/inspection-templates", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  const body = await ctx.body(templateIn);
  return created(service.templateOut(await service.saveTemplate(ctx.db, body, user)));
});

router.get("/inspection-templates/{template_id}", async (ctx) => {
  await ctx.require("maintenance", "view");
  return service.templateOut(await service.getTemplate(ctx.db, ctx.uuid("template_id")));
});

router.put("/inspection-templates/{template_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(templateIn);
  const t = await service.saveTemplate(ctx.db, body, user, await service.getTemplate(ctx.db, ctx.uuid("template_id")));
  return service.templateOut(t);
});

router.delete("/inspection-templates/{template_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "delete");
  await service.archiveTemplate(ctx.db, await service.getTemplate(ctx.db, ctx.uuid("template_id")), user);
  return noContent();
});

// ======================================================================= inspections

const INSP_SORTS = {
  scheduled_on: inspections.scheduled_on, status: inspections.status, score: inspections.score,
  completed_at: inspections.completed_at, updated_at: inspections.updated_at,
};

function inspFilters(ctx: Ctx): InspectionFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    inspector_id: q.uuid("inspector_id"),
    template_id: q.uuid("template_id"),
    scheduled_from: q.date("scheduled_from"),
    scheduled_to: q.date("scheduled_to"),
  };
}

router.get("/inspections", async (ctx) => {
  await ctx.require("maintenance", "view");
  const p = ctx.listParams();
  const f = inspFilters(ctx);
  const order = applySort(p.sort, INSP_SORTS, desc(inspections.scheduled_on));
  const [rows, total] = await paginate(ctx.db, inspections, service.inspectionQuery(f), order, p);
  return page(await service.inspectionItems(ctx.db, rows), total, p);
});

router.get("/inspections/facets", async (ctx) => {
  await ctx.require("maintenance", "view");
  const f = inspFilters(ctx);
  return { status: await facetCounts(ctx.db, inspections, service.inspectionQuery(f, new Set(["status"])), inspections.status) };
});

router.post("/inspections", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  const body = await ctx.body(inspectionCreate);
  return created(await service.inspectionOut(ctx.db, await service.createInspection(ctx.db, body, user)));
});

router.get("/inspections/{inspection_id}", async (ctx) => {
  await ctx.require("maintenance", "view");
  return service.inspectionOut(ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")));
});

router.patch("/inspections/{inspection_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(inspectionUpdate);
  const insp = await service.updateInspection(ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")), body, user);
  return service.inspectionOut(ctx.db, insp);
});

router.delete("/inspections/{inspection_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "delete");
  await service.archiveInspection(ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")), user);
  return noContent();
});

router.post("/inspections/{inspection_id}/responses", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(responsesIn);
  const insp = await service.recordResponses(ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")), body.responses, user);
  return service.inspectionOut(ctx.db, insp);
});

router.post("/inspections/{inspection_id}/status", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(inspectionStatusIn);
  const insp = await service.setInspectionStatus(
    ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")), body.status, body.summary, user,
  );
  return service.inspectionOut(ctx.db, insp);
});

router.post("/inspections/{inspection_id}/findings", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(findingIn);
  return created(await service.addFinding(ctx.db, await service.getInspection(ctx.db, ctx.uuid("inspection_id")), body, user));
});

router.patch("/inspection-findings/{finding_id}", async (ctx) => {
  const user = await ctx.require("maintenance", "edit");
  const body = await ctx.body(findingUpdate);
  return service.findingOut(await service.updateFinding(ctx.db, await service.getFinding(ctx.db, ctx.uuid("finding_id")), body, user));
});

router.post("/inspection-findings/{finding_id}/work-order", async (ctx) => {
  const user = await ctx.require("maintenance", "create");
  const wo = await service.findingToWorkOrder(ctx.db, await service.getFinding(ctx.db, ctx.uuid("finding_id")), user);
  return created(await service.toOut(ctx.db, wo));
});
