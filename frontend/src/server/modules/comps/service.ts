/**
 * Comparables & valuation (spec module 13).
 *
 * Rules implemented here:
 * - Verification method, verifying user and date are stored on every comp; editing a material fact of a verified
 *   comp returns it to `unverified` (the change and the prior verification stay in the audit trail).
 * - Excluding a comp from a set requires a reason; the reason and every include/exclude decision are retained.
 * - Indicated values are ranges (low / high / point with the method used), never a bare single number.
 * - Valuations and portfolio marks are append-only, dated records with method and analyst; nothing overwrites them.
 * - Material valuation assumptions carry evidence (comp ids, document id or a source); marks with unsourced
 *   material assumptions are refused.
 */
import {
  and, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as getRow, insert, patch } from "../../db/orm";
import { users } from "../auth/schema";
import * as documentsService from "../documents/service";
import { properties, type Property } from "../properties/schema";
import { uwModels } from "../underwriting/schema";
import { pyPow, pyRound, pySum, truthy } from "../underwriting/pyutil";
import {
  ADJUSTMENT_FACTORS, bovs, compSetItems, compSets, LEASE_BASES, leaseComps, SALE_BASES, saleComps, valuationDocuments,
  valuations, type Bov, type CompSet, type CompSetItem, type LeaseComp, type SaleComp, type Valuation,
  type ValuationDocument,
} from "./schema";
import type {
  AddItemsIn, BovCreate, BovUpdate, CompSetCreate, CompSetUpdate, FromCompSetIn, GridIn, ItemUpdate, LeaseCompCreate,
  LeaseCompUpdate, SaleCompCreate, SaleCompUpdate, ValuationCreate, ValuationDocumentIn, VerificationIn,
} from "./schemas";
import { valuationCreate } from "./schemas";

type Obj = Record<string, any>;
type Kind = "sale" | "lease";
type Comp = SaleComp | LeaseComp;

const MILES = 1609.344;
const SALE_MATERIAL = new Set([
  "sale_date", "sale_price", "price_psf", "price_per_acre", "cap_rate", "noi", "building_area_sf",
  "land_area_acres", "lease_term_remaining_years", "tenant_credit",
]);
const LEASE_MATERIAL = new Set([
  "commencement_on", "term_months", "area_sf", "base_rent_psf", "escalation_pct", "recoveries_psf",
  "free_rent_months", "ti_psf", "effective_rent_psf", "recovery_type",
]);
export const VALUATION_MATERIAL: Record<string, string[]> = {
  direct_cap: ["noi", "cap_rate"],
  dcf: ["discount_rate", "noi_year1", "growth_pct", "exit_cap"],
  land_residual: ["gross_development_value", "development_costs", "soft_costs", "developer_profit_pct"],
  sales_comparison: [],
  appraisal: [],
  bov: [],
};

const FACTORS: readonly string[] = ADJUSTMENT_FACTORS;
const nowIso = () => utcnow().toISOString();
const defined = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const blank = (v: unknown) => v === null || v === undefined || v === "";

/** `patch` that skips the UPDATE when nothing differs (SQLAlchemy only flushes changed attributes). */
async function patchIfChanged<T extends PgTable & { id: any }>(db: Db, table: T, row: T["$inferSelect"], values: Obj) {
  const changed = Object.entries(values).some(([k, v]) => !audit.isEqual((row as Obj)[k], v));
  if (!changed) return row;
  return patch(db, table, row as never, values as never) as Promise<T["$inferSelect"]>;
}

// --------------------------------------------------------------------------- pure helpers

/** Great-circle distance in miles: 2·R·asin(√(sin²(Δφ/2) + cosφ1·cosφ2·sin²(Δλ/2))), R = 3958.8 mi. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dp = p2 - p1;
  const dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

/**
 * Effective rent ($/SF/yr) = (Σ contract rent over the term − free rent − TI) / term years.
 *
 * Contract rent for lease month m (0-based) = base_psf / 12 × (1 + escalation)^⌊m/12⌋; free rent removes the first
 * `free_months` months at the starting rate; TI is a landlord cost per SF.
 */
export function effectiveRentPsf(
  base_psf: number | null | undefined,
  term_months: number | null | undefined,
  escalation_pct: number | null | undefined,
  free_months: number | null | undefined,
  ti_psf: number | null | undefined,
): number | null {
  if (!base_psf || !term_months) return null;
  const g = (escalation_pct || 0) / 100;
  const terms: number[] = [];
  for (let m = 0; m < Math.trunc(term_months); m++) terms.push((base_psf / 12) * pyPow(1 + g, Math.floor(m / 12)));
  let total = pySum(terms);
  total -= (base_psf / 12) * Math.min(Number(free_months || 0), Number(term_months));
  total -= ti_psf || 0;
  return pyRound(total / (term_months / 12), 2);
}

/** Base metric of a sale comp for the set's value basis (derived from price/area/NOI when not stored). */
export function saleMetric(c: SaleComp, basis: string): number | null {
  if (basis === "price_psf") {
    return c.price_psf || (c.sale_price && c.building_area_sf ? c.sale_price / c.building_area_sf : null);
  }
  if (basis === "price_per_acre") {
    return c.price_per_acre || (c.sale_price && c.land_area_acres ? c.sale_price / c.land_area_acres : null);
  }
  if (basis === "cap_rate") {
    return c.cap_rate || (c.noi && c.sale_price ? (c.noi / c.sale_price) * 100 : null);
  }
  return c.sale_price;
}

export function leaseMetric(c: LeaseComp, basis: string): number | null {
  if (basis === "base_rent_psf") return c.base_rent_psf;
  return c.effective_rent_psf || effectiveRentPsf(c.base_rent_psf, c.term_months, c.escalation_pct, c.free_rent_months, c.ti_psf);
}

/**
 * Net adjustment = Σ factor % (location, size, age, condition, lease term, tenant credit, timing);
 * adjusted metric = base × (1 + net / 100). Positive = subject superior to the comp.
 */
export function adjust(base: number | null, adjustments: Record<string, number>): [number, number | null] {
  const net = pySum(ADJUSTMENT_FACTORS.map((f) => Number(adjustments[f] || 0)));
  return [net, base !== null ? base * (1 + net / 100) : null];
}

/** Convert an adjusted metric to subject value: cap rate → NOI / cap; price → metric; else metric × quantity. */
export function metricToValue(metric: number | null, basis: string, qty: number | null | undefined): number | null {
  if (metric === null) return null;
  if (basis === "cap_rate") return qty && metric > 0 ? qty / (metric / 100) : null;
  if (basis === "price") return metric;
  return qty ? metric * qty : null;
}

/**
 * Indicated range from included comps' adjusted metrics with weights w:
 * low = min, high = max, point = Σ w·m / Σ w. For cap rates the value range inverts (high cap → low value).
 */
export function indicatedRange(inRows: Array<[number | null, number | null]>, basis: string, qty: number | null | undefined): Obj {
  const rows = inRows.filter(([m]) => m !== null) as Array<[number, number | null]>;
  if (!rows.length) {
    return {
      count: 0, basis, subject_quantity: qty ?? null, metric_low: null, metric_high: null, metric_point: null,
      value_low: null, value_high: null, value_point: null, method: "No included comps with a usable metric",
    };
  }
  const metrics = rows.map(([m]) => m);
  let weights = rows.map(([, w]) => Math.max(0.0, w || 0.0));
  if (pySum(weights) <= 0) weights = rows.map(() => 1.0);
  const point = pySum(metrics.map((m, i) => m * weights[i])) / pySum(weights);
  const lo = Math.min(...metrics);
  const hi = Math.max(...metrics);
  let v_lo = metricToValue(lo, basis, qty);
  let v_hi = metricToValue(hi, basis, qty);
  const v_pt = metricToValue(point, basis, qty);
  if (basis === "cap_rate") [v_lo, v_hi] = [v_hi, v_lo];
  return {
    count: rows.length, basis, subject_quantity: qty ?? null, metric_low: lo, metric_high: hi, metric_point: point,
    value_low: v_lo, value_high: v_hi, value_point: v_pt,
    method: "Weighted mean of adjusted comps; range is the min–max adjusted comp",
  };
}

/**
 * Direct capitalization: value = NOI / cap. Range uses cap_high → low value and cap_low → high value
 * (± 25 bps around the point cap when no range is given).
 */
export function directCap(noi: number, cap: number, cap_low: number | null | undefined, cap_high: number | null | undefined): Obj {
  if (!noi || !cap || cap <= 0) throw new HttpError(422, "Direct cap needs NOI and a positive cap rate");
  cap_low = cap_low && cap_low > 0 ? cap_low : Math.max(0.01, cap - 0.25);
  cap_high = cap_high && cap_high > 0 ? cap_high : cap + 0.25;
  return {
    value_point: noi / (cap / 100), value_low: noi / (cap_high / 100), value_high: noi / (cap_low / 100),
    calculation: { formula: "NOI / cap rate", noi, cap_rate: cap, cap_low, cap_high },
  };
}

/**
 * DCF: value = Σ_{t=1..n} CF_t / (1 + r)^t, CF_n including net reversion. Range from the discount-rate range
 * (± 50 bps when not given): higher rate → lower value.
 */
export function dcfValue(cfs: number[], rate: number | null, rate_low: number | null | undefined, rate_high: number | null | undefined): Obj {
  if (!cfs.length || rate === null || rate === undefined || rate <= -100) {
    throw new HttpError(422, "DCF needs cash flows and a discount rate");
  }
  const pv = (r: number) => pySum(cfs.map((cf, t) => cf / pyPow(1 + r / 100, t + 1)));
  const lo = rate_low ?? rate - 0.5;
  const hi = rate_high ?? rate + 0.5;
  if (Math.min(lo, hi) <= -100) throw new HttpError(422, "Discount rate range must be above -100%"); // (1 + r)^t = 0
  return {
    value_point: pv(rate), value_low: pv(hi), value_high: pv(lo),
    calculation: {
      formula: "Σ CF_t / (1 + r)^t", cash_flows: cfs.map((c) => pyRound(c, 2)), discount_rate: rate, rate_low: lo, rate_high: hi,
    },
  };
}

/** CF_t = NOI₁ × (1 + g)^(t−1) for t = 1..n; reversion at n = NOI₁ × (1 + g)^n / exit cap × (1 − selling %). */
export function simpleDcfFlows(noi1: number, growth_pct: number, hold: number, exit_cap: number, selling_pct: number): number[] {
  const g = growth_pct / 100;
  const cfs: number[] = [];
  for (let t = 1; t <= hold; t++) cfs.push(noi1 * pyPow(1 + g, t - 1));
  if (exit_cap > 0 && cfs.length) {
    cfs[cfs.length - 1] += (noi1 * pyPow(1 + g, hold)) / (exit_cap / 100) * (1 - selling_pct / 100);
  }
  return cfs;
}

/** Land residual = GDV − hard costs − soft costs − carry − developer profit (profit % × GDV). Range from the GDV range (± 5% when not given). */
export function landResidual(
  gdv: number, dev: number, soft: number, carry: number, profit_pct: number,
  gdv_low: number | null | undefined, gdv_high: number | null | undefined,
): Obj {
  const residual = (g: number) => g - dev - soft - carry - (g * profit_pct) / 100;
  const lo = gdv_low ? gdv_low : gdv * 0.95;
  const hi = gdv_high ? gdv_high : gdv * 1.05;
  return {
    value_point: residual(gdv), value_low: residual(lo), value_high: residual(hi),
    calculation: {
      formula: "GDV − hard − soft − carry − profit% × GDV", gdv, development_costs: dev, soft_costs: soft,
      carry_costs: carry, developer_profit_pct: profit_pct, gdv_low: lo, gdv_high: hi,
    },
  };
}

// --------------------------------------------------------------------------- shared lookups

async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((i): i is string => !!i))];
  if (!uniq.length) return new Map();
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

async function propertyLabels(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((i): i is string => !!i))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
    .from(properties)
    .where(inArray(properties.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name || r.address_line]));
}

async function getProperty(db: Db, property_id: string): Promise<Property> {
  const p = await getRow(db, properties, property_id);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  return p;
}

const locationValue = (lat: number | null | undefined, lng: number | null | undefined) =>
  (lat !== null && lat !== undefined && lng !== null && lng !== undefined
    ? sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
    : null) as unknown as string | null;

/** Link a document via the documents module. */
async function linkDocument(db: Db, document_id: string | null | undefined, entity_type: string, entity_id: string, actor: CurrentUser) {
  if (!document_id) return;
  await documentsService.link(db, document_id, entity_type, entity_id, actor);
}

// --------------------------------------------------------------------------- comps CRUD

export const COMP_MODELS = { sale: saleComps, lease: leaseComps } as const;
const tableOf = (kind: Kind): any => COMP_MODELS[kind];

export interface CompFilters {
  q?: string;
  property_type?: string[];
  verification_status?: string[];
  tenant_credit?: string[];
  state?: string[];
  county?: string;
  corridor?: string;
  property_id?: string;
  date_from?: string;
  date_to?: string;
  min_price?: number;
  max_price?: number;
  min_cap?: number;
  max_cap?: number;
  min_rent?: number;
  max_rent?: number;
}

/** WHERE clause for the comp filters; `skip` leaves a facet's own filter out (for facet counts). */
export function buildCompWhere(kind: Kind, f: CompFilters, skip: Set<string> = new Set()): SQL | undefined {
  const M = tableOf(kind);
  const cols = [M.name, M.address_line, M.city, M.county, M.corridor, M.tenant_name, M.source];
  if (kind === "sale") cols.push(saleComps.buyer_name, saleComps.seller_name);
  const filterCol = (key: "property_type" | "verification_status" | "tenant_credit" | "state") =>
    skip.has(key) ? undefined : inFilter(M[key], f[key]);
  return and(
    isNull(M.deleted_at),
    applySearch(f.q, cols),
    filterCol("property_type"),
    filterCol("verification_status"),
    filterCol("tenant_credit"),
    filterCol("state"),
    f.county ? ilike(M.county, `%${f.county}%`) : undefined,
    f.corridor ? ilike(M.corridor, `%${f.corridor}%`) : undefined,
    f.property_id ? eq(M.property_id, f.property_id) : undefined,
    ...(kind === "sale"
      ? [
          rangeFilter(saleComps.sale_date, f.date_from, f.date_to),
          rangeFilter(saleComps.sale_price, f.min_price, f.max_price),
          rangeFilter(saleComps.cap_rate, f.min_cap, f.max_cap),
        ]
      : [
          rangeFilter(leaseComps.commencement_on, f.date_from, f.date_to),
          rangeFilter(leaseComps.base_rent_psf, f.min_rent, f.max_rent),
        ]),
  );
}

export async function getComp(db: Db, kind: Kind, comp_id: string): Promise<any> {
  const c = await getRow(db, tableOf(kind), comp_id);
  if (!c || c.deleted_at) throw new HttpError(404, "Comp not found");
  return c;
}

const COMMON_OUT = [
  "id", "property_id", "name", "address_line", "city", "state", "county", "corridor", "latitude", "longitude",
  "property_type", "tenant_name", "tenant_organization_id", "tenant_credit", "building_area_sf", "land_area_acres",
  "year_built", "condition", "source", "document_id", "notes", "tags", "verification_status", "verification_method",
  "verification_notes", "verified_by_id", "verified_at", "created_at", "updated_at",
];
const SALE_OUT = [
  "sale_date", "sale_price", "price_psf", "price_per_acre", "cap_rate", "noi", "buyer_name", "buyer_organization_id",
  "seller_name", "seller_organization_id", "financing", "lease_term_remaining_years", "occupancy_pct",
];
const LEASE_OUT = [
  "space_id", "suite", "lease_type", "commencement_on", "term_months", "area_sf", "base_rent_psf", "escalation_pct",
  "escalation_structure", "recovery_type", "recoveries_psf", "free_rent_months", "concessions", "ti_psf",
  "effective_rent_psf",
];

export async function compOut(db: Db, kind: Kind, rows: any[]): Promise<Obj[]> {
  const names = await userNames(db, rows.map((r) => r.verified_by_id));
  const labels = await propertyLabels(db, rows.map((r) => r.property_id));
  const keys = [...COMMON_OUT, ...(kind === "sale" ? SALE_OUT : LEASE_OUT)];
  return rows.map((r) => ({
    ...Object.fromEntries(keys.map((k) => [k, r[k] ?? null])),
    tags: r.tags ?? [],
    verified_by_name: r.verified_by_id ? names.get(r.verified_by_id) ?? null : null,
    property_label: r.property_id ? labels.get(r.property_id) ?? null : null,
  }));
}

/** Comps linked to a known property inherit its location and physical facts when not given. */
async function fillFromProperty(db: Db, c: Obj): Promise<void> {
  if (!c.property_id) return;
  const p: Obj = await getProperty(db, c.property_id);
  for (const field of [
    "address_line", "city", "state", "county", "corridor", "latitude", "longitude", "property_type",
    "building_area_sf", "land_area_acres", "year_built",
  ]) {
    if (blank(c[field]) && !blank(p[field])) c[field] = p[field];
  }
  if (!c.name) c.name = p.name;
}

function derive(kind: Kind, c: Obj): void {
  if (kind === "sale") {
    if (c.sale_price && c.building_area_sf && !c.price_psf) c.price_psf = pyRound(c.sale_price / c.building_area_sf, 2);
    if (c.sale_price && c.land_area_acres && !c.price_per_acre) c.price_per_acre = pyRound(c.sale_price / c.land_area_acres, 2);
    if (c.sale_price && c.noi && !c.cap_rate) c.cap_rate = pyRound((c.noi / c.sale_price) * 100, 3);
  } else if (c.effective_rent_psf === null || c.effective_rent_psf === undefined) {
    c.effective_rent_psf = effectiveRentPsf(c.base_rent_psf, c.term_months, c.escalation_pct, c.free_rent_months, c.ti_psf);
  }
}

function applyVerification(c: Obj, v: VerificationIn, actor: CurrentUser): void {
  if (v.status === "verified" && !v.method) throw new HttpError(422, "Verification method is required");
  c.verification_status = v.status;
  c.verification_method = v.status !== "unverified" ? v.method ?? null : null;
  c.verification_notes = v.notes ?? null;
  c.verified_by_id = v.status !== "unverified" ? actor.id : null;
  c.verified_at = v.status !== "unverified" ? utcnow() : null;
}

/** Persist every editable column of an in-memory comp (the Python session flushed attribute changes). */
async function saveComp(db: Db, kind: Kind, c: Obj, o: { location?: boolean } = {}): Promise<void> {
  const table = tableOf(kind);
  const skip = new Set(["id", "created_at", "updated_at", "created_by_id", "deleted_at", "location"]);
  const set: Obj = {};
  for (const k of Object.keys(getTableColumns(table))) if (!skip.has(k)) set[k] = c[k] ?? null;
  set.deleted_at = c.deleted_at ?? null;
  if (o.location) set.location = locationValue(c.latitude, c.longitude);
  await patch(db, table, c as never, set as never);
}

export async function createComp(db: Db, kind: Kind, data: SaleCompCreate | LeaseCompCreate, actor: CurrentUser) {
  const { verification, ...fields } = data as Obj;
  const c: Obj = { ...defined(fields), created_by_id: actor.id, updated_by_id: actor.id };
  c.tags = c.tags || [];
  await fillFromProperty(db, c);
  derive(kind, c);
  if (verification) applyVerification(c, verification, actor);
  const row: any = await insert(db, tableOf(kind), { ...c, location: locationValue(c.latitude, c.longitude) } as never);
  await linkDocument(db, row.document_id, `${kind}_comp`, row.id, actor);
  await audit.record(db, {
    actor, action: `${kind}_comp.created`, entity_type: `${kind}_comp`, entity_id: row.id,
    summary: row.name || row.address_line || row.tenant_name, ip_address: actor.ip_address,
  });
  await db.commit();
  return row;
}

export async function updateComp(db: Db, kind: Kind, c: any, data: SaleCompUpdate | LeaseCompUpdate, actor: CurrentUser) {
  const values = defined(data as Obj);
  if ("tags" in values && values.tags === null) delete values.tags;
  const changes = audit.diff(c, values);
  if (!Object.keys(changes).length) return c;
  Object.assign(c, values);
  const material = kind === "sale" ? SALE_MATERIAL : LEASE_MATERIAL;
  if (
    kind === "lease" &&
    ["base_rent_psf", "term_months", "escalation_pct", "free_rent_months", "ti_psf"].some((k) => k in changes) &&
    !("effective_rent_psf" in values)
  ) {
    c.effective_rent_psf = null;
  }
  await fillFromProperty(db, c);
  derive(kind, c);
  const relocate = "latitude" in changes || "longitude" in changes || "property_id" in changes;
  if (c.verification_status === "verified" && Object.keys(changes).some((k) => material.has(k))) {
    changes.verification_status = { from: "verified", to: "unverified" };
    c.verification_status = "unverified";
    c.verified_by_id = null;
    c.verified_at = null;
  }
  c.updated_by_id = actor.id;
  await saveComp(db, kind, c, { location: relocate });
  if ("document_id" in changes) await linkDocument(db, c.document_id, `${kind}_comp`, c.id, actor);
  await audit.record(db, {
    actor, action: `${kind}_comp.updated`, entity_type: `${kind}_comp`, entity_id: c.id, changes, ip_address: actor.ip_address,
  });
  await recomputeSetsUsing(db, kind, c.id);
  await db.commit();
  return c;
}

export async function verifyComp(db: Db, kind: Kind, c: any, data: VerificationIn, actor: CurrentUser) {
  const before = { status: c.verification_status, method: c.verification_method };
  applyVerification(c, data, actor);
  c.updated_by_id = actor.id;
  await saveComp(db, kind, c);
  await audit.record(db, {
    actor, action: `${kind}_comp.verification`, entity_type: `${kind}_comp`, entity_id: c.id,
    changes: { verification: { from: before, to: { status: data.status, method: data.method ?? null } } },
    summary: data.notes, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

export async function archiveComp(db: Db, kind: Kind, c: any, actor: CurrentUser): Promise<void> {
  await patch(db, tableOf(kind), c, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: `${kind}_comp.archived`, entity_type: `${kind}_comp`, entity_id: c.id, ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- candidate search

export interface CandidateQuery {
  kind: string;
  subject_property_id?: string;
  near_lat?: number;
  near_lng?: number;
  radius_miles?: number;
  property_type?: string[];
  county?: string;
  corridor?: string;
  tenant_credit?: string[];
  min_term_years?: number;
  max_term_years?: number;
  date_from?: string;
  date_to?: string;
  verified_only: boolean;
  exclude_set_id?: string;
  q?: string;
  limit: number;
}

/** Automated comp candidates by type, geography (radius / county / corridor), credit, lease term and date window. */
export async function candidates(db: Db, cq: CandidateQuery): Promise<Obj[]> {
  const kind: Kind = cq.kind === "lease" ? "lease" : "sale";
  const M = tableOf(kind);
  let lat = cq.near_lat;
  let lng = cq.near_lng;
  if (cq.subject_property_id && (lat === undefined || lat === null || lng === undefined || lng === null)) {
    const p = await getProperty(db, cq.subject_property_id);
    lat = p.latitude ?? undefined;
    lng = p.longitude ?? undefined;
  }
  const conds: Array<SQL | undefined> = [isNull(M.deleted_at)];
  let distance: SQL | null = null;
  if (lat !== undefined && lat !== null && lng !== undefined && lng !== null) {
    const point = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
    distance = sql`ST_Distance(${M.location}::geography, ${point}) / ${MILES}`;
    if (cq.radius_miles) conds.push(sql`ST_DWithin(${M.location}::geography, ${point}, ${cq.radius_miles * MILES})`);
  }
  conds.push(applySearch(cq.q, [M.name, M.address_line, M.city, M.tenant_name]));
  conds.push(inFilter(M.property_type, cq.property_type));
  conds.push(inFilter(M.tenant_credit, cq.tenant_credit));
  if (cq.county) conds.push(ilike(M.county, `%${cq.county}%`));
  if (cq.corridor) conds.push(ilike(M.corridor, `%${cq.corridor}%`));
  if (cq.verified_only) conds.push(eq(M.verification_status, "verified"));
  let order: SQL;
  if (kind === "sale") {
    conds.push(rangeFilter(saleComps.lease_term_remaining_years, cq.min_term_years, cq.max_term_years));
    conds.push(rangeFilter(saleComps.sale_date, cq.date_from, cq.date_to));
    order = sql`${saleComps.sale_date} desc nulls last`;
  } else {
    if (cq.min_term_years !== undefined) conds.push(sql`${leaseComps.term_months} >= ${cq.min_term_years * 12}`);
    if (cq.max_term_years !== undefined) conds.push(sql`${leaseComps.term_months} <= ${cq.max_term_years * 12}`);
    conds.push(rangeFilter(leaseComps.commencement_on, cq.date_from, cq.date_to));
    order = sql`${leaseComps.commencement_on} desc nulls last`;
  }
  if (cq.subject_property_id) conds.push(or(isNull(M.property_id), ne(M.property_id, cq.subject_property_id)));
  if (cq.exclude_set_id) {
    const col = kind === "sale" ? compSetItems.sale_comp_id : compSetItems.lease_comp_id;
    const used = db
      .select({ id: col })
      .from(compSetItems)
      .where(and(eq(compSetItems.comp_set_id, cq.exclude_set_id), isNull(compSetItems.deleted_at), isNotNull(col)));
    conds.push(notInArray(M.id, used));
  }
  const orderBy = distance ? [sql`${distance} asc nulls last`, order] : [order, order];
  const rows: any[] = await db
    .select({ ...getTableColumns(M), distance: (distance ?? sql`null::float`).as("distance") } as never)
    .from(M)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(Math.min(cq.limit, 200));
  return rows.map(({ distance: dist, ...c }) => candidateDict(kind, c, dist === null || dist === undefined ? null : Number(dist)));
}

export function candidateDict(kind: Kind, c: any, dist: number | null = null): Obj {
  const base = {
    id: c.id, kind, label: c.name || c.address_line || c.tenant_name || "Unnamed comp",
    city: c.city, state: c.state, county: c.county, corridor: c.corridor, property_type: c.property_type,
    tenant_name: c.tenant_name, tenant_credit: c.tenant_credit, verification_status: c.verification_status,
    distance_miles: dist !== null ? pyRound(dist, 2) : null,
  };
  if (kind === "sale") {
    return {
      ...base, date: c.sale_date, price: c.sale_price, price_psf: saleMetric(c, "price_psf"),
      cap_rate: saleMetric(c, "cap_rate"), term_years: c.lease_term_remaining_years, area_sf: c.building_area_sf,
    };
  }
  return {
    ...base, date: c.commencement_on, rent_psf: c.base_rent_psf,
    term_years: c.term_months ? pyRound(c.term_months / 12, 2) : null, area_sf: c.area_sf,
  };
}

/** `Candidate` response model: every field present, unset ones null. */
export function toCandidate(d: Obj): Obj {
  const out: Obj = {};
  for (const k of [
    "id", "kind", "label", "city", "state", "county", "corridor", "property_type", "tenant_name", "tenant_credit", "date",
    "price", "price_psf", "cap_rate", "rent_psf", "term_years", "area_sf", "verification_status", "distance_miles",
  ]) {
    out[k] = d[k] ?? null;
  }
  return out;
}

// --------------------------------------------------------------------------- comp sets

export interface CompSetFilters {
  q?: string;
  kind?: string[];
  status?: string[];
  purpose?: string[];
  subject_property_id?: string;
}

export function buildSetWhere(f: CompSetFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = compSets;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.notes]),
    skip.has("kind") ? undefined : inFilter(t.kind, f.kind),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("purpose") ? undefined : inFilter(t.purpose, f.purpose),
    f.subject_property_id ? eq(t.subject_property_id, f.subject_property_id) : undefined,
  );
}

export async function getSet(db: Db, set_id: string): Promise<CompSet> {
  const cs = await getRow(db, compSets, set_id);
  if (!cs || cs.deleted_at) throw new HttpError(404, "Comp set not found");
  return cs;
}

function defaultBasis(kind: string, prop: Property | null | undefined): string {
  if (kind === "lease") return "effective_rent_psf";
  if (prop && prop.property_type === "land") return "price_per_acre";
  if (prop && prop.noi) return "cap_rate";
  return "price_psf";
}

function subjectQty(basis: string, prop: Property | null | undefined): [number | null, string | null] {
  if (!prop) return [null, null];
  if (["price_psf", "effective_rent_psf", "base_rent_psf"].includes(basis)) return [prop.building_area_sf, "Property record: building area"];
  if (basis === "price_per_acre") return [prop.land_area_acres, "Property record: land area"];
  if (basis === "cap_rate") return [prop.noi, "Property record: NOI"];
  return [1.0, null];
}

function checkBasis(kind: string, basis: string): void {
  const allowed: readonly string[] = kind === "sale" ? SALE_BASES : LEASE_BASES;
  if (!allowed.includes(basis)) throw new HttpError(422, `Value basis must be one of ${allowed.join(", ")}`);
}

async function listItems(db: Db, set_id: string): Promise<CompSetItem[]> {
  return db
    .select()
    .from(compSetItems)
    .where(and(eq(compSetItems.comp_set_id, set_id), isNull(compSetItems.deleted_at)))
    .orderBy(compSetItems.sort_order, compSetItems.created_at);
}

const itemCompId = (cs: Pick<CompSet, "kind">, it: CompSetItem) => (cs.kind === "sale" ? it.sale_comp_id : it.lease_comp_id);

async function compsFor(db: Db, cs: CompSet, items: CompSetItem[]): Promise<Map<string, any>> {
  const M = tableOf(cs.kind as Kind);
  const ids = items.map((i) => itemCompId(cs, i)).filter((i): i is string => !!i);
  if (!ids.length) return new Map();
  const rows: any[] = await db.select().from(M).where(inArray(M.id, ids));
  return new Map(rows.map((c) => [c.id, c]));
}

/** Recalculate each item's base/adjusted metric and value, then the set's indicated range. */
export async function recompute(db: Db, cs: CompSet): Promise<void> {
  const items = await listItems(db, cs.id);
  const comps = await compsFor(db, cs, items);
  const rows: Array<[number | null, number | null]> = [];
  for (const it of items) {
    const cid = itemCompId(cs, it);
    const c = cid ? comps.get(cid) : undefined;
    const base = c ? (cs.kind === "sale" ? saleMetric(c, cs.value_basis) : leaseMetric(c, cs.value_basis)) : null;
    const [net, adjusted] = adjust(base, it.adjustments || {});
    const adjusted_value = metricToValue(adjusted, cs.value_basis, cs.subject_quantity);
    await patchIfChanged(db, compSetItems, it, {
      base_metric: base, net_adjustment_pct: net, adjusted_metric: adjusted, adjusted_value,
    });
    if (it.included && c && c.deleted_at === null) rows.push([adjusted, it.weight !== null && it.weight !== undefined ? it.weight : 1.0]);
  }
  const ind = indicatedRange(rows, cs.value_basis, cs.subject_quantity);
  ind.comp_ids = items.filter((it) => it.included).map((it) => String(it.sale_comp_id || it.lease_comp_id || "None"));
  ind.computed_at = nowIso();
  await patch(db, compSets, cs, { indicated: ind });
}

async function recomputeSetsUsing(db: Db, kind: Kind, comp_id: string): Promise<void> {
  const col = kind === "sale" ? compSetItems.sale_comp_id : compSetItems.lease_comp_id;
  const rows = await db
    .select({ id: compSetItems.comp_set_id })
    .from(compSetItems)
    .where(and(eq(col, comp_id), isNull(compSetItems.deleted_at)));
  for (const sid of new Set(rows.map((r) => r.id))) {
    const cs = await getRow(db, compSets, sid);
    if (cs && !cs.deleted_at) await recompute(db, cs);
  }
}

function compSummary(kind: Kind, c: any): Obj {
  if (!c) return {};
  const d = candidateDict(kind, c);
  Object.assign(d, {
    address_line: c.address_line, year_built: c.year_built, condition: c.condition,
    building_area_sf: c.building_area_sf, land_area_acres: c.land_area_acres,
    verification_method: c.verification_method, verified_at: c.verified_at, property_id: c.property_id,
    latitude: c.latitude, longitude: c.longitude, source: c.source, document_id: c.document_id,
    archived: c.deleted_at !== null && c.deleted_at !== undefined,
  });
  if (kind === "sale") {
    Object.assign(d, {
      sale_price: c.sale_price, noi: c.noi, buyer_name: c.buyer_name, seller_name: c.seller_name,
      financing: c.financing, price_per_acre: saleMetric(c, "price_per_acre"),
    });
  } else {
    Object.assign(d, {
      base_rent_psf: c.base_rent_psf, effective_rent_psf: leaseMetric(c, "effective_rent_psf"),
      escalation_pct: c.escalation_pct, recovery_type: c.recovery_type, ti_psf: c.ti_psf,
      free_rent_months: c.free_rent_months, term_months: c.term_months, suite: c.suite,
    });
  }
  return d;
}

export async function setItemsOut(db: Db, cs: CompSet) {
  const items = await listItems(db, cs.id);
  const comps = await compsFor(db, cs, items);
  return items.map((it) => {
    const cid = itemCompId(cs, it);
    return {
      id: it.id, sale_comp_id: it.sale_comp_id, lease_comp_id: it.lease_comp_id, included: it.included,
      exclusion_reason: it.exclusion_reason, decision_history: it.decision_history, adjustments: it.adjustments,
      adjustment_notes: it.adjustment_notes, weight: it.weight, base_metric: it.base_metric,
      net_adjustment_pct: it.net_adjustment_pct, adjusted_metric: it.adjusted_metric, adjusted_value: it.adjusted_value,
      distance_miles: it.distance_miles, sort_order: it.sort_order,
      comp: compSummary(cs.kind as Kind, cid ? comps.get(cid) : undefined),
    };
  });
}

export async function setsOut(db: Db, rows: CompSet[]) {
  const labels = await propertyLabels(db, rows.map((r) => r.subject_property_id));
  const counts = new Map<string, { true?: number; false?: number }>();
  if (rows.length) {
    const res = await db
      .select({ sid: compSetItems.comp_set_id, inc: compSetItems.included, n: sql<number>`count(*)::int` })
      .from(compSetItems)
      .where(and(inArray(compSetItems.comp_set_id, rows.map((r) => r.id)), isNull(compSetItems.deleted_at)))
      .groupBy(compSetItems.comp_set_id, compSetItems.included);
    for (const r of res) {
      const c = counts.get(r.sid) ?? {};
      c[String(!!r.inc) as "true" | "false"] = Number(r.n);
      counts.set(r.sid, c);
    }
  }
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, purpose: r.purpose, status: r.status, value_basis: r.value_basis,
    subject_property_id: r.subject_property_id,
    subject_label: r.subject_property_id ? labels.get(r.subject_property_id) ?? null : null,
    indicated: r.indicated,
    included_count: counts.get(r.id)?.true ?? 0,
    excluded_count: counts.get(r.id)?.false ?? 0,
    updated_at: r.updated_at, created_at: r.created_at,
  }));
}

export async function setOut(db: Db, cs: CompSet) {
  const base = (await setsOut(db, [cs]))[0];
  let subject: Obj = {};
  if (cs.subject_property_id) {
    const p = await getRow(db, properties, cs.subject_property_id);
    if (p) {
      subject = {
        id: p.id, name: p.name, address_line: p.address_line, city: p.city, state: p.state, county: p.county,
        corridor: p.corridor, property_type: p.property_type, building_area_sf: p.building_area_sf,
        land_area_acres: p.land_area_acres, year_built: p.year_built, noi: p.noi, occupancy_pct: p.occupancy_pct,
        latitude: p.latitude, longitude: p.longitude, asking_price: p.asking_price,
      };
    }
  }
  return {
    ...base,
    subject_quantity: cs.subject_quantity,
    subject_quantity_source: cs.subject_quantity_source,
    criteria: cs.criteria || {},
    notes: cs.notes,
    owner_id: cs.owner_id,
    subject,
    items: await setItemsOut(db, cs),
  };
}

function assertEditable(cs: CompSet): void {
  if (cs.status === "final") throw new HttpError(409, "This comp set is final; reopen it as draft to change it");
}

async function addItemsTo(db: Db, cs: CompSet, comp_ids: string[], actor: CurrentUser): Promise<number> {
  const M = tableOf(cs.kind as Kind);
  const col = cs.kind === "sale" ? compSetItems.sale_comp_id : compSetItems.lease_comp_id;
  const existingRows = await db
    .select({ id: col })
    .from(compSetItems)
    .where(and(eq(compSetItems.comp_set_id, cs.id), isNull(compSetItems.deleted_at)));
  const existing = new Set(existingRows.map((r) => r.id));
  const comps: any[] = await db.select().from(M).where(and(inArray(M.id, comp_ids), isNull(M.deleted_at)));
  const prop = cs.subject_property_id ? await getRow(db, properties, cs.subject_property_id) : undefined;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(compSetItems)
    .where(eq(compSetItems.comp_set_id, cs.id));
  let order = Number(n ?? 0);
  let added = 0;
  for (const c of comps) {
    if (existing.has(c.id)) continue;
    let dist: number | null = null;
    if (prop && prop.latitude != null && prop.longitude != null && c.latitude != null && c.longitude != null) {
      dist = pyRound(haversineMiles(prop.latitude, prop.longitude, c.latitude, c.longitude), 2);
    }
    order += 1;
    await insert(db, compSetItems, {
      comp_set_id: cs.id,
      sale_comp_id: cs.kind === "sale" ? c.id : null,
      lease_comp_id: cs.kind === "lease" ? c.id : null,
      included: true,
      adjustments: {},
      adjustment_notes: {},
      weight: 1.0,
      distance_miles: dist,
      sort_order: order,
      decision_history: [{ included: true, reason: "Added to set", by: String(actor.id), by_name: actor.full_name, at: nowIso() }],
      created_by_id: actor.id,
      updated_by_id: actor.id,
    });
    added += 1;
  }
  return added;
}

export async function createSet(db: Db, data: CompSetCreate, actor: CurrentUser): Promise<CompSet> {
  const prop = await getProperty(db, data.subject_property_id);
  const basis = data.value_basis || defaultBasis(data.kind, prop);
  checkBasis(data.kind, basis);
  const [qty, qty_source] =
    data.subject_quantity !== null && data.subject_quantity !== undefined
      ? [data.subject_quantity, data.subject_quantity_source ?? null]
      : subjectQty(basis, prop);
  const cs = await insert(db, compSets, {
    subject_property_id: prop.id, name: data.name, kind: data.kind, purpose: data.purpose, status: "draft",
    value_basis: basis, subject_quantity: qty, subject_quantity_source: qty_source, criteria: data.criteria,
    notes: data.notes ?? null, indicated: {}, owner_id: actor.id, created_by_id: actor.id, updated_by_id: actor.id,
  });
  if (data.comp_ids.length) await addItemsTo(db, cs, data.comp_ids, actor);
  await recompute(db, cs);
  await audit.record(db, {
    actor, action: "comp_set.created", entity_type: "comp_set", entity_id: cs.id, summary: cs.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return cs;
}

export async function updateSet(db: Db, cs: CompSet, data: CompSetUpdate, actor: CurrentUser): Promise<CompSet> {
  const values = defined(data as Obj);
  if (
    cs.status === "final" && values.status !== "draft" &&
    Object.keys(values).some((k) => !["status", "notes", "name"].includes(k))
  ) {
    assertEditable(cs);
  }
  if ("value_basis" in values && values.value_basis) checkBasis(cs.kind, values.value_basis);
  const changes = audit.diff(cs, values);
  if (!Object.keys(changes).length) return cs;
  const set: Obj = { ...values };
  Object.assign(cs, values);
  if ("value_basis" in changes && !("subject_quantity" in values) && cs.subject_property_id) {
    const prop = await getRow(db, properties, cs.subject_property_id);
    [set.subject_quantity, set.subject_quantity_source] = subjectQty(cs.value_basis, prop);
  }
  set.updated_by_id = actor.id;
  await patch(db, compSets, cs, set as never);
  await recompute(db, cs);
  await audit.record(db, {
    actor, action: "comp_set.updated", entity_type: "comp_set", entity_id: cs.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return cs;
}

export async function archiveSet(db: Db, cs: CompSet, actor: CurrentUser): Promise<void> {
  await patch(db, compSets, cs, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "comp_set.archived", entity_type: "comp_set", entity_id: cs.id, summary: cs.name, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function addItems(db: Db, cs: CompSet, data: AddItemsIn, actor: CurrentUser): Promise<CompSet> {
  assertEditable(cs);
  const added = await addItemsTo(db, cs, data.comp_ids, actor);
  await recompute(db, cs);
  await patch(db, compSets, cs, { updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "comp_set.items_added", entity_type: "comp_set", entity_id: cs.id,
    changes: { comp_ids: data.comp_ids.map(String) }, summary: `${added} comps added`, ip_address: actor.ip_address,
  });
  await db.commit();
  return cs;
}

export async function updateItem(db: Db, cs: CompSet, item_id: string, data: ItemUpdate, actor: CurrentUser): Promise<CompSet> {
  assertEditable(cs);
  const it = await getRow(db, compSetItems, item_id);
  if (!it || it.comp_set_id !== cs.id || it.deleted_at) throw new HttpError(404, "Comp set item not found");
  const values = defined(data as Obj);
  const changes: Obj = {};
  const set: Obj = {};
  if ("included" in values && values.included !== null && values.included !== it.included) {
    const reason = String(values.exclusion_reason || "").trim();
    if (!values.included && reason.length < 3) throw new HttpError(422, "A reason is required to exclude a comp");
    set.decision_history = [
      ...(it.decision_history || []),
      { included: values.included, reason: reason || "Re-included", by: String(actor.id), by_name: actor.full_name, at: nowIso() },
    ];
    changes.included = { from: it.included, to: values.included, reason: reason || null };
    set.included = values.included;
    if (!values.included) set.exclusion_reason = reason;
  } else if (values.exclusion_reason && !it.included) {
    changes.exclusion_reason = { from: it.exclusion_reason, to: values.exclusion_reason };
    set.exclusion_reason = values.exclusion_reason;
    set.decision_history = [
      ...(it.decision_history || []),
      { included: false, reason: values.exclusion_reason, by: String(actor.id), by_name: actor.full_name, at: nowIso() },
    ];
  }
  if (values.adjustments !== undefined && values.adjustments !== null) {
    const adj = Object.fromEntries(
      Object.entries(values.adjustments as Record<string, number>).filter(([k]) => FACTORS.includes(k)).map(([k, v]) => [k, Number(v)]),
    );
    if (!audit.isEqual(adj, it.adjustments || {})) {
      changes.adjustments = { from: it.adjustments, to: adj };
      set.adjustments = adj;
    }
  }
  if (values.adjustment_notes !== undefined && values.adjustment_notes !== null) {
    set.adjustment_notes = Object.fromEntries(
      Object.entries(values.adjustment_notes as Record<string, string>).filter(([k]) => FACTORS.includes(k)),
    );
  }
  if (values.weight !== undefined && values.weight !== null && values.weight !== it.weight) {
    changes.weight = { from: it.weight, to: values.weight };
    set.weight = values.weight;
  }
  set.updated_by_id = actor.id;
  await patchIfChanged(db, compSetItems, it, set);
  await recompute(db, cs);
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "comp_set.item_updated", entity_type: "comp_set", entity_id: cs.id,
      changes: { item: String(it.id), ...changes }, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return cs;
}

export async function saveGrid(db: Db, cs: CompSet, data: GridIn, actor: CurrentUser): Promise<CompSet> {
  assertEditable(cs);
  const changes: Obj = {};
  const csSet: Obj = {};
  if (data.value_basis && data.value_basis !== cs.value_basis) {
    checkBasis(cs.kind, data.value_basis);
    changes.value_basis = { from: cs.value_basis, to: data.value_basis };
    csSet.value_basis = data.value_basis;
  }
  if (data.subject_quantity !== null && data.subject_quantity !== undefined && data.subject_quantity !== cs.subject_quantity) {
    changes.subject_quantity = { from: cs.subject_quantity, to: data.subject_quantity };
    csSet.subject_quantity = data.subject_quantity;
    csSet.subject_quantity_source = data.subject_quantity_source || cs.subject_quantity_source;
  }
  const items = new Map((await listItems(db, cs.id)).map((i) => [i.id, i]));
  const item_changes: Obj = {};
  for (const row of data.items) {
    const it = items.get(row.id);
    if (!it) continue;
    const adj = Object.fromEntries(
      Object.entries(row.adjustments).filter(([k, v]) => FACTORS.includes(k) && v !== null && v !== undefined).map(([k, v]) => [k, Number(v)]),
    );
    if (!audit.isEqual(adj, it.adjustments || {}) || row.weight !== it.weight) {
      item_changes[String(it.id)] = {
        adjustments: { from: it.adjustments, to: adj },
        weight: { from: it.weight, to: row.weight },
      };
    }
    await patchIfChanged(db, compSetItems, it, {
      adjustments: adj,
      adjustment_notes: Object.fromEntries(Object.entries(row.adjustment_notes).filter(([k, v]) => FACTORS.includes(k) && v)),
      weight: row.weight,
      updated_by_id: actor.id,
    });
  }
  csSet.updated_by_id = actor.id;
  await patchIfChanged(db, compSets, cs, csSet);
  await recompute(db, cs);
  if (Object.keys(changes).length || Object.keys(item_changes).length) {
    await audit.record(db, {
      actor, action: "comp_set.grid_saved", entity_type: "comp_set", entity_id: cs.id,
      changes: { ...changes, items: item_changes }, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return cs;
}

export interface CompSetSummary {
  id: string;
  name: string;
  kind: string;
  value_basis: string;
  metric_point: number | null;
  metric_low: number | null;
  metric_high: number | null;
  comp_ids: string[];
}

/** Used by underwriting to seed assumptions from a comp set (kind, basis, indicated point, included comp ids). */
export async function compSetSummary(db: Db, set_id: string): Promise<CompSetSummary | null> {
  const cs = await getRow(db, compSets, set_id);
  if (!cs || cs.deleted_at) return null;
  const ind = cs.indicated || {};
  return {
    id: String(cs.id), name: cs.name, kind: cs.kind, value_basis: cs.value_basis,
    metric_point: ind.metric_point ?? null, metric_low: ind.metric_low ?? null, metric_high: ind.metric_high ?? null,
    comp_ids: ind.comp_ids || [],
  };
}

// --------------------------------------------------------------------------- valuations

export interface ValuationFilters {
  property_id?: string;
  method?: string[];
  is_mark?: boolean;
  latest_only?: boolean;
  as_of_from?: string;
  as_of_to?: string;
  comp_set_id?: string;
}

export function buildValuationWhere(f: ValuationFilters, skip: Set<string> = new Set()): SQL | undefined {
  const v = valuations;
  const markCond = f.is_mark !== undefined ? sql` and is_mark = ${f.is_mark}` : sql``;
  return and(
    isNull(v.deleted_at),
    f.property_id ? eq(v.property_id, f.property_id) : undefined,
    skip.has("method") ? undefined : inFilter(v.method, f.method),
    f.is_mark !== undefined && !skip.has("is_mark") ? eq(v.is_mark, f.is_mark) : undefined,
    f.comp_set_id ? eq(v.comp_set_id, f.comp_set_id) : undefined,
    rangeFilter(v.as_of, f.as_of_from, f.as_of_to),
    f.latest_only
      ? sql`${v.id} in (select id from (select id, row_number() over (partition by property_id order by as_of desc, created_at desc) as rn from valuations where deleted_at is null${markCond}) sub where rn = 1)`
      : undefined,
  );
}

export async function valuationsOut(db: Db, rows: Valuation[]) {
  const names = await userNames(db, rows.map((r) => r.analyst_id));
  const labels = await propertyLabels(db, rows.map((r) => r.property_id));
  const out: Obj[] = [];
  for (const r of rows) {
    let prior_value_point: number | null = null;
    let change_pct: number | null = null;
    if (r.is_mark) {
      const [p] = await db
        .select({ value_point: valuations.value_point })
        .from(valuations)
        .where(
          and(
            eq(valuations.property_id, r.property_id),
            eq(valuations.is_mark, true),
            isNull(valuations.deleted_at),
            or(lt(valuations.as_of, r.as_of), and(eq(valuations.as_of, r.as_of), lt(valuations.created_at, r.created_at))),
          ),
        )
        .orderBy(desc(valuations.as_of), desc(valuations.created_at))
        .limit(1);
      prior_value_point = p?.value_point ?? null;
      if (prior_value_point && r.value_point !== null) change_pct = ((r.value_point - prior_value_point) / prior_value_point) * 100;
    }
    out.push({
      id: r.id, property_id: r.property_id, property_label: labels.get(r.property_id) ?? null, method: r.method,
      value_low: r.value_low, value_high: r.value_high, value_point: r.value_point, as_of: r.as_of,
      analyst_id: r.analyst_id, analyst_name: r.analyst_id ? names.get(r.analyst_id) ?? null : null,
      comp_set_id: r.comp_set_id, uw_model_id: r.uw_model_id, is_mark: r.is_mark, inputs: r.inputs,
      assumptions: r.assumptions, unsourced: r.unsourced, calculation: r.calculation, document_id: r.document_id,
      third_party: r.third_party, notes: r.notes, prior_value_point, change_pct, created_at: r.created_at,
    });
  }
  return out;
}

const sourcedValueOf = (assumptions: Obj, key: string): any => {
  const x = assumptions[key];
  return x !== null && typeof x === "object" && !Array.isArray(x) ? x.value : x;
};
const isSourcedAssumption = (x: any): boolean =>
  x !== null && typeof x === "object" && !Array.isArray(x) && truthy(x.source || x.comp_ids || x.document_id);

/** Returns (result {value_low, value_high, value_point, calculation}, evidence-bearing assumptions, unsourced keys). */
export async function computeValuation(db: Db, data: ValuationCreate): Promise<[Obj, Obj, string[]]> {
  const a: Obj = {};
  for (const [k, v] of Object.entries(data.assumptions)) {
    a[k] = { value: v.value ?? null, source: v.source ?? null, comp_ids: v.comp_ids, document_id: v.document_id ?? null };
  }
  const sv = (key: string) => sourcedValueOf(a, key);
  const m = data.method;
  let result: Obj;
  if (m === "direct_cap") {
    result = directCap(sv("noi") || 0, sv("cap_rate") || 0, sv("cap_rate_low"), sv("cap_rate_high"));
  } else if (m === "dcf") {
    const rate = sv("discount_rate");
    if (rate === null || rate === undefined) throw new HttpError(422, "DCF needs a discount rate");
    let cfs: number[];
    if (data.uw_model_id) {
      const model = await getRow(db, uwModels, data.uw_model_id);
      if (!model || model.deleted_at) throw new HttpError(404, "Underwriting model not found");
      cfs = [...((model.outputs || {}).cash_flows_unlevered || [])].slice(1);
      a.cash_flows = {
        value: null, source: `Underwriting model ${model.name} v${model.version} (${model.status})`,
        comp_ids: [], document_id: null, uw_model_id: String(model.id),
      };
    } else {
      cfs = simpleDcfFlows(
        sv("noi_year1") || 0, sv("growth_pct") || 0, Math.trunc(sv("hold_years") || 10), sv("exit_cap") || 0,
        sv("selling_cost_pct") || 0,
      );
    }
    result = dcfValue(cfs, rate, sv("discount_rate_low"), sv("discount_rate_high"));
  } else if (m === "sales_comparison") {
    if (!data.comp_set_id) throw new HttpError(422, "Sales comparison needs a comp set");
    const cs = await getSet(db, data.comp_set_id);
    if (cs.kind !== "sale") throw new HttpError(422, "Sales comparison needs a sale comp set");
    await recompute(db, cs);
    const ind = cs.indicated || {};
    if (ind.value_point === null || ind.value_point === undefined) {
      throw new HttpError(422, "The comp set has no indicated value (check included comps and subject quantity)");
    }
    a.indicated_metric = {
      value: ind.metric_point ?? null, source: `Comp set: ${cs.name}`, comp_ids: ind.comp_ids || [], document_id: null,
    };
    result = {
      value_low: ind.value_low ?? null, value_high: ind.value_high ?? null, value_point: ind.value_point,
      calculation: { formula: ind.method ?? null, basis: cs.value_basis, indicated: ind },
    };
  } else if (m === "land_residual") {
    result = landResidual(
      sv("gross_development_value") || 0, sv("development_costs") || 0, sv("soft_costs") || 0, sv("carry_costs") || 0,
      sv("developer_profit_pct") || 0, sv("gdv_low"), sv("gdv_high"),
    );
  } else {
    // appraisal / bov: third-party conclusion entered from the linked document
    if (data.value_point === null || data.value_point === undefined) throw new HttpError(422, "Enter the value conclusion");
    if (m === "appraisal" && !data.document_id) throw new HttpError(422, "Link the appraisal document");
    result = {
      value_point: data.value_point,
      value_low: data.value_low !== null && data.value_low !== undefined ? data.value_low : data.value_point,
      value_high: data.value_high !== null && data.value_high !== undefined ? data.value_high : data.value_point,
      calculation: { formula: `Third-party ${m} conclusion`, third_party: data.third_party ?? null },
    };
  }
  const unsourced = (VALUATION_MATERIAL[m] ?? []).filter((k) => {
    const x = sv(k);
    return x !== null && x !== undefined && !isSourcedAssumption(a[k]);
  });
  for (const k of ["value_low", "value_high", "value_point"]) {
    if (result[k] !== null && result[k] !== undefined) result[k] = pyRound(Number(result[k]), 2);
  }
  return [result, a, unsourced];
}

/** Python `f"{x:,.0f}"`. */
const fmtMoney0 = (x: number) => (pyRound(x, 0) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

export async function createValuation(db: Db, data: ValuationCreate, actor: CurrentUser): Promise<Valuation> {
  await getProperty(db, data.property_id);
  const [result, assumptions, unsourced] = await computeValuation(db, data);
  if (data.is_mark && unsourced.length) {
    throw new HttpError(422, { message: "Portfolio marks require evidence for every material assumption", unsourced });
  }
  const v = await insert(db, valuations, {
    property_id: data.property_id, method: data.method, value_low: result.value_low ?? null, value_high: result.value_high ?? null,
    value_point: result.value_point ?? null, as_of: data.as_of, analyst_id: data.analyst_id || actor.id,
    comp_set_id: data.comp_set_id ?? null, uw_model_id: data.uw_model_id ?? null, is_mark: data.is_mark,
    inputs: Object.fromEntries(Object.keys(assumptions).map((k) => [k, sourcedValueOf(assumptions, k)])),
    assumptions, unsourced, calculation: result.calculation, document_id: data.document_id ?? null,
    third_party: data.third_party ?? null, notes: data.notes ?? null, created_by_id: actor.id, updated_by_id: actor.id,
  });
  if (data.document_id) {
    await insert(db, valuationDocuments, {
      property_id: data.property_id, valuation_id: v.id, document_id: data.document_id,
      kind: data.method === "bov" ? "bov" : "appraisal", label: data.third_party ?? null, prepared_by: data.third_party ?? null,
      effective_date: data.as_of, value_conclusion: v.value_point, created_by_id: actor.id, updated_by_id: actor.id,
    });
    await linkDocument(db, data.document_id, "valuation", v.id, actor);
  }
  await audit.record(db, {
    actor, action: v.is_mark ? "valuation.marked" : "valuation.created", entity_type: "valuation", entity_id: v.id,
    summary:
      v.value_low !== null && v.value_high !== null
        ? `${data.method} ${fmtMoney0(v.value_low)}–${fmtMoney0(v.value_high)} as of ${data.as_of}`
        : data.method,
    changes: { property_id: data.property_id, value_point: v.value_point }, ip_address: actor.ip_address,
  });
  await db.commit();
  return v;
}

export async function valuationFromSet(db: Db, cs: CompSet, data: FromCompSetIn, actor: CurrentUser): Promise<Valuation> {
  if (cs.kind !== "sale" || !cs.subject_property_id) {
    throw new HttpError(422, "Only sale comp sets produce a sales-comparison value");
  }
  return createValuation(
    db,
    valuationCreate.parse({
      property_id: cs.subject_property_id, method: "sales_comparison", as_of: data.as_of, is_mark: data.is_mark,
      comp_set_id: cs.id, notes: data.notes,
    }),
    actor,
  );
}

export async function getValuation(db: Db, valuation_id: string): Promise<Valuation> {
  const v = await getRow(db, valuations, valuation_id);
  if (!v || v.deleted_at) throw new HttpError(404, "Valuation not found");
  return v;
}

export async function archiveValuation(db: Db, v: Valuation, actor: CurrentUser): Promise<void> {
  if (v.is_mark) throw new HttpError(409, "Portfolio marks are historical and cannot be deleted");
  await patch(db, valuations, v, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "valuation.archived", entity_type: "valuation", entity_id: v.id, ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Public contract: most recent valuation (mark or not) for a property. */
export async function latestValue(db: Db, property_id: string) {
  const [v] = await db
    .select()
    .from(valuations)
    .where(and(eq(valuations.property_id, property_id), isNull(valuations.deleted_at)))
    .orderBy(desc(valuations.as_of), desc(valuations.created_at))
    .limit(1);
  if (!v) return null;
  return {
    value_point: v.value_point, value_low: v.value_low, value_high: v.value_high, as_of: v.as_of, method: v.method,
    is_mark: v.is_mark, valuation_id: v.id,
  };
}

export function valuationDocumentOut(d: ValuationDocument) {
  return {
    property_id: d.property_id, document_id: d.document_id, kind: d.kind, label: d.label, prepared_by: d.prepared_by,
    effective_date: d.effective_date, value_conclusion: d.value_conclusion, valuation_id: d.valuation_id, id: d.id,
    created_at: d.created_at,
  };
}

export async function addDocument(db: Db, data: ValuationDocumentIn, actor: CurrentUser): Promise<ValuationDocument> {
  await getProperty(db, data.property_id);
  if (data.valuation_id) await getValuation(db, data.valuation_id);
  const d = await insert(db, valuationDocuments, {
    property_id: data.property_id, document_id: data.document_id, kind: data.kind, label: data.label ?? null,
    prepared_by: data.prepared_by ?? null, effective_date: data.effective_date ?? null,
    value_conclusion: data.value_conclusion ?? null, valuation_id: data.valuation_id ?? null,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await linkDocument(db, data.document_id, "property", data.property_id, actor);
  await audit.record(db, {
    actor, action: "valuation_document.linked", entity_type: "property", entity_id: data.property_id,
    summary: `${data.kind}: ${data.label || data.document_id}`, changes: { document_id: String(data.document_id) },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function removeDocument(db: Db, doc_id: string, actor: CurrentUser): Promise<void> {
  const d = await getRow(db, valuationDocuments, doc_id);
  if (!d || d.deleted_at) throw new HttpError(404, "Document link not found");
  await patch(db, valuationDocuments, d, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "valuation_document.unlinked", entity_type: "property", entity_id: d.property_id,
    changes: { document_id: String(d.document_id) }, ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- BOV

async function bovPayload(db: Db, cs: CompSet, bov: Bov, actor_name: string | null): Promise<Obj> {
  await recompute(db, cs);
  const full = await setOut(db, cs);
  let valuation: Obj | null = null;
  if (bov.valuation_id) {
    const v = await getRow(db, valuations, bov.valuation_id);
    if (v && !v.deleted_at) {
      valuation = {
        id: String(v.id), method: v.method, value_low: v.value_low, value_high: v.value_high, value_point: v.value_point,
        as_of: v.as_of,
      };
    }
  }
  const docs = cs.subject_property_id
    ? await db
        .select()
        .from(valuationDocuments)
        .where(and(eq(valuationDocuments.property_id, cs.subject_property_id), isNull(valuationDocuments.deleted_at)))
    : [];
  const included = full.items.filter((i) => i.included);
  return audit.toJsonable({
    generated_at: utcnow(),
    title: bov.title,
    prepared_for: bov.prepared_for,
    prepared_by: actor_name,
    subject: full.subject,
    comp_set: {
      id: cs.id, name: cs.name, kind: cs.kind, value_basis: cs.value_basis, subject_quantity: cs.subject_quantity,
      subject_quantity_source: cs.subject_quantity_source,
    },
    adjustment_factors: ADJUSTMENT_FACTORS,
    comps: included.map((i) => ({
      id: i.sale_comp_id || i.lease_comp_id, comp: i.comp, adjustments: i.adjustments, adjustment_notes: i.adjustment_notes,
      base_metric: i.base_metric, net_adjustment_pct: i.net_adjustment_pct, adjusted_metric: i.adjusted_metric,
      adjusted_value: i.adjusted_value, weight: i.weight, distance_miles: i.distance_miles,
    })),
    excluded: full.items
      .filter((i) => !i.included)
      .map((i) => ({ id: i.sale_comp_id || i.lease_comp_id, label: i.comp.label ?? null, reason: i.exclusion_reason })),
    indicated: cs.indicated,
    valuation,
    recommended_list_price: bov.recommended_list_price,
    narrative: bov.narrative,
    evidence: {
      comp_ids: included.map((i) => String(i.sale_comp_id || i.lease_comp_id)),
      document_ids: docs.map((d) => String(d.document_id)),
    },
  });
}

export async function createBov(db: Db, cs: CompSet, data: BovCreate, actor: CurrentUser): Promise<Bov> {
  if (!cs.subject_property_id) throw new HttpError(422, "The comp set has no subject property");
  await recompute(db, cs);
  const ind = cs.indicated || {};
  if (ind.value_point === null || ind.value_point === undefined) {
    throw new HttpError(422, "The comp set has no indicated value yet; include comps and set the subject quantity");
  }
  const bov = await insert(db, bovs, {
    property_id: cs.subject_property_id, comp_set_id: cs.id, valuation_id: data.valuation_id ?? null, title: data.title,
    prepared_for: data.prepared_for ?? null, prepared_by_id: actor.id, status: "draft",
    value_low: ind.value_low ?? null, value_high: ind.value_high ?? null, value_point: ind.value_point,
    recommended_list_price: data.recommended_list_price ?? null, narrative: data.narrative ?? null,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  const payload = await bovPayload(db, cs, bov, actor.full_name);
  await patch(db, bovs, bov, { payload, generated_at: utcnow() });
  await audit.record(db, {
    actor, action: "bov.generated", entity_type: "bov", entity_id: bov.id, summary: bov.title,
    changes: { comp_set_id: String(cs.id), value_point: bov.value_point }, ip_address: actor.ip_address,
  });
  await db.commit();
  return bov;
}

export async function getBov(db: Db, bov_id: string): Promise<Bov> {
  const b = await getRow(db, bovs, bov_id);
  if (!b || b.deleted_at) throw new HttpError(404, "BOV not found");
  return b;
}

export async function updateBov(db: Db, b: Bov, data: BovUpdate, actor: CurrentUser): Promise<Bov> {
  const values = defined(data as Obj);
  if (b.status !== "draft" && Object.keys(values).some((k) => !["status", "document_id"].includes(k))) {
    throw new HttpError(409, "Only draft BOVs can be edited");
  }
  const changes = audit.diff(b, values);
  if (!Object.keys(changes).length) return b;
  Object.assign(b, values);
  const set: Obj = { ...values };
  if (["narrative", "recommended_list_price", "title", "prepared_for"].some((k) => k in changes)) {
    set.payload = {
      ...(b.payload || {}), narrative: b.narrative, recommended_list_price: b.recommended_list_price, title: b.title,
      prepared_for: b.prepared_for,
    };
  }
  if ("document_id" in changes && b.document_id) {
    await insert(db, valuationDocuments, {
      property_id: b.property_id, valuation_id: b.valuation_id, document_id: b.document_id, kind: "bov", label: b.title,
      effective_date: b.generated_at ? b.generated_at.toISOString().slice(0, 10) : null, value_conclusion: b.value_point,
      created_by_id: actor.id, updated_by_id: actor.id,
    });
    await linkDocument(db, b.document_id, "bov", b.id, actor);
  }
  set.updated_by_id = actor.id;
  await patch(db, bovs, b, set as never);
  await audit.record(db, {
    actor, action: "bov.updated", entity_type: "bov", entity_id: b.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

export async function regenerateBov(db: Db, b: Bov, actor: CurrentUser): Promise<Bov> {
  if (b.status !== "draft") throw new HttpError(409, "Only draft BOVs can be regenerated");
  const cs = await getSet(db, b.comp_set_id);
  await recompute(db, cs);
  const ind = cs.indicated || {};
  await patch(db, bovs, b, { value_low: ind.value_low ?? null, value_high: ind.value_high ?? null, value_point: ind.value_point ?? null });
  const payload = await bovPayload(db, cs, b, actor.full_name);
  await patch(db, bovs, b, { payload, generated_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "bov.regenerated", entity_type: "bov", entity_id: b.id, changes: { value_point: b.value_point },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

export async function bovsOut(db: Db, rows: Bov[]) {
  const names = await userNames(db, rows.map((r) => r.prepared_by_id));
  const labels = await propertyLabels(db, rows.map((r) => r.property_id));
  return rows.map((r) => ({
    id: r.id, property_id: r.property_id, property_label: labels.get(r.property_id) ?? null, comp_set_id: r.comp_set_id,
    valuation_id: r.valuation_id, title: r.title, prepared_for: r.prepared_for, prepared_by_id: r.prepared_by_id,
    prepared_by_name: r.prepared_by_id ? names.get(r.prepared_by_id) ?? null : null, status: r.status,
    value_low: r.value_low, value_high: r.value_high, value_point: r.value_point,
    recommended_list_price: r.recommended_list_price, narrative: r.narrative, payload: r.payload,
    generated_at: r.generated_at, document_id: r.document_id, created_at: r.created_at, updated_at: r.updated_at,
  }));
}
