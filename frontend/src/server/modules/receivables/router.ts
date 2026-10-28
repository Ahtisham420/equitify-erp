import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { applySearch, applySort, countWhere, facetCounts, inFilter, page } from "../../common/query";
import { created, HttpError } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import type { Db } from "../../db";
import { get as getById } from "../../db/orm";
import { leases, recoveryReconciliations } from "../leases/schema";
import * as leaseService from "../leases/service";
import { today } from "../leases/util";
import { properties } from "../properties/schema";
import {
  CHARGE_SOURCES, CHARGE_STATUSES, CHARGE_TYPES, charges, COLLECTION_STATUSES, collectionStatuses,
  delinquencyNotices, PAYMENT_METHODS, paymentPlans, payments, PLAN_STATUSES, syncBatches, syncConflicts,
} from "./schema";
import {
  applyIn, evaluateIn, exportIn, generateIn, importIn, manualChargeIn, noticeCreate, noticeSendIn, paymentIn, planIn,
  reconBillIn, resolveIn, settingsIn, unapplyIn, voidIn,
} from "./schemas";
import * as service from "./service";
import type { ChargeFilters } from "./service";

export const router = new Router();

const CHARGE_SORTS = {
  due_on: charges.due_on, amount: charges.amount, tenant_name: charges.tenant_name, status: charges.status,
  charge_type: charges.charge_type, balance: sql`(${charges.amount} - ${charges.amount_paid})`,
  created_at: charges.created_at,
};
const PAYMENT_SORTS = {
  received_on: payments.received_on, amount: payments.amount, tenant_name: payments.tenant_name,
  unapplied_amount: payments.unapplied_amount, created_at: payments.created_at,
};

async function leaseNames(db: Db, lease_ids: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(lease_ids.filter((i): i is string => Boolean(i)))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: leases.id, name: leases.tenant_name }).from(leases).where(inArray(leases.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

router.get("/receivables/meta", async (ctx) => {
  await ctx.require("receivables", "view");
  return {
    charge_types: CHARGE_TYPES, charge_statuses: CHARGE_STATUSES, charge_sources: CHARGE_SOURCES,
    payment_methods: PAYMENT_METHODS, plan_statuses: PLAN_STATUSES, collection_statuses: COLLECTION_STATUSES,
  };
});

router.get("/receivables/dashboard", async (ctx) => {
  await ctx.require("receivables", "view");
  const q = ctx.query;
  return service.dashboard(ctx.db, { property_id: q.uuid("property_id"), asset_id: q.uuid("asset_id"), as_of: q.date("as_of") });
});

// --------------------------------------------------------------------------- tenants / ledger

router.get("/receivables/tenants", async (ctx) => {
  await ctx.require("receivables", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const st = service.tenantsStatement(ctx.db, today(), {
    property_id: q.uuid("property_id"), asset_id: q.uuid("asset_id"), q: p.q, collection_status: q.strs("collection_status"),
    delinquent_only: q.bool("delinquent_only") ?? false,
  });
  const order = applySort(p.sort, st.sorts, desc(st.balance));
  const rows = await st.query().orderBy(...order).limit(p.page_size).offset((p.page - 1) * p.page_size);
  const total = await st.count();
  return page(await service.tenantRows(ctx.db, rows), total, p);
});

router.get("/receivables/tenants/{lease_id}/ledger", async (ctx) => {
  await ctx.require("receivables", "view");
  return service.ledger(ctx.db, ctx.uuid("lease_id"), ctx.query.date("as_of"));
});

// --------------------------------------------------------------------------- charges

function chargeFilters(ctx: Ctx): ChargeFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    lease_id: q.uuid("lease_id"),
    property_id: q.uuid("property_id"),
    asset_id: q.uuid("asset_id"),
    charge_type: q.strs("charge_type"),
    status: q.strs("status"),
    source: q.strs("source"),
    period: q.str("period", { pattern: /^\d{4}-\d{2}$/ }),
    due_from: q.date("due_from"),
    due_to: q.date("due_to"),
    overdue: q.bool("overdue"),
  };
}

router.get("/receivables/charges", async (ctx) => {
  await ctx.require("receivables", "view");
  const p = ctx.listParams();
  const f = chargeFilters(ctx);
  const where = service.buildChargeWhere(f);
  const order = applySort(p.sort, CHARGE_SORTS, desc(charges.due_on));
  const total = await countWhere(ctx.db, charges, where);
  const rows = await ctx.db
    .select()
    .from(charges)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(rows.map((c) => service.chargeOut(c)), total, p);
});

router.get("/receivables/charges/facets", async (ctx) => {
  await ctx.require("receivables", "view");
  const f = chargeFilters(ctx);
  const w = service.buildChargeWhere;
  return {
    status: await facetCounts(ctx.db, charges, w(f, new Set(["status"])), charges.status),
    charge_type: await facetCounts(ctx.db, charges, w(f, new Set(["charge_type"])), charges.charge_type),
    source: await facetCounts(ctx.db, charges, w(f, new Set(["source"])), charges.source),
  };
});

router.post("/receivables/charges/generate", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  return service.generateCharges(ctx.db, await ctx.body(generateIn), user);
});

router.post("/receivables/charges", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  const body = await ctx.body(manualChargeIn);
  return created(service.chargeOut(await service.createManualCharge(ctx.db, body, user)));
});

router.post("/receivables/charges/{charge_id}/approve", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const c = await service.getRow(ctx.db, charges, ctx.uuid("charge_id"), "Charge");
  return service.chargeOut(await service.approveCharge(ctx.db, c, user));
});

router.post("/receivables/charges/{charge_id}/void", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const id = ctx.uuid("charge_id");
  const body = await ctx.body(voidIn);
  const c = await service.getRow(ctx.db, charges, id, "Charge");
  return service.chargeOut(await service.voidCharge(ctx.db, c, body.reason, user));
});

router.post("/receivables/late-fees/assess", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  const body = await ctx.body(evaluateIn);
  return { created: await service.assessLateFees(ctx.db, body.as_of, body.property_id, user) };
});

// --------------------------------------------------------------------------- payments

router.get("/receivables/payments", async (ctx) => {
  await ctx.require("receivables", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const lease_id = q.uuid("lease_id");
  const property_id = q.uuid("property_id");
  const received_from = q.date("received_from");
  const received_to = q.date("received_to");
  const where = and(
    isNull(payments.deleted_at),
    applySearch(p.q, [payments.tenant_name, payments.reference]),
    lease_id ? eq(payments.lease_id, lease_id) : undefined,
    property_id ? eq(payments.property_id, property_id) : undefined,
    inFilter(payments.status, q.strs("status")),
    inFilter(payments.method, q.strs("method")),
    received_from ? sql`${payments.received_on} >= ${received_from}` : undefined,
    received_to ? sql`${payments.received_on} <= ${received_to}` : undefined,
    q.bool("unapplied_only") ? and(sql`${payments.unapplied_amount} > 0`, eq(payments.status, "received")) : undefined,
  );
  const order = applySort(p.sort, PAYMENT_SORTS, desc(payments.received_on));
  const total = await countWhere(ctx.db, payments, where);
  const rows = await ctx.db
    .select()
    .from(payments)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  const items = [];
  for (const row of rows) items.push(await service.paymentOut(ctx.db, row));
  return page(items, total, p);
});

router.post("/receivables/payments", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  const body = await ctx.body(paymentIn);
  return created(await service.paymentOut(ctx.db, await service.recordPayment(ctx.db, body, user)));
});

router.get("/receivables/payments/{payment_id}", async (ctx) => {
  await ctx.require("receivables", "view");
  return service.paymentOut(ctx.db, await service.getRow(ctx.db, payments, ctx.uuid("payment_id"), "Payment"));
});

router.post("/receivables/payments/{payment_id}/apply", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  const id = ctx.uuid("payment_id");
  const body = await ctx.body(applyIn);
  const p = await service.getRow(ctx.db, payments, id, "Payment");
  return service.paymentOut(ctx.db, await service.applyPayment(ctx.db, p, body, user));
});

router.post("/receivables/payments/{payment_id}/unapply", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  const id = ctx.uuid("payment_id");
  const body = await ctx.body(unapplyIn);
  const p = await service.getRow(ctx.db, payments, id, "Payment");
  return service.paymentOut(ctx.db, await service.unapply(ctx.db, p, body, user));
});

router.post("/receivables/payments/{payment_id}/reverse", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const id = ctx.uuid("payment_id");
  const body = await ctx.body(voidIn);
  const p = await service.getRow(ctx.db, payments, id, "Payment");
  return service.paymentOut(ctx.db, await service.reversePayment(ctx.db, p, body.reason, user));
});

// --------------------------------------------------------------------------- settings & delinquency

router.get("/receivables/settings", async (ctx) => {
  await ctx.require("receivables", "view");
  return service.getSettings(ctx.db);
});

router.put("/receivables/settings", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  return service.saveSettings(ctx.db, await ctx.body(settingsIn), user);
});

router.post("/receivables/delinquency/evaluate", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  return service.evaluate(ctx.db, await ctx.body(evaluateIn), user);
});

router.get("/receivables/delinquency", async (ctx) => {
  await ctx.require("receivables", "view");
  const property_id = ctx.query.uuid("property_id");
  const status = ctx.query.strs("status");
  const rows = await ctx.db
    .select({
      cs: collectionStatuses, tenant: leases.tenant_name,
      prop: sql<string | null>`coalesce(${properties.name}, ${properties.address_line})`,
    })
    .from(collectionStatuses)
    .innerJoin(leases, eq(leases.id, collectionStatuses.lease_id))
    .innerJoin(properties, eq(properties.id, leases.property_id))
    .where(and(
      isNull(leases.deleted_at),
      property_id ? eq(leases.property_id, property_id) : undefined,
      status ? inArray(collectionStatuses.status, status) : ne(collectionStatuses.status, "current"),
    ))
    .orderBy(desc(collectionStatuses.days_past_due))
    .limit(500);
  const labels = new Map((await service.getSettings(ctx.db)).ladder.map((s) => [s.key, s.label]));
  return rows.map(({ cs, tenant, prop }) => ({
    id: cs.id, lease_id: cs.lease_id, tenant_name: tenant, property_name: prop, status: cs.status,
    step_index: cs.step_index, step_key: cs.step_key, step_label: labels.get(cs.step_key || "") ?? null,
    past_due_balance: cs.past_due_balance, days_past_due: cs.days_past_due, oldest_due_on: cs.oldest_due_on,
    on_hold: cs.on_hold, last_evaluated_at: cs.last_evaluated_at,
  }));
});

router.get("/receivables/notices", async (ctx) => {
  await ctx.require("receivables", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const n = delinquencyNotices;
  const lease_id = q.uuid("lease_id");
  const property_id = q.uuid("property_id");
  const where = and(
    isNull(n.deleted_at),
    applySearch(p.q, [n.subject, n.label]),
    inFilter(n.status, q.strs("status")),
    inFilter(n.step_key, q.strs("step_key")),
    lease_id ? eq(n.lease_id, lease_id) : undefined,
    property_id ? eq(n.property_id, property_id) : undefined,
  );
  const sorts = { created_at: n.created_at, balance: n.balance, days_past_due: n.days_past_due };
  const order = applySort(p.sort, sorts, desc(n.created_at));
  const total = await countWhere(ctx.db, n, where);
  const rows = await ctx.db
    .select()
    .from(n)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  const names = await leaseNames(ctx.db, rows.map((r) => r.lease_id));
  return page(rows.map((r) => service.noticeOut(r, names.get(r.lease_id) ?? null)), total, p);
});

router.post("/receivables/notices", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  const body = await ctx.body(noticeCreate);
  return created(service.noticeOut(await service.createNotice(ctx.db, body.lease_id, body.step_key, user)));
});

router.post("/receivables/notices/{notice_id}/send", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  const id = ctx.uuid("notice_id");
  const body = await ctx.body(noticeSendIn);
  const n = await service.getRow(ctx.db, delinquencyNotices, id, "Notice");
  return service.noticeOut(await service.sendNotice(ctx.db, n, body.delivery_method, user));
});

router.post("/receivables/notices/{notice_id}/cancel", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  const n = await service.getRow(ctx.db, delinquencyNotices, ctx.uuid("notice_id"), "Notice");
  return service.noticeOut(await service.cancelNotice(ctx.db, n, user));
});

// --------------------------------------------------------------------------- payment plans

router.get("/receivables/payment-plans", async (ctx) => {
  await ctx.require("receivables", "view");
  const q = ctx.query;
  const lease_id = q.uuid("lease_id");
  const property_id = q.uuid("property_id");
  const rows = await ctx.db
    .select()
    .from(paymentPlans)
    .where(and(
      isNull(paymentPlans.deleted_at),
      inFilter(paymentPlans.status, q.strs("status")),
      lease_id ? eq(paymentPlans.lease_id, lease_id) : undefined,
      property_id ? eq(paymentPlans.property_id, property_id) : undefined,
    ))
    .orderBy(desc(paymentPlans.created_at))
    .limit(200);
  const out = [];
  for (const plan of rows) out.push(await service.planOut(ctx.db, plan));
  return out;
});

router.post("/receivables/payment-plans", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const body = await ctx.body(planIn);
  return created(await service.planOut(ctx.db, await service.createPlan(ctx.db, body, user)));
});

router.post("/receivables/payment-plans/{plan_id}/cancel", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const plan = await service.getRow(ctx.db, paymentPlans, ctx.uuid("plan_id"), "Payment plan");
  return service.planOut(ctx.db, await service.cancelPlan(ctx.db, plan, user));
});

// --------------------------------------------------------------------------- reconciliation billing

router.get("/receivables/reconciliation-billing", async (ctx) => {
  await ctx.require("receivables", "view");
  const q = ctx.query;
  const r = recoveryReconciliations;
  const property_id = q.uuid("property_id");
  const year = q.int("year");
  const rows = await ctx.db
    .select({ rec: r, tenant: leases.tenant_name })
    .from(r)
    .innerJoin(leases, eq(leases.id, r.lease_id))
    .where(and(
      isNull(r.deleted_at),
      inArray(r.status, q.strs("status") ?? ["final", "billed"]),
      property_id ? eq(r.property_id, property_id) : undefined,
      year ? eq(r.year, year) : undefined,
    ))
    .orderBy(desc(r.year))
    .limit(500);
  return rows.map(({ rec, tenant }) => leaseService.reconciliationOut(rec, tenant));
});

router.post("/receivables/reconciliation-billing", async (ctx) => {
  const user = await ctx.require("receivables", "create");
  return service.billReconciliations(ctx.db, await ctx.body(reconBillIn), user);
});

// --------------------------------------------------------------------------- accounting / banking sync

router.get("/receivables/sync/batches", async (ctx) => {
  await ctx.require("receivables", "view");
  const direction = ctx.query.str("direction");
  const rows = await ctx.db
    .select()
    .from(syncBatches)
    .where(and(isNull(syncBatches.deleted_at), direction ? eq(syncBatches.direction, direction) : undefined))
    .orderBy(desc(syncBatches.created_at))
    .limit(200);
  return rows.map(service.batchOut);
});

router.get("/receivables/sync/batches/{batch_id}", async (ctx) => {
  await ctx.require("receivables", "view");
  return service.batchDetail(await service.getRow(ctx.db, syncBatches, ctx.uuid("batch_id"), "Batch"));
});

router.post("/receivables/sync/export", async (ctx) => {
  const user = await ctx.require("receivables", "export");
  return created(service.batchDetail(await service.exportBatch(ctx.db, await ctx.body(exportIn), user)));
});

router.post("/receivables/sync/import", async (ctx) => {
  const user = await ctx.require("receivables", "edit");
  return created(service.batchOut(await service.importBatch(ctx.db, await ctx.body(importIn), user)));
});

router.get("/receivables/sync/conflicts", async (ctx) => {
  await ctx.require("receivables", "view");
  const p = ctx.listParams();
  const batch_id = ctx.query.uuid("batch_id");
  const where = and(inFilter(syncConflicts.status, ctx.query.strs("status")), batch_id ? eq(syncConflicts.batch_id, batch_id) : undefined);
  const total = await countWhere(ctx.db, syncConflicts, where);
  const rows = await ctx.db
    .select()
    .from(syncConflicts)
    .where(where)
    .orderBy(desc(syncConflicts.created_at))
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return page(rows.map(service.conflictOut), total, p);
});

router.post("/receivables/sync/conflicts/{conflict_id}/resolve", async (ctx) => {
  const user = await ctx.require("receivables", "approve");
  const id = ctx.uuid("conflict_id");
  const body = await ctx.body(resolveIn);
  const cf = await getById(ctx.db, syncConflicts, id);
  if (!cf) throw new HttpError(404, "Conflict not found");
  return service.conflictOut(await service.resolveConflict(ctx.db, cf, body, user));
});
