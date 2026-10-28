import { and, desc, eq, getTableColumns, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import type { PgColumn } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import type { Actor } from "../../common/audit";
import * as provenance from "../../common/provenance";
import type { ProvenanceIn } from "../../common/provenance";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get as getRow, insert, patch } from "../../db/orm";
import { users } from "../auth/schema";
import { annualDebtService } from "../debt/calc";
import { loanProperties, loans } from "../debt/schema";
import { capitalPartners, investments } from "../investors/schema";
import { guaranties, leases, rentSteps } from "../leases/schema";
import { workOrders } from "../maintenance/schema";
import { budgetLines, budgets } from "../operations/schema";
import { properties, type Property } from "../properties/schema";
import { tasks } from "../tasks/schema";
import { territories, territoryMembers } from "../territories/schema";
import {
  addDays, addMonths, daysBetween, fmtFixed, fmtMonthYear, isoDate, monthRange, monthStart, normKey, pct, pyQuote,
  pyStr, r2, safeDiv, todayStr,
} from "./calc";
import {
  assetFinancials, assetMilestones, assetSettings, assets, concentrationLimits, MATERIAL_FIELDS, tenantProfiles,
  varianceExplanations, watchlistEntries,
  type Asset, type AssetFinancial, type AssetMilestone, type TenantProfile, type VarianceExplanation, type WatchlistEntry,
} from "./schema";
import type {
  AssetCreate, AssetUpdate, ExplainIn, FinancialIn, Metric, MilestoneIn, MilestoneUpdate, SettingsIn,
} from "./schemas";

export const ENTITY = "asset";
export const INCOME_CATS = new Set(["income"]);
export const EXPENSE_CATS = new Set(["expense"]);

export const DEFAULT_SETTINGS: Record<string, any> = {
  variance_pct: 10.0,
  variance_amount: 5000.0,
  watch_min_dscr: 1.25,
  watch_min_occupancy: 85.0,
  maturity_months: 12,
  persistent_variance_months: 3,
  maintenance_backlog: 10,
  maintenance_overdue_days: 30,
};

/** period -> category -> amount */
export type Monthly = Record<string, Record<string, number>>;
type Kpi = Record<string, any>;

// (account, period) composite keys for Map lookups
const mk = (account: string, period: string) => `${account}\u0001${period}`;
const unmk = (key: string): [string, string] => key.split("\u0001") as [string, string];

// --------------------------------------------------------------------------- settings / lookups

export async function getSettings(db: Db): Promise<Record<string, any>> {
  const [row] = await db.select().from(assetSettings).where(eq(assetSettings.key, "thresholds")).limit(1);
  return { ...DEFAULT_SETTINGS, ...((row?.value as Record<string, any>) ?? {}) };
}

export async function saveSettings(db: Db, data: SettingsIn, actor: CurrentUser): Promise<Record<string, any>> {
  const [existing] = await db.select().from(assetSettings).where(eq(assetSettings.key, "thresholds")).limit(1);
  const before = await getSettings(db);
  let row = existing;
  if (!row) {
    row = await insert(db, assetSettings, { key: "thresholds", value: data, created_by_id: actor.id, updated_by_id: actor.id });
  } else {
    row = await patch(db, assetSettings, row, { value: data, updated_by_id: actor.id });
  }
  await audit.record(db, {
    actor, action: "asset.settings_updated", entity_type: "asset_settings", changes: { from: before, to: row.value },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return { ...DEFAULT_SETTINGS, ...(row.value as Record<string, any>) };
}

export function propLabel(p: Property | null | undefined): string {
  if (!p) return "Unknown property";
  return p.name || p.address_line;
}

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Record<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!set.length) return {};
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  return Object.fromEntries(rows.map((u) => [u.id, u.full_name]));
}

export async function get(db: Db, assetId: string): Promise<Asset> {
  const a = await getRow(db, assets, assetId);
  if (!a || a.deleted_at) throw new HttpError(404, "Asset not found");
  return a;
}

export async function byProperty(db: Db, propertyId: string): Promise<Asset | null> {
  const [a] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.property_id, propertyId), isNull(assets.deleted_at)))
    .limit(1);
  return a ?? null;
}

export async function loadProps(db: Db, rows: Asset[]): Promise<Record<string, Property>> {
  const pids = [...new Set(rows.map((a) => a.property_id))];
  if (!pids.length) return {};
  const found = await db.select().from(properties).where(inArray(properties.id, pids));
  return Object.fromEntries(found.map((p) => [p.id, p]));
}

// --------------------------------------------------------------------------- list / filters

export interface AssetFilters {
  q?: string;
  status?: string[];
  property_type?: string[];
  state?: string[];
  manager_id?: string[];
  ids?: string[];
  property_id?: string;
  watchlist?: boolean;
}

/** WHERE for the filters over `assets JOIN properties`; `skip` leaves a facet's own filter out. */
export function buildWhere(f: AssetFilters, skip: Set<string> = new Set()): SQL | undefined {
  return and(
    isNull(assets.deleted_at),
    applySearch(f.q, [properties.name, properties.address_line, properties.city, properties.county, properties.corridor]),
    skip.has("status") ? undefined : inFilter(assets.status, f.status),
    skip.has("property_type") ? undefined : inFilter(properties.property_type, f.property_type),
    skip.has("state") ? undefined : inFilter(properties.state, f.state),
    inFilter(assets.manager_id, f.manager_id),
    inFilter(assets.id, f.ids),
    f.property_id ? eq(assets.property_id, f.property_id) : undefined,
    f.watchlist
      ? sql`${assets.id} in (select ${watchlistEntries.asset_id} from ${watchlistEntries} where ${watchlistEntries.status} = 'open' and ${watchlistEntries.deleted_at} is null)`
      : undefined,
  );
}

const assetColumns = getTableColumns(assets);

export async function listAssets(
  db: Db, f: AssetFilters, order: SQL[] = [], paging?: { limit: number; offset: number },
): Promise<Asset[]> {
  let q = db
    .select(assetColumns)
    .from(assets)
    .innerJoin(properties, eq(properties.id, assets.property_id))
    .where(buildWhere(f))
    .orderBy(...order)
    .$dynamic();
  if (paging) q = q.limit(paging.limit).offset(paging.offset);
  return (await q) as Asset[];
}

export async function countAssets(db: Db, f: AssetFilters): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assets)
    .innerJoin(properties, eq(properties.id, assets.property_id))
    .where(buildWhere(f));
  return r?.n ?? 0;
}

/** Counts per distinct value of `column` within the filtered join (facet_counts). */
export async function facetCounts(db: Db, f: AssetFilters, skip: string, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(assets)
    .innerJoin(properties, eq(properties.id, assets.property_id))
    .where(buildWhere(f, new Set([skip])))
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

// --------------------------------------------------------------------------- cross-module reads

export interface LeaseInfo {
  id: string;
  tenant_name: string;
  tenant_organization_id: string | null;
  rentable_sf: number;
  expiration_on: string | null;
  commencement_on: string | null;
  annual_rent: number;
  guarantor: string | null;
}

/** Active leases with current annual rent per property. */
export async function leaseData(db: Db, propertyIds: Set<string>): Promise<Record<string, LeaseInfo[]> | null> {
  if (!propertyIds.size) return {};
  const today = todayStr();
  const rows = await db
    .select()
    .from(leases)
    .where(and(inArray(leases.property_id, [...propertyIds]), eq(leases.status, "active"), isNull(leases.deleted_at)));
  const rent: Record<string, number> = {};
  const guarantors: Record<string, string> = {};
  if (rows.length) {
    const ids = rows.map((l) => l.id);
    const steps = await db.select().from(rentSteps).where(inArray(rentSteps.lease_id, ids));
    for (const s of steps) {
      if (s.start_on && s.start_on > today) continue;
      if (s.end_on && s.end_on < today) continue;
      const annual = s.annual_rent !== null && s.annual_rent !== undefined ? s.annual_rent : (s.monthly_rent || 0) * 12;
      rent[s.lease_id] = Number(annual || 0);
    }
    for (const g of await db.select().from(guaranties).where(inArray(guaranties.lease_id, ids))) {
      const name = (g as any).guarantor_name || (g as any).name;
      if (name) guarantors[g.lease_id] = name;
    }
  }
  const out: Record<string, LeaseInfo[]> = {};
  for (const l of rows) {
    (out[l.property_id] ??= []).push({
      id: l.id,
      tenant_name: l.tenant_name || "Unnamed tenant",
      tenant_organization_id: l.tenant_organization_id,
      rentable_sf: Number(l.rentable_sf || 0),
      expiration_on: l.expiration_on,
      commencement_on: l.commencement_on,
      annual_rent: rent[l.id] ?? 0.0,
      guarantor: guarantors[l.id] ?? null,
    });
  }
  return out;
}

export async function latestValuation(db: Db, propertyId: string): Promise<Record<string, any> | null> {
  try {
    const { latestValue } = await import("../comps/service");
    return ((await latestValue(db, propertyId)) as Record<string, any> | null) ?? null;
  } catch {
    return null; // a missing/failing comps module must not break asset views
  }
}

export interface LoanInfo {
  id: string;
  lender_name: string;
  balance: number;
  annual_debt_service: number;
  rate: number | null;
  rate_type: string;
  maturity_on: string | null;
  covenant_state: string;
  share: number;
  cap_expires_on: string | null;
}

/** Active loans per asset with the balance allocated to that asset (cross-collateral aware). */
export async function activeLoans(db: Db, rows: Asset[]): Promise<Record<string, LoanInfo[]>> {
  if (!rows.length) return {};
  const byProp = new Map(rows.map((a) => [a.property_id, a.id]));
  const assetIds = new Set(rows.map((a) => a.id));
  const propIds = [...byProp.keys()];
  const links = await db.select().from(loanProperties).where(inArray(loanProperties.property_id, propIds));
  const linkedLoanIds = [...new Set(links.map((l) => l.loan_id))];
  const conds: SQL[] = [inArray(loans.asset_id, [...assetIds]), inArray(loans.property_id, propIds)];
  if (linkedLoanIds.length) conds.push(inArray(loans.id, linkedLoanIds));
  const found = await db
    .select()
    .from(loans)
    .where(and(isNull(loans.deleted_at), eq(loans.status, "active"), or(...conds)));
  const allLinks: Record<string, (typeof links)[number][]> = {};
  if (found.length) {
    for (const l of await db.select().from(loanProperties).where(inArray(loanProperties.loan_id, found.map((x) => x.id)))) {
      (allLinks[l.loan_id] ??= []).push(l);
    }
  }
  const out: Record<string, LoanInfo[]> = {};
  for (const loan of found) {
    const bal = Number(loan.current_balance || 0);
    const ds = annualDebtService(loan);
    const shares = new Map<string, number>();
    const lk = allLinks[loan.id] ?? [];
    const allocTotal = lk.reduce((t, x) => t + Number(x.allocated_amount || 0), 0);
    if (lk.length && allocTotal > 0) {
      for (const x of lk) {
        if (byProp.has(x.property_id)) shares.set(byProp.get(x.property_id)!, Number(x.allocated_amount || 0) / allocTotal);
      }
    } else {
      const target = loan.asset_id && assetIds.has(loan.asset_id) ? loan.asset_id : byProp.get(loan.property_id as string);
      if (target) {
        shares.set(target, 1.0);
      } else if (lk.length) {
        for (const x of lk) if (byProp.has(x.property_id)) shares.set(byProp.get(x.property_id)!, 1.0 / lk.length);
      }
    }
    for (const [aid, share] of shares) {
      (out[aid] ??= []).push({
        id: loan.id, lender_name: loan.lender_name || "Unknown lender", balance: bal * share,
        annual_debt_service: ds * share, rate: loan.rate, rate_type: loan.rate_type,
        maturity_on: loan.maturity_on, covenant_state: loan.covenant_state, share, cap_expires_on: loan.cap_expires_on,
      });
    }
  }
  return out;
}

export interface Stake {
  partner_id: string;
  name: string;
  ownership_pct: number;
  commitment: number;
  funded: number;
}

export async function partnerStakes(db: Db, assetIds: Set<string>): Promise<Record<string, Stake[]> | null> {
  if (!assetIds.size) return {};
  const rows = await db
    .select({ inv: investments, partner: capitalPartners })
    .from(investments)
    .innerJoin(capitalPartners, eq(capitalPartners.id, investments.partner_id))
    .where(inArray(investments.asset_id, [...assetIds]));
  const out: Record<string, Stake[]> = {};
  for (const { inv, partner } of rows) {
    if ((inv as any).deleted_at || (partner as any).deleted_at) continue;
    (out[inv.asset_id] ??= []).push({
      partner_id: partner.id, name: partner.name, ownership_pct: Number(inv.ownership_pct || 0),
      commitment: Number(inv.commitment || 0), funded: Number(inv.funded || 0),
    });
  }
  return out;
}

// --------------------------------------------------------------------------- financial aggregation

export async function monthlyByCategory(
  db: Db, assetIds: Set<string>, since: string, opts: { verified_only?: boolean } = {},
): Promise<Record<string, Monthly>> {
  if (!assetIds.size) return {};
  const rows = await db
    .select({
      asset_id: assetFinancials.asset_id, period: assetFinancials.period, category: assetFinancials.category,
      total: sql<string>`sum(${assetFinancials.amount})`,
    })
    .from(assetFinancials)
    .where(
      and(
        inArray(assetFinancials.asset_id, [...assetIds]),
        eq(assetFinancials.is_current, true),
        isNull(assetFinancials.deleted_at),
        gte(assetFinancials.period, since),
        opts.verified_only ? eq(assetFinancials.verified, true) : undefined,
      ),
    )
    .groupBy(assetFinancials.asset_id, assetFinancials.period, assetFinancials.category);
  const out: Record<string, Monthly> = {};
  for (const r of rows) {
    const m = (out[r.asset_id] ??= {});
    (m[r.period] ??= {})[r.category] = Number(r.total || 0);
  }
  return out;
}

export function windowSum(monthly: Monthly, end: string, cats: Set<string>, months = 12): number {
  const start = addMonths(end, -(months - 1));
  let total = 0;
  for (const [p, row] of Object.entries(monthly)) {
    if (start <= p && p <= end) for (const [c, v] of Object.entries(row)) if (cats.has(c)) total += v;
  }
  return total;
}

/** NOI for the 12 months ending `end` (default: latest period with data). Returns [noi, end, months_present]. */
export function ttmNoi(monthly: Monthly, end?: string | null): [number | null, string | null, number] {
  const periods = Object.keys(monthly);
  if (!periods.length) return [null, null, 0];
  const e = end || periods.reduce((a, b) => (a > b ? a : b));
  const start = addMonths(e, -11);
  const present = periods.filter((p) => start <= p && p <= e).length;
  if (present === 0) return [null, e, 0];
  return [windowSum(monthly, e, INCOME_CATS) - windowSum(monthly, e, EXPENSE_CATS), e, present];
}

export async function capexTotals(db: Db, assetIds: Set<string>): Promise<Record<string, number>> {
  if (!assetIds.size) return {};
  const rows = await db
    .select({ asset_id: assetFinancials.asset_id, total: sql<string>`sum(${assetFinancials.amount})` })
    .from(assetFinancials)
    .where(
      and(
        inArray(assetFinancials.asset_id, [...assetIds]),
        eq(assetFinancials.category, "capex"),
        eq(assetFinancials.is_current, true),
        isNull(assetFinancials.deleted_at),
      ),
    )
    .groupBy(assetFinancials.asset_id);
  return Object.fromEntries(rows.map((r) => [r.asset_id, Number(r.total || 0)]));
}

// --------------------------------------------------------------------------- KPIs

export function occupancyWale(prop: Property, leaseList: LeaseInfo[] | null | undefined): [number | null, number | null, string] {
  const today = todayStr();
  if (leaseList && leaseList.length) {
    const area = Number(prop.building_area_sf || 0);
    const leased = leaseList
      .filter((l) => !l.commencement_on || l.commencement_on <= today)
      .reduce((t, l) => t + l.rentable_sf, 0);
    let occ: number | null = area ? Math.min(100.0, (leased / area) * 100) : null;
    const weights = leaseList
      .map((l): [number, number | null] => [
        l.annual_rent || l.rentable_sf,
        l.expiration_on ? Math.max(0.0, daysBetween(l.expiration_on, today) / 365.25) : null,
      ])
      .filter(([w, y]) => y !== null && w) as Array<[number, number]>;
    const wale = weights.length ? weights.reduce((t, [w, y]) => t + w * y, 0) / weights.reduce((t, [w]) => t + w, 0) : null;
    if (occ === null) occ = prop.occupancy_pct !== null && prop.occupancy_pct !== undefined ? Number(prop.occupancy_pct) : null;
    return [occ, wale, "leases"];
  }
  return [
    prop.occupancy_pct !== null && prop.occupancy_pct !== undefined ? Number(prop.occupancy_pct) : null,
    prop.wale_years !== null && prop.wale_years !== undefined ? Number(prop.wale_years) : null,
    "property",
  ];
}

export async function computeKpis(
  db: Db, rows: Asset[], props: Record<string, Property>, opts: { with_value?: boolean } = {},
): Promise<Record<string, Kpi>> {
  const withValue = opts.with_value ?? true;
  const ids = new Set(rows.map((a) => a.id));
  const monthly = await monthlyByCategory(db, ids, addMonths(monthStart(todayStr()), -36));
  const capex = await capexTotals(db, ids);
  const loanMap = await activeLoans(db, rows);
  const leaseMap = await leaseData(db, new Set(rows.map((a) => a.property_id)));
  const out: Record<string, Kpi> = {};
  for (const a of rows) {
    const p = props[a.property_id];
    const m = monthly[a.id] ?? {};
    let [noi, end, present] = ttmNoi(m);
    const aLoans = loanMap[a.id] ?? [];
    const dsActual = end ? windowSum(m, end, new Set(["debt_service"])) : 0.0;
    const dsEst = aLoans.reduce((t, l) => t + l.annual_debt_service, 0);
    const ds = dsActual > 0 ? dsActual : dsEst;
    const debt = aLoans.reduce((t, l) => t + l.balance, 0);
    const propLeases = leaseMap !== null ? (leaseMap[a.property_id] ?? null) : null;
    const [occ, wale, occSrc] = p ? occupancyWale(p, propLeases) : [null, null, "property"];
    let noiSrc: string;
    if (noi === null && p && p.noi !== null && p.noi !== undefined) {
      noi = Number(p.noi);
      noiSrc = "property";
    } else {
      noiSrc = "financials";
    }
    let value: number | null = null;
    let valueSrc: string | null = null;
    if (withValue) {
      const v = await latestValuation(db, a.property_id);
      if (v && v.value_point) {
        value = Number(v.value_point);
        valueSrc = `valuation (${v.method || "mark"}, ${v.as_of})`;
      }
    }
    if (value === null && a.current_value) {
      value = Number(a.current_value);
      valueSrc = "asset record";
    }
    if (value === null && a.basis) {
      value = Number(a.basis);
      valueSrc = "basis";
    }
    const costRaw = Number(a.basis || 0) + (capex[a.id] ?? 0.0);
    const cost = costRaw || null;
    out[a.id] = {
      noi_ttm: r2(noi), noi_source: noiSrc, ttm_end: end, months_present: present,
      income_ttm: end ? r2(windowSum(m, end, INCOME_CATS)) : null,
      expense_ttm: end ? r2(windowSum(m, end, EXPENSE_CATS)) : null,
      capex_total: r2(capex[a.id] ?? 0.0), debt_service: ds ? r2(ds) : null,
      debt_service_source: dsActual > 0 ? "financials" : dsEst ? "loan terms" : null,
      debt: r2(debt), value: r2(value), value_source: valueSrc,
      occupancy: r2(occ), occupancy_source: occSrc, wale: r2(wale), cost: r2(cost),
      yield_on_cost: pct(noi, cost), leverage: debt ? pct(debt, value) : value ? 0.0 : null,
      coverage: ds ? r2(safeDiv(noi, ds), 3) : null,
      loans: aLoans, leases: propLeases, building_sf: p ? Number(p.building_area_sf || 0) : 0,
    };
  }
  return out;
}

const metric = (value: number | null, label: string | null, source: string | null, drill: Array<Record<string, string>>): Metric => ({
  value, label, source, drill,
});

export function kpiMetrics(a: Asset, k: Kpi): Record<string, Metric> {
  const aid = a.id;
  const pid = a.property_id;
  const fin = { label: "Monthly financials", href: `/assets/${aid}?tab=financials` };
  const loanDrill = (k.loans as LoanInfo[]).map((l) => ({ label: `Loan · ${l.lender_name}`, href: `/loans/${l.id}` }));
  const leaseDrill = k.occupancy_source === "leases"
    ? [{ label: "Leases", href: `/leases?property_id=${pid}` }]
    : [{ label: "Property record", href: `/properties/${pid}` }];
  const valueDrill = String(k.value_source || "").startsWith("valuation")
    ? [{ label: "Valuations", href: `/comps?property_id=${pid}` }]
    : [{ label: "Asset record", href: `/assets/${aid}` }];
  const noiDrill = k.noi_source === "financials" ? [fin] : [{ label: "Property record", href: `/properties/${pid}` }];
  return {
    occupancy: metric(k.occupancy, "Occupancy", k.occupancy_source, leaseDrill),
    wale: metric(k.wale, "WALE (years)", k.occupancy_source, leaseDrill),
    noi: metric(k.noi_ttm, "NOI (TTM)", k.noi_source, noiDrill),
    yield_on_cost: metric(k.yield_on_cost, "Yield on cost", "NOI / (basis + capex)",
      [...noiDrill, { label: "Asset basis", href: `/assets/${aid}` }]),
    leverage: metric(k.leverage, "Leverage (LTV)", "debt / value", [...loanDrill, ...valueDrill]),
    coverage: metric(k.coverage, "Coverage (DSCR)", k.debt_service_source, [...noiDrill, ...loanDrill]),
    value: metric(k.value, "Value", k.value_source, valueDrill),
    debt: metric(k.debt, "Debt balance", "loans", loanDrill),
  };
}

export async function openWatchCounts(db: Db, ids: Set<string>): Promise<Record<string, number>> {
  if (!ids.size) return {};
  const rows = await db
    .select({ asset_id: watchlistEntries.asset_id, n: sql<number>`count(*)::int` })
    .from(watchlistEntries)
    .where(
      and(inArray(watchlistEntries.asset_id, [...ids]), eq(watchlistEntries.status, "open"), isNull(watchlistEntries.deleted_at)),
    )
    .groupBy(watchlistEntries.asset_id);
  return Object.fromEntries(rows.map((r) => [r.asset_id, Number(r.n)]));
}

export async function toItems(db: Db, rows: Asset[]): Promise<Record<string, any>[]> {
  const props = await loadProps(db, rows);
  const kp = await computeKpis(db, rows, props, { with_value: true });
  const names = await userNames(db, rows.map((a) => a.manager_id));
  const watch = await openWatchCounts(db, new Set(rows.map((a) => a.id)));
  return rows.map((a) => {
    const p = props[a.property_id];
    const k = kp[a.id];
    return {
      id: a.id, property_id: a.property_id, property_label: propLabel(p),
      city: p ? p.city : null, state: p ? p.state : null,
      property_type: p ? p.property_type : null, status: a.status, acquired_on: a.acquired_on,
      basis: a.basis, current_value: k.value, manager_id: a.manager_id,
      manager_name: a.manager_id ? (names[a.manager_id] ?? null) : null, noi_ttm: k.noi_ttm, occupancy: k.occupancy,
      leverage: k.leverage, coverage: k.coverage, yield_on_cost: k.yield_on_cost,
      open_watch: watch[a.id] ?? 0, updated_at: a.updated_at,
    };
  });
}

export async function uwBenchmark(db: Db, a: Asset): Promise<Record<string, any> | null> {
  if (!a.uw_model_id) return null;
  let m: any;
  try {
    const { getApproved } = await import("../underwriting/service");
    m = await getApproved(db, a.uw_model_id);
  } catch (e) {
    if (e instanceof HttpError) {
      return { model_id: a.uw_model_id, available: false, note: "Linked underwriting model is not approved." };
    }
    return null;
  }
  const outputs: Record<string, any> = m.outputs || {};
  const keys = [
    "purchase_price", "noi_year1", "going_in_cap", "stabilized_cap", "loan_amount", "dscr", "debt_yield",
    "cash_on_cash", "irr", "equity_multiple", "exit_value", "breakeven_occupancy",
  ];
  return {
    model_id: m.id, available: true, name: m.name ?? null, version: m.version ?? null,
    approved_at: m.approved_at ?? null,
    outputs: Object.fromEntries(keys.filter((k) => k in outputs).map((k) => [k, outputs[k]])),
    href: `/underwriting/${m.id}`,
  };
}

export async function toOut(db: Db, a: Asset): Promise<Record<string, any>> {
  const props = await loadProps(db, [a]);
  const p = props[a.property_id];
  const k = (await computeKpis(db, [a], props))[a.id];
  const names = await userNames(db, [a.manager_id]);
  const stakes = await partnerStakes(db, new Set([a.id]));
  return {
    id: a.id,
    status: a.status, acquired_on: a.acquired_on, basis: a.basis, equity_invested: a.equity_invested,
    current_value: a.current_value, value_as_of: a.value_as_of, hold_thesis: a.hold_thesis,
    business_plan: a.business_plan, target_hold_years: a.target_hold_years, exit_cap_rate: a.exit_cap_rate,
    target_exit_on: a.target_exit_on, exit_assumptions: a.exit_assumptions ?? {}, manager_id: a.manager_id,
    uw_model_id: a.uw_model_id, opportunity_id: a.opportunity_id, notes: a.notes,
    property_id: a.property_id, closing_id: a.closing_id, disposed_on: a.disposed_on,
    created_at: a.created_at, updated_at: a.updated_at,
    property_label: propLabel(p),
    address_line: p ? p.address_line : null, city: p ? p.city : null, state: p ? p.state : null,
    county: p ? p.county : null, property_type: p ? p.property_type : null, corridor: p ? p.corridor : null,
    manager_name: a.manager_id ? (names[a.manager_id] ?? null) : null,
    kpis: kpiMetrics(a, k),
    capital_structure: {
      debt_total: k.debt, value: k.value, equity_invested: a.equity_invested, ltv: k.leverage,
      loans: (k.loans as LoanInfo[]).map((l) => ({ ...l, href: `/loans/${l.id}` })),
      partners: stakes !== null ? (stakes[a.id] ?? []).map((s) => ({ ...s, href: `/investors/${s.partner_id}` })) : null,
    },
    benchmark: await uwBenchmark(db, a),
  };
}

// --------------------------------------------------------------------------- mutations

export async function create(db: Db, data: AssetCreate, actor: CurrentUser): Promise<Asset> {
  const prop = await getRow(db, properties, data.property_id);
  if (!prop || prop.deleted_at) throw new HttpError(404, "Property not found");
  if (await byProperty(db, data.property_id)) throw new HttpError(409, "This property already has an asset record");
  const { provenance: prov, ...values } = data;
  const a = await insert(db, assets, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
  for (const field of MATERIAL_FIELDS) {
    const v = (a as Record<string, any>)[field];
    if (v !== null && v !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: a.id, field, value: v, prov, actor_id: actor.id });
    }
  }
  await markPropertyOwned(db, prop, actor);
  await audit.record(db, {
    actor, action: "asset.created", entity_type: ENTITY, entity_id: a.id, summary: propLabel(prop), ip_address: actor.ip_address,
  });
  await events.emit(db, "asset.created", { asset_id: a.id, property_id: a.property_id, actor });
  await db.commit();
  return a;
}

async function markPropertyOwned(db: Db, prop: Property, actor: Actor): Promise<void> {
  if (prop.status !== "owned" && prop.status !== "managed") {
    const old = prop.status;
    await patch(db, properties, prop, { status: "owned", updated_by_id: actor?.id ?? null });
    await audit.record(db, {
      actor, action: "property.updated", entity_type: "property", entity_id: prop.id,
      changes: { status: { from: old, to: "owned" } }, summary: "Acquired — asset record created",
    });
    await events.emit(db, "property.updated", { property_id: prop.id, changed: new Set(["status"]), actor });
  }
}

/** Idempotent per property. Sets property.status='owned'. Does not commit. */
export async function createAssetFromClosing(
  db: Db,
  o: {
    property_id: string;
    opportunity_id?: string | null;
    closing_id?: string | null;
    acquired_on: string;
    basis: number | null;
    uw_model_id?: string | null;
    manager_id?: string | null;
    hold_thesis?: string | null;
    actor: Actor;
  },
): Promise<Asset> {
  const { property_id, acquired_on, basis, actor } = o;
  const opportunity_id = o.opportunity_id ?? null;
  const closing_id = o.closing_id ?? null;
  const uw_model_id = o.uw_model_id ?? null;
  const existing = await byProperty(db, property_id);
  if (existing) {
    const changed: Record<string, any> = {};
    const set: Record<string, any> = {};
    for (const [field, value] of [["closing_id", closing_id], ["opportunity_id", opportunity_id], ["uw_model_id", uw_model_id]] as const) {
      if (value && (existing as Record<string, any>)[field] === null) {
        set[field] = value;
        changed[field] = { from: null, to: value };
      }
    }
    if (Object.keys(changed).length) {
      await patch(db, assets, existing, set as never);
      await audit.record(db, {
        actor, action: "asset.linked", entity_type: ENTITY, entity_id: existing.id, changes: changed,
        summary: "Linked closing records",
      });
    }
    return existing;
  }
  const prop = await getRow(db, properties, property_id);
  if (!prop) throw new HttpError(404, "Property not found");
  const actorId = actor?.id ?? null;
  const a = await insert(db, assets, {
    property_id, status: "active", acquired_on, basis, opportunity_id, closing_id, uw_model_id,
    manager_id: o.manager_id ?? null, hold_thesis: o.hold_thesis ?? null, exit_assumptions: {},
    created_by_id: actorId, updated_by_id: actorId,
  } as never);
  const prov: ProvenanceIn = { source: "Closing", observed_on: acquired_on, confidence: 1.0, verified: true, ai_derived: false };
  for (const field of ["basis", "acquired_on"]) {
    const v = (a as Record<string, any>)[field];
    if (v !== null && v !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: a.id, field, value: v, prov, actor_id: actorId });
    }
  }
  await markPropertyOwned(db, prop, actor);
  await audit.record(db, {
    actor, action: "asset.created", entity_type: ENTITY, entity_id: a.id,
    summary: `Created from closing · ${propLabel(prop)}`, changes: { closing_id, opportunity_id, basis },
  });
  await events.emit(db, "asset.created", { asset_id: a.id, property_id, actor });
  return a;
}

export async function update(db: Db, a: Asset, data: AssetUpdate, actor: CurrentUser): Promise<Asset> {
  const { provenance: prov, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if ("exit_assumptions" in values && values.exit_assumptions === null) values.exit_assumptions = {};
  // `a` is mutated in memory by applyMaterial; persisted below with one UPDATE.
  const changes = await provenance.applyMaterial(db, a, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL_FIELDS, prov, actor_id: actor.id,
  });
  if (!Object.keys(changes).length) return a;
  const set: Record<string, any> = Object.fromEntries(Object.keys(changes).map((k) => [k, (a as Record<string, any>)[k]]));
  if ("status" in changes && a.status === "disposed" && !a.disposed_on) {
    a.disposed_on = todayStr();
    set.disposed_on = a.disposed_on;
  }
  set.updated_by_id = actor.id;
  await patch(db, assets, a, set as never);
  await audit.record(db, {
    actor, action: "asset.updated", entity_type: ENTITY, entity_id: a.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return a;
}

export async function archive(db: Db, a: Asset, actor: CurrentUser): Promise<void> {
  await patch(db, assets, a, { deleted_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, { actor, action: "asset.archived", entity_type: ENTITY, entity_id: a.id, ip_address: actor.ip_address });
  await db.commit();
}

// --------------------------------------------------------------------------- financials

/** Returns [row, outcome, change] where outcome is created | superseded | unchanged. */
async function addFinancialRow(
  db: Db, a: Asset, row: FinancialIn, source: string, actor: CurrentUser,
): Promise<[AssetFinancial, string, Record<string, any> | null]> {
  const period = monthStart(row.period);
  const account = row.account.trim();
  const [prior] = await db
    .select()
    .from(assetFinancials)
    .where(
      and(
        eq(assetFinancials.asset_id, a.id), eq(assetFinancials.period, period), eq(assetFinancials.account, account),
        eq(assetFinancials.is_current, true), isNull(assetFinancials.deleted_at),
      ),
    )
    .limit(1);
  let change: Record<string, any> | null = null;
  if (prior) {
    if (Number(prior.amount) === Number(row.amount) && prior.category === row.category) return [prior, "unchanged", null];
    if (prior.verified && !actor.can("assets", "approve")) {
      throw new HttpError(403, `${account} ${period.slice(0, 7)} is a verified actual; replacing it requires approval permission`);
    }
    // Superseded, kept for history. deleted_at is also set so consumers that only filter on deleted_at
    // never double count; history views read rows regardless of deleted_at.
    await patch(db, assetFinancials, prior, { is_current: false, deleted_at: new Date(), updated_by_id: actor.id });
    change = { from: Number(prior.amount), to: row.amount };
  }
  const f = await insert(db, assetFinancials, {
    asset_id: a.id, period, account, category: row.category, amount: row.amount, source, notes: row.notes ?? null,
    verified: false, is_current: true, created_by_id: actor.id, updated_by_id: actor.id,
  });
  return [f, prior ? "superseded" : "created", change];
}

export async function addFinancial(db: Db, a: Asset, row: FinancialIn, actor: CurrentUser): Promise<AssetFinancial> {
  const [f, outcome, change] = await addFinancialRow(db, a, row, "manual", actor);
  if (outcome !== "unchanged") {
    await audit.record(db, {
      actor, action: "asset.financial_entered", entity_type: ENTITY, entity_id: a.id,
      summary: `${f.account} ${f.period.slice(0, 7)}`, changes: { amount: change || { to: row.amount } },
      ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return f;
}

export async function bulkFinancials(
  db: Db, a: Asset, rows: FinancialIn[], source: string, actor: CurrentUser,
): Promise<Record<string, any>> {
  const counts: Record<string, number> = { created: 0, superseded: 0, unchanged: 0 };
  for (const row of rows) {
    const [, outcome] = await addFinancialRow(db, a, row, source, actor);
    counts[outcome] += 1;
  }
  await audit.record(db, {
    actor, action: "asset.financials_imported", entity_type: ENTITY, entity_id: a.id,
    summary: `${rows.length} rows (${counts.superseded} superseded)`, changes: { rows: rows.length, ...counts },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return { rows: rows.length, ...counts };
}

export async function verifyFinancials(db: Db, a: Asset, start: string, end: string, actor: CurrentUser): Promise<number> {
  const found = await db
    .select({ id: assetFinancials.id })
    .from(assetFinancials)
    .where(
      and(
        eq(assetFinancials.asset_id, a.id), eq(assetFinancials.is_current, true), isNull(assetFinancials.deleted_at),
        eq(assetFinancials.verified, false), gte(assetFinancials.period, monthStart(start)),
        lte(assetFinancials.period, monthStart(end)),
      ),
    );
  if (found.length) {
    await db
      .update(assetFinancials)
      .set({ verified: true, verified_by_id: actor.id, verified_at: new Date() })
      .where(inArray(assetFinancials.id, found.map((r) => r.id)));
  }
  await audit.record(db, {
    actor, action: "asset.financials_verified", entity_type: ENTITY, entity_id: a.id,
    summary: `${found.length} rows ${start.slice(0, 7)} to ${end.slice(0, 7)}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return found.length;
}

export async function deleteFinancial(db: Db, f: AssetFinancial, actor: CurrentUser): Promise<void> {
  await patch(db, assetFinancials, f, { deleted_at: new Date(), is_current: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "asset.financial_deleted", entity_type: ENTITY, entity_id: f.asset_id,
    summary: `${f.account} ${f.period.slice(0, 7)}`, changes: { amount: { from: f.amount, to: null } },
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- actual vs budget vs underwriting

export async function budgetLinesFor(
  db: Db, assetId: string, years: Set<number>,
): Promise<{ values: Map<string, number>; cats: Map<string, string>; used: string[] }> {
  const values = new Map<string, number>();
  const cats = new Map<string, string>();
  const used: string[] = [];
  for (const fy of years) {
    const [budget] = await db
      .select()
      .from(budgets)
      .where(
        and(eq(budgets.asset_id, assetId), eq(budgets.fiscal_year, fy), eq(budgets.status, "approved"), isNull(budgets.deleted_at)),
      )
      .orderBy(desc(budgets.version))
      .limit(1);
    if (!budget) continue;
    used.push(budget.id);
    for (const line of await db.select().from(budgetLines).where(eq(budgetLines.budget_id, budget.id))) {
      if ((line as any).deleted_at) continue;
      const key = mk(line.account, `${String(fy).padStart(4, "0")}-${String(Number(line.month)).padStart(2, "0")}-01`);
      values.set(key, (values.get(key) ?? 0) + Number(line.amount || 0));
      if (!cats.has(line.account)) cats.set(line.account, line.category);
    }
  }
  return { values, cats, used };
}

/** Annual UW amounts by account (if the model exposes line items) and summary totals. */
export function uwLines(outputsFull: Record<string, any> | null): [Map<string, number>, Map<string, string>, Record<string, number>] {
  const lines = new Map<string, number>();
  const cats = new Map<string, string>();
  const totals: Record<string, number> = {};
  const o = outputsFull || {};
  const items = o.line_items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    for (const [acct, amt] of Object.entries(items)) if (typeof amt === "number") lines.set(acct, amt);
  } else if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === "object" && it.account && typeof it.amount === "number") {
        lines.set(it.account, it.amount);
        if (it.category) cats.set(it.account, it.category);
      }
    }
  }
  const groups: Array<[string, string[]]> = [
    ["income", ["egi", "effective_gross_income", "revenue_year1", "total_income"]],
    ["expense", ["opex", "operating_expenses", "expenses_year1", "total_expenses"]],
    ["noi", ["noi_year1"]],
  ];
  for (const [key, names] of groups) {
    for (const n of names) {
      if (typeof o[n] === "number") {
        totals[key] = o[n];
        break;
      }
    }
  }
  return [lines, cats, totals];
}

async function uwOutputs(db: Db, a: Asset): Promise<Record<string, any> | null> {
  if (!a.uw_model_id) return null;
  try {
    const { getApproved } = await import("../underwriting/service");
    return (((await getApproved(db, a.uw_model_id)) as any).outputs as Record<string, any>) || {};
  } catch {
    return null;
  }
}

export function variance(actual: number | null, bench: number | null, category: string, s: Record<string, any>) {
  if (bench === null || bench === undefined || actual === null || actual === undefined) {
    return { variance: null, variance_pct: null, favorable: null, flag: false };
  }
  const v = actual - bench;
  const vp = bench ? pct(v, Math.abs(bench)) : null;
  const favorable = category === "income" || category === "noi" ? v >= 0 : v <= 0;
  const bigAmt = Math.abs(v) >= Number(s.variance_amount);
  const bigPct = vp === null || Math.abs(vp) >= Number(s.variance_pct);
  return { variance: r2(v), variance_pct: vp, favorable, flag: Boolean(bigAmt && bigPct && v !== 0) };
}

export async function performance(db: Db, a: Asset, year: number, monthArg?: number | null): Promise<Record<string, any>> {
  const s = await getSettings(db);
  const rows = await db
    .select({
      account: assetFinancials.account, category: assetFinancials.category, period: assetFinancials.period,
      total: sql<string>`sum(${assetFinancials.amount})`,
    })
    .from(assetFinancials)
    .where(
      and(
        eq(assetFinancials.asset_id, a.id), eq(assetFinancials.is_current, true), isNull(assetFinancials.deleted_at),
        gte(assetFinancials.period, `${String(year - 1).padStart(4, "0")}-01-01`),
        lte(assetFinancials.period, `${String(year).padStart(4, "0")}-12-01`),
      ),
    )
    .groupBy(assetFinancials.account, assetFinancials.category, assetFinancials.period);
  const actual = new Map<string, number>();
  const cats = new Map<string, string>();
  for (const r of rows) {
    const key = mk(r.account, r.period);
    actual.set(key, (actual.get(key) ?? 0) + Number(r.total || 0));
    if (!cats.has(r.account)) cats.set(r.account, r.category);
  }
  const today = todayStr();
  let month = monthArg ?? null;
  if (month === null) {
    const inYear = [...actual.keys()].map((k) => unmk(k)[1]).filter((p) => Number(p.slice(0, 4)) === year);
    month = inYear.length
      ? Number(inYear.reduce((x, y) => (x > y ? x : y)).slice(5, 7))
      : year === Number(today.slice(0, 4)) ? Number(today.slice(5, 7)) : 12;
  }
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const end = `${String(year).padStart(4, "0")}-${pad2(month)}-01`;
  const ttmStart = addMonths(end, -11);
  const { values: budget, cats: bcats, used: budgetIds } = await budgetLinesFor(
    db, a.id, Number(ttmStart.slice(0, 4)) < year ? new Set([year, year - 1]) : new Set([year]),
  );
  for (const [k, v] of bcats) if (!cats.has(k)) cats.set(k, v);
  const outputs = await uwOutputs(db, a);
  const [uwAnnual, ucats, uwTotals] = uwLines(outputs);
  for (const [k, v] of ucats) if (!cats.has(k)) cats.set(k, v);
  const months = Array.from({ length: 12 }, (_, i) => `${String(year).padStart(4, "0")}-${pad2(i + 1)}-01`);
  const ttmMonths = monthRange(ttmStart, end);
  const order: Record<string, number> = { income: 0, expense: 1, capex: 2, reserve: 3, debt_service: 4, distribution: 5 };
  const accountSet = new Set<string>();
  for (const k of actual.keys()) accountSet.add(unmk(k)[0]);
  for (const k of budget.keys()) accountSet.add(unmk(k)[0]);
  for (const k of uwAnnual.keys()) accountSet.add(k);
  const accounts = [...accountSet].sort((x, y) => {
    const ox = order[cats.get(x) ?? "expense"] ?? 9;
    const oy = order[cats.get(y) ?? "expense"] ?? 9;
    if (ox !== oy) return ox - oy;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const haveBudget = budgetIds.length > 0;
  const haveUw = outputs !== null;

  const existing = new Map<string, { id: string; status: string }>();
  const existingRows = await db
    .select()
    .from(varianceExplanations)
    .where(and(eq(varianceExplanations.asset_id, a.id), isNull(varianceExplanations.deleted_at), eq(varianceExplanations.period, end)));
  for (const v of existingRows) existing.set(`${v.account}\u0001${v.window}\u0001${v.basis}`, { id: v.id, status: v.status });

  type Getter = (m: string) => number | null;
  const windowVals = (getA: Getter, getB: Getter, getU: Getter, ms: string[]): [number, number | null, number | null] => {
    const act = ms.reduce((t, m) => t + (getA(m) as number), 0);
    const bud = haveBudget ? ms.reduce((t, m) => t + (getB(m) as number), 0) : null;
    const uw = getU(ms[0]) !== null ? ms.reduce((t, m) => t + (getU(m) as number), 0) : null;
    return [act, bud, uw];
  };

  const build = (name: string, cat: string, getA: Getter, getB: Getter, getU: Getter, summary = false): Record<string, any> => {
    const monthly = months.map((m) => ({
      period: m, actual: r2(getA(m)), budget: haveBudget ? r2(getB(m)) : null, uw: r2(getU(m)),
    }));
    const explanations: Record<string, any> = {};
    if (!summary) {
      for (const w of ["month", "ttm"]) {
        for (const b of ["budget", "underwriting"]) {
          const e = existing.get(`${name}\u0001${w}\u0001${b}`);
          if (e) explanations[`${w}:${b}`] = e;
        }
      }
    }
    const out: Record<string, any> = {
      account: name, category: cat, is_summary: summary, monthly,
      drill: !summary ? `/assets/${a.id}?tab=financials&account=${pyQuote(name)}` : `/assets/${a.id}?tab=financials`,
      explanations,
    };
    for (const [key, ms] of [["month", [end]], ["ttm", ttmMonths]] as Array<[string, string[]]>) {
      const [act, bud, uw] = windowVals(getA, getB, getU, ms);
      const vb = variance(act, bud, cat, s);
      const vu = variance(act, uw, cat, s);
      out[key] = {
        actual: r2(act), budget: r2(bud), uw: r2(uw),
        var_budget: vb.variance, var_budget_pct: vb.variance_pct, fav_budget: vb.favorable,
        flag_budget: vb.flag && !summary,
        var_uw: vu.variance, var_uw_pct: vu.variance_pct, fav_uw: vu.favorable,
        flag_uw: vu.flag && !summary,
      };
    }
    return out;
  };

  const lines = accounts.map((acct) => {
    const cat = cats.get(acct) ?? "expense";
    const uwM = uwAnnual.get(acct);
    return build(
      acct, cat,
      (m) => actual.get(mk(acct, m)) ?? 0.0,
      (m) => budget.get(mk(acct, m)) ?? 0.0,
      () => (uwM !== undefined ? uwM / 12 : null),
    );
  });

  const catSum = (src: Map<string, number>, cset: Set<string>, m: string): number => {
    let total = 0;
    for (const [key, v] of src) {
      const [acct, p] = unmk(key);
      if (p === m && cset.has(cats.get(acct) ?? "expense")) total += v;
    }
    return total;
  };
  const uwCat = (key: string, cset: Set<string>): Getter => {
    if (key in uwTotals) return () => uwTotals[key] / 12;
    const vals = [...uwAnnual].filter(([acct]) => cset.has(cats.get(acct) ?? "expense")).map(([, v]) => v);
    return vals.length ? () => vals.reduce((t, v) => t + v, 0) / 12 : () => null;
  };
  const uwNoi: Getter = "noi" in uwTotals
    ? () => uwTotals.noi / 12
    : uwCat("income", INCOME_CATS)(end) !== null
      ? (m) => (uwCat("income", INCOME_CATS)(m) || 0) - (uwCat("expense", EXPENSE_CATS)(m) || 0)
      : () => null;
  const summary = [
    build("Total income", "income", (m) => catSum(actual, INCOME_CATS, m), (m) => catSum(budget, INCOME_CATS, m),
      uwCat("income", INCOME_CATS), true),
    build("Total operating expenses", "expense", (m) => catSum(actual, EXPENSE_CATS, m),
      (m) => catSum(budget, EXPENSE_CATS, m), uwCat("expense", EXPENSE_CATS), true),
    build("Net operating income", "noi",
      (m) => catSum(actual, INCOME_CATS, m) - catSum(actual, EXPENSE_CATS, m),
      (m) => catSum(budget, INCOME_CATS, m) - catSum(budget, EXPENSE_CATS, m), uwNoi, true),
  ];
  return {
    asset_id: a.id, year, month, period: end, ttm_start: ttmStart, ttm_end: end,
    months, budget_available: haveBudget, budget_ids: budgetIds,
    uw_available: haveUw, uw_model_id: a.uw_model_id,
    uw_note: haveUw
      ? "Underwriting benchmark is the approved acquisition model (year-1 run rate)."
      : "No approved underwriting model is linked to this asset.",
    thresholds: { pct: s.variance_pct, amount: s.variance_amount },
    lines, summary,
  };
}

async function varianceTask(db: Db, a: Asset, v: VarianceExplanation, label: string, actorId: string | null): Promise<void> {
  const { createTask } = await import("../tasks/service");
  const task = await createTask(db, {
    title: `Explain ${v.basis} variance: ${v.account} (${v.window}, ${fmtMonthYear(v.period)})`,
    assignee_id: v.owner_id, due_at: new Date(Date.now() + 7 * 86_400_000), task_type: "review", priority: "normal",
    description: `Actual ${pyStr(v.actual)} vs ${v.basis} ${pyStr(v.benchmark)} (variance ${pyStr(v.variance)}, ${pyStr(v.variance_pct)}%).`,
    related_type: "asset", related_id: a.id, related_label: label, source: "assets.variance",
    idempotency_key: `variance:${a.id}:${v.period}:${v.window}:${v.basis}:${v.account}`.slice(0, 200), actor_id: actorId,
  });
  await patch(db, varianceExplanations, v, { task_id: task.id });
}

/** Creates 'required' explanation records for every flagged line without one. Does not commit. */
export async function detectVariances(db: Db, a: Asset, year: number, month: number | null | undefined, actor: Actor): Promise<number> {
  const perf = await performance(db, a, year, month);
  const prop = await getRow(db, properties, a.property_id);
  let created = 0;
  for (const line of perf.lines) {
    for (const window of ["month", "ttm"]) {
      const w = line[window];
      const combos: Array<[string, boolean, number | null, number | null, number | null]> = [
        ["budget", w.flag_budget, w.budget, w.var_budget, w.var_budget_pct],
        ["underwriting", w.flag_uw, w.uw, w.var_uw, w.var_uw_pct],
      ];
      for (const [basis, flag, bench, vr, vp] of combos) {
        if (!flag || line.explanations[`${window}:${basis}`]) continue;
        const v = await insert(db, varianceExplanations, {
          asset_id: a.id, period: perf.period, window, basis, account: line.account, actual: w.actual, benchmark: bench,
          variance: vr, variance_pct: vp, owner_id: a.manager_id, status: "required", created_by_id: actor?.id ?? null,
        });
        await varianceTask(db, a, v, propLabel(prop), actor?.id ?? null);
        line.explanations[`${window}:${basis}`] = { id: v.id, status: v.status };
        created += 1;
      }
    }
  }
  return created;
}

export async function explain(db: Db, a: Asset, data: ExplainIn, actor: CurrentUser): Promise<VarianceExplanation> {
  const period = monthStart(data.period);
  let [v] = await db
    .select()
    .from(varianceExplanations)
    .where(
      and(
        eq(varianceExplanations.asset_id, a.id), eq(varianceExplanations.period, period),
        eq(varianceExplanations.window, data.window), eq(varianceExplanations.basis, data.basis),
        eq(varianceExplanations.account, data.account), isNull(varianceExplanations.deleted_at),
      ),
    )
    .limit(1);
  if (!v) {
    const hasBoth = data.actual !== null && data.actual !== undefined && data.benchmark !== null && data.benchmark !== undefined;
    const varAmt = hasBoth ? (data.actual as number) - (data.benchmark as number) : null;
    v = await insert(db, varianceExplanations, {
      asset_id: a.id, period, window: data.window, basis: data.basis, account: data.account,
      actual: data.actual ?? null, benchmark: data.benchmark ?? null, variance: varAmt,
      variance_pct: varAmt !== null && data.benchmark ? pct(varAmt, Math.abs(data.benchmark)) : null,
      created_by_id: actor.id,
    });
  }
  v = await submit(db, v, data.explanation, data.owner_id || actor.id, actor);
  await db.commit();
  return v;
}

async function submit(
  db: Db, v: VarianceExplanation, text: string, ownerId: string | null, actor: CurrentUser,
): Promise<VarianceExplanation> {
  const old = v.explanation;
  await patch(db, varianceExplanations, v, {
    explanation: text, owner_id: v.owner_id || ownerId, status: "submitted", submitted_at: new Date(),
    updated_by_id: actor.id,
  });
  if (v.task_id) {
    const task = await getRow(db, tasks, v.task_id);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      await patch(db, tasks, task, { status: "done", completed_at: new Date(), completed_by_id: actor.id } as never);
    }
  }
  await audit.record(db, {
    actor, action: "asset.variance_explained", entity_type: ENTITY, entity_id: v.asset_id,
    summary: `${v.account} ${v.window} vs ${v.basis} (${v.period.slice(0, 7)})`,
    changes: { explanation: { from: old, to: text } }, ip_address: actor.ip_address,
  });
  return v;
}

export async function submitExplanation(db: Db, v: VarianceExplanation, text: string, actor: CurrentUser): Promise<VarianceExplanation> {
  await submit(db, v, text, actor.id, actor);
  await db.commit();
  return v;
}

export async function reviewExplanation(
  db: Db, v: VarianceExplanation, decision: string, note: string | null | undefined, actor: CurrentUser,
): Promise<VarianceExplanation> {
  if (v.status !== "submitted") throw new HttpError(409, "Only submitted explanations can be reviewed");
  await patch(db, varianceExplanations, v, {
    status: decision, review_note: note ?? null, reviewed_by_id: actor.id, reviewed_at: new Date(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `asset.variance_${decision}`, entity_type: ENTITY, entity_id: v.asset_id,
    summary: `${v.account} ${v.window} vs ${v.basis}`, changes: { note: note ?? null }, ip_address: actor.ip_address,
  });
  await db.commit();
  return v;
}

export async function varianceItems(db: Db, rows: VarianceExplanation[]): Promise<Record<string, any>[]> {
  const found = rows.length
    ? await db.select().from(assets).where(inArray(assets.id, [...new Set(rows.map((r) => r.asset_id))]))
    : [];
  const byId = Object.fromEntries(found.map((a) => [a.id, a]));
  const props = await loadProps(db, found);
  const names = await userNames(db, rows.map((r) => r.owner_id));
  const cols = [
    "id", "asset_id", "period", "window", "basis", "account", "actual", "benchmark", "variance", "variance_pct",
    "owner_id", "explanation", "status", "submitted_at", "reviewed_at", "review_note", "created_at",
  ];
  return rows.map((r) => {
    const a = byId[r.asset_id];
    const d: Record<string, any> = Object.fromEntries(cols.map((c) => [c, (r as Record<string, any>)[c]]));
    d.asset_label = a ? propLabel(props[a.property_id]) : null;
    d.owner_name = r.owner_id ? (names[r.owner_id] ?? null) : null;
    return d;
  });
}

// --------------------------------------------------------------------------- cash flow

export async function cashFlow(db: Db, rows: Asset[], months = 12, endArg?: string | null): Promise<Record<string, any>> {
  const ids = rows.map((a) => a.id);
  const end = monthStart(endArg || todayStr());
  const start = addMonths(end, -(months - 1));
  const monthly = await monthlyByCategory(db, new Set(ids), start);
  const loanMap = await activeLoans(db, rows);
  const estDs: Record<string, number> = {};
  for (const [aid, ls] of Object.entries(loanMap)) estDs[aid] = ls.reduce((t, l) => t + l.annual_debt_service, 0) / 12;
  const out: Record<string, any>[] = [];
  let cum = 0.0;
  const totals: Record<string, number> = {};
  const keys = [
    "income", "expense", "noi", "capex", "reserves", "debt_service", "cash_flow_before_debt", "cash_flow_after_debt",
    "distributions", "net_cash_flow",
  ];
  for (const m of monthRange(start, end)) {
    const r: Record<string, any> = {
      period: m, income: 0.0, expense: 0.0, capex: 0.0, reserves: 0.0, debt_service: 0.0, distributions: 0.0,
      debt_service_estimated: false,
    };
    for (const aid of ids) {
      const row = monthly[aid]?.[m] ?? {};
      r.income += row.income ?? 0.0;
      r.expense += row.expense ?? 0.0;
      r.capex += row.capex ?? 0.0;
      r.reserves += row.reserve ?? 0.0;
      r.distributions += row.distribution ?? 0.0;
      if ("debt_service" in row) {
        r.debt_service += row.debt_service;
      } else if (estDs[aid]) {
        r.debt_service += estDs[aid];
        r.debt_service_estimated = true;
      }
    }
    r.noi = r.income - r.expense;
    r.cash_flow_before_debt = r.noi - r.capex - r.reserves;
    r.cash_flow_after_debt = r.cash_flow_before_debt - r.debt_service;
    r.net_cash_flow = r.cash_flow_after_debt - r.distributions;
    cum += r.net_cash_flow;
    for (const k of keys) {
      totals[k] = (totals[k] ?? 0) + r[k];
      r[k] = r2(r[k]);
    }
    r.cumulative = r2(cum);
    out.push(r);
  }
  const drill: Array<Record<string, string>> = rows.length === 1
    ? [{ label: "Monthly financials", href: `/assets/${rows[0].id}?tab=financials` }]
    : [{ label: "Assets", href: "/assets" }];
  drill.push(
    ...Object.values(loanMap).flatMap((ls) => ls.map((l) => ({ label: `Loan · ${l.lender_name}`, href: `/loans/${l.id}` }))).slice(0, 20),
  );
  return {
    start, end, rows: out, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, r2(v)])),
    asset_count: rows.length, drill,
    note: "Debt service falls back to scheduled payments from loan terms where no actual was entered.",
  };
}

// --------------------------------------------------------------------------- portfolio views

function aggregate(ids: string[], kp: Record<string, Kpi>, byId: Record<string, Asset>): Record<string, any> {
  const ks = ids.map((i) => kp[i]);
  const sum = (f: (k: Kpi) => number) => ks.reduce((t, k) => t + f(k), 0);
  const value = sum((k) => k.value || 0);
  const noi = sum((k) => k.noi_ttm || 0);
  const debt = sum((k) => k.debt || 0);
  const ds = sum((k) => k.debt_service || 0);
  const cost = sum((k) => k.cost || 0);
  const occW = ks.filter((k) => k.occupancy !== null).map((k): [number, number] => [k.building_sf || 1, k.occupancy]);
  const waleW = ks.filter((k) => k.wale !== null).map((k): [number, number] => [k.value || 1, k.wale]);
  return {
    asset_count: ids.length, value: r2(value), basis: r2(ids.reduce((t, i) => t + Number(byId[i].basis || 0), 0)),
    noi_ttm: r2(noi), debt: r2(debt), debt_service: r2(ds),
    occupancy: occW.length ? r2(occW.reduce((t, [w, o]) => t + w * o, 0) / occW.reduce((t, [w]) => t + w, 0)) : null,
    wale: waleW.length ? r2(waleW.reduce((t, [w, y]) => t + w * y, 0) / waleW.reduce((t, [w]) => t + w, 0)) : null,
    yield_on_cost: pct(noi, cost), leverage: pct(debt, value), coverage: r2(safeDiv(noi, ds), 3),
  };
}

export async function portfolio(db: Db, f: AssetFilters, groupBy: string): Promise<Record<string, any>> {
  if (!f.status || !f.status.length) f.status = ["active", "held_for_sale"];
  const rows = await listAssets(db, f);
  const props = await loadProps(db, rows);
  const kp = await computeKpis(db, rows, props);
  const amap = Object.fromEntries(rows.map((a) => [a.id, a]));
  const ids = rows.map((a) => a.id);
  const totals = aggregate(ids, kp, amap);
  const loanDrill = [{ label: "Loans", href: "/loans" }];
  const totalMetrics = {
    occupancy: metric(totals.occupancy, "Occupancy", null, [{ label: "Assets by occupancy", href: "/assets?sort=occupancy" }]),
    wale: metric(totals.wale, "WALE (years)", null, [{ label: "Leases", href: "/leases" }]),
    noi: metric(totals.noi_ttm, "NOI (TTM)", null, [{ label: "Assets", href: "/assets" }]),
    yield_on_cost: metric(totals.yield_on_cost, "Yield on cost", null, [{ label: "Assets", href: "/assets" }]),
    leverage: metric(totals.leverage, "Leverage", null, loanDrill),
    coverage: metric(totals.coverage, "Coverage", null, loanDrill),
    value: metric(totals.value, "Value", null, [{ label: "Assets", href: "/assets" }]),
  };

  const groups = new Map<string, { key: string; label: string; ids: string[]; measure: number }>();
  const add = (key: string, label: string, aid: string, measure: number) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, label, ids: [], measure: 0.0 };
      groups.set(key, g);
    }
    if (!g.ids.includes(aid)) g.ids.push(aid);
    g.measure += measure;
  };

  let measureLabel = "Value";
  let unavailable: string | null = null;
  for (const a of rows) {
    const p = props[a.property_id];
    const k = kp[a.id];
    const value = k.value || 0;
    if (groupBy === "property_type") {
      add(p ? p.property_type : "other", p ? p.property_type : "other", a.id, value);
    } else if (groupBy === "geography") {
      const st = p ? (p.state || "Unknown") : "Unknown";
      const co = p ? (p.county || "Unknown county") : "Unknown county";
      add(`${st}|${co}`, `${st} · ${co}`, a.id, value);
    } else if (groupBy === "corridor") {
      const c = (p ? p.corridor : null) || "No corridor";
      add(c, c, a.id, value);
    } else if (groupBy === "vintage") {
      const y = a.acquired_on ? a.acquired_on.slice(0, 4).replace(/^0+(?=\d)/, "") : "Unknown";
      add(y, y, a.id, value);
    } else if (groupBy === "lender") {
      measureLabel = "Debt balance";
      if (!(k.loans as LoanInfo[]).length) add("unlevered", "Unlevered", a.id, 0.0);
      for (const l of k.loans as LoanInfo[]) add(l.lender_name, l.lender_name, a.id, l.balance);
    } else if (groupBy === "tenant") {
      measureLabel = "Annual base rent";
      if (k.leases === null) unavailable = "Lease data is not available.";
      for (const l of (k.leases as LeaseInfo[] | null) ?? []) add(normKey(l.tenant_name), l.tenant_name, a.id, l.annual_rent);
    } else if (groupBy === "capital_partner") {
      measureLabel = "Value attributable";
    }
  }
  if (groupBy === "capital_partner") {
    const stakes = await partnerStakes(db, new Set(ids));
    if (stakes === null) {
      unavailable = "Investor data is not available.";
    } else {
      for (const a of rows) {
        for (const st of stakes[a.id] ?? []) add(String(st.partner_id), st.name, a.id, ((kp[a.id].value || 0) * st.ownership_pct) / 100);
      }
    }
  }
  if (groupBy === "territory") {
    const pids = [...new Set(rows.map((a) => a.property_id))];
    if (pids.length) {
      const found = await db
        .select({ property_id: territoryMembers.property_id, id: territories.id, name: territories.name })
        .from(territoryMembers)
        .innerJoin(territories, eq(territories.id, territoryMembers.territory_id))
        .where(and(inArray(territoryMembers.property_id, pids), isNull(territories.deleted_at)));
      const byProp = new Map(rows.map((a) => [a.property_id, a]));
      for (const r of found) {
        const a = byProp.get(r.property_id as string)!;
        add(String(r.id), r.name, a.id, kp[a.id].value || 0);
      }
    }
  }

  const all = [...groups.values()];
  const totalMeasure = all.reduce((t, g) => t + g.measure, 0);
  const outGroups = [...all]
    .sort((x, y) => y.measure - x.measure)
    .map((g) => {
      const agg = aggregate(g.ids, kp, amap);
      let href: string;
      if (groupBy === "property_type") href = `/assets?property_type=${g.key}`;
      else if (groupBy === "geography") href = `/assets?state=${g.key.split("|")[0]}`;
      else if (groupBy === "territory") href = `/territories/${g.key}`;
      else href = "/assets?" + g.ids.slice(0, 60).map((i) => `ids=${i}`).join("&");
      return {
        key: g.key, label: g.label, measure: r2(g.measure), share_pct: pct(g.measure, totalMeasure), asset_ids: g.ids,
        ...agg, drill: href,
      };
    });
  return {
    group_by: groupBy, measure_label: measureLabel, unavailable, totals, metrics: totalMetrics, groups: outGroups,
  };
}

// --------------------------------------------------------------------------- concentration

export async function tenantProfileMap(db: Db): Promise<Record<string, TenantProfile>> {
  const rows = await db.select().from(tenantProfiles).where(isNull(tenantProfiles.deleted_at));
  return Object.fromEntries(rows.map((t) => [t.tenant_key, t]));
}

export async function concentration(db: Db): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(isNull(assets.deleted_at), inArray(assets.status, ["active", "held_for_sale"])));
  const props = await loadProps(db, rows);
  const kp = await computeKpis(db, rows, props);
  const profiles = await tenantProfileMap(db);
  const limits = await db
    .select()
    .from(concentrationLimits)
    .where(and(isNull(concentrationLimits.deleted_at), eq(concentrationLimits.is_active, true)));
  const dims = ["tenant", "brand", "industry", "guarantor", "lender", "geography"];
  type Bucket = { key: string; label: string; amount: number; asset_ids: string[] };
  const buckets: Record<string, Map<string, Bucket>> = Object.fromEntries(dims.map((d) => [d, new Map<string, Bucket>()]));

  const add = (dim: string, key: string, label: string, amount: number, aid: string) => {
    let b = buckets[dim].get(key);
    if (!b) {
      b = { key, label, amount: 0.0, asset_ids: [] };
      buckets[dim].set(key, b);
    }
    b.amount += amount;
    if (!b.asset_ids.includes(aid)) b.asset_ids.push(aid);
  };

  let leasesAvailable = true;
  for (const a of rows) {
    const k = kp[a.id];
    const p = props[a.property_id];
    if (k.leases === null) leasesAvailable = false;
    for (const l of (k.leases as LeaseInfo[] | null) ?? []) {
      const tk = normKey(l.tenant_name);
      const prof = profiles[tk];
      add("tenant", tk, l.tenant_name, l.annual_rent, a.id);
      const brand = (prof ? prof.brand : null) || l.tenant_name;
      add("brand", normKey(brand), brand, l.annual_rent, a.id);
      const ind = (prof ? prof.industry : null) || "Unclassified";
      add("industry", normKey(ind), ind, l.annual_rent, a.id);
      const g = l.guarantor || "No guarantor";
      add("guarantor", normKey(g), g, l.annual_rent, a.id);
    }
    for (const l of k.loans as LoanInfo[]) add("lender", normKey(l.lender_name), l.lender_name, l.balance, a.id);
    const st = (p ? p.state : null) || "Unknown";
    add("geography", st.toLowerCase(), st, k.value || 0, a.id);
  }

  const measures: Record<string, string> = {
    tenant: "Annual base rent", brand: "Annual base rent", industry: "Annual base rent",
    guarantor: "Annual base rent", lender: "Debt balance", geography: "Value",
  };
  const result: Record<string, any> = {};
  const breaches: Record<string, any>[] = [];
  for (const [dim, items] of Object.entries(buckets)) {
    const list = [...items.values()];
    const total = list.reduce((t, i) => t + i.amount, 0);
    const outRows: Record<string, any>[] = [];
    for (const i of [...list].sort((x, y) => y.amount - x.amount)) {
      const share = pct(i.amount, total) || 0.0;
      const matching = limits.filter((lim) => lim.dimension === dim && (lim.key === null || normKey(lim.key) === i.key));
      let lim: (typeof limits)[number] | null = null;
      for (const m of matching) if (lim === null || m.max_pct < lim.max_pct) lim = m;
      const breached = Boolean(lim && share > lim.max_pct);
      const row = {
        ...i, amount: r2(i.amount), pct: share, limit_pct: lim ? lim.max_pct : null, limit_id: lim ? lim.id : null,
        severity: lim ? lim.severity : null, breached,
        drill: "/assets?" + i.asset_ids.slice(0, 60).map((x) => `ids=${x}`).join("&"),
      };
      outRows.push(row);
      if (breached) breaches.push({ dimension: dim, ...row });
    }
    result[dim] = {
      measure: measures[dim], total: r2(total), items: outRows,
      unavailable: leasesAvailable || dim === "lender" || dim === "geography" ? null : "Lease data is not available.",
    };
  }
  return { dimensions: result, breaches };
}

/** Raises one alert per breached limit per month. Does not commit. */
export async function checkConcentration(db: Db): Promise<Record<string, any>[]> {
  const { raiseAlert } = await import("../tasks/service");
  const data = await concentration(db);
  const stamp = todayStr().slice(0, 7);
  for (const b of data.breaches) {
    await raiseAlert(db, {
      title: `Concentration limit exceeded: ${b.dimension} · ${b.label}`,
      reason: `${b.label} is ${pyStr(b.pct)}% of portfolio ${b.dimension} exposure (limit ${pyStr(b.limit_pct)}%).`,
      severity: b.severity || "medium", related_type: "concentration_limit", related_id: b.limit_id,
      related_label: `${b.dimension}: ${b.label}`, rule_key: "assets.concentration",
      idempotency_key: `concentration:${b.dimension}:${b.key}:${stamp}`.slice(0, 200),
    });
  }
  return data.breaches;
}

// --------------------------------------------------------------------------- watchlist

/** Returns [open work orders, overdue work orders] for the property. */
async function maintenanceBacklog(db: Db, propertyId: string, overdueDays: number): Promise<[number, number] | null> {
  const found = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.property_id, propertyId), isNull(workOrders.deleted_at)));
  const closed = new Set(["completed", "closed", "cancelled", "done", "resolved"]);
  const open = found.filter((w) => !closed.has((w as any).status || "open"));
  const cutoff = addDays(todayStr(), -overdueDays);
  let overdue = 0;
  for (const w of open) {
    const raw = (w as any).due_on || (w as any).due_at;
    const due = raw ? isoDate(raw) : null;
    if (due !== null && due < cutoff) overdue += 1;
  }
  return [open.length, overdue];
}

async function persistentVariance(db: Db, a: Asset, s: Record<string, any>): Promise<string[]> {
  const n = Math.trunc(Number(s.persistent_variance_months));
  let end = monthStart(todayStr());
  const [latestRow] = await db
    .select({ latest: sql<string | null>`max(${assetFinancials.period})` })
    .from(assetFinancials)
    .where(and(eq(assetFinancials.asset_id, a.id), eq(assetFinancials.is_current, true), isNull(assetFinancials.deleted_at)));
  const latest = latestRow?.latest;
  if (!latest) return [];
  end = end < latest ? end : latest;
  const months = monthRange(addMonths(end, -(n - 1)), end);
  const { values: budget, cats: bcats, used } = await budgetLinesFor(db, a.id, new Set(months.map((m) => Number(m.slice(0, 4)))));
  if (!used.length) return [];
  const found = await db
    .select({
      account: assetFinancials.account, category: assetFinancials.category, period: assetFinancials.period,
      total: sql<string>`sum(${assetFinancials.amount})`,
    })
    .from(assetFinancials)
    .where(
      and(
        eq(assetFinancials.asset_id, a.id), eq(assetFinancials.is_current, true), isNull(assetFinancials.deleted_at),
        inArray(assetFinancials.period, months),
      ),
    )
    .groupBy(assetFinancials.account, assetFinancials.category, assetFinancials.period);
  const actual = new Map<string, number>();
  const cats = new Map(bcats);
  for (const r of found) {
    const key = mk(r.account, r.period);
    actual.set(key, (actual.get(key) ?? 0) + Number(r.total || 0));
    if (!cats.has(r.account)) cats.set(r.account, r.category);
  }
  const accts = new Set<string>();
  for (const k of actual.keys()) accts.add(unmk(k)[0]);
  for (const k of budget.keys()) accts.add(unmk(k)[0]);
  const persistent: string[] = [];
  for (const acct of accts) {
    const flags = months.map(
      (m) => variance(actual.get(mk(acct, m)) ?? 0.0, budget.get(mk(acct, m)) ?? 0.0, cats.get(acct) ?? "expense", s).flag,
    );
    if (flags.every(Boolean)) persistent.push(acct);
  }
  return persistent.sort();
}

/** Evaluates every watchlist trigger, opens/refreshes entries (+ alerts) and clears resolved ones. Does not commit. */
export async function scanWatchlist(db: Db, actor: Actor, assetIds?: string[] | null): Promise<Record<string, any>> {
  const { raiseAlert } = await import("../tasks/service");
  const s = await getSettings(db);
  const found = await db
    .select()
    .from(assets)
    .where(
      and(
        isNull(assets.deleted_at), inArray(assets.status, ["active", "held_for_sale"]),
        assetIds && assetIds.length ? inArray(assets.id, assetIds) : undefined,
      ),
    );
  const props = await loadProps(db, found);
  const kp = await computeKpis(db, found, props, { with_value: false });
  const profiles = await tenantProfileMap(db);
  const today = todayStr();
  const now = new Date();
  let opened = 0;
  let refreshed = 0;
  let cleared = 0;
  for (const a of found) {
    const k = kp[a.id];
    const p = props[a.property_id];
    const label = propLabel(p);
    const fired: Record<string, Record<string, any>> = {};
    if (k.coverage !== null && k.coverage < s.watch_min_dscr) {
      fired.coverage = {
        severity: k.coverage < 1.0 ? "high" : "medium", metric: k.coverage, threshold: s.watch_min_dscr,
        href: `/assets/${a.id}?tab=cash-flow`,
        detail: `Coverage ${fmtFixed(k.coverage, 2)}x below ${pyStr(s.watch_min_dscr)}x`,
      };
    }
    if (k.occupancy !== null && k.occupancy < s.watch_min_occupancy) {
      fired.occupancy = {
        severity: "medium", metric: k.occupancy, threshold: s.watch_min_occupancy,
        href: k.occupancy_source === "leases" ? `/leases?property_id=${a.property_id}` : `/properties/${a.property_id}`,
        detail: `Occupancy ${fmtFixed(k.occupancy, 1)}% below ${pyStr(s.watch_min_occupancy)}%`,
      };
    }
    const watchTenants = [
      ...new Set(
        ((k.leases as LeaseInfo[] | null) ?? []).filter((l) => profiles[normKey(l.tenant_name)]?.credit_watch).map((l) => l.tenant_name),
      ),
    ].sort();
    if (watchTenants.length) {
      fired.tenant_credit = {
        severity: "high", metric: watchTenants.length, threshold: null, href: `/leases?property_id=${a.property_id}`,
        detail: "Tenant credit watch: " + watchTenants.join(", "),
      };
    }
    const mb = await maintenanceBacklog(db, a.property_id, Math.trunc(Number(s.maintenance_overdue_days)));
    if (mb && (mb[0] >= Math.trunc(Number(s.maintenance_backlog)) || mb[1] > 0)) {
      fired.maintenance = {
        severity: "medium", metric: mb[0], threshold: Number(s.maintenance_backlog),
        href: `/work-orders?property_id=${a.property_id}`,
        detail: `${mb[0]} open work orders, ${mb[1]} overdue more than ${s.maintenance_overdue_days} days`,
      };
    }
    const aLoans = k.loans as LoanInfo[];
    const bad = aLoans.filter((l) => ["watch", "breach", "projected_breach"].includes(l.covenant_state));
    if (bad.length) {
      const worst = bad.some((l) => l.covenant_state === "breach")
        ? "breach"
        : bad.some((l) => l.covenant_state === "projected_breach") ? "projected_breach" : "watch";
      fired.covenant = {
        severity: ({ breach: "critical", projected_breach: "high" } as Record<string, string>)[worst] ?? "medium",
        metric: null, threshold: null, href: `/loans/${bad[0].id}?tab=covenants`,
        detail: `Covenant status ${worst.replace(/_/g, " ")} on ${bad.length} loan(s)`,
      };
    }
    const horizon = addMonths(today, Math.trunc(Number(s.maturity_months)));
    const maturing = aLoans.filter((l) => l.maturity_on && l.maturity_on <= horizon);
    if (maturing.length) {
      let first = maturing[0];
      for (const l of maturing) if ((l.maturity_on as string) < (first.maturity_on as string)) first = l;
      fired.maturity = {
        severity: (first.maturity_on as string) <= addMonths(today, 6) ? "high" : "medium",
        metric: daysBetween(first.maturity_on as string, today), threshold: Number(s.maturity_months),
        href: `/loans/${first.id}`,
        detail: `Loan with ${first.lender_name} matures ${first.maturity_on}`,
      };
    }
    const persistent = await persistentVariance(db, a, s);
    if (persistent.length) {
      fired.variance = {
        severity: "medium", metric: persistent.length, threshold: Number(s.persistent_variance_months),
        href: `/assets/${a.id}?tab=financials`,
        detail: `Budget variance above threshold for ${s.persistent_variance_months}+ consecutive months: ` +
          persistent.slice(0, 6).join(", "),
      };
    }

    const openEntries: Record<string, WatchlistEntry> = {};
    const openRows = await db
      .select()
      .from(watchlistEntries)
      .where(and(eq(watchlistEntries.asset_id, a.id), eq(watchlistEntries.status, "open"), isNull(watchlistEntries.deleted_at)));
    for (const e of openRows) openEntries[e.trigger] = e;
    for (const [trig, info] of Object.entries(fired)) {
      let e = openEntries[trig];
      if (e) {
        await patch(db, watchlistEntries, e, {
          last_detected_at: now, detail: info.detail, metric_value: info.metric, severity: info.severity,
        });
        refreshed += 1;
        continue;
      }
      e = await insert(db, watchlistEntries, {
        asset_id: a.id, trigger: trig, severity: info.severity, status: "open", detail: info.detail,
        metric_value: info.metric, threshold: info.threshold, source_href: info.href, first_detected_at: now,
        last_detected_at: now, created_by_id: actor?.id ?? null,
      });
      const alert = await raiseAlert(db, {
        title: `Watchlist: ${trig.replace(/_/g, " ")} · ${label}`, reason: info.detail, severity: info.severity,
        owner_id: a.manager_id, related_type: "asset", related_id: a.id, related_label: label,
        rule_key: `assets.watchlist.${trig}`, idempotency_key: `watchlist:${e.id}`,
      });
      await patch(db, watchlistEntries, e, { alert_id: alert.id });
      opened += 1;
    }
    for (const [trig, e] of Object.entries(openEntries)) {
      if (!(trig in fired)) {
        await patch(db, watchlistEntries, e, {
          status: "resolved", resolved_at: now, resolution_note: "Condition cleared on automated scan",
        });
        cleared += 1;
      }
    }
  }
  const breaches = await checkConcentration(db);
  await audit.record(db, {
    actor, action: "asset.watchlist_scanned", entity_type: ENTITY,
    summary: `${found.length} assets: ${opened} opened, ${refreshed} refreshed, ${cleared} cleared`,
    changes: { opened, refreshed, cleared, concentration_breaches: breaches.length },
  });
  return { assets: found.length, opened, refreshed, cleared, concentration_breaches: breaches.length };
}

export async function watchItems(db: Db, rows: WatchlistEntry[]): Promise<Record<string, any>[]> {
  const found = rows.length
    ? await db.select().from(assets).where(inArray(assets.id, [...new Set(rows.map((r) => r.asset_id))]))
    : [];
  const byId = Object.fromEntries(found.map((a) => [a.id, a]));
  const props = await loadProps(db, found);
  const cols = [
    "id", "asset_id", "trigger", "severity", "status", "detail", "metric_value", "threshold", "source_href",
    "first_detected_at", "last_detected_at", "resolved_at", "resolution_note", "alert_id",
  ];
  return rows.map((r) => {
    const a = byId[r.asset_id];
    const d: Record<string, any> = Object.fromEntries(cols.map((c) => [c, (r as Record<string, any>)[c]]));
    d.asset_label = a ? propLabel(props[a.property_id]) : null;
    return d;
  });
}

export async function resolveWatch(
  db: Db, e: WatchlistEntry, newStatus: string, note: string, actor: CurrentUser,
): Promise<WatchlistEntry> {
  if (e.status !== "open") throw new HttpError(409, "Entry is not open");
  await patch(db, watchlistEntries, e, {
    status: newStatus, resolution_note: note, resolved_at: new Date(), resolved_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `asset.watchlist_${newStatus}`, entity_type: ENTITY, entity_id: e.asset_id,
    summary: `${e.trigger}: ${note}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

// --------------------------------------------------------------------------- milestones

export async function milestoneItems(db: Db, rows: AssetMilestone[]): Promise<Record<string, any>[]> {
  const names = await userNames(db, rows.map((r) => r.owner_id));
  const today = todayStr();
  const cols = ["id", "asset_id", "title", "description", "owner_id", "due_on", "status", "completed_on", "task_id", "updated_at"];
  return rows.map((r) => ({
    ...Object.fromEntries(cols.map((c) => [c, (r as Record<string, any>)[c]])),
    owner_name: r.owner_id ? (names[r.owner_id] ?? null) : null,
    overdue: Boolean(r.due_on && r.due_on < today && (r.status === "planned" || r.status === "in_progress")),
  }));
}

async function milestoneTask(db: Db, a: Asset, m: AssetMilestone, actor: CurrentUser): Promise<void> {
  if (!m.owner_id || (m.status !== "planned" && m.status !== "in_progress")) return;
  const { createTask } = await import("../tasks/service");
  const prop = await getRow(db, properties, a.property_id);
  const due = m.due_on ? new Date(`${m.due_on}T17:00:00Z`) : null;
  const task = await createTask(db, {
    title: `Milestone: ${m.title}`, assignee_id: m.owner_id, due_at: due, task_type: "general",
    description: m.description, related_type: "asset", related_id: a.id, related_label: propLabel(prop),
    source: "assets.milestone", idempotency_key: `milestone:${m.id}:${m.owner_id}`, actor_id: actor.id,
  });
  await patch(db, assetMilestones, m, { task_id: task.id });
}

export async function createMilestone(db: Db, a: Asset, data: MilestoneIn, actor: CurrentUser): Promise<AssetMilestone> {
  const m = await insert(db, assetMilestones, {
    asset_id: a.id, ...data, completed_on: data.status === "done" ? todayStr() : null,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await milestoneTask(db, a, m, actor);
  await audit.record(db, {
    actor, action: "asset.milestone_created", entity_type: ENTITY, entity_id: a.id, summary: m.title,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

export async function updateMilestone(db: Db, m: AssetMilestone, data: MilestoneUpdate, actor: CurrentUser): Promise<AssetMilestone> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const changes = audit.diff(m, values);
  if (!Object.keys(changes).length) return m;
  const set: Record<string, any> = { ...values };
  if ("status" in changes) set.completed_on = values.status === "done" ? todayStr() : null;
  set.updated_by_id = actor.id;
  await patch(db, assetMilestones, m, set as never);
  if ("status" in changes && m.task_id && (m.status === "done" || m.status === "cancelled")) {
    const task = await getRow(db, tasks, m.task_id);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      await patch(db, tasks, task, {
        status: m.status === "done" ? "done" : "cancelled", completed_at: new Date(), completed_by_id: actor.id,
      } as never);
    }
  }
  if ("owner_id" in changes) await milestoneTask(db, await get(db, m.asset_id), m, actor);
  await audit.record(db, {
    actor, action: "asset.milestone_updated", entity_type: ENTITY, entity_id: m.asset_id, summary: m.title, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}
