/**
 * Vendors, capital projects, insurance, property tax and operating budgets (spec module 22).
 *
 * Public contract for other modules:
 *   vendorIsCompliant(db, vendor_id) -> Promise<[boolean, string[]]>
 */
import {
  and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, arrayOverlaps, type SQL,
} from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, insertMany, patch } from "../../db/orm";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";
import { raiseAlert } from "../tasks/service";
import {
  alertsRef, assetFinancials, assets, documentLinks, leaseClauses, leaseRecoveries, leases, workOrders,
} from "./external";
import {
  budgetLines, budgets, capitalProjects, changeOrders, insuranceCertificates, insuranceClaims, insurancePolicies,
  projectApprovals, projectBids, projectBudgetEntries, projectDraws, taxAssessments, taxPayments, taxProtests,
  vendorCredentials, vendorReviews, vendors,
  type Budget, type BudgetLine, type CapitalProject, type ChangeOrder, type InsuranceCertificate,
  type InsuranceClaim, type InsurancePolicy, type ProjectBid, type ProjectDraw, type TaxAssessment,
  type TaxPayment, type TaxProtest, type Vendor, type VendorCredential,
} from "./schema";
import {
  assessmentIn, bidIn, changeOrderIn, certificateIn, claimIn, credentialIn, drawIn, paymentIn, policyIn, protestIn,
  reviewIn, projectIn,
  type AssessmentIn, type BidIn, type BudgetIn, type CertificateIn, type ChangeOrderIn, type ClaimIn,
  type CredentialIn, type DrawIn, type DrawUpdate, type HearingResultIn, type LinesIn, type PaymentConfirmIn,
  type PaymentIn, type PolicyIn, type ProjectIn, type ProjectStatusIn, type ProjectUpdate, type ProtestIn,
  type ProtestUpdate, type ReviewIn, type VendorIn, type VendorUpdate,
} from "./schemas";

export const EXPIRING_DAYS = 30;
export const POLICY_WARNING_DAYS = 60;
export const CREDENTIAL_LABELS: Record<string, string> = {
  license: "License", insurance_coi: "Certificate of insurance", w9: "W-9", other: "Credential",
};

// ======================================================================= small helpers

const _404 = (what: string) => new HttpError(404, `${what} not found`);
const _422 = (message: string, extra?: Record<string, any>) =>
  new HttpError(422, extra ? { message, ...extra } : message);

/** Python `round(x, n)` (half-up here). */
const round = (x: number, n = 0) => {
  const f = 10 ** n;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
};
/** Python `f"{n:,.{dp}f}"`. */
const fmt = (n: number | string, dp = 2) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const num = (v: unknown) => Number(v ?? 0);
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const spaced = (s: string) => s.replace(/_/g, " ");

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const _days = (d: string | null | undefined): number | null => (d ? dayDiff(d, today()) : null);

/** Python `==` over JSON-ish values (key order of JSONB objects is not significant). */
function same(a: any, b: any): boolean {
  if ((a ?? null) === null && (b ?? null) === null) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => same(a[k], b[k]));
  }
  return a === b;
}

/** `{field: {from, to}}` for the fields of `data` that differ from `obj` (audit.diff, JSONB-order tolerant). */
function diff(obj: Record<string, any>, data: Record<string, any>): Record<string, { from: any; to: any }> {
  const out: Record<string, { from: any; to: any }> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (!same(obj[k], v)) out[k] = { from: audit.toJsonable(obj[k] ?? null), to: audit.toJsonable(v) };
  }
  return out;
}

const _delta = (before: Record<string, any>, after: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(after)
      .filter(([k, v]) => !same(before[k], v))
      .map(([k, v]) => [k, { from: audit.toJsonable(before[k] ?? null), to: audit.toJsonable(v) }]),
  );

/** Defined-only copy (pydantic `exclude_unset`). */
const defined = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A pydantic `model_dump()`: every field of the schema, absent optionals as null. */
const dense = (schema: { shape: Record<string, unknown> }, data: Record<string, any>, exclude: string[] = []) =>
  Object.fromEntries(Object.keys(schema.shape).filter((k) => !exclude.includes(k)).map((k) => [k, data[k] ?? null]));

export const pick = (row: Record<string, any>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

const ids = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

const falseSql = sql`false`;
const inIds = (col: any, list: string[]): SQL => (list.length ? inArray(col, list) : falseSql);

async function _record(
  db: Db, actor: CurrentUser, action: string, entity_type: string, entity_id: string | null,
  o: { changes?: Record<string, any> | null; summary?: string | null } = {},
): Promise<void> {
  await audit.record(db, {
    actor, action, entity_type, entity_id, changes: o.changes, summary: o.summary, ip_address: actor.ip_address,
  });
}

// ======================================================================= cross-module helpers (guarded)

export async function linkDocuments(
  db: Db, docIds: Array<string | null | undefined> | null | undefined, entity_type: string, entity_id: string,
  actor: CurrentUser,
): Promise<void> {
  const list = (docIds ?? []).filter((i): i is string => !!i);
  if (!list.length) return;
  let documents: any;
  try {
    documents = await import("../documents/service");
  } catch {
    return;
  }
  for (const doc_id of list) await documents.link(db, doc_id, entity_type, entity_id, actor);
}

export async function linkedDocumentCounts(db: Db, entity_type: string, entityIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!entityIds.length) return out;
  const rows = await db
    .select({ id: documentLinks.entity_id, n: sql<number>`count(*)::int` })
    .from(documentLinks)
    .where(and(eq(documentLinks.entity_type, entity_type), inArray(documentLinks.entity_id, entityIds)))
    .groupBy(documentLinks.entity_id);
  for (const r of rows) out.set(r.id!, Number(r.n));
  return out;
}

/** Operational deadlines feed the shared critical-date engine (contracts module) when installed. */
export async function criticalDate(
  db: Db,
  o: {
    related_type: string; related_id: string; date_type: string; label: string; due_on: string | null | undefined;
    property_id: string | null; actor: CurrentUser | null; lead_days?: number; is_blocking?: boolean; status_?: string;
  },
): Promise<void> {
  if (!o.due_on) return;
  let contracts: any;
  try {
    contracts = await import("../contracts/service");
  } catch {
    return;
  }
  await contracts.upsertCriticalDate(db, {
    related_type: o.related_type, related_id: o.related_id, date_type: o.date_type, label: o.label, due_on: o.due_on,
    property_id: o.property_id, owner_id: o.actor ? o.actor.id : null, lead_days: o.lead_days ?? 14,
    is_blocking: o.is_blocking ?? false, source: "manual", status: o.status_ ?? "confirmed", actor: o.actor,
  });
}

export async function assetForProperty(db: Db, property_id: string | null | undefined): Promise<string | null> {
  if (!property_id) return null;
  const [r] = await db.select({ id: assets.id }).from(assets).where(eq(assets.property_id, property_id)).limit(1);
  return r?.id ?? null;
}

export async function propertyNames(db: Db, idList: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = ids(idList);
  const out = new Map<string, string>();
  if (!list.length) return out;
  const rows = await db
    .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
    .from(properties)
    .where(inArray(properties.id, list));
  for (const r of rows) out.set(r.id, r.name || r.address_line);
  return out;
}

export async function userNames(db: Db, idList: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = ids(idList);
  const out = new Map<string, string>();
  if (!list.length) return out;
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, list));
  for (const r of rows) out.set(r.id, r.full_name);
  return out;
}

export async function vendorNames(db: Db, idList: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = ids(idList);
  const out = new Map<string, string>();
  if (!list.length) return out;
  const rows = await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, list));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

async function _requireProperty(db: Db, property_id: string | null | undefined): Promise<void> {
  if (property_id) {
    const p = await get(db, properties, property_id);
    if (!p || p.deleted_at) throw _404("Property");
  }
}

function _checkCapitalLimit(actor: CurrentUser, amount: number): void {
  if (!actor.canApprove("capital", amount)) {
    throw new HttpError(403, `$${fmt(amount)} exceeds your capital approval limit`);
  }
}

// ======================================================================= vendor compliance

export function credentialStatus(
  c: { status: string; expires_on: string | null }, today_: string = today(),
): string {
  if (c.status === "rejected") return "rejected";
  if (c.expires_on && c.expires_on < today_) return "expired";
  if (c.expires_on && c.expires_on <= addDays(today_, EXPIRING_DAYS)) return "expiring";
  return "valid";
}

const _current = (c: VendorCredential, today_: string) =>
  c.status !== "rejected" && (c.expires_on === null || c.expires_on >= today_);

const _currentCertificate = (c: InsuranceCertificate, today_: string) =>
  c.status === "compliant" && (c.expires_on === null || c.expires_on >= today_);

/** Pure rule: vendor active, every required credential kind has a current (unexpired, not rejected) record. */
export function evaluateCompliance(
  v: Vendor, creds: VendorCredential[], certs: InsuranceCertificate[], today_: string = today(),
): [boolean, string[]] {
  const reasons: string[] = [];
  if (v.status === "suspended" || v.status === "inactive") reasons.push(`Vendor is ${v.status}`);
  const currentKinds = new Set(creds.filter((c) => _current(c, today_)).map((c) => c.kind));
  if (certs.some((c) => _currentCertificate(c, today_))) currentKinds.add("insurance_coi");
  for (const c of creds) {
    if (c.is_required && c.status !== "rejected" && c.expires_on && c.expires_on < today_ && !currentKinds.has(c.kind)) {
      reasons.push(`${CREDENTIAL_LABELS[c.kind] ?? "Credential"} "${c.name}" expired on ${c.expires_on}`);
    }
  }
  const expiredKinds = new Set(creds.filter((c) => c.is_required && c.expires_on && c.expires_on < today_).map((c) => c.kind));
  if (v.requires_insurance && !currentKinds.has("insurance_coi") && !expiredKinds.has("insurance_coi")) {
    reasons.push("No current certificate of insurance on file");
  }
  if (v.requires_license && !currentKinds.has("license") && !expiredKinds.has("license")) {
    reasons.push("No current license on file");
  }
  return [reasons.length === 0, reasons];
}

async function _complianceInputs(db: Db, vendorIds: string[]) {
  let creds = new Map<string, VendorCredential[]>();
  let certs = new Map<string, InsuranceCertificate[]>();
  if (vendorIds.length) {
    creds = group(
      await db.select().from(vendorCredentials)
        .where(and(inArray(vendorCredentials.vendor_id, vendorIds), isNull(vendorCredentials.deleted_at))),
      (c) => c.vendor_id,
    );
    certs = group(
      await db.select().from(insuranceCertificates)
        .where(and(
          inArray(insuranceCertificates.vendor_id, vendorIds), eq(insuranceCertificates.holder_kind, "vendor"),
          isNull(insuranceCertificates.deleted_at),
        )),
      (c) => c.vendor_id!,
    );
  }
  return { creds, certs };
}

/** Expired required insurance/license blocks dependent workflows (work-order assignment, project award, draws). */
export async function vendorIsCompliant(db: Db, vendor_id: string): Promise<[boolean, string[]]> {
  const v = await get(db, vendors, vendor_id);
  if (!v || v.deleted_at) return [false, ["Vendor not found"]];
  const { creds, certs } = await _complianceInputs(db, [v.id]);
  return evaluateCompliance(v, creds.get(v.id) ?? [], certs.get(v.id) ?? []);
}

// ======================================================================= vendors

export interface VendorFilters {
  q?: string;
  status?: string[];
  services?: string[];
  compliance?: string; // compliant | non_compliant
  tag?: string[];
}

export function vendorQuery(f: VendorFilters, o: { skip?: Set<string> } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = vendors;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.primary_contact_name, t.email, t.service_area]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    f.services?.length && !skip.has("services") ? arrayOverlaps(t.services, f.services) : undefined,
    f.tag?.length ? arrayOverlaps(t.tags, f.tag) : undefined,
  );
}

export async function nonCompliantIds(db: Db): Promise<string[]> {
  const rows = await db.select().from(vendors).where(isNull(vendors.deleted_at));
  const { creds, certs } = await _complianceInputs(db, rows.map((v) => v.id));
  return rows
    .filter((v) => !evaluateCompliance(v, creds.get(v.id) ?? [], certs.get(v.id) ?? [])[0])
    .map((v) => v.id);
}

type Spend = { work_orders: number; projects: number };

async function _spendByVendor(db: Db, vendorIds: string[], year?: number): Promise<(id: string) => Spend & { has: boolean }> {
  const out = new Map<string, Spend>();
  const spendOf = (id: string) => ({ ...(out.get(id) ?? { work_orders: 0, projects: 0 }), has: out.has(id) });
  if (!vendorIds.length) return spendOf;
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { work_orders: 0, projects: 0 }));
    return e;
  };
  const wo = await db
    .select({ vendor_id: workOrders.vendor_id, total: sql<string>`coalesce(sum(${workOrders.actual_cost}), 0)` })
    .from(workOrders)
    .where(and(
      inArray(workOrders.vendor_id, vendorIds), isNull(workOrders.deleted_at),
      inArray(workOrders.status, ["completed", "verified"]),
      year ? sql`extract(year from ${workOrders.completed_at}) = ${year}` : undefined,
    ))
    .groupBy(workOrders.vendor_id);
  for (const r of wo) entry(r.vendor_id!).work_orders = Number(r.total || 0);
  const pr = await db
    .select({ vendor_id: capitalProjects.contractor_vendor_id, total: sql<string>`coalesce(sum(${projectDraws.amount}), 0)` })
    .from(capitalProjects)
    .innerJoin(projectDraws, eq(projectDraws.project_id, capitalProjects.id))
    .where(and(
      inArray(capitalProjects.contractor_vendor_id, vendorIds), eq(projectDraws.status, "paid"),
      isNull(projectDraws.deleted_at),
      year ? sql`extract(year from ${projectDraws.paid_on}) = ${year}` : undefined,
    ))
    .groupBy(capitalProjects.contractor_vendor_id);
  for (const r of pr) entry(r.vendor_id!).projects = Number(r.total || 0);
  return spendOf;
}

const VENDOR_LIST_KEYS = [
  "id", "name", "organization_id", "services", "status", "primary_contact_name", "email", "phone",
  "performance_rating", "tags", "updated_at",
] as const;

export async function vendorItems(db: Db, rows: Vendor[]) {
  const vendorIds = rows.map((v) => v.id);
  const { creds, certs } = await _complianceInputs(db, vendorIds);
  const spend = await _spendByVendor(db, vendorIds, new Date().getUTCFullYear());
  const today_ = today();
  return rows.map((v) => {
    const [compliant, compliance_reasons] = evaluateCompliance(v, creds.get(v.id) ?? [], certs.get(v.id) ?? [], today_);
    const upcoming = [...(creds.get(v.id) ?? []), ...(certs.get(v.id) ?? [])]
      .map((c) => c.expires_on)
      .filter((d): d is string => !!d);
    const s = spend(v.id);
    return {
      ...pick(v, VENDOR_LIST_KEYS),
      compliant,
      compliance_reasons,
      next_expiry_on: upcoming.length ? upcoming.reduce((a, b) => (b < a ? b : a)) : null,
      spend_ytd: s.has ? round(s.work_orders + s.projects, 2) : 0,
    };
  });
}

export async function getVendor(db: Db, vendor_id: string): Promise<Vendor> {
  const v = await get(db, vendors, vendor_id);
  if (!v || v.deleted_at) throw _404("Vendor");
  return v;
}

const CREDENTIAL_OUT_KEYS = [
  "id", "vendor_id", "kind", "name", "number", "issuer", "coverage_amount", "effective_on", "expires_on",
  "is_required", "status", "document_id", "verified_by_id", "verified_at", "notes", "updated_at",
] as const;

export function credentialOut(c: VendorCredential) {
  return {
    ...pick(c, CREDENTIAL_OUT_KEYS),
    status: credentialStatus(c),
    days_to_expiry: _days(c.expires_on),
  };
}

const REVIEW_OUT_KEYS = [
  "id", "rating", "quality", "timeliness", "communication", "comment", "work_order_id", "project_id", "created_at",
  "created_by_id",
] as const;
export const reviewOut = (r: Record<string, any>) => pick(r, REVIEW_OUT_KEYS);

export async function vendorOut(db: Db, v: Vendor) {
  const base = (await vendorItems(db, [v]))[0];
  const creds = await db.select().from(vendorCredentials)
    .where(and(eq(vendorCredentials.vendor_id, v.id), isNull(vendorCredentials.deleted_at)))
    .orderBy(asc(vendorCredentials.expires_on));
  const reviews = await db.select().from(vendorReviews)
    .where(and(eq(vendorReviews.vendor_id, v.id), isNull(vendorReviews.deleted_at)))
    .orderBy(desc(vendorReviews.created_at));
  const certs = await db.select().from(insuranceCertificates)
    .where(and(eq(insuranceCertificates.vendor_id, v.id), isNull(insuranceCertificates.deleted_at)));

  const total = (await _spendByVendor(db, [v.id]))(v.id);
  const ytd = (await _spendByVendor(db, [v.id], new Date().getUTCFullYear()))(v.id);
  const spend = {
    work_orders_total: total.work_orders, projects_total: total.projects,
    total: round(total.work_orders + total.projects, 2), ytd: round(ytd.work_orders + ytd.projects, 2),
  };

  const bids = await db.select().from(projectBids)
    .where(and(eq(projectBids.vendor_id, v.id), isNull(projectBids.deleted_at)))
    .orderBy(desc(projectBids.created_at));
  const projects = new Map<string, CapitalProject>();
  if (bids.length) {
    for (const p of await db.select().from(capitalProjects).where(inArray(capitalProjects.id, ids(bids.map((b) => b.project_id))))) {
      projects.set(p.id, p);
    }
  }
  const bidRows = bids.map((b) => ({
    id: b.id, project_id: b.project_id, project_name: projects.get(b.project_id)?.name ?? null, amount: b.amount,
    status: b.status, submitted_on: b.submitted_on, created_at: b.created_at.toISOString(),
  }));

  const perf: Record<string, any> = {
    review_rating: v.performance_rating, review_count: reviews.length, satisfaction_avg: null,
    completed_work_orders: 0, on_time_pct: null, avg_days_to_complete: null,
    bids_submitted: bids.length, bids_won: bids.filter((b) => b.status === "awarded").length,
  };
  const wos = await db.select().from(workOrders)
    .where(and(eq(workOrders.vendor_id, v.id), isNull(workOrders.deleted_at)))
    .orderBy(desc(workOrders.created_at))
    .limit(200);
  const done = wos.filter((w) => (w.status === "completed" || w.status === "verified") && w.completed_at);
  const rated = done.map((w) => w.satisfaction_rating).filter((r): r is number => !!r);
  const dated = done.filter((w) => w.due_on);
  Object.assign(perf, {
    completed_work_orders: done.length,
    satisfaction_avg: rated.length ? round(rated.reduce((a, b) => a + b, 0) / rated.length, 2) : null,
    on_time_pct: dated.length
      ? round((100 * dated.filter((w) => w.completed_at!.toISOString().slice(0, 10) <= w.due_on!).length) / dated.length, 1)
      : null,
    avg_days_to_complete: done.length
      ? round(
        done.reduce((a, w) => a + (w.completed_at!.getTime() - (w.assigned_at ?? w.created_at!).getTime()) / 1000, 0)
          / 86400 / done.length,
        1,
      )
      : null,
  });
  const work_orders = wos.slice(0, 50).map((w) => ({
    id: w.id, number: w.number, title: w.title, status: w.status, actual_cost: w.actual_cost,
    satisfaction_rating: w.satisfaction_rating, completed_at: w.completed_at ? w.completed_at.toISOString() : null,
    created_at: w.created_at!.toISOString(),
  }));

  return {
    ...base,
    address: v.address,
    contacts: v.contacts,
    rates: v.rates,
    contracts: v.contracts,
    service_area: v.service_area,
    requires_insurance: v.requires_insurance,
    requires_license: v.requires_license,
    notes: v.notes,
    created_at: v.created_at,
    credentials: creds.map(credentialOut),
    reviews: reviews.map(reviewOut),
    performance: perf,
    spend,
    bids: bidRows,
    work_orders,
    certificates: await certificateItems(db, certs),
  };
}

export async function createVendor(db: Db, data: VendorIn, actor: CurrentUser): Promise<Vendor> {
  const v = await insert(db, vendors, { ...data, created_by_id: actor.id, updated_by_id: actor.id } as never);
  await _record(db, actor, "vendor.created", "vendor", v.id, { summary: v.name });
  await db.commit();
  return v;
}

export async function updateVendor(db: Db, v: Vendor, data: VendorUpdate, actor: CurrentUser): Promise<Vendor> {
  const values = defined(data);
  const changes = diff(v, values);
  if (!Object.keys(changes).length) return v;
  await patch(db, vendors, v, { ...values, updated_by_id: actor.id } as never);
  await _record(db, actor, "vendor.updated", "vendor", v.id, { changes });
  await db.commit();
  return v;
}

export async function archiveVendor(db: Db, v: Vendor, actor: CurrentUser): Promise<void> {
  await patch(db, vendors, v, { deleted_at: utcnow(), status: "inactive" });
  await _record(db, actor, "vendor.archived", "vendor", v.id, { summary: v.name });
  await db.commit();
}

export async function saveCredential(
  db: Db, v: Vendor, data: CredentialIn, actor: CurrentUser, c: VendorCredential | null = null,
): Promise<VendorCredential> {
  const values = dense(credentialIn, data, ["verified"]);
  let changes: Record<string, any>;
  let action: string;
  let row: VendorCredential;
  if (c === null) {
    changes = Object.fromEntries(
      Object.entries(values).filter(([, val]) => val !== null).map(([k, val]) => [k, audit.toJsonable(val)]),
    );
    action = "vendor.credential_added";
    row = await insert(db, vendorCredentials, {
      vendor_id: v.id, ...values,
      status: credentialStatus({ status: "valid", expires_on: (values.expires_on as string | null) ?? null }),
      ...(data.verified ? { verified_by_id: actor.id, verified_at: utcnow() } : {}),
      created_by_id: actor.id, updated_by_id: actor.id,
    } as never);
  } else {
    changes = diff(c, values);
    action = "vendor.credential_updated";
    let status = c.status;
    if (status === "rejected" && "expires_on" in changes) status = "valid";
    const set: Record<string, any> = { ...values, updated_by_id: actor.id };
    if (data.verified && !c.verified_at) {
      set.verified_by_id = actor.id;
      set.verified_at = utcnow();
    } else if (!data.verified) {
      set.verified_by_id = null;
      set.verified_at = null;
    }
    if (status !== "rejected") status = credentialStatus({ status, expires_on: (values.expires_on as string | null) ?? null });
    set.status = status;
    row = await patch(db, vendorCredentials, c, set as never);
  }
  await linkDocuments(db, [data.document_id], "vendor_credential", row.id, actor);
  await _record(db, actor, action, "vendor", v.id, { changes, summary: `${row.kind}: ${row.name}` });
  await db.commit();
  return row;
}

export async function getCredential(db: Db, cred_id: string): Promise<VendorCredential> {
  const c = await get(db, vendorCredentials, cred_id);
  if (!c || c.deleted_at) throw _404("Credential");
  return c;
}

export async function archiveCredential(db: Db, c: VendorCredential, actor: CurrentUser): Promise<void> {
  await patch(db, vendorCredentials, c, { deleted_at: utcnow() });
  await _record(db, actor, "vendor.credential_removed", "vendor", c.vendor_id, { summary: `${c.kind}: ${c.name}` });
  await db.commit();
}

export async function addReview(db: Db, v: Vendor, data: ReviewIn, actor: CurrentUser) {
  const r = await insert(db, vendorReviews, {
    vendor_id: v.id, ...dense(reviewIn, data), created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  const [{ avg }] = await db
    .select({ avg: sql<string | null>`avg(${vendorReviews.rating})` })
    .from(vendorReviews)
    .where(and(eq(vendorReviews.vendor_id, v.id), isNull(vendorReviews.deleted_at)));
  const before = v.performance_rating;
  await patch(db, vendors, v, { performance_rating: avg !== null && avg !== undefined ? round(Number(avg), 2) : null });
  await _record(db, actor, "vendor.reviewed", "vendor", v.id, {
    summary: `${data.rating}/5`, changes: { performance_rating: { from: before, to: v.performance_rating } },
  });
  await db.commit();
  return reviewOut(r);
}

// ======================================================================= expiration scan

/** Idempotent: alerts are keyed by record + date + state, so re-running never duplicates. */
export async function runScan(db: Db, actor: CurrentUser | null) {
  const today_ = today();
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let raised = 0;

  const alert = async (key: string, kw: Omit<Parameters<typeof raiseAlert>[1], "idempotency_key">) => {
    const [exists] = await db.select({ id: alertsRef.id }).from(alertsRef).where(eq(alertsRef.idempotency_key, key)).limit(1);
    await raiseAlert(db, { idempotency_key: key, ...kw } as never);
    if (!exists) raised += 1;
  };

  const vendorMap = new Map<string, Vendor>();
  for (const v of await db.select().from(vendors).where(isNull(vendors.deleted_at))) vendorMap.set(v.id, v);
  const creds = (
    await db.select().from(vendorCredentials)
      .where(and(isNull(vendorCredentials.deleted_at), isNotNull(vendorCredentials.expires_on)))
  ).filter((c) => vendorMap.has(c.vendor_id));
  for (const c of creds) {
    const state = credentialStatus(c, today_);
    if (c.status !== state && c.status !== "rejected") await patch(db, vendorCredentials, c, { status: state });
    if (state !== "expiring" && state !== "expired") continue;
    bump(`credentials_${state}`);
    const v = vendorMap.get(c.vendor_id)!;
    const label = CREDENTIAL_LABELS[c.kind] ?? "Credential";
    await alert(`vendor_credential:${c.id}:${c.expires_on}:${state}`, {
      title: `${v.name}: ${label.toLowerCase()} ${state === "expired" ? "expired" : "expiring"}`,
      reason: `${label} "${c.name}" ${state === "expired" ? "expired" : "expires"} on ${c.expires_on}.`
        + (state === "expired" && c.is_required ? " Assignment and award are blocked until renewed." : ""),
      severity: state === "expired" && c.is_required ? "high" : "medium",
      related_type: "vendor", related_id: v.id, related_label: v.name, rule_key: "operations.credential_expiry",
    });
  }

  const policies = await db.select().from(insurancePolicies).where(and(
    isNull(insurancePolicies.deleted_at), inArray(insurancePolicies.status, ["active", "pending_renewal"]),
    sql`${insurancePolicies.expires_on} <= ${addDays(today_, POLICY_WARNING_DAYS)}`,
  ));
  for (const p of policies) {
    const expired = p.expires_on < today_;
    if (expired) await patch(db, insurancePolicies, p, { status: "expired" });
    bump("policies_expiring");
    await alert(`policy:${p.id}:${p.expires_on}:${expired ? "expired" : "expiring"}`, {
      title: `${p.carrier} ${spaced(p.coverage_type)} policy ${expired ? "expired" : "expiring"}`,
      reason: `Policy ${p.policy_number} ${expired ? "expired" : "expires"} on ${p.expires_on}.`,
      severity: expired || dayDiff(p.expires_on, today_) <= 14 ? "high" : "medium",
      related_type: "insurance_policy", related_id: p.id, related_label: p.policy_number,
      rule_key: "operations.policy_expiry",
    });
  }

  const certs = await db.select().from(insuranceCertificates).where(and(
    isNull(insuranceCertificates.deleted_at), isNotNull(insuranceCertificates.expires_on),
    sql`${insuranceCertificates.expires_on} <= ${addDays(today_, EXPIRING_DAYS)}`,
  ));
  for (const c of certs) {
    const lapsed = c.expires_on! < today_;
    if (lapsed && c.status !== "expired") await patch(db, insuranceCertificates, c, { status: "expired" });
    if (lapsed) bump("certificates_lapsed");
    const holder = c.tenant_name || (c.vendor_id && vendorMap.has(c.vendor_id) ? vendorMap.get(c.vendor_id)!.name : "Certificate holder");
    await alert(`certificate:${c.id}:${c.expires_on}:${lapsed ? "lapsed" : "expiring"}`, {
      title: `${holder}: insurance certificate ${lapsed ? "lapsed" : "expiring"}`,
      reason: `${capitalize(spaced(c.coverage_type))} certificate ${lapsed ? "lapsed" : "expires"} on ${c.expires_on}. Request a renewal.`,
      severity: lapsed ? "high" : "medium", related_type: "insurance_certificate", related_id: c.id,
      related_label: holder, rule_key: "operations.certificate_lapse",
    });
  }

  const protests = await db.select().from(taxProtests).where(and(
    isNull(taxProtests.deleted_at), eq(taxProtests.status, "considering"), isNotNull(taxProtests.deadline_on),
    sql`${taxProtests.deadline_on} <= ${addDays(today_, EXPIRING_DAYS)}`,
  ));
  for (const pr of protests) {
    bump("protest_deadlines");
    await alert(`protest_deadline:${pr.id}:${pr.deadline_on}`, {
      title: `Tax protest deadline ${pr.deadline_on} (${pr.tax_year})`,
      reason: "The protest has not been filed. Missing the deadline forfeits the appeal for this tax year.",
      severity: "high", related_type: "tax_protest", related_id: pr.id, related_label: `${pr.tax_year} protest`,
      rule_key: "operations.protest_deadline",
    });
  }
  const protested = db.select({ id: taxProtests.assessment_id }).from(taxProtests).where(isNull(taxProtests.deleted_at));
  const assessments = await db.select().from(taxAssessments).where(and(
    isNull(taxAssessments.deleted_at), isNotNull(taxAssessments.protest_deadline_on),
    sql`${taxAssessments.protest_deadline_on} >= ${today_}`,
    sql`${taxAssessments.protest_deadline_on} <= ${addDays(today_, EXPIRING_DAYS)}`,
    notInArray(taxAssessments.id, protested),
  ));
  for (const a of assessments) {
    bump("protest_deadlines");
    await alert(`assessment_deadline:${a.id}:${a.protest_deadline_on}`, {
      title: `Decide on ${a.tax_year} assessment protest by ${a.protest_deadline_on}`,
      reason: `Assessed value $${fmt(a.assessed_total, 0)}; no protest decision is recorded.`,
      severity: "medium", related_type: "tax_assessment", related_id: a.id, related_label: `${a.tax_year} assessment`,
      rule_key: "operations.protest_deadline",
    });
  }

  const payments = await db.select().from(taxPayments).where(and(
    isNull(taxPayments.deleted_at), inArray(taxPayments.status, ["scheduled", "late"]),
    sql`${taxPayments.due_on} <= ${addDays(today_, EXPIRING_DAYS)}`,
  ));
  for (const pay of payments) {
    const late = pay.due_on < today_;
    if (late) await patch(db, taxPayments, pay, { status: "late" });
    bump("payments_due");
    await alert(`tax_payment:${pay.id}:${pay.due_on}:${late ? "late" : "due"}`, {
      title: `Property tax ${late ? "past due" : "due"} ${pay.due_on}`,
      reason: `$${fmt(pay.amount_due)} ${pay.tax_year} ${pay.installment || "installment"} has no payment confirmation.`,
      severity: late ? "high" : "medium", related_type: "tax_payment", related_id: pay.id,
      related_label: `${pay.tax_year} ${pay.installment || ""}`.trim(), rule_key: "operations.tax_payment",
    });
  }

  if (actor) {
    await audit.record(db, {
      actor, action: "operations.scan", entity_type: "operations", summary: `${raised} alerts`, changes: { ...counts },
      ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return {
    credentials_expiring: counts.credentials_expiring ?? 0, credentials_expired: counts.credentials_expired ?? 0,
    policies_expiring: counts.policies_expiring ?? 0, certificates_lapsed: counts.certificates_lapsed ?? 0,
    protest_deadlines: counts.protest_deadlines ?? 0, payments_due: counts.payments_due ?? 0, alerts_raised: raised,
  };
}

// ======================================================================= capital projects

export const PROJECT_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["pending_approval", "cancelled"]),
  pending_approval: new Set(["draft", "cancelled"]),
  approved: new Set(["bidding", "cancelled"]),
  bidding: new Set(["cancelled"]),
  awarded: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "cancelled"]),
  completed: new Set(["closed", "in_progress"]),
  closed: new Set(),
  cancelled: new Set(),
};

export interface ProjectFilters {
  q?: string;
  status?: string[];
  category?: string[];
  property_id?: string;
  asset_id?: string;
  contractor_vendor_id?: string;
  manager_id?: string;
  min_budget?: number;
  max_budget?: number;
}

/** Search across a table's own columns plus the linked property's name/address (Python outer-joined Property). */
function propertySearch(q: string | undefined, columns: any[], propertyIdCol: any): SQL | undefined {
  if (!q) return undefined;
  const terms = q.split(/\s+/).filter(Boolean);
  return and(...terms.map((term) => {
    const like = `%${term}%`;
    return or(
      ...columns.map((c) => sql`${c} ilike ${like}`),
      sql`${propertyIdCol} in (select id from properties where name ilike ${like} or address_line ilike ${like})`,
    );
  }));
}

export function projectQuery(f: ProjectFilters, o: { skip?: Set<string> } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = capitalProjects;
  return and(
    isNull(t.deleted_at),
    propertySearch(f.q, [t.name, t.scope], t.property_id),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("category") ? undefined : inFilter(t.category, f.category),
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    f.contractor_vendor_id ? eq(t.contractor_vendor_id, f.contractor_vendor_id) : undefined,
    f.manager_id ? eq(t.manager_id, f.manager_id) : undefined,
    rangeFilter(t.current_budget, f.min_budget, f.max_budget),
  );
}

const PROJECT_LIST_KEYS = [
  "id", "property_id", "asset_id", "name", "category", "status", "manager_id", "original_budget", "current_budget",
  "contract_amount", "contractor_vendor_id", "start_on", "target_completion_on", "actual_completion_on", "updated_at",
] as const;

export async function projectItems(db: Db, rows: CapitalProject[]) {
  const projectIds = rows.map((p) => p.id);
  const props = await propertyNames(db, rows.map((p) => p.property_id));
  const mgrs = await userNames(db, rows.map((p) => p.manager_id));
  const vens = await vendorNames(db, rows.map((p) => p.contractor_vendor_id));
  const spent = new Map<string, number>();
  const pending = new Map<string, number>();
  if (projectIds.length) {
    const s = await db
      .select({ id: projectDraws.project_id, total: sql<string>`coalesce(sum(${projectDraws.amount}), 0)` })
      .from(projectDraws)
      .where(and(
        inArray(projectDraws.project_id, projectIds), inArray(projectDraws.status, ["approved", "paid"]),
        isNull(projectDraws.deleted_at),
      ))
      .groupBy(projectDraws.project_id);
    for (const r of s) spent.set(r.id, Number(r.total));
    const c = await db
      .select({ id: changeOrders.project_id, n: sql<number>`count(*)::int` })
      .from(changeOrders)
      .where(and(
        inArray(changeOrders.project_id, projectIds), eq(changeOrders.status, "pending"), isNull(changeOrders.deleted_at),
      ))
      .groupBy(changeOrders.project_id);
    for (const r of c) pending.set(r.id, Number(r.n));
  }
  return rows.map((p) => ({
    ...pick(p, PROJECT_LIST_KEYS),
    property_name: props.get(p.property_id) ?? null,
    manager_name: p.manager_id ? mgrs.get(p.manager_id) ?? null : null,
    contractor_name: p.contractor_vendor_id ? vens.get(p.contractor_vendor_id) ?? null : null,
    committed: num(p.contract_amount),
    spent: num(spent.get(p.id)),
    pending_change_orders: num(pending.get(p.id)),
  }));
}

export async function getProject(db: Db, project_id: string): Promise<CapitalProject> {
  const p = await get(db, capitalProjects, project_id);
  if (!p || p.deleted_at) throw _404("Capital project");
  return p;
}

const BID_OUT_KEYS = [
  "vendor_id", "amount", "submitted_on", "valid_until", "duration_days", "scope_notes", "document_id", "id",
  "project_id", "status", "decision_note", "created_at",
] as const;

export async function bidItems(db: Db, bids: ProjectBid[]) {
  const vendorIds = ids(bids.map((b) => b.vendor_id));
  const names = await vendorNames(db, vendorIds);
  const { creds, certs } = await _complianceInputs(db, vendorIds);
  const vendorMap = new Map<string, Vendor>();
  if (bids.length) {
    for (const v of await db.select().from(vendors).where(inArray(vendors.id, vendorIds))) vendorMap.set(v.id, v);
  }
  return bids.map((b) => {
    const v = vendorMap.get(b.vendor_id);
    const [ok, reasons] = v
      ? evaluateCompliance(v, creds.get(b.vendor_id) ?? [], certs.get(b.vendor_id) ?? [])
      : [null, [] as string[]];
    return {
      ...pick(b, BID_OUT_KEYS),
      vendor_name: names.get(b.vendor_id) ?? null,
      vendor_compliant: ok,
      vendor_compliance_reasons: reasons,
    };
  });
}

const DRAW_OUT_KEYS = [
  "amount", "requested_on", "period_end_on", "percent_complete", "retainage", "lien_waiver_document_id",
  "lien_waiver_type", "notes", "id", "project_id", "number", "status", "approved_by_id", "approved_at", "paid_on",
  "payment_reference", "created_at",
] as const;
export const drawOut = (d: ProjectDraw, lien_waiver_on_file = false) => ({
  ...pick(d, DRAW_OUT_KEYS), lien_waiver_on_file,
});

const CHANGE_ORDER_OUT_KEYS = [
  "title", "description", "reason", "amount", "days_impact", "document_id", "id", "project_id", "number", "status",
  "decided_by_id", "decided_at", "decision_note", "created_at", "created_by_id",
] as const;
export const changeOrderOut = (c: ChangeOrder) => pick(c, CHANGE_ORDER_OUT_KEYS);

const BUDGET_ENTRY_KEYS = [
  "id", "kind", "amount_before", "amount_after", "delta", "reason", "change_order_id", "recorded_at", "created_by_id",
] as const;
const APPROVAL_KEYS = ["id", "stage", "decision", "amount", "reference_id", "note", "decided_by_id", "decided_at"] as const;

export async function projectOut(db: Db, p: CapitalProject) {
  const base = (await projectItems(db, [p]))[0];
  const bids = await db.select().from(projectBids)
    .where(and(eq(projectBids.project_id, p.id), isNull(projectBids.deleted_at)))
    .orderBy(asc(projectBids.amount));
  const draws = await db.select().from(projectDraws)
    .where(and(eq(projectDraws.project_id, p.id), isNull(projectDraws.deleted_at)))
    .orderBy(asc(projectDraws.number));
  const cos = await db.select().from(changeOrders)
    .where(and(eq(changeOrders.project_id, p.id), isNull(changeOrders.deleted_at)))
    .orderBy(asc(changeOrders.number));
  const history = await db.select().from(projectBudgetEntries)
    .where(eq(projectBudgetEntries.project_id, p.id))
    .orderBy(asc(projectBudgetEntries.recorded_at));
  const approvals = await db.select().from(projectApprovals)
    .where(eq(projectApprovals.project_id, p.id))
    .orderBy(asc(projectApprovals.decided_at));
  const waivers = await linkedDocumentCounts(db, "lien_waiver", draws.map((d) => d.id));
  const names = await userNames(db, approvals.map((a) => a.decided_by_id));
  return {
    ...base,
    scope: p.scope,
    contingency: p.contingency,
    budget_approved_by_id: p.budget_approved_by_id,
    budget_approved_at: p.budget_approved_at,
    awarded_bid_id: p.awarded_bid_id,
    milestones: p.milestones,
    warranty_expires_on: p.warranty_expires_on,
    warranty_terms: p.warranty_terms,
    useful_life_years: p.useful_life_years,
    recoverability: p.recoverability,
    recoverability_analyzed_at: p.recoverability_analyzed_at,
    notes: p.notes,
    created_at: p.created_at,
    paid: round(draws.filter((d) => d.status === "paid").reduce((a, d) => a + num(d.amount), 0), 2),
    remaining: round(num(p.current_budget) - num(p.contract_amount), 2),
    approved_change_orders: round(cos.filter((c) => c.status === "approved").reduce((a, c) => a + num(c.amount), 0), 2),
    bids: await bidItems(db, bids),
    draws: draws.map((d) => drawOut(d, !!d.lien_waiver_document_id || (waivers.get(d.id) ?? 0) > 0)),
    change_orders: cos.map(changeOrderOut),
    budget_history: history.map((h) => pick(h, BUDGET_ENTRY_KEYS)),
    approvals: approvals.map((a) => ({
      ...pick(a, APPROVAL_KEYS),
      decided_by_name: a.decided_by_id ? names.get(a.decided_by_id) ?? null : null,
    })),
  };
}

async function _budgetEntry(
  db: Db, p: CapitalProject, kind: string, after: number, reason: string | null, actor: CurrentUser,
  change_order_id: string | null = null,
): Promise<void> {
  const before = kind !== "original" ? num(p.current_budget) : 0;
  await insert(db, projectBudgetEntries, {
    project_id: p.id, kind, amount_before: before, amount_after: after, delta: round(after - before, 2), reason,
    change_order_id, recorded_at: utcnow(), created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await patch(db, capitalProjects, p, { current_budget: after });
}

async function _approval(
  db: Db, p: CapitalProject, stage: string, decision: string, actor: CurrentUser,
  o: { amount?: number | null; reference_id?: string | null; note?: string | null } = {},
): Promise<void> {
  await insert(db, projectApprovals, {
    project_id: p.id, stage, decision, amount: o.amount ?? null, reference_id: o.reference_id ?? null,
    note: o.note ?? null, decided_by_id: actor.id, decided_at: utcnow(), created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
}

export async function createProject(db: Db, data: ProjectIn, actor: CurrentUser): Promise<CapitalProject> {
  await _requireProperty(db, data.property_id);
  const { property_id, asset_id, manager_id, original_budget, ...values } = data;
  const p = await insert(db, capitalProjects, {
    ...dense(projectIn, values as never, ["property_id", "asset_id", "manager_id", "original_budget"]),
    milestones: data.milestones,
    property_id, manager_id: manager_id || actor.id,
    asset_id: asset_id || (await assetForProperty(db, property_id)),
    original_budget, current_budget: 0, status: "draft",
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await _budgetEntry(db, p, "original", original_budget, "Original budget", actor);
  await _record(db, actor, "capital_project.created", "capital_project", p.id, {
    summary: p.name, changes: { original_budget },
  });
  await criticalDate(db, {
    related_type: "capital_project", related_id: p.id, date_type: "target_completion",
    label: `${p.name}: target completion`, due_on: p.target_completion_on, property_id: p.property_id, actor,
  });
  await db.commit();
  return p;
}

export async function updateProject(db: Db, p: CapitalProject, data: ProjectUpdate, actor: CurrentUser): Promise<CapitalProject> {
  if (p.status === "closed" || p.status === "cancelled") throw _422(`A ${p.status} project cannot be edited`);
  const values = defined(data);
  const changes = diff(p, values);
  if (!Object.keys(changes).length) return p;
  await patch(db, capitalProjects, p, { ...values, updated_by_id: actor.id } as never);
  await _record(db, actor, "capital_project.updated", "capital_project", p.id, { changes });
  if ("target_completion_on" in changes) {
    await criticalDate(db, {
      related_type: "capital_project", related_id: p.id, date_type: "target_completion",
      label: `${p.name}: target completion`, due_on: p.target_completion_on, property_id: p.property_id, actor,
    });
  }
  if ("warranty_expires_on" in changes) {
    await criticalDate(db, {
      related_type: "capital_project", related_id: p.id, date_type: "warranty_expiration",
      label: `${p.name}: warranty expires`, due_on: p.warranty_expires_on, property_id: p.property_id, actor,
      lead_days: 60,
    });
  }
  await db.commit();
  return p;
}

export async function archiveProject(db: Db, p: CapitalProject, actor: CurrentUser): Promise<void> {
  if (p.status !== "draft" && p.status !== "cancelled") {
    throw _422("Only draft or cancelled projects can be archived; project history is retained");
  }
  await patch(db, capitalProjects, p, { deleted_at: utcnow() });
  await _record(db, actor, "capital_project.archived", "capital_project", p.id, { summary: p.name });
  await db.commit();
}

export async function setProjectStatus(db: Db, p: CapitalProject, data: ProjectStatusIn, actor: CurrentUser): Promise<CapitalProject> {
  const to = data.status;
  if (!(PROJECT_TRANSITIONS[p.status] ?? new Set()).has(to)) throw _422(`Cannot move a project from ${p.status} to ${to}`);
  if (to === "in_progress" && p.contractor_vendor_id) {
    const [ok, reasons] = await vendorIsCompliant(db, p.contractor_vendor_id);
    if (!ok) throw _422("Contractor is not compliant; work cannot start", { reasons });
  }
  if (to === "completed") {
    const set: Record<string, any> = { actual_completion_on: data.actual_completion_on || today() };
    if (data.warranty_expires_on) set.warranty_expires_on = data.warranty_expires_on;
    if (data.warranty_terms) set.warranty_terms = data.warranty_terms;
    await patch(db, capitalProjects, p, set as never);
    await criticalDate(db, {
      related_type: "capital_project", related_id: p.id, date_type: "warranty_expiration",
      label: `${p.name}: warranty expires`, due_on: p.warranty_expires_on, property_id: p.property_id, actor,
      lead_days: 60,
    });
  }
  if (to === "closed") {
    const [{ n: openCos }] = await db.select({ n: sql<number>`count(*)::int` }).from(changeOrders)
      .where(and(eq(changeOrders.project_id, p.id), eq(changeOrders.status, "pending"), isNull(changeOrders.deleted_at)));
    const [{ n: openDraws }] = await db.select({ n: sql<number>`count(*)::int` }).from(projectDraws)
      .where(and(
        eq(projectDraws.project_id, p.id), inArray(projectDraws.status, ["requested", "approved"]),
        isNull(projectDraws.deleted_at),
      ));
    if (openCos || openDraws) throw _422("Resolve pending change orders and unpaid draws before closing the project");
  }
  if (to === "cancelled" && !(data.note || "").trim()) throw _422("A reason is required to cancel a project");
  const previous = p.status;
  await patch(db, capitalProjects, p, { status: to, updated_by_id: actor.id });
  if (to === "completed") {
    await _approval(db, p, "completion", "approved", actor, { amount: num(p.contract_amount), note: data.note });
  }
  await _record(db, actor, `capital_project.${to}`, "capital_project", p.id, {
    changes: { status: { from: previous, to } }, summary: data.note,
  });
  await db.commit();
  return p;
}

export async function decideBudget(
  db: Db, p: CapitalProject, decision: string, note: string | null | undefined, actor: CurrentUser,
): Promise<CapitalProject> {
  if (p.status !== "pending_approval") throw _422("Submit the project for approval first");
  if (decision === "approved") {
    _checkCapitalLimit(actor, num(p.current_budget));
    await patch(db, capitalProjects, p, { status: "approved", budget_approved_by_id: actor.id, budget_approved_at: utcnow() });
  } else {
    if (!(note || "").trim()) throw _422("A note is required when rejecting");
    await patch(db, capitalProjects, p, { status: "draft" });
  }
  await _approval(db, p, "budget", decision, actor, { amount: num(p.current_budget), note });
  await _record(db, actor, `capital_project.budget_${decision}`, "capital_project", p.id, {
    summary: note, changes: { current_budget: p.current_budget },
  });
  await db.commit();
  return p;
}

export async function reviseBudget(db: Db, p: CapitalProject, new_budget: number, reason: string, actor: CurrentUser): Promise<CapitalProject> {
  if (p.status === "closed" || p.status === "cancelled") throw _422(`A ${p.status} project cannot be revised`);
  if (p.contract_amount && new_budget < num(p.contract_amount)) throw _422("Budget cannot be below the committed contract amount");
  const early = p.status === "draft" || p.status === "pending_approval";
  if (!early) _checkCapitalLimit(actor, new_budget);
  const before = num(p.current_budget);
  await _budgetEntry(db, p, "revision", new_budget, reason, actor);
  if (!early) await _approval(db, p, "budget", "approved", actor, { amount: new_budget, note: `Revision: ${reason}` });
  await _record(db, actor, "capital_project.budget_revised", "capital_project", p.id, {
    summary: reason, changes: { current_budget: { from: before, to: new_budget } },
  });
  await db.commit();
  return p;
}

export async function addBid(db: Db, p: CapitalProject, data: BidIn, actor: CurrentUser): Promise<ProjectBid> {
  if (p.status !== "approved" && p.status !== "bidding") throw _422("Bids are collected once the project budget is approved");
  await getVendor(db, data.vendor_id);
  const b = await insert(db, projectBids, {
    project_id: p.id, ...dense(bidIn, data), status: "submitted", created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  if (p.status === "approved") await patch(db, capitalProjects, p, { status: "bidding" });
  await linkDocuments(db, [data.document_id], "project_bid", b.id, actor);
  await _record(db, actor, "capital_project.bid_added", "capital_project", p.id, {
    summary: `$${fmt(data.amount)}`, changes: { vendor_id: data.vendor_id, amount: data.amount },
  });
  await db.commit();
  return b;
}

export async function getBid(db: Db, bid_id: string): Promise<ProjectBid> {
  const b = await get(db, projectBids, bid_id);
  if (!b || b.deleted_at) throw _404("Bid");
  return b;
}

export async function setBidStatus(db: Db, b: ProjectBid, to: string, note: string | null | undefined, actor: CurrentUser): Promise<ProjectBid> {
  if (b.status === "awarded") throw _422("An awarded bid cannot be changed");
  const previous = b.status;
  await patch(db, projectBids, b, { status: to, decision_note: note ?? null });
  await _record(db, actor, "capital_project.bid_updated", "capital_project", b.project_id, {
    changes: { bid: String(b.id), status: { from: previous, to } }, summary: note,
  });
  await db.commit();
  return b;
}

export async function awardBid(db: Db, b: ProjectBid, note: string | null | undefined, actor: CurrentUser): Promise<CapitalProject> {
  const p = await getProject(db, b.project_id);
  if (p.status !== "approved" && p.status !== "bidding") throw _422(`Cannot award while the project is ${p.status}`);
  if (b.status !== "submitted" && b.status !== "shortlisted") throw _422(`A ${b.status} bid cannot be awarded`);
  const [ok, reasons] = await vendorIsCompliant(db, b.vendor_id);
  if (!ok) throw _422("Vendor is not compliant; award is blocked", { reasons });
  if (num(b.amount) > num(p.current_budget)) {
    throw _422(`Bid $${fmt(b.amount)} exceeds the approved budget $${fmt(p.current_budget)}; revise the budget first`);
  }
  _checkCapitalLimit(actor, num(b.amount));
  const others = await db.select().from(projectBids).where(and(
    eq(projectBids.project_id, p.id), ne(projectBids.id, b.id), isNull(projectBids.deleted_at),
    inArray(projectBids.status, ["submitted", "shortlisted"]),
  ));
  for (const other of others) await patch(db, projectBids, other, { status: "rejected", decision_note: "Not selected" });
  await patch(db, projectBids, b, { status: "awarded", decision_note: note ?? null });
  await patch(db, capitalProjects, p, {
    status: "awarded", contractor_vendor_id: b.vendor_id, awarded_bid_id: b.id, contract_amount: b.amount,
    updated_by_id: actor.id,
  });
  await _approval(db, p, "award", "approved", actor, { amount: num(b.amount), reference_id: b.id, note });
  await _record(db, actor, "capital_project.awarded", "capital_project", p.id, {
    summary: note, changes: { vendor_id: b.vendor_id, contract_amount: b.amount },
  });
  await db.commit();
  return p;
}

export async function addChangeOrder(db: Db, p: CapitalProject, data: ChangeOrderIn, actor: CurrentUser): Promise<ChangeOrder> {
  if (p.status !== "awarded" && p.status !== "in_progress") throw _422("Change orders apply to awarded or in-progress projects");
  const [{ m }] = await db.select({ m: sql<number>`coalesce(max(${changeOrders.number}), 0)` }).from(changeOrders)
    .where(eq(changeOrders.project_id, p.id));
  const number = Number(m || 0) + 1;
  const co = await insert(db, changeOrders, {
    project_id: p.id, number, ...dense(changeOrderIn, data), status: "pending", created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
  await linkDocuments(db, [data.document_id], "change_order", co.id, actor);
  await raiseAlert(db, {
    title: `Change order #${number} needs approval: ${p.name}`, reason: `${data.title} ($${fmt(data.amount)}).`,
    severity: "medium", related_type: "capital_project", related_id: p.id, related_label: p.name,
    rule_key: "operations.change_order_approval", idempotency_key: `change_order:${co.id}`,
  } as never);
  await _record(db, actor, "capital_project.change_order_requested", "capital_project", p.id, {
    summary: `CO #${number} ${data.title}`, changes: { amount: data.amount, days_impact: data.days_impact ?? null },
  });
  await db.commit();
  return co;
}

export async function getChangeOrder(db: Db, co_id: string): Promise<ChangeOrder> {
  const co = await get(db, changeOrders, co_id);
  if (!co || co.deleted_at) throw _404("Change order");
  return co;
}

export async function decideChangeOrder(
  db: Db, co: ChangeOrder, decision: string, note: string | null | undefined, actor: CurrentUser,
): Promise<ChangeOrder> {
  if (co.status !== "pending") throw _422("This change order was already decided");
  const p = await getProject(db, co.project_id);
  if (decision === "rejected" && !(note || "").trim()) throw _422("A note is required when rejecting");
  if (decision === "approved") {
    _checkCapitalLimit(actor, Math.abs(num(co.amount)));
    const new_budget = num(p.current_budget) + num(co.amount);
    await _budgetEntry(db, p, "change_order", new_budget, `CO #${co.number}: ${co.title}`, actor, co.id);
    const set: Record<string, any> = { contract_amount: num(p.contract_amount) + num(co.amount) };
    if (co.days_impact && p.target_completion_on) set.target_completion_on = addDays(p.target_completion_on, co.days_impact);
    await patch(db, capitalProjects, p, set as never);
  }
  await patch(db, changeOrders, co, {
    status: decision, decided_by_id: actor.id, decided_at: utcnow(), decision_note: note ?? null,
  });
  await _approval(db, p, "change_order", decision, actor, { amount: num(co.amount), reference_id: co.id, note });
  await _record(db, actor, `capital_project.change_order_${decision}`, "capital_project", p.id, {
    summary: `CO #${co.number} ${co.title}`,
    changes: { amount: co.amount, current_budget: p.current_budget, contract_amount: p.contract_amount },
  });
  await db.commit();
  return co;
}

export async function addDraw(db: Db, p: CapitalProject, data: DrawIn, actor: CurrentUser): Promise<ProjectDraw> {
  if (!["awarded", "in_progress", "completed"].includes(p.status)) throw _422("Draws apply to awarded projects");
  const [{ t }] = await db.select({ t: sql<string>`coalesce(sum(${projectDraws.amount}), 0)` }).from(projectDraws)
    .where(and(eq(projectDraws.project_id, p.id), ne(projectDraws.status, "rejected"), isNull(projectDraws.deleted_at)));
  const drawn = Number(t || 0);
  if (drawn + data.amount > num(p.contract_amount) + 0.005) {
    throw _422(`Draws would total $${fmt(drawn + data.amount)}, above the contract amount $${fmt(num(p.contract_amount))}`);
  }
  const [{ m }] = await db.select({ m: sql<number>`coalesce(max(${projectDraws.number}), 0)` }).from(projectDraws)
    .where(eq(projectDraws.project_id, p.id));
  const number = Number(m || 0) + 1;
  const d = await insert(db, projectDraws, {
    project_id: p.id, number, ...dense(drawIn, data), status: "requested", created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
  await linkDocuments(db, [data.lien_waiver_document_id], "lien_waiver", d.id, actor);
  await _record(db, actor, "capital_project.draw_requested", "capital_project", p.id, {
    summary: `Draw #${number}`, changes: { amount: data.amount },
  });
  await db.commit();
  return d;
}

export async function getDraw(db: Db, draw_id: string): Promise<ProjectDraw> {
  const d = await get(db, projectDraws, draw_id);
  if (!d || d.deleted_at) throw _404("Draw");
  return d;
}

export async function updateDraw(db: Db, d: ProjectDraw, data: DrawUpdate, actor: CurrentUser): Promise<ProjectDraw> {
  const values = defined(data);
  const changes = diff(d, values);
  if (Object.keys(values).length) await patch(db, projectDraws, d, values as never);
  if (Object.keys(changes).length) {
    await linkDocuments(db, [values.lien_waiver_document_id], "lien_waiver", d.id, actor);
    await _record(db, actor, "capital_project.draw_updated", "capital_project", d.project_id, {
      summary: `Draw #${d.number}`, changes,
    });
  }
  await db.commit();
  return d;
}

export async function decideDraw(db: Db, d: ProjectDraw, decision: string, note: string | null | undefined, actor: CurrentUser): Promise<ProjectDraw> {
  if (d.status !== "requested") throw _422("This draw was already decided");
  const p = await getProject(db, d.project_id);
  const set: Record<string, any> = {};
  if (decision === "approved") {
    if (!d.lien_waiver_document_id && !(await linkedDocumentCounts(db, "lien_waiver", [d.id])).get(d.id)) {
      throw _422("A lien waiver must be attached before the draw can be approved");
    }
    if (p.contractor_vendor_id) {
      const [ok, reasons] = await vendorIsCompliant(db, p.contractor_vendor_id);
      if (!ok) throw _422("Contractor is not compliant; draw approval is blocked", { reasons });
    }
    _checkCapitalLimit(actor, num(d.amount));
    set.approved_by_id = actor.id;
    set.approved_at = utcnow();
  } else if (!(note || "").trim()) {
    throw _422("A note is required when rejecting");
  }
  set.status = decision;
  if (note) set.notes = d.notes ? `${d.notes}\n${note}` : note;
  await patch(db, projectDraws, d, set as never);
  await _approval(db, p, "draw", decision, actor, { amount: num(d.amount), reference_id: d.id, note });
  await _record(db, actor, `capital_project.draw_${decision}`, "capital_project", p.id, {
    summary: `Draw #${d.number}`, changes: { amount: d.amount },
  });
  await db.commit();
  return d;
}

export async function payDraw(db: Db, d: ProjectDraw, paid_on: string, reference: string | null | undefined, actor: CurrentUser): Promise<ProjectDraw> {
  if (d.status !== "approved") throw _422("Only approved draws can be marked paid");
  await patch(db, projectDraws, d, { status: "paid", paid_on, payment_reference: reference ?? null });
  await _record(db, actor, "capital_project.draw_paid", "capital_project", d.project_id, {
    summary: `Draw #${d.number}`, changes: { amount: d.amount, paid_on, reference: reference ?? null },
  });
  await db.commit();
  return d;
}

/** Share of the project cost recoverable from tenants under applicable leases (amortized over useful life). */
export async function analyzeRecoverability(db: Db, p: CapitalProject, actor: CurrentUser): Promise<CapitalProject> {
  const leaseRows = await db.select().from(leases).where(and(
    eq(leases.property_id, p.property_id), eq(leases.status, "active"), isNull(leases.deleted_at),
  ));
  const life = p.useful_life_years || 10;
  const cost = num(p.current_budget);
  const total_sf = leaseRows.reduce((a, l) => a + num(l.rentable_sf), 0) || null;
  const leaseIds = leaseRows.map((l) => l.id);
  const recs = leaseIds.length
    ? group(
      await db.select().from(leaseRecoveries).where(and(inArray(leaseRecoveries.lease_id, leaseIds), isNull(leaseRecoveries.deleted_at))),
      (r) => r.lease_id!,
    )
    : new Map<string, (typeof leaseRecoveries.$inferSelect)[]>();
  const clauses = leaseIds.length
    ? group(
      await db.select().from(leaseClauses).where(and(inArray(leaseClauses.lease_id, leaseIds), isNull(leaseClauses.deleted_at))),
      (c) => c.lease_id!,
    )
    : new Map<string, (typeof leaseClauses.$inferSelect)[]>();

  const results: Record<string, any>[] = [];
  let recoverable_total = 0;
  for (const l of leaseRows) {
    const sf = num(l.rentable_sf);
    const lrecs = recs.get(l.id) ?? [];
    let share: number | null = null;
    for (const r of lrecs) {
      const val = r.pro_rata_share;
      if (val) {
        share = Number(val) * (Number(val) <= 1 ? 100 : 1);
        break;
      }
    }
    if (share === null && total_sf) share = round((100 * sf) / total_sf, 2);
    const text = (clauses.get(l.id) ?? []).map((c) => String(c.summary || c.quoted_text || "")).join(" ").toLowerCase();
    const rec_text = lrecs.map((r) => `${""} ${r.category} ${r.notes ?? "None"}`).join(" ").toLowerCase();
    const excluded = ["capital expenditures are excluded", "excluding capital", "shall not include capital"].some((t) => text.includes(t));
    let allowed = (rec_text.includes("capital") || text.includes("amortiz") || text.includes("capital improvement")) && !excluded;
    const lease_type = String(l.lease_type || "").toLowerCase();
    if (!allowed && !excluded && (lease_type === "absolute_net" || lease_type === "bondable")) allowed = true;
    let reason: string;
    if (allowed) reason = text.includes("amortiz") ? "Lease permits recovery of amortized capital costs" : "Recovery terms include capital items";
    else if (excluded) reason = "Lease excludes capital expenditures from recoveries";
    else reason = "No capital recovery provision found";
    const amount = allowed ? round((cost * (share || 0)) / 100, 2) : 0;
    recoverable_total += amount;
    results.push({
      lease_id: String(l.id), tenant_name: l.tenant_name ?? null, lease_type: l.lease_type ?? null,
      rentable_sf: sf || null, share_pct: share, recoverable: allowed, recoverable_amount: amount,
      annual_recovery: allowed ? round(amount / life, 2) : 0, reason,
    });
  }
  const recoverability = {
    project_cost: cost, useful_life_years: life, lease_count: leaseRows.length,
    recoverable_amount: round(recoverable_total, 2),
    recoverable_pct: cost ? round((100 * recoverable_total) / cost, 2) : null,
    annual_recovery: round(recoverable_total / life, 2), leases: results,
    status: recoverable_total > 0 ? "recoverable" : leaseRows.length ? "not_recoverable" : "no_leases",
  };
  await patch(db, capitalProjects, p, { recoverability, recoverability_analyzed_at: utcnow() });
  await _record(db, actor, "capital_project.recoverability_analyzed", "capital_project", p.id, {
    changes: { recoverable_amount: recoverability.recoverable_amount, recoverable_pct: recoverability.recoverable_pct },
  });
  await db.commit();
  return p;
}

// ======================================================================= insurance

const POLICY_IN_KEYS = [
  "property_id", "asset_id", "policy_number", "coverage_type", "carrier", "broker", "named_insured", "limit_amount",
  "aggregate_limit", "deductible", "premium", "effective_on", "expires_on", "status", "document_id", "renewal_of_id",
  "notes",
] as const;

export async function policyItems(db: Db, rows: InsurancePolicy[]) {
  const names = await propertyNames(db, rows.map((p) => p.property_id));
  const claims = new Map<string, number>();
  if (rows.length) {
    const r = await db
      .select({ id: insuranceClaims.policy_id, n: sql<number>`count(*)::int` })
      .from(insuranceClaims)
      .where(and(
        inArray(insuranceClaims.policy_id, rows.map((p) => p.id)), notInArray(insuranceClaims.status, ["closed", "denied", "paid"]),
        isNull(insuranceClaims.deleted_at),
      ))
      .groupBy(insuranceClaims.policy_id);
    for (const x of r) claims.set(x.id!, Number(x.n));
  }
  return rows.map((p) => ({
    ...pick(p, POLICY_IN_KEYS),
    id: p.id,
    property_name: p.property_id ? names.get(p.property_id) ?? null : null,
    days_to_expiry: _days(p.expires_on),
    open_claims: num(claims.get(p.id)),
    updated_at: p.updated_at,
  }));
}

export function policyQuery(
  q: string | undefined, coverage_type: string[] | undefined, status_: string[] | undefined,
  property_id: string | undefined, expiring_within_days: number | undefined, o: { skip?: Set<string> } = {},
): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = insurancePolicies;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.policy_number, t.carrier, t.broker, t.named_insured]),
    skip.has("coverage_type") ? undefined : inFilter(t.coverage_type, coverage_type),
    skip.has("status") ? undefined : inFilter(t.status, status_),
    property_id ? eq(t.property_id, property_id) : undefined,
    expiring_within_days !== undefined && expiring_within_days !== null
      ? sql`${t.expires_on} <= ${addDays(today(), expiring_within_days)}`
      : undefined,
  );
}

export async function getPolicy(db: Db, policy_id: string): Promise<InsurancePolicy> {
  const p = await get(db, insurancePolicies, policy_id);
  if (!p || p.deleted_at) throw _404("Policy");
  return p;
}

export async function savePolicy(db: Db, data: PolicyIn, actor: CurrentUser, p: InsurancePolicy | null = null): Promise<InsurancePolicy> {
  if (data.expires_on <= data.effective_on) throw _422("Expiration must be after the effective date");
  await _requireProperty(db, data.property_id);
  const values = dense(policyIn, data);
  if (!values.asset_id) values.asset_id = await assetForProperty(db, data.property_id);
  let row: InsurancePolicy;
  if (p === null) {
    row = await insert(db, insurancePolicies, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
    await _record(db, actor, "insurance_policy.created", "insurance_policy", row.id, { summary: `${row.carrier} ${row.policy_number}` });
  } else {
    const changes = diff(p, values);
    row = await patch(db, insurancePolicies, p, { ...values, updated_by_id: actor.id } as never);
    if (Object.keys(changes).length) await _record(db, actor, "insurance_policy.updated", "insurance_policy", row.id, { changes });
  }
  await linkDocuments(db, [data.document_id], "insurance_policy", row.id, actor);
  if (row.status === "active" || row.status === "pending_renewal") {
    await criticalDate(db, {
      related_type: "insurance_policy", related_id: row.id, date_type: "insurance_expiration",
      label: `${row.carrier} ${spaced(row.coverage_type)} policy expires`, due_on: row.expires_on,
      property_id: row.property_id, actor, lead_days: POLICY_WARNING_DAYS,
    });
  }
  await db.commit();
  return row;
}

export async function archivePolicy(db: Db, p: InsurancePolicy, actor: CurrentUser): Promise<void> {
  await patch(db, insurancePolicies, p, { deleted_at: utcnow() });
  await _record(db, actor, "insurance_policy.archived", "insurance_policy", p.id, { summary: p.policy_number });
  await db.commit();
}

export function evaluateCertificate(
  c: Pick<InsuranceCertificate, "received_on" | "expires_on" | "required_limit" | "limit_amount" | "additional_insured_required" | "additional_insured">,
  today_: string = today(),
): [string, string[]] {
  if (!c.received_on) return ["requested", []];
  const issues: string[] = [];
  if (c.expires_on && c.expires_on < today_) return ["expired", [`Expired on ${c.expires_on}`]];
  if (c.required_limit && (c.limit_amount || 0) < c.required_limit) {
    issues.push(`Limit $${fmt(num(c.limit_amount), 0)} is below the required $${fmt(num(c.required_limit), 0)}`);
  }
  if (c.additional_insured_required && !c.additional_insured) issues.push("Owner is not named as additional insured");
  if (!c.expires_on) issues.push("Expiration date missing");
  return [issues.length ? "deficient" : "compliant", issues];
}

const CERT_IN_KEYS = [
  "holder_kind", "vendor_id", "tenant_organization_id", "tenant_name", "lease_id", "property_id", "coverage_type",
  "carrier", "policy_number", "limit_amount", "required_limit", "additional_insured", "additional_insured_required",
  "effective_on", "expires_on", "received_on", "requested_on", "document_id", "notes",
] as const;

export async function certificateItems(db: Db, rows: InsuranceCertificate[]) {
  const names = await propertyNames(db, rows.map((c) => c.property_id));
  const vens = await vendorNames(db, rows.map((c) => c.vendor_id));
  return rows.map((c) => ({
    ...pick(c, CERT_IN_KEYS),
    id: c.id,
    status: c.status,
    deficiencies: c.deficiencies,
    holder_name: (c.holder_kind === "vendor" && c.vendor_id ? vens.get(c.vendor_id) : c.tenant_name) || c.tenant_name || null,
    property_name: c.property_id ? names.get(c.property_id) ?? null : null,
    days_to_expiry: _days(c.expires_on),
    updated_at: c.updated_at,
  }));
}

export function certificateQuery(
  q: string | undefined, holder_kind: string[] | undefined, status_: string[] | undefined,
  property_id: string | undefined, vendor_id: string | undefined, o: { skip?: Set<string> } = {},
): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = insuranceCertificates;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.tenant_name, t.carrier, t.policy_number]),
    skip.has("holder_kind") ? undefined : inFilter(t.holder_kind, holder_kind),
    skip.has("status") ? undefined : inFilter(t.status, status_),
    property_id ? eq(t.property_id, property_id) : undefined,
    vendor_id ? eq(t.vendor_id, vendor_id) : undefined,
  );
}

export async function getCertificate(db: Db, cert_id: string): Promise<InsuranceCertificate> {
  const c = await get(db, insuranceCertificates, cert_id);
  if (!c || c.deleted_at) throw _404("Certificate");
  return c;
}

export async function saveCertificate(
  db: Db, data: CertificateIn, actor: CurrentUser, c: InsuranceCertificate | null = null,
): Promise<InsuranceCertificate> {
  if (data.holder_kind === "vendor" && !data.vendor_id) throw _422("Select the vendor this certificate belongs to");
  if (data.holder_kind === "tenant" && !(data.tenant_name || data.tenant_organization_id || data.lease_id)) {
    throw _422("Identify the tenant (name, organization or lease)");
  }
  await _requireProperty(db, data.property_id);
  const values = dense(certificateIn, data);
  let row: InsuranceCertificate;
  let action: string;
  let changes: Record<string, any> | null;
  if (c === null) {
    const [status, deficiencies] = evaluateCertificate(values as never);
    row = await insert(db, insuranceCertificates, {
      ...values, status, deficiencies, created_by_id: actor.id, updated_by_id: actor.id,
    } as never);
    action = "insurance_certificate.created";
    changes = null;
  } else {
    changes = diff(c, values);
    const [status, deficiencies] = evaluateCertificate({ ...c, ...values } as never);
    row = await patch(db, insuranceCertificates, c, { ...values, status, deficiencies, updated_by_id: actor.id } as never);
    action = "insurance_certificate.updated";
  }
  await linkDocuments(db, [data.document_id], "insurance_certificate", row.id, actor);
  await _record(db, actor, action, "insurance_certificate", row.id, { changes, summary: `${row.holder_kind}: ${row.status}` });
  await db.commit();
  return row;
}

export async function archiveCertificate(db: Db, c: InsuranceCertificate, actor: CurrentUser): Promise<void> {
  await patch(db, insuranceCertificates, c, { deleted_at: utcnow() });
  await _record(db, actor, "insurance_certificate.archived", "insurance_certificate", c.id);
  await db.commit();
}

const CLAIM_IN_KEYS = [
  "policy_id", "property_id", "claim_number", "incident_on", "reported_on", "cause", "description", "claimed_amount",
  "reserve_amount", "paid_amount", "deductible_applied", "adjuster_name", "adjuster_contact", "work_order_id",
] as const;

export async function claimItems(db: Db, rows: InsuranceClaim[]) {
  const names = await propertyNames(db, rows.map((c) => c.property_id));
  const pols = new Map<string, InsurancePolicy>();
  const polIds = ids(rows.map((c) => c.policy_id));
  if (polIds.length) {
    for (const p of await db.select().from(insurancePolicies).where(inArray(insurancePolicies.id, polIds))) pols.set(p.id, p);
  }
  return rows.map((c) => {
    const pol = c.policy_id ? pols.get(c.policy_id) : undefined;
    return {
      ...pick(c, CLAIM_IN_KEYS),
      id: c.id,
      status: c.status,
      status_history: c.status_history,
      closed_on: c.closed_on,
      property_name: c.property_id ? names.get(c.property_id) ?? null : null,
      policy_label: pol ? `${pol.carrier} · ${pol.policy_number}` : null,
      updated_at: c.updated_at,
    };
  });
}

export function claimQuery(
  q: string | undefined, status_: string[] | undefined, property_id: string | undefined, policy_id: string | undefined,
  o: { skip?: Set<string> } = {},
): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = insuranceClaims;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.claim_number, t.description, t.cause, t.adjuster_name]),
    skip.has("status") ? undefined : inFilter(t.status, status_),
    property_id ? eq(t.property_id, property_id) : undefined,
    policy_id ? eq(t.policy_id, policy_id) : undefined,
  );
}

export async function getClaim(db: Db, claim_id: string): Promise<InsuranceClaim> {
  const c = await get(db, insuranceClaims, claim_id);
  if (!c || c.deleted_at) throw _404("Claim");
  return c;
}

export async function saveClaim(db: Db, data: ClaimIn, actor: CurrentUser, c: InsuranceClaim | null = null): Promise<InsuranceClaim> {
  const values = dense(claimIn, data);
  if (data.policy_id && !data.property_id) values.property_id = (await getPolicy(db, data.policy_id)).property_id;
  await _requireProperty(db, values.property_id as string | null);
  let row: InsuranceClaim;
  if (c === null) {
    row = await insert(db, insuranceClaims, {
      ...values, status: "reported", created_by_id: actor.id, updated_by_id: actor.id,
      status_history: [{ from: null, to: "reported", at: utcnow().toISOString(), by_name: actor.full_name, note: null }],
    } as never);
    await _record(db, actor, "insurance_claim.created", "insurance_claim", row.id, { summary: row.claim_number || row.cause });
  } else {
    const changes = diff(c, values);
    row = await patch(db, insuranceClaims, c, { ...values, updated_by_id: actor.id } as never);
    if (Object.keys(changes).length) await _record(db, actor, "insurance_claim.updated", "insurance_claim", row.id, { changes });
  }
  await db.commit();
  return row;
}

export async function setClaimStatus(
  db: Db, c: InsuranceClaim, to: string, note: string | null | undefined, paid_amount: number | null | undefined,
  actor: CurrentUser,
): Promise<InsuranceClaim> {
  if (c.status === "closed") throw _422("This claim is closed");
  const previous = c.status;
  const set: Record<string, any> = {
    status_history: [...(c.status_history || []), { from: previous, to, at: utcnow().toISOString(), by_name: actor.full_name, note: note ?? null }],
    status: to,
  };
  if (paid_amount !== null && paid_amount !== undefined) set.paid_amount = paid_amount;
  if (to === "closed") set.closed_on = today();
  await patch(db, insuranceClaims, c, set as never);
  await _record(db, actor, "insurance_claim.status_changed", "insurance_claim", c.id, {
    summary: note, changes: { status: { from: previous, to }, paid_amount: c.paid_amount },
  });
  await db.commit();
  return c;
}

// ======================================================================= property tax

const ASSESSMENT_IN_KEYS = [
  "property_id", "parcel_id", "tax_year", "jurisdiction", "account_number", "assessed_land", "assessed_improvements",
  "assessed_total", "market_value", "taxable_value", "tax_rate", "estimated_tax", "notice_received_on",
  "protest_deadline_on", "source", "observed_on", "notes",
] as const;

export async function assessmentItems(db: Db, rows: TaxAssessment[]) {
  const names = await propertyNames(db, rows.map((a) => a.property_id));
  const prior = new Map<string, number>();
  const protests = new Map<string, TaxProtest>();
  const akey = (pid: string, parcel: string | null, year: number) => `${pid}|${parcel ?? ""}|${year}`;
  if (rows.length) {
    const props = ids(rows.map((a) => a.property_id));
    for (const a of await db.select().from(taxAssessments).where(and(inArray(taxAssessments.property_id, props), isNull(taxAssessments.deleted_at)))) {
      prior.set(akey(a.property_id, a.parcel_id, a.tax_year), a.assessed_total);
    }
    for (const pr of await db.select().from(taxProtests).where(and(inArray(taxProtests.assessment_id, rows.map((a) => a.id)), isNull(taxProtests.deleted_at)))) {
      protests.set(pr.assessment_id, pr);
    }
  }
  return rows.map((a) => {
    const prev = prior.get(akey(a.property_id, a.parcel_id, a.tax_year - 1)) ?? null;
    const pr = protests.get(a.id);
    return {
      ...pick(a, ASSESSMENT_IN_KEYS),
      id: a.id,
      property_name: names.get(a.property_id) ?? null,
      prior_assessed_total: prev,
      change_pct: prev ? round((100 * (num(a.assessed_total) - num(prev))) / num(prev), 2) : null,
      protest_id: pr ? pr.id : null,
      protest_status: pr ? pr.status : null,
      updated_at: a.updated_at,
    };
  });
}

export async function getAssessment(db: Db, assessment_id: string): Promise<TaxAssessment> {
  const a = await get(db, taxAssessments, assessment_id);
  if (!a || a.deleted_at) throw _404("Assessment");
  return a;
}

export async function saveAssessment(db: Db, data: AssessmentIn, actor: CurrentUser, a: TaxAssessment | null = null): Promise<TaxAssessment> {
  await _requireProperty(db, data.property_id);
  const values = dense(assessmentIn, data);
  if ((values.estimated_tax === null || values.estimated_tax === undefined) && data.tax_rate) {
    values.estimated_tax = round((num(data.taxable_value || data.assessed_total) * data.tax_rate) / 100, 2);
  }
  const t = taxAssessments;
  const [dup] = await db.select({ id: t.id }).from(t).where(and(
    eq(t.property_id, data.property_id), eq(t.tax_year, data.tax_year), isNull(t.deleted_at),
    data.parcel_id ? eq(t.parcel_id, data.parcel_id) : isNull(t.parcel_id),
    a ? ne(t.id, a.id) : undefined,
  )).limit(1);
  if (dup) throw new HttpError(409, `An assessment for ${data.tax_year} already exists; edit it instead`);
  let row: TaxAssessment;
  if (a === null) {
    row = await insert(db, taxAssessments, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
    await _record(db, actor, "tax_assessment.created", "tax_assessment", row.id, {
      summary: `${row.tax_year}: $${fmt(row.assessed_total, 0)}`,
    });
  } else {
    const changes = diff(a, values);
    row = await patch(db, taxAssessments, a, { ...values, updated_by_id: actor.id } as never);
    if (Object.keys(changes).length) { // corrections are kept in the audit trail with before/after values
      await _record(db, actor, "tax_assessment.updated", "tax_assessment", row.id, { changes });
    }
  }
  await criticalDate(db, {
    related_type: "tax_assessment", related_id: row.id, date_type: "tax_protest_deadline",
    label: `${row.tax_year} tax protest deadline`, due_on: row.protest_deadline_on, property_id: row.property_id,
    actor, lead_days: 30, is_blocking: true,
  });
  await db.commit();
  return row;
}

export async function archiveAssessment(db: Db, a: TaxAssessment, actor: CurrentUser): Promise<void> {
  await patch(db, taxAssessments, a, { deleted_at: utcnow() });
  await _record(db, actor, "tax_assessment.archived", "tax_assessment", a.id, { summary: String(a.tax_year) });
  await db.commit();
}

const PROTEST_OUT_KEYS = [
  "id", "assessment_id", "property_id", "tax_year", "status", "deadline_on", "filed_on", "consultant_organization_id",
  "consultant_name", "consultant_fee_pct", "consultant_fee_flat", "owner_opinion_value", "evidence_document_ids",
  "evidence_notes", "hearing_on", "hearing_result", "final_value", "value_reduction", "tax_savings", "consultant_fee",
  "net_savings", "resolved_on", "notes", "updated_at",
] as const;

export async function protestItems(db: Db, rows: TaxProtest[]) {
  const names = await propertyNames(db, rows.map((p) => p.property_id));
  const totals = new Map<string, number>();
  if (rows.length) {
    const r = await db.select({ id: taxAssessments.id, t: taxAssessments.assessed_total }).from(taxAssessments)
      .where(inArray(taxAssessments.id, ids(rows.map((p) => p.assessment_id))));
    for (const x of r) totals.set(x.id, x.t);
  }
  return rows.map((p) => ({
    ...pick(p, PROTEST_OUT_KEYS),
    property_name: names.get(p.property_id) ?? null,
    assessed_total: totals.get(p.assessment_id) ?? null,
    days_to_deadline: p.status === "considering" ? _days(p.deadline_on) : null,
  }));
}

export async function getProtest(db: Db, protest_id: string): Promise<TaxProtest> {
  const p = await get(db, taxProtests, protest_id);
  if (!p || p.deleted_at) throw _404("Protest");
  return p;
}

async function _protestDates(db: Db, p: TaxProtest, actor: CurrentUser): Promise<void> {
  await criticalDate(db, {
    related_type: "tax_protest", related_id: p.id, date_type: "tax_protest_deadline",
    label: `${p.tax_year} tax protest filing deadline`, due_on: p.deadline_on, property_id: p.property_id, actor,
    lead_days: 30, is_blocking: true, status_: p.status === "considering" ? "confirmed" : "completed",
  });
  await criticalDate(db, {
    related_type: "tax_protest", related_id: p.id, date_type: "tax_protest_hearing",
    label: `${p.tax_year} tax protest hearing`, due_on: p.hearing_on, property_id: p.property_id, actor, lead_days: 14,
    status_: p.hearing_result ? "completed" : "confirmed",
  });
}

export async function createProtest(db: Db, data: ProtestIn, actor: CurrentUser): Promise<TaxProtest> {
  const a = await getAssessment(db, data.assessment_id);
  const [existing] = await db.select({ id: taxProtests.id }).from(taxProtests)
    .where(and(eq(taxProtests.assessment_id, a.id), isNull(taxProtests.deleted_at))).limit(1);
  if (existing) throw new HttpError(409, "A protest already exists for this assessment");
  const values = dense(protestIn, data);
  values.evidence_document_ids = data.evidence_document_ids;
  values.deadline_on = data.deadline_on || a.protest_deadline_on;
  const p = await insert(db, taxProtests, {
    ...values, property_id: a.property_id, tax_year: a.tax_year, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await linkDocuments(db, data.evidence_document_ids, "tax_protest", p.id, actor);
  await _protestDates(db, p, actor);
  await _record(db, actor, "tax_protest.created", "tax_protest", p.id, { summary: `${p.tax_year} protest` });
  await db.commit();
  return p;
}

export async function updateProtest(db: Db, p: TaxProtest, data: ProtestUpdate, actor: CurrentUser): Promise<TaxProtest> {
  const values = defined(data);
  const changes = diff(p, values);
  if (!Object.keys(changes).length) return p;
  const current = new Set(p.evidence_document_ids || []);
  const newDocs = ((values.evidence_document_ids as string[] | null | undefined) || []).filter((d, i, arr) => !current.has(d) && arr.indexOf(d) === i);
  const set: Record<string, any> = { ...values };
  if ("evidence_document_ids" in values) set.evidence_document_ids = values.evidence_document_ids || [];
  const filedOn = "filed_on" in set ? set.filed_on : p.filed_on;
  if (values.status === "filed" && !filedOn) set.filed_on = today();
  set.updated_by_id = actor.id;
  await patch(db, taxProtests, p, set as never);
  await linkDocuments(db, newDocs, "tax_protest", p.id, actor);
  await _protestDates(db, p, actor);
  await _record(db, actor, "tax_protest.updated", "tax_protest", p.id, { changes });
  await db.commit();
  return p;
}

/** Measured outcome: value reduction x effective rate, net of consultant fees. */
export function protestSavings(
  assessed_total: number, final_value: number | null | undefined, tax_rate: number | null | undefined,
  estimated_tax: number | null | undefined, fee_pct: number | null | undefined, fee_flat: number | null | undefined,
) {
  if (final_value === null || final_value === undefined) {
    return { value_reduction: 0, tax_savings: 0, consultant_fee: num(fee_flat), net_savings: -num(fee_flat) };
  }
  const reduction = round(num(assessed_total) - num(final_value), 2);
  const rate = tax_rate ? tax_rate : estimated_tax && assessed_total ? (100 * num(estimated_tax)) / num(assessed_total) : 0;
  const savings = reduction > 0 ? round((Math.max(reduction, 0) * rate) / 100, 2) : round((reduction * rate) / 100, 2);
  const fee = num(fee_flat) + (fee_pct && savings > 0 ? round((savings * fee_pct) / 100, 2) : 0);
  return { value_reduction: reduction, tax_savings: savings, consultant_fee: round(fee, 2), net_savings: round(savings - fee, 2) };
}

export async function recordHearing(db: Db, p: TaxProtest, data: HearingResultIn, actor: CurrentUser): Promise<TaxProtest> {
  const a = await getAssessment(db, p.assessment_id);
  let final: number | null | undefined = data.final_value;
  if ((data.hearing_result === "no_change" || data.hearing_result === "withdrawn") && (final === null || final === undefined)) {
    final = num(a.assessed_total);
  }
  if (["reduced", "increased", "settled"].includes(data.hearing_result) && (final === null || final === undefined)) {
    throw _422("Enter the final assessed value");
  }
  const result = protestSavings(num(a.assessed_total), final, a.tax_rate, a.estimated_tax, p.consultant_fee_pct, p.consultant_fee_flat);
  const before = Object.fromEntries(
    ["hearing_result", "final_value", "tax_savings", "net_savings", "status"].map((k) => [k, (p as Record<string, any>)[k]]),
  );
  const status = { reduced: "won", no_change: "lost", increased: "lost", settled: "settled", withdrawn: "withdrawn" }[data.hearing_result];
  await patch(db, taxProtests, p, {
    hearing_result: data.hearing_result, final_value: final ?? null, value_reduction: result.value_reduction,
    tax_savings: result.tax_savings, consultant_fee: result.consultant_fee, net_savings: result.net_savings,
    resolved_on: data.resolved_on || today(), status, updated_by_id: actor.id,
  });
  await _protestDates(db, p, actor);
  await _record(db, actor, "tax_protest.resolved", "tax_protest", p.id, {
    summary: data.note,
    changes: _delta(before, {
      hearing_result: p.hearing_result, final_value: final ?? null, tax_savings: p.tax_savings,
      net_savings: p.net_savings, status: p.status,
    }),
  });
  await db.commit();
  return p;
}

export async function taxSummary(db: Db, property_id: string | undefined, tax_year: number | undefined) {
  const rows = await db.select().from(taxProtests).where(and(
    isNull(taxProtests.deleted_at),
    property_id ? eq(taxProtests.property_id, property_id) : undefined,
    tax_year ? eq(taxProtests.tax_year, tax_year) : undefined,
  ));
  const resolved = rows.filter((p) => p.hearing_result);
  const won = resolved.filter((p) => num(p.value_reduction) > 0);
  const total = (k: "value_reduction" | "tax_savings" | "consultant_fee" | "net_savings") =>
    round(resolved.reduce((a, p) => a + num(p[k]), 0), 2);
  return {
    protests: rows.length,
    resolved: resolved.length,
    total_value_reduction: total("value_reduction"),
    total_tax_savings: total("tax_savings"),
    total_consultant_fees: total("consultant_fee"),
    total_net_savings: total("net_savings"),
    success_rate: resolved.length ? round((100 * won.length) / resolved.length, 1) : null,
  };
}

const PAYMENT_OUT_KEYS = [
  "property_id", "assessment_id", "tax_year", "installment", "amount_due", "due_on", "document_id", "notes", "id",
  "amount_paid", "paid_on", "method", "confirmation_number", "status", "confirmed_by_id", "confirmed_at", "updated_at",
] as const;

export async function paymentItems(db: Db, rows: TaxPayment[]) {
  const names = await propertyNames(db, rows.map((p) => p.property_id));
  return rows.map((p) => ({ ...pick(p, PAYMENT_OUT_KEYS), property_name: names.get(p.property_id) ?? null }));
}

export async function getPayment(db: Db, payment_id: string): Promise<TaxPayment> {
  const p = await get(db, taxPayments, payment_id);
  if (!p || p.deleted_at) throw _404("Payment");
  return p;
}

export async function createPayment(db: Db, data: PaymentIn, actor: CurrentUser): Promise<TaxPayment> {
  await _requireProperty(db, data.property_id);
  const p = await insert(db, taxPayments, {
    ...dense(paymentIn, data), status: "scheduled", created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await criticalDate(db, {
    related_type: "tax_payment", related_id: p.id, date_type: "tax_payment_due",
    label: `${p.tax_year} property tax ${p.installment || "payment"} due`, due_on: p.due_on, property_id: p.property_id,
    actor, lead_days: 21, is_blocking: true,
  });
  await _record(db, actor, "tax_payment.scheduled", "tax_payment", p.id, { summary: `$${fmt(p.amount_due)} due ${p.due_on}` });
  await db.commit();
  return p;
}

export async function confirmPayment(db: Db, p: TaxPayment, data: PaymentConfirmIn, actor: CurrentUser): Promise<TaxPayment> {
  if (p.status === "confirmed") throw _422("This payment is already confirmed");
  const before = { status: p.status, amount_paid: p.amount_paid };
  const set: Record<string, any> = {
    amount_paid: data.amount_paid, paid_on: data.paid_on, method: data.method ?? null,
    confirmation_number: data.confirmation_number, status: "confirmed", confirmed_by_id: actor.id,
    confirmed_at: utcnow(),
  };
  if (data.document_id) set.document_id = data.document_id;
  await patch(db, taxPayments, p, set as never);
  await linkDocuments(db, [data.document_id], "tax_payment", p.id, actor);
  await criticalDate(db, {
    related_type: "tax_payment", related_id: p.id, date_type: "tax_payment_due",
    label: `${p.tax_year} property tax ${p.installment || "payment"} due`, due_on: p.due_on, property_id: p.property_id,
    actor, lead_days: 21, is_blocking: true, status_: "completed",
  });
  await _record(db, actor, "tax_payment.confirmed", "tax_payment", p.id, {
    summary: data.confirmation_number, changes: _delta(before, { status: "confirmed", amount_paid: data.amount_paid }),
  });
  await db.commit();
  return p;
}

export async function archivePayment(db: Db, p: TaxPayment, actor: CurrentUser): Promise<void> {
  if (p.status === "confirmed") throw _422("Confirmed payments are retained");
  await patch(db, taxPayments, p, { deleted_at: utcnow() });
  await _record(db, actor, "tax_payment.archived", "tax_payment", p.id);
  await db.commit();
}

// ======================================================================= operating budgets

type Financials = Map<string, [string, number]>; // `${account}\u0000${month}` -> [category, amount]
const cellKey = (account: string, month: number) => `${account}\u0000${month}`;

/** {(account, month): (category, amount)} from assets.asset_financials; null if there is no asset. */
async function _financials(db: Db, asset_id: string | null, year: number): Promise<Financials | null> {
  if (!asset_id) return null;
  const rows = await db.select().from(assetFinancials).where(and(
    eq(assetFinancials.asset_id, asset_id), sql`extract(year from ${assetFinancials.period}) = ${year}`,
    isNull(assetFinancials.deleted_at),
  ));
  const out: Financials = new Map();
  for (const f of rows) {
    const cat = f.category && ["income", "expense", "capex"].includes(f.category) ? f.category : null;
    if (cat === null) continue;
    const key = cellKey(f.account!, Number(f.period!.slice(5, 7)));
    out.set(key, [cat, (out.get(key)?.[1] ?? 0) + num(f.amount)]);
  }
  return out;
}

export async function budgetTotals(db: Db, budgetIds: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (!budgetIds.length) return out;
  const rows = await db
    .select({
      id: budgetLines.budget_id, category: budgetLines.category,
      total: sql<string>`sum(coalesce(${budgetLines.reforecast_amount}, ${budgetLines.amount}))`,
    })
    .from(budgetLines)
    .where(inArray(budgetLines.budget_id, budgetIds))
    .groupBy(budgetLines.budget_id, budgetLines.category);
  for (const r of rows) {
    const e = out.get(r.id) ?? { income: 0, expense: 0, capex: 0 };
    e[r.category] = Number(r.total || 0);
    out.set(r.id, e);
  }
  return out;
}

const BUDGET_LIST_KEYS = [
  "id", "property_id", "asset_id", "fiscal_year", "version", "kind", "name", "status", "parent_budget_id",
  "approved_by_id", "approved_at", "updated_at",
] as const;

export async function budgetItems(db: Db, rows: Budget[]) {
  const names = await propertyNames(db, rows.map((b) => b.property_id));
  const totals = await budgetTotals(db, rows.map((b) => b.id));
  return rows.map((b) => {
    const t = totals.get(b.id) ?? { income: 0, expense: 0, capex: 0 };
    return {
      ...pick(b, BUDGET_LIST_KEYS),
      property_name: names.get(b.property_id) ?? null,
      total_income: t.income, total_expense: t.expense, total_capex: t.capex,
      noi: round(t.income - t.expense, 2),
    };
  });
}

export function budgetQuery(
  q: string | undefined, status_: string[] | undefined, fiscal_year: number[] | undefined,
  property_id: string | undefined, asset_id: string | undefined, current_only: boolean | undefined,
  o: { skip?: Set<string> } = {},
): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = budgets;
  return and(
    isNull(t.deleted_at),
    propertySearch(q, [t.name], t.property_id),
    skip.has("status") ? undefined : inFilter(t.status, status_),
    skip.has("fiscal_year") ? undefined : inFilter(t.fiscal_year, fiscal_year),
    property_id ? eq(t.property_id, property_id) : undefined,
    asset_id ? eq(t.asset_id, asset_id) : undefined,
    current_only ? ne(t.status, "superseded") : undefined,
  );
}

export async function getBudget(db: Db, budget_id: string): Promise<Budget> {
  const b = await get(db, budgets, budget_id);
  if (!b || b.deleted_at) throw _404("Budget");
  return b;
}

export async function budgetOut(db: Db, b: Budget) {
  const base = (await budgetItems(db, [b]))[0];
  const lines = await db.select().from(budgetLines).where(eq(budgetLines.budget_id, b.id));
  const actuals = await _financials(db, b.asset_id, b.fiscal_year);
  type Acc = { category: string; budget: number[]; reforecast: Array<number | null>; prior: Array<number | null> };
  const accounts = new Map<string, Acc>();
  for (const line of lines) {
    let acc = accounts.get(line.account);
    if (!acc) {
      acc = { category: line.category, budget: Array(12).fill(0), reforecast: Array(12).fill(null), prior: Array(12).fill(null) };
      accounts.set(line.account, acc);
    }
    acc.budget[line.month - 1] = num(line.amount);
    acc.reforecast[line.month - 1] = line.reforecast_amount !== null ? Number(line.reforecast_amount) : null;
    acc.prior[line.month - 1] = line.prior_actual !== null ? Number(line.prior_actual) : null;
  }
  const order: Record<string, number> = { income: 0, expense: 1, capex: 2 };
  const sorted = [...accounts.entries()].sort(([an, a], [bn, b2]) => {
    const d = (order[a.category] ?? 9) - (order[b2.category] ?? 9);
    return d !== 0 ? d : an < bn ? -1 : an > bn ? 1 : 0;
  });
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const rows = sorted.map(([account, acc]) => {
    const actual: Array<number | null> = Array(12).fill(null);
    if (actuals && actuals.size) {
      for (let m = 0; m < 12; m++) actual[m] = actuals.get(cellKey(account, m + 1))?.[1] ?? null;
    }
    const months = [...Array(12).keys()].filter((m) => actual[m] !== null);
    const plan = acc.budget.map((bv, m) => (acc.reforecast[m] !== null ? acc.reforecast[m]! : bv));
    const variance = months.length ? round(sum(months.map((m) => actual[m]! - plan[m])), 2) : null;
    const planToDate = sum(months.map((m) => plan[m]));
    const hasRf = acc.reforecast.some((v) => v !== null);
    const hasPrior = acc.prior.some((v) => v !== null);
    return {
      account, category: acc.category, budget: acc.budget, reforecast: acc.reforecast, prior_actual: acc.prior, actual,
      budget_total: round(sum(acc.budget), 2),
      reforecast_total: hasRf ? round(sum(plan), 2) : null,
      prior_actual_total: hasPrior ? round(sum(acc.prior.map((v) => v || 0)), 2) : null,
      actual_total: months.length ? round(sum(months.map((m) => actual[m]!)), 2) : null,
      variance,
      variance_pct: variance !== null && planToDate ? round((100 * variance) / planToDate, 2) : null,
    };
  });
  const versions = await db.select().from(budgets).where(and(
    eq(budgets.property_id, b.property_id), eq(budgets.fiscal_year, b.fiscal_year), isNull(budgets.deleted_at),
  )).orderBy(desc(budgets.version));
  return {
    ...base,
    notes: b.notes,
    approval_note: b.approval_note,
    submitted_at: b.submitted_at,
    superseded_at: b.superseded_at,
    created_at: b.created_at,
    rows,
    versions: await budgetItems(db, versions),
    actuals_available: actuals !== null,
  };
}

async function _loadPrior(db: Db, b: Budget): Promise<number> {
  const prior = await _financials(db, b.asset_id, b.fiscal_year - 1);
  if (!prior || !prior.size) return 0;
  const existing = new Map<string, BudgetLine>();
  for (const l of await db.select().from(budgetLines).where(eq(budgetLines.budget_id, b.id))) existing.set(cellKey(l.account, l.month), l);
  const fresh: Array<Record<string, any>> = [];
  for (const [key, [cat, amount]] of prior) {
    const [account, month] = key.split("\u0000");
    const line = existing.get(key);
    if (!line) {
      fresh.push({ budget_id: b.id, account, category: cat, month: Number(month), amount: round(amount, 2), prior_actual: round(amount, 2) });
    } else {
      await patch(db, budgetLines, line, { prior_actual: round(amount, 2) });
    }
  }
  await insertMany(db, budgetLines, fresh as never[]);
  return prior.size;
}

export async function createBudget(db: Db, data: BudgetIn, actor: CurrentUser): Promise<Budget> {
  await _requireProperty(db, data.property_id);
  const [dup] = await db.select({ id: budgets.id }).from(budgets).where(and(
    eq(budgets.property_id, data.property_id), eq(budgets.fiscal_year, data.fiscal_year), isNull(budgets.deleted_at),
  )).limit(1);
  if (dup) {
    throw new HttpError(409, `A ${data.fiscal_year} budget already exists for this property; create a new version instead`);
  }
  const names = await propertyNames(db, [data.property_id]);
  const b = await insert(db, budgets, {
    property_id: data.property_id, asset_id: await assetForProperty(db, data.property_id), fiscal_year: data.fiscal_year,
    version: 1, kind: "original", status: "draft", notes: data.notes ?? null,
    name: data.name || `${names.get(data.property_id) ?? "Property"} FY${data.fiscal_year} budget`,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  const loaded = data.load_prior_actuals ? await _loadPrior(db, b) : 0;
  await _record(db, actor, "budget.created", "budget", b.id, { summary: b.name, changes: { prior_actual_cells: loaded } });
  await db.commit();
  return b;
}

export async function loadPriorActuals(db: Db, b: Budget, actor: CurrentUser): Promise<Budget> {
  if (b.status !== "draft") throw _422("Only draft budgets can be edited");
  const loaded = await _loadPrior(db, b);
  if (!loaded) throw _422("No prior-year actuals are available for this asset");
  await _record(db, actor, "budget.prior_actuals_loaded", "budget", b.id, { changes: { cells: loaded } });
  await db.commit();
  return b;
}

export async function saveLines(db: Db, b: Budget, data: LinesIn, actor: CurrentUser): Promise<Budget> {
  if (b.status !== "draft") throw _422("Approved and submitted budgets are locked; create a new version to change them");
  type L = { row: BudgetLine | null; account: string; month: number; category: string; amount: number; reforecast_amount: number | null; dirty: boolean };
  const existing = new Map<string, L>();
  for (const l of await db.select().from(budgetLines).where(eq(budgetLines.budget_id, b.id))) {
    existing.set(cellKey(l.account, l.month), {
      row: l, account: l.account, month: l.month, category: l.category, amount: num(l.amount),
      reforecast_amount: l.reforecast_amount, dirty: false,
    });
  }
  let changed = 0;
  for (const cell of data.cells) {
    const account = cell.account.trim();
    const key = cellKey(account, cell.month);
    let line = existing.get(key);
    if (!line) {
      line = { row: null, account, month: cell.month, category: cell.category, amount: 0, reforecast_amount: null, dirty: true };
      existing.set(key, line);
    }
    if (line.category !== cell.category) {
      line.category = cell.category;
      line.dirty = true;
    }
    if (cell.amount !== null && cell.amount !== undefined && line.amount !== cell.amount) {
      line.amount = cell.amount;
      line.dirty = true;
      changed += 1;
    }
    if ("reforecast_amount" in cell && line.reforecast_amount !== (cell.reforecast_amount ?? null)) {
      line.reforecast_amount = cell.reforecast_amount ?? null;
      line.dirty = true;
      changed += 1;
    }
  }
  const fresh = [...existing.values()].filter((l) => l.row === null);
  for (let i = 0; i < fresh.length; i += 500) {
    await insertMany(db, budgetLines, fresh.slice(i, i + 500).map((l) => ({
      budget_id: b.id, account: l.account, category: l.category, month: l.month, amount: l.amount,
      reforecast_amount: l.reforecast_amount,
    })) as never[]);
  }
  for (const l of existing.values()) {
    if (l.row && l.dirty) {
      await patch(db, budgetLines, l.row, { category: l.category, amount: l.amount, reforecast_amount: l.reforecast_amount });
    }
  }
  if (data.remove_accounts.length) {
    await db.delete(budgetLines).where(and(eq(budgetLines.budget_id, b.id), inArray(budgetLines.account, data.remove_accounts)));
  }
  await patch(db, budgets, b, { updated_by_id: actor.id });
  await _record(db, actor, "budget.lines_updated", "budget", b.id, {
    changes: { cells_changed: changed, accounts_removed: data.remove_accounts.length ? data.remove_accounts : null },
  });
  await db.commit();
  return b;
}

export async function submitBudget(db: Db, b: Budget, actor: CurrentUser): Promise<Budget> {
  if (b.status !== "draft") throw _422("Only draft budgets can be submitted");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(budgetLines).where(eq(budgetLines.budget_id, b.id));
  if (!n) throw _422("Add budget lines before submitting");
  await patch(db, budgets, b, { status: "submitted", submitted_at: utcnow() });
  await _record(db, actor, "budget.submitted", "budget", b.id, { changes: { status: { from: "draft", to: "submitted" } } });
  await db.commit();
  return b;
}

export async function decideBudgetApproval(db: Db, b: Budget, decision: string, note: string | null | undefined, actor: CurrentUser): Promise<Budget> {
  if (b.status !== "submitted") throw _422("Submit the budget before approval");
  if (decision === "approved") {
    const prevs = await db.select().from(budgets).where(and(
      eq(budgets.property_id, b.property_id), eq(budgets.fiscal_year, b.fiscal_year), ne(budgets.id, b.id),
      eq(budgets.status, "approved"), isNull(budgets.deleted_at),
    ));
    for (const prev of prevs) {
      await patch(db, budgets, prev, { status: "superseded", superseded_at: utcnow() });
      await _record(db, actor, "budget.superseded", "budget", prev.id, { summary: `by v${b.version}` });
    }
    await patch(db, budgets, b, { status: "approved", approved_by_id: actor.id, approved_at: utcnow(), approval_note: note ?? null });
  } else {
    if (!(note || "").trim()) throw _422("A note is required when returning a budget");
    await patch(db, budgets, b, { status: "draft", approval_note: note ?? null });
  }
  await _record(db, actor, `budget.${decision}`, "budget", b.id, {
    summary: note, changes: { status: { from: "submitted", to: b.status } },
  });
  await db.commit();
  return b;
}

export async function newVersion(db: Db, src: Budget, kind: string, name: string | null | undefined, actor: CurrentUser): Promise<Budget> {
  const [open] = await db.select({ id: budgets.id }).from(budgets).where(and(
    eq(budgets.property_id, src.property_id), eq(budgets.fiscal_year, src.fiscal_year),
    inArray(budgets.status, ["draft", "submitted"]), isNull(budgets.deleted_at),
  )).limit(1);
  if (open) throw _422("A draft or submitted version already exists for this year");
  const [{ m }] = await db.select({ m: sql<number | null>`max(${budgets.version})` }).from(budgets)
    .where(and(eq(budgets.property_id, src.property_id), eq(budgets.fiscal_year, src.fiscal_year)));
  const version = Number(m || 0) + 1;
  const b = await insert(db, budgets, {
    property_id: src.property_id, asset_id: src.asset_id, fiscal_year: src.fiscal_year, version, kind,
    name: name || `${src.name.split(" v")[0]} v${version}${kind === "reforecast" ? " reforecast" : ""}`,
    status: "draft", parent_budget_id: src.id, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  const lines = await db.select().from(budgetLines).where(eq(budgetLines.budget_id, src.id));
  await insertMany(db, budgetLines, lines.map((line) => ({
    budget_id: b.id, account: line.account, category: line.category, month: line.month, amount: line.amount,
    reforecast_amount: line.reforecast_amount, prior_actual: line.prior_actual, notes: line.notes,
  })) as never[]);
  await _record(db, actor, "budget.version_created", "budget", b.id, {
    summary: `v${version} from v${src.version}`, changes: { kind, parent_budget_id: src.id },
  });
  await db.commit();
  return b;
}

export async function archiveBudget(db: Db, b: Budget, actor: CurrentUser): Promise<void> {
  if (b.status === "approved" || b.status === "superseded") throw _422("Approved budget versions are retained");
  await patch(db, budgets, b, { deleted_at: utcnow() });
  await _record(db, actor, "budget.archived", "budget", b.id, { summary: b.name });
  await db.commit();
}
