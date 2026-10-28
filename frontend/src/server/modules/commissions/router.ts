import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { utcnow } from "../../core/security";
import { get as ormGet, patch } from "../../db/orm";
import {
  agentPlans, COMMISSION_STATUSES, commissionEvents, commissionInvoices, commissions, INVOICE_STATUSES,
  RECONCILIATION_STATES, SIDES, splitPlans,
} from "./schema";
import {
  agentPlanIn, cancelIn, commissionCreate, commissionUpdate, earnIn, invoiceCreate, noteIn, paymentCreate, planIn,
  releaseIn, voidIn,
} from "./schemas";
import * as service from "./service";
import type { CommissionFilters } from "./service";

export const router = new Router();

const t = commissions;
const SORTS = {
  title: t.title, gross: t.gross, status: t.status, expected_on: t.expected_on, expected_close_on: t.expected_close_on,
  earned_on: t.earned_on, paid_on: t.paid_on, probability: t.probability, deal_volume: t.deal_volume,
  updated_at: t.updated_at,
};

function filters(ctx: Ctx): CommissionFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    status: q.strs("status"),
    side: q.strs("side"),
    property_type: q.strs("property_type"),
    reconciliation_status: q.strs("reconciliation_status"),
    source: q.strs("source"),
    agent_id: q.uuids("agent_id"),
    brokerage_deal_id: q.uuid("brokerage_deal_id"),
    min_gross: q.num("min_gross"),
    max_gross: q.num("max_gross"),
    expected_from: q.date("expected_from"),
    expected_to: q.date("expected_to"),
  };
}

router.get("/commissions", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const p = ctx.listParams();
  const f = filters(ctx);
  const order = applySort(p.sort, SORTS, desc(t.updated_at));
  const [rows, total] = await paginate(ctx.db, t, service.buildQuery(f, user), order, p);
  return page(await service.toItems(ctx.db, rows, user), total, p);
});

router.get("/commissions/facets", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const f = filters(ctx);
  const q = (skip: string) => service.buildQuery(f, user, new Set([skip]));
  return {
    status: await facetCounts(ctx.db, t, q("status"), t.status),
    side: await facetCounts(ctx.db, t, q("side"), t.side),
    property_type: await facetCounts(ctx.db, t, q("property_type"), t.property_type),
    reconciliation_status: await facetCounts(ctx.db, t, q("reconciliation_status"), t.reconciliation_status),
  };
});

router.get("/commissions/meta", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  return {
    statuses: COMMISSION_STATUSES, sides: SIDES, invoice_statuses: INVOICE_STATUSES,
    reconciliation_states: RECONCILIATION_STATES, production_groups: service.GROUPS, restricted: service.restricted(user),
  };
});

router.post("/commissions", async (ctx) => {
  const user = await ctx.require("commissions", "create");
  const body = await ctx.body(commissionCreate);
  return created(await service.toOut(ctx.db, await service.create(ctx.db, body, user), user));
});

router.post("/commissions/sync", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  return service.syncFromDeals(ctx.db, user);
});

router.get("/commissions/deal-options", async (ctx) => {
  const user = await ctx.require("commissions", "create");
  const q = ctx.query.str("q", { max: 200 });
  let deals = await service.dealRows(ctx.db);
  if (service.restricted(user)) deals = deals.filter((d) => d.agent_id === user.id);
  const labels = await service.dealLabels(ctx.db, deals);
  const linkedRows = await ctx.db
    .select({ d: t.brokerage_deal_id })
    .from(t)
    .where(and(isNotNull(t.brokerage_deal_id), isNull(t.deleted_at), ne(t.status, "cancelled")));
  const linked = new Set(linkedRows.map((r) => r.d));
  const out: Record<string, any>[] = [];
  for (const d of deals) {
    const label = labels.get(d.id) || "";
    if (q && !label.toLowerCase().includes(q.toLowerCase())) continue;
    out.push({
      id: d.id, label, stage: d.stage ?? null, agent_id: d.agent_id ?? null, expected_close_on: d.expected_close_on ?? null,
      probability: service.normProb(d.probability), gross_commission_estimate: d.gross_commission_estimate ?? null,
      has_commission: linked.has(d.id),
    });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)).slice(0, 200);
});

// --------------------------------------------------------------------------- forecast & production

router.get("/commissions/forecast", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const months = ctx.query.int("months", { ge: 1, le: 36 }) ?? 12;
  const agentId = ctx.query.uuid("agent_id") ?? null;
  await service.ensureSnapshot(ctx.db, user); // monthly forecast snapshot for accuracy tracking (idempotent)
  return service.forecast(ctx.db, user, months, agentId);
});

router.post("/commissions/forecast/snapshot", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const s = await service.ensureSnapshot(ctx.db, user);
  return { snapshot_month: s.snapshot_month, total_weighted: s.total_weighted, taken_at: s.taken_at };
});

router.get("/commissions/forecast/accuracy", async (ctx) => {
  await ctx.require("commissions", "view_sensitive");
  return service.accuracy(ctx.db, ctx.query.int("months", { ge: 1, le: 36 }) ?? 12);
});

router.get("/commissions/production", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const q = ctx.query;
  return service.production(
    ctx.db, user, q.str("group_by") ?? "agent", q.date("start") ?? null, q.date("end") ?? null, q.uuid("agent_id") ?? null,
    q.uuid("team_id") ?? null, q.str("property_type") ?? null, q.str("source") ?? null,
  );
});

// --------------------------------------------------------------------------- invoices

router.get("/commissions/invoices", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const p = ctx.listParams();
  const status = ctx.query.strs("status");
  const overdue = ctx.query.bool("overdue");
  const inv = commissionInvoices;
  const terms = p.q ? p.q.split(/\s+/).filter(Boolean) : [];
  const where = and(
    isNull(inv.deleted_at),
    isNull(t.deleted_at),
    service.visible(user),
    status?.length ? inArray(inv.status, status) : undefined,
    overdue ? and(eq(inv.status, "issued"), sql`${inv.due_on} < ${new Date().toISOString().slice(0, 10)}`) : undefined,
    ...terms.map((term) =>
      or(
        sql`${inv.invoice_number} ilike ${`%${term}%`}`,
        sql`${inv.bill_to} ilike ${`%${term}%`}`,
        sql`${t.title} ilike ${`%${term}%`}`,
      ),
    ),
  );
  const order = applySort(
    p.sort,
    {
      invoice_number: inv.invoice_number, issued_on: inv.issued_on, due_on: inv.due_on, amount: inv.amount, status: inv.status,
    },
    desc(inv.issued_on),
  );
  const [cnt] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(inv)
    .innerJoin(t, eq(t.id, inv.commission_id))
    .where(where);
  const rows = (
    await ctx.db
      .select({ inv })
      .from(inv)
      .innerJoin(t, eq(t.id, inv.commission_id))
      .where(where)
      .orderBy(...order)
      .limit(p.page_size)
      .offset((p.page - 1) * p.page_size)
  ).map((r) => r.inv);
  const titles = new Map<string, string>();
  if (rows.length) {
    const tr = await ctx.db
      .select({ id: t.id, title: t.title })
      .from(t)
      .where(inArray(t.id, [...new Set(rows.map((r) => r.commission_id))]));
    for (const r of tr) titles.set(r.id, r.title);
  }
  return page(rows.map((r) => service.invoiceOut(r, titles.get(r.commission_id) ?? null)), Number(cnt?.n ?? 0), p);
});

router.post("/commissions/invoices/{invoice_id}/void", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(voidIn);
  const inv = await ormGet(ctx.db, commissionInvoices, ctx.uuid("invoice_id"));
  if (!inv || inv.deleted_at) throw new HttpError(404, "Invoice not found");
  await service.get(ctx.db, inv.commission_id, user);
  return service.invoiceOut(await service.voidInvoice(ctx.db, inv, body.reason, user));
});

// --------------------------------------------------------------------------- split plans

router.get("/commissions/split-plans", async (ctx) => {
  await ctx.require("commissions", "view_sensitive");
  const countRows = await ctx.db
    .select({ plan_id: agentPlans.plan_id, n: sql<number>`count(*)::int` })
    .from(agentPlans)
    .where(isNull(agentPlans.deleted_at))
    .groupBy(agentPlans.plan_id);
  const counts = new Map(countRows.map((r) => [r.plan_id, Number(r.n)]));
  const plans = await ctx.db.select().from(splitPlans).where(isNull(splitPlans.deleted_at)).orderBy(splitPlans.name);
  return plans.map((p) => service.planOut(p, counts.get(p.id) ?? 0));
});

router.post("/commissions/split-plans", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(planIn);
  return created(service.planOut(await service.savePlan(ctx.db, null, body, user)));
});

router.put("/commissions/split-plans/{plan_id}", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(planIn);
  const plan = await ormGet(ctx.db, splitPlans, ctx.uuid("plan_id"));
  if (!plan || plan.deleted_at) throw new HttpError(404, "Plan not found");
  return service.planOut(await service.savePlan(ctx.db, plan, body, user));
});

router.get("/commissions/agent-plans", async (ctx) => {
  await ctx.require("commissions", "view_sensitive");
  return service.agentPlansList(ctx.db);
});

router.put("/commissions/agent-plans/{agent_id}", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(agentPlanIn);
  await service.assignPlan(ctx.db, ctx.uuid("agent_id"), body.plan_id, body.effective_from, user);
  return noContent();
});

// --------------------------------------------------------------------------- single commission

router.get("/commissions/{commission_id}", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  return service.toOut(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), user);
});

router.patch("/commissions/{commission_id}", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const body = await ctx.body(commissionUpdate);
  const c = await service.update(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body, user);
  return service.toOut(ctx.db, c, user);
});

router.delete("/commissions/{commission_id}", async (ctx) => {
  const user = await ctx.require("commissions", "delete");
  const c = await service.get(ctx.db, ctx.uuid("commission_id"), user);
  if (c.status !== "forecast") throw new HttpError(409, "Only forecast commissions can be deleted; earned commissions are retained");
  await patch(ctx.db, commissions, c, { deleted_at: utcnow(), updated_by_id: user.id } as never);
  await audit.record(ctx.db, {
    actor: user, action: "commission.deleted", entity_type: "commission", entity_id: c.id, summary: c.title,
    ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return noContent();
});

router.get("/commissions/{commission_id}/events", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const id = ctx.uuid("commission_id");
  await service.get(ctx.db, id, user);
  const rows = await ctx.db.select().from(commissionEvents).where(eq(commissionEvents.commission_id, id)).orderBy(desc(commissionEvents.at));
  return rows.map((e) => ({
    id: e.id, action: e.action, from_status: e.from_status, to_status: e.to_status, at: e.at, actor_name: e.actor_name,
    note: e.note,
  }));
});

router.get("/commissions/{commission_id}/compliance", async (ctx) => {
  const user = await ctx.require("commissions", "view");
  const c = await service.get(ctx.db, ctx.uuid("commission_id"), user);
  const [ok, reasons] = await service.complianceCheck(ctx.db, c.brokerage_deal_id);
  return { complete: ok, reasons };
});

router.post("/commissions/{commission_id}/earn", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const body = await ctx.body(earnIn);
  const c = await service.earn(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body, user);
  return service.toOut(ctx.db, c, user);
});

router.post("/commissions/{commission_id}/approve", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(noteIn);
  const c = await service.approve(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body.note, user);
  return service.toOut(ctx.db, c, user);
});

router.post("/commissions/{commission_id}/cancel", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const body = await ctx.body(cancelIn);
  const c = await service.cancel(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body.reason, user);
  return service.toOut(ctx.db, c, user);
});

router.post("/commissions/{commission_id}/invoices", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const body = await ctx.body(invoiceCreate);
  const c = await service.get(ctx.db, ctx.uuid("commission_id"), user);
  const inv = await service.createInvoice(ctx.db, c, body, user);
  return created(service.invoiceOut(inv, c.title));
});

router.post("/commissions/{commission_id}/payments", async (ctx) => {
  const user = await ctx.require("commissions", "edit");
  const body = await ctx.body(paymentCreate);
  const pay = await service.recordPayment(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body, user);
  return created(service.paymentOut(pay));
});

router.post("/commissions/{commission_id}/release", async (ctx) => {
  const user = await ctx.require("commissions", "approve");
  const body = await ctx.body(releaseIn);
  const c = await service.release(ctx.db, await service.get(ctx.db, ctx.uuid("commission_id"), user), body, user);
  return service.toOut(ctx.db, c, user);
});
