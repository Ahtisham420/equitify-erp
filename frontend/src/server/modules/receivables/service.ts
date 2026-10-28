import {
  and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL,
} from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, countWhere, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as getById, insert, patch } from "../../db/orm";
import { leases, recoveryReconciliations, type Lease } from "../leases/schema";
import * as leaseService from "../leases/service";
import {
  addDays, addMonths, dateOf, diffDays, longDate, money, round as pyRound, save, shortMonthYear, today, ymd,
} from "../leases/util";
import { properties } from "../properties/schema";
import * as taskService from "../tasks/service";
import {
  charges, collectionStatuses, delinquencyNotices, paymentApplications, paymentPlanInstallments, paymentPlans,
  payments, receivablesSettings, syncBatches, syncConflicts,
  type Charge, type CollectionStatus, type DelinquencyNotice, type Payment, type PaymentApplication,
  type PaymentPlan, type SyncBatch, type SyncConflict,
} from "./schema";
import {
  emptyBuckets, ladderStep, lateFeeDefaults,
  type ApplyIn, type Buckets, type EvaluateIn, type EvaluateOut, type ExportIn, type GenerateIn, type GenerateOut,
  type ImportIn, type LadderStep, type LateFeeDefaults, type ManualChargeIn, type PaymentIn, type PlanIn,
  type ReconBillIn, type ReconBillOut, type ResolveIn, type SettingsIn, type SettingsOut, type UnapplyIn,
} from "./schemas";

export const ENTITY = "receivables";
const OPEN_STATUSES = ["open", "partial", "credit"];
const CENT = 0.005;
type Rec = Record<string, any>;

const DEFAULT_LADDER: Rec[] = [
  {
    key: "reminder", label: "Payment reminder", days_past_due: 5, min_balance: 0, create_task: false,
    task_priority: "normal", collection_status: "delinquent", subject: "Payment reminder: {property_name}",
    body: "Dear {tenant_name},\n\nOur records show a past-due balance of {balance} as of {as_of} "
      + "({days_past_due} days past due). Please remit payment at your earliest convenience.\n\nThank you.",
  },
  {
    key: "notice", label: "Past-due notice", days_past_due: 15, min_balance: 0, create_task: true,
    task_priority: "normal", collection_status: "delinquent", subject: "Past-due notice: {property_name}",
    body: "Dear {tenant_name},\n\nYour account is {days_past_due} days past due with a balance of {balance} "
      + "as of {as_of}. Late fees may apply under your lease. Please pay by {cure_by}.",
  },
  {
    key: "default_notice", label: "Notice of default", days_past_due: 30, min_balance: 0, create_task: true,
    task_priority: "high", collection_status: "delinquent", subject: "Notice of default: {property_name}",
    body: "Dear {tenant_name},\n\nYou are in default of your lease for failure to pay {balance}, now "
      + "{days_past_due} days past due as of {as_of}. If the default is not cured by {cure_by}, the landlord "
      + "may exercise its remedies under the lease.",
  },
  {
    key: "legal", label: "Refer to legal", days_past_due: 60, min_balance: 0, create_task: true,
    task_priority: "urgent", collection_status: "legal", subject: "Referral to counsel: {tenant_name}",
    body: "{tenant_name} at {property_name} owes {balance}, {days_past_due} days past due as of {as_of}. "
      + "Refer to counsel for collection / default remedies.",
  },
];
const DEFAULT_ALERT_DAYS = 90;

// --------------------------------------------------------------------------- helpers

/** `round(float(v or 0) + 0, 2)` */
const _round = (v: number | null | undefined): number => pyRound(Number(v || 0), 2);

export function chargeStatus(c: Pick<Charge, "voided_at" | "status" | "amount" | "amount_paid">): string {
  if (c.voided_at) return "void";
  if (c.status === "pending_approval") return "pending_approval";
  const amount = Number(c.amount);
  const paid = Number(c.amount_paid || 0);
  if (amount < 0) return "credit";
  if (paid >= amount - CENT) return "paid";
  return paid > CENT ? "partial" : "open";
}

export function chargeBalance(c: Pick<Charge, "status" | "amount" | "amount_paid">): number {
  if (c.status === "void" || c.status === "pending_approval") return 0.0;
  return _round(Number(c.amount) - Number(c.amount_paid || 0));
}

const CHARGE_OUT_KEYS = [
  "id", "lease_id", "property_id", "tenant_name", "charge_type", "period_start", "period_end", "due_on", "amount",
  "amount_paid",
] as const;
const CHARGE_OUT_KEYS2 = [
  "status", "source", "source_ref", "description", "approved_by_id", "approved_at", "voided_at", "void_reason",
  "external_ref", "created_at", "updated_at",
] as const;

export function chargeOut(c: Charge, as_of: string | null = null) {
  const asOf = as_of || today();
  const balance = chargeBalance(c);
  const r = c as Rec;
  return {
    ...Object.fromEntries(CHARGE_OUT_KEYS.map((k) => [k, r[k]])),
    balance,
    days_past_due: balance > CENT ? Math.max(0, diffDays(asOf, c.due_on)) : 0,
    ...Object.fromEntries(CHARGE_OUT_KEYS2.map((k) => [k, r[k]])),
  };
}

export function bucketOf(due_on: string, as_of: string): string {
  const days = diffDays(as_of, due_on);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

/** Aggregated open-balance buckets as of a date (SELECT list for charges). */
export function bucketColumns(as_of: string) {
  const bal = sql`(${charges.amount} - ${charges.amount_paid})`;
  const c30 = addDays(as_of, -30);
  const c60 = addDays(as_of, -60);
  const c90 = addDays(as_of, -90);
  const sum = (cond: SQL) => sql<number>`coalesce(sum(case when ${cond} then ${bal} else 0 end), 0)`.mapWith(Number);
  return {
    current: sum(sql`${charges.due_on} >= ${as_of}`),
    d1_30: sum(sql`${charges.due_on} < ${as_of} and ${charges.due_on} >= ${c30}`),
    d31_60: sum(sql`${charges.due_on} < ${c30} and ${charges.due_on} >= ${c60}`),
    d61_90: sum(sql`${charges.due_on} < ${c60} and ${charges.due_on} >= ${c90}`),
    d90_plus: sum(sql`${charges.due_on} < ${c90}`),
    total: sql<number>`coalesce(sum(${bal}), 0)`.mapWith(Number),
  };
}

const buckets = (row: Rec): Buckets => ({
  current: _round(row.current), d1_30: _round(row.d1_30), d31_60: _round(row.d31_60), d61_90: _round(row.d61_90),
  d90_plus: _round(row.d90_plus), total: _round(row.total),
});

const openChargeFilter = (): SQL[] => [isNull(charges.deleted_at), inArray(charges.status, OPEN_STATUSES)];

export async function getLease(db: Db, lease_id: string): Promise<Lease> {
  const lease = await getById(db, leases, lease_id);
  if (!lease || lease.deleted_at) throw new HttpError(404, "Lease not found");
  return lease;
}

export async function getRow(db: Db, table: any, row_id: string, label: string): Promise<any> {
  const row = await getById(db, table, row_id);
  if (!row || (row as Rec).deleted_at) throw new HttpError(404, `${label} not found`);
  return row;
}

async function propertyName(db: Db, property_id: string): Promise<string | null> {
  const p = await getById(db, properties, property_id);
  return p ? p.name || p.address_line : null;
}

// --------------------------------------------------------------------------- settings

async function setting(db: Db, key: string) {
  const [row] = await db.select().from(receivablesSettings).where(eq(receivablesSettings.key, key)).limit(1);
  return row;
}

export async function getSettings(db: Db): Promise<SettingsOut> {
  const fees = await setting(db, "late_fee_defaults");
  const ladder = await setting(db, "escalation_ladder");
  const alert = await setting(db, "alert_days");
  return {
    late_fee_defaults: lateFeeDefaults.parse(fees ? fees.value : {}),
    ladder: (ladder ? (ladder.value as Rec[]) : DEFAULT_LADDER).map((s) => ladderStep.parse(s)),
    alert_days: alert ? Number((alert.value as Rec).days ?? DEFAULT_ALERT_DAYS) : DEFAULT_ALERT_DAYS,
  };
}

export async function saveSettings(db: Db, data: SettingsIn, actor: CurrentUser): Promise<SettingsOut> {
  const updates: Rec = {};
  if (data.late_fee_defaults !== null && data.late_fee_defaults !== undefined) {
    updates.late_fee_defaults = { ...data.late_fee_defaults };
  }
  if (data.ladder !== null && data.ladder !== undefined) {
    const keys = data.ladder.map((s) => s.key);
    if (new Set(keys).size !== keys.length) throw new HttpError(422, "Ladder step keys must be unique");
    updates.escalation_ladder = [...data.ladder].sort((a, b) => a.days_past_due - b.days_past_due).map((s) => ({ ...s }));
  }
  if (data.alert_days !== null && data.alert_days !== undefined) updates.alert_days = { days: data.alert_days };
  const changes: Rec = {};
  for (const [key, value] of Object.entries(updates)) {
    const row = await setting(db, key);
    if (row) {
      if (!audit.isEqual(row.value, value)) {
        changes[key] = { from: row.value, to: value };
        await patch(db, receivablesSettings, row, { value, updated_by_id: actor.id });
      }
    } else {
      await insert(db, receivablesSettings, { key, value, created_by_id: actor.id, updated_by_id: actor.id });
      changes[key] = { from: null, to: value };
    }
  }
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "receivables.settings_updated", entity_type: ENTITY, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return getSettings(db);
}

// --------------------------------------------------------------------------- charges

export interface ChargeFilters {
  q?: string;
  lease_id?: string;
  property_id?: string;
  asset_id?: string;
  charge_type?: string[];
  status?: string[];
  source?: string[];
  period?: string;
  due_from?: string;
  due_to?: string;
  overdue?: boolean;
}

export function buildChargeWhere(f: ChargeFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = charges;
  let periodCond: SQL | undefined;
  if (f.period) {
    const [y, m] = f.period.split("-").map(Number);
    const start = ymd(y, m, 1);
    const end = addDays(ymd(y + (m === 12 ? 1 : 0), (m % 12) + 1, 1), -1);
    periodCond = or(
      and(gte(t.period_start, start), lte(t.period_start, end)),
      and(isNull(t.period_start), gte(t.due_on, start), lte(t.due_on, end)),
    );
  }
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.tenant_name, t.description, t.external_ref]),
    f.lease_id ? eq(t.lease_id, f.lease_id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    skip.has("charge_type") ? undefined : inFilter(t.charge_type, f.charge_type),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("source") ? undefined : inFilter(t.source, f.source),
    periodCond,
    f.due_from ? gte(t.due_on, f.due_from) : undefined,
    f.due_to ? lte(t.due_on, f.due_to) : undefined,
    f.overdue ? and(inArray(t.status, ["open", "partial"]), lt(t.due_on, today())) : undefined,
  );
}

function newCharge(
  lease: Lease,
  o: {
    charge_type: string; amount: number; due_on: string; source: string; source_ref: Rec; actor: CurrentUser;
    description?: string | null; period_start?: string | null; period_end?: string | null;
    idempotency_key?: string | null; status?: string | null;
  },
): Rec {
  return {
    lease_id: lease.id, property_id: lease.property_id, asset_id: lease.asset_id, tenant_name: lease.tenant_name,
    charge_type: o.charge_type, amount: _round(o.amount), amount_paid: 0, due_on: o.due_on,
    period_start: o.period_start ?? null, period_end: o.period_end ?? null, source: o.source,
    source_ref: audit.toJsonable(o.source_ref), description: o.description ?? null,
    idempotency_key: o.idempotency_key ?? null, created_by_id: o.actor.id, updated_by_id: o.actor.id,
    status: o.status || (o.amount < 0 ? "credit" : "open"),
  };
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

/** Recurring charges for a month from VERIFIED lease schedules. Idempotent per lease+period+charge type. */
export async function generateCharges(db: Db, data: GenerateIn, actor: CurrentUser): Promise<GenerateOut> {
  const [y, m] = data.period.split("-").map(Number);
  if (!(m >= 1 && m <= 12)) throw new HttpError(422, "Invalid period");
  const p0 = ymd(y, m, 1);
  const p1 = addDays(ymd(y + (m === 12 ? 1 : 0), (m % 12) + 1, 1), -1);
  const rows = await db
    .select()
    .from(leases)
    .where(and(
      isNull(leases.deleted_at), eq(leases.status, "active"),
      data.property_id ? eq(leases.property_id, data.property_id) : undefined,
      data.lease_ids?.length ? inArray(leases.id, data.lease_ids) : undefined,
    ));
  let created = 0;
  let existing = 0;
  let unverified = 0;
  let nLeases = 0;
  let total = 0.0;
  for (const lease of rows) {
    nLeases += 1;
    if (!lease.verified) {
      unverified += 1;
      continue;
    }
    const grouped = new Map<string, { period_start: string; period_end: string; charge_type: string; amount: number; refs: Rec[] }>();
    for (const r of await leaseService.rentSchedule(db, lease.id, true)) {
      if (!(p0 <= r.period_start && r.period_start <= p1)) continue;
      const gk = `${r.period_start}|${r.charge_type}`;
      let g = grouped.get(gk);
      if (!g) {
        g = { period_start: r.period_start, period_end: r.period_end, charge_type: r.charge_type, amount: 0.0, refs: [] };
        grouped.set(gk, g);
      }
      g.amount += r.amount;
      g.period_end = g.period_end > r.period_end ? g.period_end : r.period_end;
      g.refs.push(r.source_ref);
    }
    for (const r of grouped.values()) {
      const source_ref = r.refs.length === 1 ? r.refs[0] : { components: r.refs };
      const key = `sched:${lease.id}:${r.period_start}:${r.charge_type}`;
      const [dupe] = await db.select({ id: charges.id }).from(charges).where(eq(charges.idempotency_key, key)).limit(1);
      if (dupe) {
        existing += 1;
        continue;
      }
      const label = capitalize(r.charge_type.replace(/_/g, " "));
      await insert(db, charges, newCharge(lease, {
        charge_type: r.charge_type, amount: r.amount, due_on: r.period_start, source: "schedule",
        source_ref: { ...source_ref, lease_id: lease.id, period: data.period, verified_terms: true },
        description: `${label} ${shortMonthYear(r.period_start)}`, period_start: r.period_start,
        period_end: r.period_end, idempotency_key: key, actor,
      }) as never);
      created += 1;
      total += r.amount;
    }
  }
  await audit.record(db, {
    actor, action: "receivables.charges_generated", entity_type: ENTITY, summary: `${data.period}: ${created} charges`,
    ip_address: actor.ip_address,
    changes: {
      period: data.period, created, existing, skipped_unverified: unverified, property_id: data.property_id ?? null,
    },
  });
  await events.emit(db, "receivables.charges_generated", { period: data.period, created, actor });
  await db.commit();
  return { period: data.period, created, existing, skipped_unverified: unverified, leases: nLeases, amount: _round(total) };
}

export async function createManualCharge(db: Db, data: ManualChargeIn, actor: CurrentUser): Promise<Charge> {
  const lease = await getLease(db, data.lease_id);
  const approved = actor.can("receivables", "approve");
  const values = newCharge(lease, {
    charge_type: data.charge_type, amount: data.amount, due_on: data.due_on, source: "manual",
    source_ref: { entered_by_id: actor.id, entered_by: actor.full_name }, description: data.description,
    period_start: data.period_start, period_end: data.period_end, actor, status: approved ? null : "pending_approval",
  });
  if (approved) {
    values.approved_by_id = actor.id;
    values.approved_at = utcnow();
  }
  const c = await insert(db, charges, values as never);
  await audit.record(db, {
    actor, action: "charge.created_manual", entity_type: "charge", entity_id: c.id,
    summary: `${lease.tenant_name}: ${data.description} ${money(data.amount)}`,
    changes: { lease_id: lease.id, amount: c.amount, approved }, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

/** Public contract: a charge raised by another module (e.g. maintenance chargeback). Idempotent per source.
 *  Follows the manual-charge approval rule. Does not commit. */
export async function createCharge(
  db: Db,
  o: {
    lease_id: string; amount: number; charge_type: string; description: string; due_on: string; source_type: string;
    source_id: string; actor: CurrentUser;
  },
): Promise<Charge> {
  const { lease_id, amount, charge_type, description, due_on, source_type, source_id, actor } = o;
  const key = `${source_type}:${source_id}:${charge_type}`;
  const [existing] = await db.select().from(charges).where(eq(charges.idempotency_key, key)).limit(1);
  if (existing) return existing;
  const lease = await getLease(db, lease_id);
  const approved = actor.can("receivables", "approve");
  const values = newCharge(lease, {
    charge_type, amount, due_on, source: "manual",
    source_ref: { source_type, source_id, entered_by_id: actor.id }, description: description.slice(0, 300),
    idempotency_key: key, actor, status: approved ? null : "pending_approval",
  });
  if (approved) {
    values.approved_by_id = actor.id;
    values.approved_at = utcnow();
  }
  const c = await insert(db, charges, values as never);
  await audit.record(db, {
    actor, action: "charge.created_manual", entity_type: "charge", entity_id: c.id,
    summary: `${lease.tenant_name}: ${description} ${money(c.amount)}`,
    changes: { lease_id: lease.id, amount: c.amount, source_type, source_id, approved }, ip_address: actor.ip_address,
  });
  return c;
}

export async function approveCharge(db: Db, c: Charge, actor: CurrentUser): Promise<Charge> {
  if (c.status !== "pending_approval") throw new HttpError(409, "Charge is not awaiting approval");
  if (c.created_by_id === actor.id && !actor.is_admin) {
    throw new HttpError(409, "A manual charge must be approved by someone other than its author");
  }
  c.status = "open";
  c.status = chargeStatus(c);
  await patch(db, charges, c, {
    status: c.status, approved_by_id: actor.id, approved_at: utcnow(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "charge.approved", entity_type: "charge", entity_id: c.id,
    summary: `${c.tenant_name}: ${money(c.amount)}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

export async function voidCharge(db: Db, c: Charge, reason: string, actor: CurrentUser): Promise<Charge> {
  if (c.voided_at) throw new HttpError(409, "Charge is already void");
  if (Number(c.amount_paid || 0) > CENT) throw new HttpError(409, "Unapply payments from this charge before voiding it");
  const prev = c.status;
  await patch(db, charges, c, {
    voided_at: utcnow(), voided_by_id: actor.id, void_reason: reason, status: "void", updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "charge.voided", entity_type: "charge", entity_id: c.id, summary: reason,
    changes: { status: { from: prev, to: "void" } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

// --------------------------------------------------------------------------- payments & application

export async function paymentOut(db: Db, p: Payment) {
  const apps = await db
    .select()
    .from(paymentApplications)
    .where(eq(paymentApplications.payment_id, p.id))
    .orderBy(asc(paymentApplications.created_at));
  const r = p as Rec;
  return {
    ...Object.fromEntries(
      ["id", "lease_id", "property_id", "tenant_name", "received_on", "amount", "unapplied_amount", "method",
        "reference", "status", "reversed_at", "reversal_reason", "notes", "external_ref", "created_at"]
        .map((k) => [k, r[k]]),
    ),
    applications: apps.map((a) => Object.fromEntries(
      ["id", "payment_id", "charge_id", "amount", "applied_on", "method", "reversed_at", "reversal_reason",
        "created_by_id"].map((k) => [k, (a as Rec)[k]]),
    )),
  };
}

async function apply(db: Db, p: Payment, c: Charge, amount: number, method: string, actor: CurrentUser): Promise<void> {
  if (c.lease_id !== p.lease_id) throw new HttpError(422, "Charge belongs to another lease");
  if (c.status !== "open" && c.status !== "partial") throw new HttpError(422, `Charge is ${c.status} and cannot take payment`);
  amount = _round(amount);
  if (amount > Number(p.unapplied_amount) + CENT) throw new HttpError(422, "Allocation exceeds the payment's unapplied cash");
  if (amount > chargeBalance(c) + CENT) throw new HttpError(422, "Allocation exceeds the charge balance");
  await insert(db, paymentApplications, {
    payment_id: p.id, charge_id: c.id, amount, applied_on: today(), method, created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  c.amount_paid = _round(Number(c.amount_paid || 0) + amount);
  await patch(db, charges, c, { amount_paid: c.amount_paid, status: chargeStatus(c), updated_by_id: actor.id });
  await patch(db, payments, p, { unapplied_amount: _round(Number(p.unapplied_amount) - amount), updated_by_id: actor.id });
}

/** Oldest-first: charges by due date, then creation. */
async function autoApply(db: Db, p: Payment, actor: CurrentUser): Promise<number> {
  let applied = 0.0;
  const rows = await db
    .select()
    .from(charges)
    .where(and(
      eq(charges.lease_id, p.lease_id), isNull(charges.deleted_at), inArray(charges.status, ["open", "partial"]),
      gt(charges.amount, 0),
    ))
    .orderBy(asc(charges.due_on), asc(charges.created_at));
  for (const c of rows) {
    const remaining = Number(p.unapplied_amount);
    if (remaining <= CENT) break;
    const amt = Math.min(remaining, chargeBalance(c));
    if (amt > CENT) {
      await apply(db, p, c, amt, "auto", actor);
      applied += amt;
    }
  }
  return _round(applied);
}

async function applyAllocations(
  db: Db, p: Payment, allocations: { charge_id: string; amount: number }[], actor: CurrentUser,
): Promise<number> {
  let applied = 0.0;
  for (const a of allocations) {
    const c = await getRow(db, charges, a.charge_id, "Charge");
    await apply(db, p, c, a.amount, "manual", actor);
    applied += a.amount;
  }
  return _round(applied);
}

export async function recordPayment(db: Db, data: PaymentIn, actor: CurrentUser): Promise<Payment> {
  const lease = await getLease(db, data.lease_id);
  const p = await insert(db, payments, {
    lease_id: lease.id, property_id: lease.property_id, tenant_name: lease.tenant_name, received_on: data.received_on,
    amount: _round(data.amount), unapplied_amount: _round(data.amount), method: data.method,
    reference: data.reference, notes: data.notes, status: "received", created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  let applied: number;
  if (data.allocations.length) applied = await applyAllocations(db, p, data.allocations, actor);
  else if (data.auto_apply) applied = await autoApply(db, p, actor);
  else applied = 0.0;
  await audit.record(db, {
    actor, action: "payment.received", entity_type: "payment", entity_id: p.id,
    summary: `${lease.tenant_name}: ${money(p.amount)} (${p.method})`,
    changes: { lease_id: lease.id, amount: p.amount, applied, unapplied: p.unapplied_amount, reference: p.reference },
    ip_address: actor.ip_address,
  });
  await refreshCollection(db, lease, today());
  await events.emit(db, "receivables.payment_received", { payment_id: p.id, lease_id: lease.id, amount: p.amount, actor });
  await db.commit();
  return p;
}

export async function applyPayment(db: Db, p: Payment, data: ApplyIn, actor: CurrentUser): Promise<Payment> {
  if (p.status !== "received") throw new HttpError(409, "Reversed payments cannot be applied");
  if (Number(p.unapplied_amount) <= CENT) throw new HttpError(409, "Payment is fully applied");
  const applied = data.allocations.length
    ? await applyAllocations(db, p, data.allocations, actor)
    : await autoApply(db, p, actor);
  await audit.record(db, {
    actor, action: "payment.applied", entity_type: "payment", entity_id: p.id,
    changes: { applied, mode: data.allocations.length ? "manual" : "oldest_first", unapplied: p.unapplied_amount },
    ip_address: actor.ip_address,
  });
  await refreshCollection(db, await getLease(db, p.lease_id), today());
  await db.commit();
  return p;
}

async function unapplyOne(db: Db, p: Payment, app: PaymentApplication, reason: string, actor: CurrentUser): Promise<void> {
  const c = await getById(db, charges, app.charge_id);
  await patch(db, paymentApplications, app, {
    reversed_at: utcnow(), reversed_by_id: actor.id, reversal_reason: reason, updated_by_id: actor.id,
  });
  if (c) {
    c.amount_paid = _round(Number(c.amount_paid || 0) - Number(app.amount));
    await patch(db, charges, c, { amount_paid: c.amount_paid, status: chargeStatus(c), updated_by_id: actor.id });
  }
  await patch(db, payments, p, { unapplied_amount: _round(Number(p.unapplied_amount) + Number(app.amount)) });
}

export async function unapply(db: Db, p: Payment, data: UnapplyIn, actor: CurrentUser): Promise<Payment> {
  const app = await getById(db, paymentApplications, data.application_id);
  if (!app || app.payment_id !== p.id || app.reversed_at) throw new HttpError(404, "Active application not found");
  await unapplyOne(db, p, app, data.reason, actor);
  await audit.record(db, {
    actor, action: "payment.unapplied", entity_type: "payment", entity_id: p.id, summary: data.reason,
    changes: { charge_id: app.charge_id, amount: app.amount }, ip_address: actor.ip_address,
  });
  await refreshCollection(db, await getLease(db, p.lease_id), today());
  await db.commit();
  return p;
}

/** Reversal, never deletion: applications are reversed and the payment keeps its history. */
export async function reversePayment(db: Db, p: Payment, reason: string, actor: CurrentUser): Promise<Payment> {
  if (p.status === "reversed") throw new HttpError(409, "Payment is already reversed");
  const apps = await db
    .select()
    .from(paymentApplications)
    .where(and(eq(paymentApplications.payment_id, p.id), isNull(paymentApplications.reversed_at)));
  for (const app of apps) await unapplyOne(db, p, app, `Payment reversed: ${reason}`, actor);
  await patch(db, payments, p, {
    status: "reversed", reversed_at: utcnow(), reversed_by_id: actor.id, reversal_reason: reason, unapplied_amount: 0,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "payment.reversed", entity_type: "payment", entity_id: p.id, summary: reason,
    changes: { amount: p.amount, applications_reversed: apps.length }, ip_address: actor.ip_address,
  });
  await events.emit(db, "receivables.payment_reversed", { payment_id: p.id, lease_id: p.lease_id, actor });
  await refreshCollection(db, await getLease(db, p.lease_id), today());
  await db.commit();
  return p;
}

// --------------------------------------------------------------------------- balances, ledger, aging

/** Lease late-fee terms when the lease is verified and specifies them; otherwise the configured defaults. */
export function lateFeeTerms(lease: Lease, defaults: LateFeeDefaults) {
  const hasTerms = lease.verified
    && [lease.late_fee_grace_days, lease.late_fee_pct, lease.late_fee_flat].some((v) => v !== null && v !== undefined);
  if (hasTerms) {
    return {
      basis: "lease_terms",
      grace_days: lease.late_fee_grace_days !== null ? lease.late_fee_grace_days : defaults.grace_days,
      pct: lease.late_fee_pct, flat: lease.late_fee_flat,
    };
  }
  return { basis: "defaults", grace_days: defaults.grace_days, pct: defaults.pct, flat: defaults.flat };
}

async function unappliedByLease(db: Db, lease_ids: string[] | null = null): Promise<Map<string, number>> {
  const rows = await db
    .select({
      lease_id: payments.lease_id,
      total: sql<number>`coalesce(sum(${payments.unapplied_amount}), 0)`.mapWith(Number),
    })
    .from(payments)
    .where(and(
      isNull(payments.deleted_at), eq(payments.status, "received"),
      lease_ids !== null ? (lease_ids.length ? inArray(payments.lease_id, lease_ids) : sql`false`) : undefined,
    ))
    .groupBy(payments.lease_id);
  return new Map(rows.map((r) => [r.lease_id, Number(r.total)]));
}

export interface TenantOpts {
  property_id?: string;
  asset_id?: string;
  q?: string;
  collection_status?: string[];
  delinquent_only?: boolean;
  lease_id?: string;
}

/** Per-lease balance/aging statement. `query()` is the row SELECT; `count()` the unpaginated total. */
export function tenantsStatement(db: Db, as_of: string, o: TenantOpts = {}) {
  // bucket columns are SQL expressions: alias them so the subquery exposes named fields
  const aggSub = db
    .select({
      lease_id: charges.lease_id,
      current: bucketColumns(as_of).current.as("current"),
      d1_30: bucketColumns(as_of).d1_30.as("d1_30"),
      d31_60: bucketColumns(as_of).d31_60.as("d31_60"),
      d61_90: bucketColumns(as_of).d61_90.as("d61_90"),
      d90_plus: bucketColumns(as_of).d90_plus.as("d90_plus"),
      total: bucketColumns(as_of).total.as("total"),
    })
    .from(charges)
    .where(and(...openChargeFilter()))
    .groupBy(charges.lease_id)
    .as("agg");
  const unapp = db
    .select({
      lease_id: payments.lease_id,
      unapplied: sql<number>`coalesce(sum(${payments.unapplied_amount}), 0)`.mapWith(Number).as("unapplied"),
    })
    .from(payments)
    .where(and(isNull(payments.deleted_at), eq(payments.status, "received")))
    .groupBy(payments.lease_id)
    .as("unapp");

  const n = (c: SQL.Aliased<number> | any) => sql<number>`coalesce(${c}, 0)`.mapWith(Number);
  const pastDue = sql<number>`(${n(aggSub.d1_30)} + ${n(aggSub.d31_60)} + ${n(aggSub.d61_90)} + ${n(aggSub.d90_plus)})`;
  const balance = sql<number>`(${n(aggSub.total)} - ${n(unapp.unapplied)})`;
  const fields = {
    id: leases.id,
    tenant_name: leases.tenant_name,
    property_id: leases.property_id,
    lease_status: leases.status,
    property_name: sql<string | null>`coalesce(${properties.name}, ${properties.address_line})`,
    current: n(aggSub.current),
    d1_30: n(aggSub.d1_30),
    d31_60: n(aggSub.d31_60),
    d61_90: n(aggSub.d61_90),
    d90_plus: n(aggSub.d90_plus),
    total: n(aggSub.total),
    unapplied: n(unapp.unapplied),
    balance: balance.mapWith(Number),
    past_due: pastDue.mapWith(Number),
    collection_status: collectionStatuses.status,
    step_key: collectionStatuses.step_key,
    days_past_due: collectionStatuses.days_past_due,
  };
  const terms = (o.q ?? "").split(/\s+/).filter(Boolean);
  const where = and(
    isNull(leases.deleted_at),
    or(eq(leases.status, "active"), isNotNull(aggSub.lease_id), isNotNull(unapp.lease_id)),
    o.property_id ? eq(leases.property_id, o.property_id) : undefined,
    o.asset_id ? eq(leases.asset_id, o.asset_id) : undefined,
    o.lease_id ? eq(leases.id, o.lease_id) : undefined,
    ...terms.map((t) => or(sql`${leases.tenant_name} ilike ${`%${t}%`}`, sql`${properties.name} ilike ${`%${t}%`}`)),
    o.collection_status?.length
      ? inArray(sql`coalesce(${collectionStatuses.status}, 'current')`, o.collection_status)
      : undefined,
    o.delinquent_only ? sql`${pastDue} > ${CENT}` : undefined,
  );
  const query = () =>
    db
      .select(fields)
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.property_id))
      .leftJoin(aggSub, eq(aggSub.lease_id, leases.id))
      .leftJoin(unapp, eq(unapp.lease_id, leases.id))
      .leftJoin(collectionStatuses, eq(collectionStatuses.lease_id, leases.id))
      .where(where);
  const count = async (): Promise<number> => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.property_id))
      .leftJoin(aggSub, eq(aggSub.lease_id, leases.id))
      .leftJoin(unapp, eq(unapp.lease_id, leases.id))
      .leftJoin(collectionStatuses, eq(collectionStatuses.lease_id, leases.id))
      .where(where);
    return r?.n ?? 0;
  };
  const sorts = {
    tenant_name: leases.tenant_name, balance, past_due: pastDue, d90_plus: n(aggSub.d90_plus),
    property_name: properties.name,
  };
  return { query, count, sorts, balance, pastDue };
}

export async function tenantRows(db: Db, rows: Rec[]) {
  const ids = rows.map((r) => r.id);
  const plans = new Set<string>(
    ids.length
      ? (await db
        .select({ id: paymentPlans.lease_id })
        .from(paymentPlans)
        .where(and(inArray(paymentPlans.lease_id, ids), eq(paymentPlans.status, "active"), isNull(paymentPlans.deleted_at))))
        .map((r) => r.id)
      : [],
  );
  return rows.map((r) => ({
    id: r.id, lease_id: r.id, tenant_name: r.tenant_name, property_id: r.property_id, property_name: r.property_name,
    lease_status: r.lease_status, balance: _round(r.balance), past_due: _round(r.past_due), unapplied: _round(r.unapplied),
    buckets: buckets(r), collection_status: r.collection_status || "current", step_key: r.step_key ?? null,
    days_past_due: r.days_past_due || 0, has_plan: plans.has(r.id),
  }));
}

export async function tenantBalance(db: Db, lease_id: string, as_of: string) {
  const [row] = await tenantsStatement(db, as_of, { lease_id }).query().limit(1);
  if (!row) {
    const lease = await getLease(db, lease_id);
    return {
      id: lease.id, lease_id: lease.id, tenant_name: lease.tenant_name, property_id: lease.property_id,
      property_name: await propertyName(db, lease.property_id), lease_status: lease.status, balance: 0, past_due: 0,
      unapplied: 0, buckets: emptyBuckets(), collection_status: "current", step_key: null, days_past_due: 0,
      has_plan: false,
    };
  }
  return (await tenantRows(db, [row]))[0];
}

interface LedgerEntry {
  id: string;
  on: string;
  kind: "charge" | "payment" | "reversal" | "void";
  description: string;
  charge_type: string | null;
  debit: number;
  credit: number;
  balance: number;
  status: string | null;
  ref_id: string;
  source: string | null;
  source_ref: Rec;
}

const entry = (e: Partial<LedgerEntry> & Pick<LedgerEntry, "id" | "on" | "kind" | "description" | "ref_id">): LedgerEntry => ({
  charge_type: null, debit: 0, credit: 0, balance: 0, status: null, source: null, source_ref: {}, ...e,
});

export async function ledger(db: Db, lease_id: string, as_of: string | null = null) {
  const asOf = as_of || today();
  const lease = await getLease(db, lease_id);
  const chargeRows = await db
    .select()
    .from(charges)
    .where(and(eq(charges.lease_id, lease_id), isNull(charges.deleted_at)))
    .orderBy(asc(charges.due_on), asc(charges.created_at));
  const paymentRows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.lease_id, lease_id), isNull(payments.deleted_at)))
    .orderBy(asc(payments.received_on), asc(payments.created_at));
  const raw: [string, number, LedgerEntry][] = [];
  for (const c of chargeRows) {
    if (c.status === "pending_approval") continue;
    const amt = Number(c.amount);
    raw.push([c.due_on, 0, entry({
      id: `c:${c.id}`, on: c.due_on, kind: "charge", description: c.description || c.charge_type,
      charge_type: c.charge_type, debit: Math.max(amt, 0), credit: Math.max(-amt, 0), status: c.status, ref_id: c.id,
      source: c.source, source_ref: c.source_ref || {},
    })]);
    if (c.voided_at) {
      raw.push([dateOf(c.voided_at), 2, entry({
        id: `v:${c.id}`, on: dateOf(c.voided_at), kind: "void", description: `Void: ${c.void_reason || ""}`.trim(),
        charge_type: c.charge_type, debit: Math.max(-amt, 0), credit: Math.max(amt, 0), status: "void", ref_id: c.id,
      })]);
    }
  }
  for (const p of paymentRows) {
    raw.push([p.received_on, 1, entry({
      id: `p:${p.id}`, on: p.received_on, kind: "payment",
      description: `Payment (${p.method}${p.reference ? ", " + p.reference : ""})`, credit: Number(p.amount),
      status: p.status, ref_id: p.id,
    })]);
    if (p.reversed_at) {
      raw.push([dateOf(p.reversed_at), 2, entry({
        id: `r:${p.id}`, on: dateOf(p.reversed_at), kind: "reversal",
        description: `Payment reversed: ${p.reversal_reason || ""}`.trim(), debit: Number(p.amount),
        status: "reversed", ref_id: p.id,
      })]);
    }
  }
  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let running = 0.0;
  const entries: LedgerEntry[] = [];
  for (const [, , e] of raw) {
    running = _round(running + e.debit - e.credit);
    e.balance = running;
    entries.push(e);
  }
  const openCharges = chargeRows
    .filter((c) => ["open", "partial", "credit", "pending_approval"].includes(c.status))
    .map((c) => chargeOut(c, asOf));
  const settings = await getSettings(db);
  return {
    tenant: await tenantBalance(db, lease_id, asOf), entries, open_charges: openCharges,
    late_fee_terms: lateFeeTerms(lease, settings.late_fee_defaults),
  };
}

export async function dashboard(
  db: Db, o: { property_id?: string | null; asset_id?: string | null; as_of?: string | null },
) {
  const { property_id, asset_id } = o;
  const asOf = o.as_of || today();
  const scope: SQL[] = [...openChargeFilter()];
  const payScope: SQL[] = [isNull(payments.deleted_at), eq(payments.status, "received")];
  if (property_id) {
    scope.push(eq(charges.property_id, property_id));
    payScope.push(eq(payments.property_id, property_id));
  }
  if (asset_id) {
    scope.push(eq(charges.asset_id, asset_id));
    payScope.push(inArray(payments.property_id, db.select({ id: charges.property_id }).from(charges).where(eq(charges.asset_id, asset_id))));
  }
  const [totals] = await db.select(bucketColumns(asOf)).from(charges).where(and(...scope));
  const [unappRow] = await db
    .select({ v: sql<number>`coalesce(sum(${payments.unapplied_amount}), 0)`.mapWith(Number) })
    .from(payments)
    .where(and(...payScope));
  const unapplied = Number(unappRow?.v ?? 0);

  const byPropRows = await db
    .select({
      property_id: charges.property_id,
      name: sql<string>`coalesce(${properties.name}, ${properties.address_line})`,
      tenants: sql<number>`count(distinct ${charges.lease_id})::int`,
      ...bucketColumns(asOf),
    })
    .from(charges)
    .innerJoin(properties, eq(properties.id, charges.property_id))
    .where(and(...scope))
    .groupBy(charges.property_id, properties.name, properties.address_line);
  const by_property = byPropRows
    .map((r) => ({
      id: String(r.property_id), label: r.name, property_id: r.property_id, lease_id: null, buckets: buckets(r),
      unapplied: 0, tenants: r.tenants,
    }))
    .sort((a, b) => b.buckets.total - a.buckets.total);

  const st = tenantsStatement(db, asOf, { property_id: property_id ?? undefined, asset_id: asset_id ?? undefined, delinquent_only: true });
  const tRows = await st.query().orderBy(sql`${st.pastDue} desc`);
  const delinquent = tRows.length;
  const by_tenant = tRows.slice(0, 15).map((r) => ({
    id: String(r.id), label: r.tenant_name, property_id: r.property_id, lease_id: r.id, buckets: buckets(r),
    unapplied: _round(r.unapplied), tenants: 0,
  }));

  const m0 = `${asOf.slice(0, 7)}-01`;
  const [billedRow] = await db
    .select({ v: sql<number>`coalesce(sum(${charges.amount}), 0)`.mapWith(Number) })
    .from(charges)
    .where(and(
      isNull(charges.deleted_at), notInArray(charges.status, ["void", "pending_approval"]), gt(charges.amount, 0),
      gte(charges.due_on, m0), lte(charges.due_on, asOf),
      property_id ? eq(charges.property_id, property_id) : undefined,
      asset_id ? eq(charges.asset_id, asset_id) : undefined,
    ));
  const billed = Number(billedRow?.v ?? 0);
  const [collRow] = await db
    .select({ v: sql<number>`coalesce(sum(${payments.amount}), 0)`.mapWith(Number) })
    .from(payments)
    .where(and(...payScope, gte(payments.received_on, m0), lte(payments.received_on, asOf)));
  const collected = Number(collRow?.v ?? 0);
  return {
    as_of: asOf, totals: buckets(totals), unapplied: _round(unapplied), delinquent_tenants: delinquent,
    billed_this_month: _round(billed), collected_this_month: _round(collected),
    collection_rate: billed ? pyRound((collected / billed) * 100, 1) : null, by_property, by_tenant,
  };
}

// --------------------------------------------------------------------------- late fees

async function _assessLateFees(db: Db, as_of: string, property_id: string | null | undefined, actor: CurrentUser): Promise<number> {
  const defaults = (await getSettings(db)).late_fee_defaults;
  if (!defaults.charge_types.length) return 0;
  const rows = await db
    .select()
    .from(charges)
    .where(and(
      ...openChargeFilter(), inArray(charges.status, ["open", "partial"]), gt(charges.amount, 0),
      inArray(charges.charge_type, defaults.charge_types), lt(charges.due_on, as_of),
      property_id ? eq(charges.property_id, property_id) : undefined,
    ));
  const cache = new Map<string, Lease>();
  let created = 0;
  for (const c of rows) {
    let lease = cache.get(c.lease_id) ?? (await getById(db, leases, c.lease_id));
    if (!lease || lease.deleted_at) continue;
    cache.set(c.lease_id, lease);
    const terms = lateFeeTerms(lease, defaults);
    if (diffDays(as_of, c.due_on) <= (terms.grace_days || 0)) continue;
    const key = `late:${c.id}`;
    const [dupe] = await db.select({ id: charges.id }).from(charges).where(eq(charges.idempotency_key, key)).limit(1);
    if (dupe) continue;
    const balance = chargeBalance(c);
    const fee = (balance * (terms.pct || 0)) / 100 + Number(terms.flat || 0);
    if (fee <= CENT) continue;
    lease = lease as Lease;
    await insert(db, charges, newCharge(lease, {
      charge_type: "late_fee", amount: fee, due_on: as_of, source: "late_fee",
      source_ref: { ...terms, charge_id: c.id, charge_due_on: c.due_on, balance_at_assessment: balance },
      description: `Late fee on ${c.description || c.charge_type}`, period_start: c.period_start,
      period_end: c.period_end, idempotency_key: key, actor,
    }) as never);
    created += 1;
  }
  if (created) {
    await audit.record(db, {
      actor, action: "receivables.late_fees_assessed", entity_type: ENTITY, summary: `${created} late fees as of ${as_of}`,
      ip_address: actor.ip_address,
    });
  }
  return created;
}

export async function assessLateFees(
  db: Db, as_of: string | null | undefined, property_id: string | null | undefined, actor: CurrentUser,
): Promise<number> {
  const n = await _assessLateFees(db, as_of || today(), property_id, actor);
  await db.commit();
  return n;
}

// --------------------------------------------------------------------------- delinquency ladder & notices

/** Python `str.format_map` with missing keys left as `{key}`; malformed templates are returned unchanged. */
export function render(template: string, ctx: Rec): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i++;
        continue;
      }
      const end = template.indexOf("}", i + 1);
      if (end === -1) return template;
      const field = template.slice(i + 1, end);
      const name = field.split(/[:!]/, 1)[0];
      if (name === "" || /^\d+$/.test(name)) return template;
      out += name in ctx ? String(ctx[name]) : `{${name}}`;
      i = end;
    } else if (ch === "}") {
      if (template[i + 1] === "}") {
        out += "}";
        i++;
        continue;
      }
      return template;
    } else out += ch;
  }
  return out;
}

async function collection(db: Db, lease_id: string, actor: { id?: string | null } | null): Promise<CollectionStatus> {
  const [existing] = await db.select().from(collectionStatuses).where(eq(collectionStatuses.lease_id, lease_id)).limit(1);
  if (existing) return existing;
  return insert(db, collectionStatuses, {
    lease_id, status: "current", step_index: 0, past_due_balance: 0, days_past_due: 0, on_hold: false,
    created_by_id: actor?.id ?? null,
  });
}

async function pastDueFor(db: Db, lease_id: string, as_of: string): Promise<[number, string | null]> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${charges.amount} - ${charges.amount_paid}), 0)`.mapWith(Number),
      oldest: sql<string | null>`min(${charges.due_on})`,
    })
    .from(charges)
    .where(and(
      eq(charges.lease_id, lease_id), isNull(charges.deleted_at), inArray(charges.status, ["open", "partial"]),
      gt(charges.amount, 0), lt(charges.due_on, as_of),
    ));
  const unapplied = (await unappliedByLease(db, [lease_id])).get(lease_id) ?? 0.0;
  const [cr] = await db
    .select({ v: sql<number>`coalesce(sum(${charges.amount}), 0)`.mapWith(Number) })
    .from(charges)
    .where(and(eq(charges.lease_id, lease_id), isNull(charges.deleted_at), eq(charges.status, "credit")));
  const credits = Number(cr?.v ?? 0);
  return [_round(Number(row.total) - unapplied + credits), row.oldest ?? null];
}

/** After payment activity: clear the ladder if the tenant is no longer past due. Never escalates. */
async function refreshCollection(db: Db, lease: Lease, as_of: string): Promise<void> {
  const [cs] = await db.select().from(collectionStatuses).where(eq(collectionStatuses.lease_id, lease.id)).limit(1);
  if (!cs) return;
  const [past_due, oldest] = await pastDueFor(db, lease.id, as_of);
  cs.past_due_balance = Math.max(past_due, 0);
  cs.oldest_due_on = past_due > CENT ? oldest : null;
  cs.days_past_due = oldest && past_due > CENT ? diffDays(as_of, oldest) : 0;
  if (past_due <= CENT && cs.status !== "current") {
    cs.status = "current";
    cs.step_index = 0;
    cs.step_key = null;
  }
  await save(db, collectionStatuses, cs);
}

async function createNoticeRow(
  db: Db, lease: Lease, step: LadderStep, index: number, balance: number, days: number, as_of: string,
  actor: { id?: string | null } | null, key: string | null,
): Promise<DelinquencyNotice> {
  if (key) {
    const [existing] = await db.select().from(delinquencyNotices).where(eq(delinquencyNotices.idempotency_key, key)).limit(1);
    if (existing) return existing;
  }
  const ctx = {
    tenant_name: lease.tenant_name, property_name: (await propertyName(db, lease.property_id)) || "",
    balance: `$${money(balance)}`, days_past_due: days, as_of: longDate(as_of), cure_by: longDate(addDays(as_of, 10)),
    step: step.label,
  };
  return insert(db, delinquencyNotices, {
    lease_id: lease.id, property_id: lease.property_id, step_key: step.key, step_index: index, label: step.label,
    balance: _round(balance), days_past_due: days, subject: render(step.subject, ctx).slice(0, 300),
    body: render(step.body, ctx), status: "draft", idempotency_key: key, created_by_id: actor?.id ?? null,
  });
}

/** Recompute installment status; returns true when the plan is newly breached. */
async function evaluatePlan(db: Db, plan: PaymentPlan, as_of: string, actor: CurrentUser): Promise<boolean> {
  const [paidRow] = await db
    .select({ v: sql<number>`coalesce(sum(${payments.amount}), 0)`.mapWith(Number) })
    .from(payments)
    .where(and(
      eq(payments.lease_id, plan.lease_id), isNull(payments.deleted_at), eq(payments.status, "received"),
      gte(payments.received_on, dateOf(plan.created_at)),
    ));
  const paidSince = Number(paidRow?.v ?? 0);
  // Ongoing obligations are satisfied first; only the excess counts toward the plan.
  const [newRow] = await db
    .select({ v: sql<number>`coalesce(sum(${charges.amount}), 0)`.mapWith(Number) })
    .from(charges)
    .where(and(
      eq(charges.lease_id, plan.lease_id), isNull(charges.deleted_at), gt(charges.amount, 0),
      notInArray(charges.status, ["void", "pending_approval"]), gte(charges.due_on, plan.start_on),
      lte(charges.due_on, as_of),
    ));
  let remaining = Math.max(0.0, paidSince - Number(newRow?.v ?? 0));
  const planPatch: Rec = { paid_amount: _round(Math.min(remaining, Number(plan.total_amount))) };
  let breach = false;
  const insts = await db
    .select()
    .from(paymentPlanInstallments)
    .where(and(eq(paymentPlanInstallments.plan_id, plan.id), isNull(paymentPlanInstallments.deleted_at)))
    .orderBy(asc(paymentPlanInstallments.sequence));
  for (const i of insts) {
    const paid = Math.min(Number(i.amount), remaining);
    remaining -= paid;
    let status: string;
    if (paid >= Number(i.amount) - CENT) status = "paid";
    else if (addDays(i.due_on, plan.grace_days) < as_of) {
      status = "missed";
      breach = true;
    } else status = paid > CENT ? "partial" : "scheduled";
    await patch(db, paymentPlanInstallments, i, { paid_amount: _round(paid), status });
  }
  if (insts.length && insts.every((i) => i.status === "paid") && plan.status === "active") planPatch.status = "completed";
  const status = planPatch.status ?? plan.status;
  if (breach && status === "active") {
    planPatch.status = "breached";
    planPatch.breached_at = utcnow();
    await patch(db, paymentPlans, plan, planPatch);
    const lease = await getLease(db, plan.lease_id);
    await taskService.raiseAlert(db, {
      title: `Payment plan breached: ${lease.tenant_name}`,
      reason: `An installment is more than ${plan.grace_days} days past due.`, severity: "high",
      owner_id: lease.manager_id, related_type: "lease", related_id: lease.id, related_label: lease.tenant_name,
      rule_key: "receivables.plan_breach", idempotency_key: `receivables:plan_breach:${plan.id}`,
    });
    await audit.record(db, {
      actor, action: "payment_plan.breached", entity_type: "payment_plan", entity_id: plan.id, summary: lease.tenant_name,
    });
    await events.emit(db, "receivables.payment_plan_breached", { plan_id: plan.id, lease_id: plan.lease_id, actor });
    return true;
  }
  await patch(db, paymentPlans, plan, planPatch);
  return false;
}

/** Aging drives automations: late fees, ladder escalation (notices + tasks), plan breaches, aging alerts. */
export async function evaluate(db: Db, data: EvaluateIn, actor: CurrentUser): Promise<EvaluateOut> {
  const asOf = data.as_of || today();
  const settings = await getSettings(db);
  const ladder = [...settings.ladder].sort((a, b) => a.days_past_due - b.days_past_due);
  const late = await _assessLateFees(db, asOf, data.property_id, actor);

  const plans = await db
    .select()
    .from(paymentPlans)
    .where(and(
      eq(paymentPlans.status, "active"), isNull(paymentPlans.deleted_at),
      data.property_id ? eq(paymentPlans.property_id, data.property_id) : undefined,
    ));
  let breached = 0;
  for (const plan of plans) {
    if (await evaluatePlan(db, plan, asOf, actor)) {
      breached += 1;
      const cs = await collection(db, plan.lease_id, actor);
      await patch(db, collectionStatuses, cs, { on_hold: false });
    }
  }

  const idRows = await db
    .selectDistinct({ id: charges.lease_id })
    .from(charges)
    .where(and(...openChargeFilter(), data.property_id ? eq(charges.property_id, data.property_id) : undefined));
  const csRows = await db
    .select({ id: collectionStatuses.lease_id })
    .from(collectionStatuses)
    .where(ne(collectionStatuses.status, "current"));
  const leaseIds = new Set<string>([...idRows.map((r) => r.id), ...csRows.map((r) => r.id)]);
  let evaluated = 0;
  let escalated = 0;
  let resolved = 0;
  let notices = 0;
  for (const lease_id of leaseIds) {
    const lease = await getById(db, leases, lease_id);
    if (!lease || lease.deleted_at || (data.property_id && lease.property_id !== data.property_id)) continue;
    evaluated += 1;
    const cs = await collection(db, lease.id, actor);
    const [past_due, oldest] = await pastDueFor(db, lease.id, asOf);
    const days = oldest && past_due > CENT ? diffDays(asOf, oldest) : 0;
    cs.past_due_balance = Math.max(past_due, 0);
    cs.days_past_due = days;
    cs.oldest_due_on = past_due > CENT ? oldest : null;
    cs.last_evaluated_at = utcnow();
    cs.updated_by_id = actor.id;
    if (past_due <= CENT) {
      if (cs.status !== "current") {
        resolved += 1;
        await audit.record(db, {
          actor, action: "collection.resolved", entity_type: "lease", entity_id: lease.id, summary: lease.tenant_name,
          ip_address: actor.ip_address,
        });
      }
      cs.status = "current";
      cs.step_index = 0;
      cs.step_key = null;
      cs.on_hold = false;
      await save(db, collectionStatuses, cs);
      continue;
    }
    const [activePlan] = await db
      .select({ id: paymentPlans.id })
      .from(paymentPlans)
      .where(and(eq(paymentPlans.lease_id, lease.id), eq(paymentPlans.status, "active"), isNull(paymentPlans.deleted_at)))
      .limit(1);
    if (activePlan) {
      cs.status = "payment_plan";
      cs.on_hold = true;
      await save(db, collectionStatuses, cs);
      continue;
    }
    cs.on_hold = false;
    let target = 0;
    ladder.forEach((step, i) => {
      if (days >= step.days_past_due && past_due >= step.min_balance) target = i + 1;
    });
    if (target > cs.step_index) {
      const step = ladder[target - 1];
      const n = await createNoticeRow(db, lease, step, target, past_due, days, asOf, actor,
        `ladder:${lease.id}:${step.key}:${oldest ?? ""}`);
      notices += 1;
      if (step.create_task) {
        const task = await taskService.createTask(db, {
          title: `${step.label}: ${lease.tenant_name}`, assignee_id: lease.manager_id,
          due_at: new Date(utcnow().getTime() + 2 * 86_400_000), task_type: "follow_up", priority: step.task_priority,
          description: `${days} days past due, balance $${money(past_due)}. Review and send the drafted notice.`,
          related_type: "lease", related_id: lease.id, related_label: lease.tenant_name, source: "receivables",
          idempotency_key: `receivables:${lease.id}:${step.key}:${oldest ?? ""}`, actor_id: actor.id,
        });
        await patch(db, delinquencyNotices, n, { task_id: task.id });
      }
      await audit.record(db, {
        actor, action: "collection.escalated", entity_type: "lease", entity_id: lease.id,
        summary: `${step.label} (${days} days, $${money(past_due)})`,
        changes: { step: { from: cs.step_key, to: step.key } }, ip_address: actor.ip_address,
      });
      cs.step_index = target;
      cs.step_key = step.key;
      cs.status = step.collection_status;
      escalated += 1;
      await events.emit(db, "receivables.delinquency_escalated", {
        lease_id: lease.id, step_key: step.key, notice_id: n.id, actor,
      });
    } else if (cs.step_index === 0) {
      cs.status = "delinquent";
    }
    await save(db, collectionStatuses, cs);
    if (days >= settings.alert_days) {
      await taskService.raiseAlert(db, {
        title: `${lease.tenant_name} is ${days} days past due`,
        reason: `Past-due balance $${money(past_due)} exceeds the ${settings.alert_days}-day aging threshold.`,
        severity: "high", owner_id: lease.manager_id, related_type: "lease", related_id: lease.id,
        related_label: lease.tenant_name, rule_key: "receivables.aging",
        idempotency_key: `receivables:aging:${lease.id}:${oldest ?? ""}`,
      });
    }
  }
  await db.commit();
  return { evaluated, escalated, resolved, notices, breached_plans: breached, late_fees: late };
}

export async function createNotice(db: Db, lease_id: string, step_key: string, actor: CurrentUser) {
  const lease = await getLease(db, lease_id);
  const settings = await getSettings(db);
  const steps = [...settings.ladder].sort((a, b) => a.days_past_due - b.days_past_due);
  const idx = steps.findIndex((s) => s.key === step_key);
  if (idx === -1) throw new HttpError(422, "Unknown ladder step");
  const index = idx + 1;
  const step = steps[idx];
  const asOf = today();
  const [past_due, oldest] = await pastDueFor(db, lease.id, asOf);
  const days = oldest && past_due > CENT ? diffDays(asOf, oldest) : 0;
  const n = await createNoticeRow(db, lease, step, index, Math.max(past_due, 0), days, asOf, actor, null);
  await audit.record(db, {
    actor, action: "notice.drafted", entity_type: "lease", entity_id: lease.id, summary: n.subject,
    changes: { notice_id: n.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return n;
}

export async function sendNotice(db: Db, n: DelinquencyNotice, method: string, actor: CurrentUser) {
  if (n.status !== "draft") throw new HttpError(409, `Notice is already ${n.status}`);
  await patch(db, delinquencyNotices, n, {
    status: "sent", sent_at: utcnow(), sent_by_id: actor.id, delivery_method: method, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "notice.sent", entity_type: "lease", entity_id: n.lease_id, summary: n.subject,
    changes: { notice_id: n.id, delivery_method: method }, ip_address: actor.ip_address,
  });
  await db.commit();
  return n;
}

export async function cancelNotice(db: Db, n: DelinquencyNotice, actor: CurrentUser) {
  if (n.status !== "draft") throw new HttpError(409, "Only draft notices can be cancelled");
  await patch(db, delinquencyNotices, n, { status: "cancelled", updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "notice.cancelled", entity_type: "lease", entity_id: n.lease_id, summary: n.subject,
    changes: { notice_id: n.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return n;
}

export const NOTICE_KEYS = [
  "id", "lease_id", "property_id", "step_key", "step_index", "label", "balance", "days_past_due", "subject", "body",
  "status", "delivery_method", "sent_at", "sent_by_id", "task_id", "created_at",
] as const;
export const noticeOut = (n: DelinquencyNotice, tenant_name: string | null = null) => {
  const r = n as Rec;
  const { id, lease_id, property_id, ...rest } = Object.fromEntries(NOTICE_KEYS.map((k) => [k, r[k]]));
  return { id, lease_id, property_id, tenant_name, ...rest };
};

// --------------------------------------------------------------------------- payment plans

export async function createPlan(db: Db, data: PlanIn, actor: CurrentUser): Promise<PaymentPlan> {
  const lease = await getLease(db, data.lease_id);
  const [active] = await db
    .select({ id: paymentPlans.id })
    .from(paymentPlans)
    .where(and(eq(paymentPlans.lease_id, lease.id), eq(paymentPlans.status, "active"), isNull(paymentPlans.deleted_at)))
    .limit(1);
  if (active) throw new HttpError(409, "This tenant already has an active payment plan");
  let total: number | null | undefined = data.total_amount;
  if (total === null || total === undefined) [total] = await pastDueFor(db, lease.id, data.start_on);
  if (total <= CENT) throw new HttpError(422, "Nothing is past due to put on a plan");
  const plan = await insert(db, paymentPlans, {
    lease_id: lease.id, property_id: lease.property_id, total_amount: _round(total), start_on: data.start_on,
    installment_count: data.installment_count, frequency_months: data.frequency_months, grace_days: data.grace_days,
    status: "active", paid_amount: 0, approved_by_id: actor.id, notes: data.notes, created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  const each = _round(total / data.installment_count);
  for (let i = 0; i < data.installment_count; i++) {
    const amount = i < data.installment_count - 1 ? each : _round(total - each * (data.installment_count - 1));
    await insert(db, paymentPlanInstallments, {
      plan_id: plan.id, sequence: i + 1, due_on: addMonths(data.start_on, i * data.frequency_months), amount,
      paid_amount: 0, status: "scheduled", created_by_id: actor.id,
    });
  }
  const cs = await collection(db, lease.id, actor);
  await patch(db, collectionStatuses, cs, { status: "payment_plan", on_hold: true });
  await audit.record(db, {
    actor, action: "payment_plan.created", entity_type: "payment_plan", entity_id: plan.id,
    summary: `${lease.tenant_name}: ${money(plan.total_amount)} over ${data.installment_count}`,
    changes: { lease_id: lease.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return plan;
}

export async function cancelPlan(db: Db, plan: PaymentPlan, actor: CurrentUser): Promise<PaymentPlan> {
  if (plan.status !== "active") throw new HttpError(409, "Only active plans can be cancelled");
  await patch(db, paymentPlans, plan, { status: "cancelled", updated_by_id: actor.id });
  const cs = await collection(db, plan.lease_id, actor);
  await patch(db, collectionStatuses, cs, { on_hold: false, ...(cs.status === "payment_plan" ? { status: "delinquent" } : {}) });
  await audit.record(db, {
    actor, action: "payment_plan.cancelled", entity_type: "payment_plan", entity_id: plan.id, ip_address: actor.ip_address,
  });
  await db.commit();
  return plan;
}

export async function planOut(db: Db, plan: PaymentPlan) {
  const lease = await getLease(db, plan.lease_id);
  const insts = await db
    .select()
    .from(paymentPlanInstallments)
    .where(and(eq(paymentPlanInstallments.plan_id, plan.id), isNull(paymentPlanInstallments.deleted_at)))
    .orderBy(asc(paymentPlanInstallments.sequence));
  const r = plan as Rec;
  return {
    ...Object.fromEntries(
      ["id", "lease_id", "property_id"].map((k) => [k, r[k]]),
    ),
    tenant_name: lease.tenant_name,
    ...Object.fromEntries(
      ["total_amount", "start_on", "installment_count", "frequency_months", "grace_days", "status", "paid_amount",
        "breached_at", "notes", "created_at"].map((k) => [k, r[k]]),
    ),
    installments: insts.map((i) => Object.fromEntries(
      ["id", "sequence", "due_on", "amount", "paid_amount", "status"].map((k) => [k, (i as Rec)[k]]),
    )),
  };
}

// --------------------------------------------------------------------------- recovery reconciliation billing

export async function billReconciliations(db: Db, data: ReconBillIn, actor: CurrentUser): Promise<ReconBillOut> {
  let billed = 0;
  let skipped = 0;
  let total = 0.0;
  for (const rid of new Set(data.reconciliation_ids)) {
    const rec = await getById(db, recoveryReconciliations, rid);
    if (!rec || rec.deleted_at || rec.status !== "final") {
      skipped += 1;
      continue;
    }
    const lease = await getById(db, leases, rec.lease_id);
    if (!lease || lease.deleted_at) {
      skipped += 1;
      continue;
    }
    const amount = Number(rec.true_up_amount || 0);
    const key = `recon:${rec.id}`;
    let exists = false;
    if (Math.abs(amount) > CENT) {
      const [dupe] = await db.select({ id: charges.id }).from(charges).where(eq(charges.idempotency_key, key)).limit(1);
      exists = Boolean(dupe);
    }
    if (Math.abs(amount) <= CENT || exists) {
      skipped += 1;
      continue;
    }
    const values = newCharge(lease, {
      charge_type: "recovery_true_up", amount, due_on: data.due_on, source: "reconciliation",
      period_start: ymd(rec.year, 1, 1), period_end: ymd(rec.year, 12, 31),
      description: `${rec.year} recovery reconciliation ${amount > 0 ? "true-up" : "credit"}`,
      source_ref: {
        reconciliation_id: rec.id, year: rec.year, actual_share: rec.actual_share,
        estimates_billed: rec.estimates_billed, cap_reduction: rec.cap_reduction,
      },
      idempotency_key: key, actor,
    });
    values.approved_by_id = rec.finalized_by_id;
    values.approved_at = rec.finalized_at;
    const c = await insert(db, charges, values as never);
    await leaseService.markReconciliationBilled(db, rec, c.id, actor);
    await audit.record(db, {
      actor, action: "charge.reconciliation_billed", entity_type: "charge", entity_id: c.id,
      summary: `${lease.tenant_name} ${rec.year}: ${money(amount)}`, changes: { reconciliation_id: rec.id },
      ip_address: actor.ip_address,
    });
    billed += 1;
    total += amount;
  }
  await db.commit();
  return { billed, skipped, amount: _round(total) };
}

// --------------------------------------------------------------------------- accounting / banking sync

export const BATCH_KEYS = [
  "id", "direction", "system", "status", "period_from", "period_to", "property_id", "entry_count", "matched_count",
  "conflict_count", "external_batch_id", "summary", "created_at",
] as const;
export const batchOut = (b: SyncBatch) => Object.fromEntries(BATCH_KEYS.map((k) => [k, (b as Rec)[k]]));
export const batchDetail = (b: SyncBatch) => ({ ...batchOut(b), payload: b.payload ?? [] });

export const CONFLICT_KEYS = [
  "id", "batch_id", "entity_type", "entity_id", "external_id", "field", "local_value", "external_value", "status",
  "resolved_by_id", "resolved_at", "resolution_note", "created_at",
] as const;
export const conflictOut = (c: SyncConflict) => Object.fromEntries(CONFLICT_KEYS.map((k) => [k, (c as Rec)[k]]));

export async function exportBatch(db: Db, data: ExportIn, actor: CurrentUser): Promise<SyncBatch> {
  if (data.period_to < data.period_from) throw new HttpError(422, "Period end is before start");
  const cRows = await db
    .select()
    .from(charges)
    .where(and(
      isNull(charges.deleted_at), ne(charges.status, "pending_approval"),
      gte(charges.due_on, data.period_from), lte(charges.due_on, data.period_to),
      data.property_id ? eq(charges.property_id, data.property_id) : undefined,
    ))
    .orderBy(asc(charges.due_on));
  const pRows = await db
    .select()
    .from(payments)
    .where(and(
      isNull(payments.deleted_at), gte(payments.received_on, data.period_from), lte(payments.received_on, data.period_to),
      data.property_id ? eq(payments.property_id, data.property_id) : undefined,
    ))
    .orderBy(asc(payments.received_on));
  const entries: Rec[] = [];
  for (const c of cRows) {
    entries.push({
      kind: "charge", local_id: c.id, lease_id: c.lease_id, tenant_name: c.tenant_name, charge_type: c.charge_type,
      entry_date: c.due_on, amount: c.amount, status: c.status, external_ref: c.external_ref, source: c.source,
    });
  }
  for (const p of pRows) {
    entries.push({
      kind: "payment", local_id: p.id, lease_id: p.lease_id, tenant_name: p.tenant_name, entry_date: p.received_on,
      amount: p.amount, status: p.status, method: p.method, reference: p.reference, external_ref: p.external_ref,
    });
  }
  const b = await insert(db, syncBatches, {
    direction: "export", system: data.system, status: "completed", period_from: data.period_from,
    period_to: data.period_to, property_id: data.property_id, entry_count: entries.length,
    payload: audit.toJsonable(entries), summary: `${entries.length} ledger entries exported`,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "sync.exported", entity_type: "sync_batch", entity_id: b.id,
    summary: `${data.system}: ${entries.length} entries`, ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

/** JSONB value for a nullable Python-side value: JSON `null` rather than SQL NULL (SQLAlchemy's default). */
const jsonValue = (v: unknown): any => (v === null || v === undefined ? sql`'null'::jsonb` : audit.toJsonable(v));

const localDate = (row: Rec, kind: string): string => (kind === "charge" ? row.due_on : row.received_on);

/** Match external entries to our records. Disagreements become conflicts; nothing is overwritten. */
export async function importBatch(db: Db, data: ImportIn, actor: CurrentUser): Promise<SyncBatch> {
  const dump = (e: Rec) => Object.fromEntries(
    ["external_id", "kind", "local_id", "lease_id", "amount", "entry_date", "status", "reference"].map((k) => [k, e[k] ?? null]),
  );
  const b = await insert(db, syncBatches, {
    direction: "import", system: data.system, status: "pending", external_batch_id: data.external_batch_id,
    entry_count: data.entries.length, payload: data.entries.map(dump), created_by_id: actor.id, updated_by_id: actor.id,
  });
  let matched = 0;
  let conflicts = 0;

  const conflict = async (kind: string, row_id: string | null, ext_id: string, field: string, local: unknown, external: unknown) => {
    await insert(db, syncConflicts, {
      batch_id: b.id, entity_type: kind, entity_id: row_id, external_id: ext_id, field,
      local_value: jsonValue(local), external_value: jsonValue(external), status: "open", created_by_id: actor.id,
    } as never);
  };

  for (const e of data.entries) {
    const table: any = e.kind === "charge" ? charges : payments;
    let row: Rec | undefined = e.local_id ? await getById(db, table, e.local_id) : undefined;
    if (!row) {
      [row] = await db
        .select()
        .from(table)
        .where(and(eq(table.external_ref, e.external_id), isNull(table.deleted_at)))
        .limit(1) as Rec[];
    }
    if (!row || row.deleted_at) {
      await conflict(e.kind, null, e.external_id, "unmatched", null, dump(e));
      conflicts += 1;
      continue;
    }
    const diffs: [string, unknown, unknown][] = [];
    if (row.external_ref && row.external_ref !== e.external_id) diffs.push(["external_ref", row.external_ref, e.external_id]);
    if (e.amount !== null && e.amount !== undefined && Math.abs(Number(row.amount) - e.amount) > CENT) {
      diffs.push(["amount", Number(row.amount), e.amount]);
    }
    if (e.entry_date && e.entry_date !== localDate(row, e.kind)) diffs.push(["date", localDate(row, e.kind), e.entry_date]);
    if (e.status && e.status !== row.status) diffs.push(["status", row.status, e.status]);
    if (diffs.length) {
      for (const [field, local, external] of diffs) await conflict(e.kind, row.id, e.external_id, field, local, external);
      conflicts += 1;
    } else {
      matched += 1;
      await patch(db, table, row as never, {
        ...(row.external_ref ? {} : { external_ref: e.external_id }), synced_at: utcnow(),
      } as never);
    }
  }
  const summary = `${matched} matched, ${conflicts} entries need review`;
  await patch(db, syncBatches, b, {
    matched_count: matched, conflict_count: conflicts, status: conflicts ? "completed_with_conflicts" : "completed",
    summary,
  });
  await audit.record(db, {
    actor, action: "sync.imported", entity_type: "sync_batch", entity_id: b.id, summary: `${data.system}: ${summary}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

export async function resolveConflict(db: Db, cf: SyncConflict, data: ResolveIn, actor: CurrentUser): Promise<SyncConflict> {
  if (cf.status !== "open") throw new HttpError(409, "Conflict is already resolved");
  const changes: Rec = {};
  if (data.resolution === "accept_external") {
    if (cf.field === "unmatched" || !cf.entity_id) {
      throw new HttpError(422, "Unmatched external entries must be entered manually (as an approved charge or payment)");
    }
    const ext = cf.external_value;
    if (cf.entity_type === "charge") {
      const c: Charge = await getRow(db, charges, cf.entity_id, "Charge");
      const set: Rec = {};
      if (cf.field === "amount") {
        if (Number(ext) < Number(c.amount_paid || 0) - CENT) {
          throw new HttpError(409, "External amount is below what has been applied");
        }
        changes.amount = { from: c.amount, to: Number(ext) };
        c.amount = _round(Number(ext));
        set.amount = c.amount;
        set.status = chargeStatus(c);
      } else if (cf.field === "date") {
        changes.due_on = { from: c.due_on, to: ext };
        set.due_on = String(ext).slice(0, 10);
      } else if (cf.field === "status" && ext === "void") {
        await voidCharge(db, c, `Accepted from accounting sync (${cf.external_id})`, actor);
        changes.status = { from: cf.local_value, to: "void" };
      } else if (cf.field === "external_ref") {
        changes.external_ref = { from: c.external_ref, to: ext };
        set.external_ref = String(ext);
      } else {
        throw new HttpError(422, "This difference must be corrected manually");
      }
      await patch(db, charges, c, { ...set, updated_by_id: actor.id });
    } else {
      const p: Payment = await getRow(db, payments, cf.entity_id, "Payment");
      const set: Rec = {};
      if (cf.field === "amount") {
        const applied = Number(p.amount) - Number(p.unapplied_amount);
        if (Number(ext) < applied - CENT) throw new HttpError(409, "Unapply allocations before reducing the payment");
        changes.amount = { from: p.amount, to: Number(ext) };
        set.amount = _round(Number(ext));
        set.unapplied_amount = _round(Number(ext) - applied);
      } else if (cf.field === "date") {
        changes.received_on = { from: p.received_on, to: ext };
        set.received_on = String(ext).slice(0, 10);
      } else if (cf.field === "status" && ext === "reversed") {
        await reversePayment(db, p, `Accepted from accounting sync (${cf.external_id})`, actor);
        changes.status = { from: cf.local_value, to: "reversed" };
      } else if (cf.field === "external_ref") {
        changes.external_ref = { from: p.external_ref, to: ext };
        set.external_ref = String(ext);
      } else {
        throw new HttpError(422, "This difference must be corrected manually");
      }
      await patch(db, payments, p, { ...set, updated_by_id: actor.id });
    }
    if (Object.keys(changes).length) {
      await audit.record(db, {
        actor, action: `${cf.entity_type}.sync_accepted`, entity_type: cf.entity_type, entity_id: cf.entity_id,
        summary: `Accepted external ${cf.field} from sync`, changes, ip_address: actor.ip_address,
      });
    }
  }
  const fresh = (await getById(db, syncConflicts, cf.id))!;
  await patch(db, syncConflicts, fresh, {
    status: data.resolution !== "accept_external" ? data.resolution : "accepted_external", resolved_by_id: actor.id,
    resolved_at: utcnow(), resolution_note: data.note,
  });
  await audit.record(db, {
    actor, action: "sync_conflict.resolved", entity_type: "sync_batch", entity_id: fresh.batch_id,
    summary: `${fresh.entity_type} ${fresh.field}: ${fresh.status}`, changes: { conflict_id: fresh.id },
    ip_address: actor.ip_address,
  });
  const openLeft = await countWhere(
    db, syncConflicts,
    and(eq(syncConflicts.batch_id, fresh.batch_id), eq(syncConflicts.status, "open"), ne(syncConflicts.id, fresh.id)),
  );
  if (!openLeft) {
    const b = await getById(db, syncBatches, fresh.batch_id);
    if (b && b.status === "completed_with_conflicts") await patch(db, syncBatches, b, { status: "completed" });
  }
  await db.commit();
  return fresh;
}
