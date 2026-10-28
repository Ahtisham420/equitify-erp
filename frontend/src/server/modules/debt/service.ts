import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import type { Actor } from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get as getRow, insert, patch, remove } from "../../db/orm";
import * as assetsSvc from "../assets/service";
import {
  addDays, addMonths, daysBetween, fmtFixed, fmtMoney, monthStart, monthsBetween, pct, pyStr, r2, safeDiv, todayStr,
} from "../assets/calc";
import { assets, type Asset } from "../assets/schema";
import { properties } from "../properties/schema";
import { alerts, tasks } from "../tasks/schema";
import * as calc from "./calc";
import {
  COVENANT_STATE_RANK, covenants, covenantTests, debtSettings, FREQ_MONTHS, lenderReportingObligations, loanEvents,
  loanProperties, loanReserves, loans, MATERIAL_FIELDS, reserveTransactions,
  type Covenant, type CovenantTest, type LenderReportingObligation, type Loan, type LoanProperty, type LoanReserve,
  type ReserveTransaction,
} from "./schema";
import {
  debtSettingsIn, guarantorIn, prepaymentIn,
  type CollateralIn, type CovenantIn, type DebtSettingsIn, type LoanCreate, type LoanUpdate, type ObligationIn,
  type ReserveIn, type ReserveTxnIn,
} from "./schemas";

export const ENTITY = "loan";
export const DEFAULT_SETTINGS: Record<string, any> = debtSettingsIn.parse({});
export const KIND_LABELS: Record<string, string> = {
  dscr: "DSCR", debt_yield: "Debt yield", ltv: "LTV", occupancy: "Occupancy", net_worth: "Guarantor net worth",
};
export const DEFAULT_OPERATOR: Record<string, string> = {
  dscr: "min", debt_yield: "min", ltv: "max", occupancy: "min", net_worth: "min",
};

/** 17:00 UTC on the given date. */
const dueDt = (d: string): Date => new Date(`${d}T17:00:00Z`);

/** Python `str.strip(chars)` */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** Order-insensitive structural equality (Python `==` on dicts/lists). */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if ((a ?? null) === null && (b ?? null) === null) return true;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** audit.diff with order-insensitive comparison of JSON columns (jsonb does not preserve key order). */
function diffObj(obj: Record<string, any>, data: Record<string, any>): Record<string, { from: any; to: any }> {
  const changes: Record<string, { from: any; to: any }> = {};
  for (const [field, next] of Object.entries(data)) {
    if (next === undefined) continue;
    const old = obj[field];
    if (!deepEqual(old, next)) changes[field] = { from: audit.toJsonable(old ?? null), to: audit.toJsonable(next) };
  }
  return changes;
}

// --------------------------------------------------------------------------- settings / lookups

export async function getSettings(db: Db): Promise<Record<string, any>> {
  const [row] = await db.select().from(debtSettings).where(eq(debtSettings.key, "config")).limit(1);
  const merged: Record<string, any> = { ...DEFAULT_SETTINGS, ...((row?.value as Record<string, any>) ?? {}) };
  merged.market = { ...DEFAULT_SETTINGS.market, ...(merged.market || {}) };
  return merged;
}

export async function saveSettings(db: Db, data: DebtSettingsIn, actor: CurrentUser): Promise<Record<string, any>> {
  const [existing] = await db.select().from(debtSettings).where(eq(debtSettings.key, "config")).limit(1);
  const before = await getSettings(db);
  let row = existing;
  if (!row) {
    row = await insert(db, debtSettings, { key: "config", value: data, created_by_id: actor.id, updated_by_id: actor.id });
  } else {
    row = await patch(db, debtSettings, row, { value: data, updated_by_id: actor.id });
  }
  await audit.record(db, {
    actor, action: "debt.settings_updated", entity_type: "debt_settings", changes: { from: before, to: row.value },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return getSettings(db);
}

export function loanLabel(l: Loan): string {
  return l.name || [l.lender_name, l.loan_number].filter(Boolean).join(" · ") || "Loan";
}

export async function get(db: Db, loanId: string): Promise<Loan> {
  const l = await getRow(db, loans, loanId);
  if (!l || l.deleted_at) throw new HttpError(404, "Loan not found");
  return l;
}

export async function propLabels(db: Db, ids: Iterable<string | null | undefined>): Promise<Record<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!set.length) return {};
  const rows = await db.select().from(properties).where(inArray(properties.id, set));
  return Object.fromEntries(rows.map((p) => [p.id, p.name || p.address_line]));
}

const userNames = assetsSvc.userNames;

export function refiWindow(l: Loan, s: Record<string, any>): [string | null, boolean, number | null] {
  if (!l.maturity_on) return [null, false, null];
  const opens = addMonths(l.maturity_on, -Math.trunc(Number(s.refi_window_months)));
  const today = todayStr();
  return [opens, l.status === "active" && opens <= today && today <= l.maturity_on, monthsBetween(today, l.maturity_on)];
}

// --------------------------------------------------------------------------- list

export interface LoanFilters {
  q?: string;
  status?: string[];
  rate_type?: string[];
  loan_type?: string[];
  covenant_state?: string[];
  lender_name?: string[];
  property_id?: string;
  asset_id?: string;
  maturity_from?: string;
  maturity_to?: string;
}

export function buildWhere(f: LoanFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = loans;
  const cols: Array<[keyof LoanFilters, any]> = [
    ["status", t.status], ["rate_type", t.rate_type], ["loan_type", t.loan_type],
    ["covenant_state", t.covenant_state], ["lender_name", t.lender_name],
  ];
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.loan_number, t.lender_name]),
    ...cols.map(([key, col]) => (skip.has(key) ? undefined : inFilter(col, f[key] as string[] | undefined))),
    f.property_id
      ? or(
          eq(t.property_id, f.property_id),
          sql`${t.id} in (select ${loanProperties.loan_id} from ${loanProperties} where ${loanProperties.property_id} = ${f.property_id})`,
        )
      : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    rangeFilter(t.maturity_on, f.maturity_from, f.maturity_to),
  );
}

export async function toItems(db: Db, rows: Loan[]): Promise<Record<string, any>[]> {
  const s = await getSettings(db);
  const labels = await propLabels(db, rows.map((l) => l.property_id));
  return rows.map((l) => {
    const [, inWin, mtm] = refiWindow(l, s);
    return {
      id: l.id, name: l.name, loan_number: l.loan_number, label: loanLabel(l),
      property_id: l.property_id, property_label: l.property_id ? (labels[l.property_id] ?? null) : null,
      asset_id: l.asset_id, lender_name: l.lender_name, loan_type: l.loan_type, current_balance: l.current_balance,
      rate: l.rate, rate_type: l.rate_type, maturity_on: l.maturity_on, months_to_maturity: mtm,
      in_refi_window: inWin, cap_expires_on: l.cap_expires_on, status: l.status,
      covenant_state: l.covenant_state, updated_at: l.updated_at,
    };
  });
}

export async function toOut(db: Db, l: Loan): Promise<Record<string, any>> {
  const s = await getSettings(db);
  const links = await db.select().from(loanProperties).where(eq(loanProperties.loan_id, l.id));
  const labels = await propLabels(db, [l.property_id, ...links.map((x) => x.property_id)]);
  const owner = await userNames(db, [l.owner_id]);
  const [opens, inWin, mtm] = refiWindow(l, s);
  const reserves = await db
    .select()
    .from(loanReserves)
    .where(and(eq(loanReserves.loan_id, l.id), isNull(loanReserves.deleted_at)));
  const g = parseGuarantors(l.guarantors);
  const pp = prepaymentIn.safeParse(l.prepayment ?? {});
  return {
    name: l.name, loan_number: l.loan_number, property_id: l.property_id, asset_id: l.asset_id,
    lender_organization_id: l.lender_organization_id, lender_name: l.lender_name, loan_type: l.loan_type,
    original_balance: l.original_balance, current_balance: l.current_balance, originated_on: l.originated_on,
    maturity_on: l.maturity_on, extension_options: l.extension_options ?? [], rate_type: l.rate_type, rate: l.rate,
    index_name: l.index_name, spread: l.spread, rate_floor: l.rate_floor, amortization_months: l.amortization_months,
    io_months: l.io_months, recourse: l.recourse, recourse_notes: l.recourse_notes, guarantors: g,
    prepayment: pp.success ? pp.data : l.prepayment, cap_strike: l.cap_strike, cap_provider: l.cap_provider,
    cap_expires_on: l.cap_expires_on, swap_rate: l.swap_rate, swap_expires_on: l.swap_expires_on, status: l.status,
    owner_id: l.owner_id, notes: l.notes,
    id: l.id, label: loanLabel(l),
    property_label: l.property_id ? (labels[l.property_id] ?? null) : null,
    lender_label: l.lender_name,
    owner_name: l.owner_id ? (owner[l.owner_id] ?? null) : null,
    covenant_state: l.covenant_state,
    annual_debt_service: l.status === "active" ? calc.annualDebtService(l) : null,
    months_to_maturity: mtm, refi_window_opens_on: opens, in_refi_window: inWin,
    collateral: links.map((x) => ({
      id: x.id, property_id: x.property_id, property_label: labels[x.property_id] ?? null,
      allocated_amount: x.allocated_amount, release_price: x.release_price, is_primary: x.property_id === l.property_id,
    })),
    reserve_balance: r2(reserves.reduce((t, r) => t + Number(r.balance || 0), 0)),
    created_at: l.created_at, updated_at: l.updated_at,
  };
}

function parseGuarantors(v: unknown): any[] {
  const list = (v as any[]) ?? [];
  const parsed = guarantorIn.array().safeParse(list);
  return parsed.success ? parsed.data : list;
}

// --------------------------------------------------------------------------- history

export async function addEvent(
  db: Db, loan: Loan, eventType: string, actor: Actor | null | undefined,
  o: { field?: string | null; from_value?: any; to_value?: any; effective_on?: string | null; note?: string | null } = {},
) {
  return insert(db, loanEvents, {
    loan_id: loan.id, event_type: eventType, field: o.field ?? null,
    from_value: audit.toJsonable(o.from_value ?? null), to_value: audit.toJsonable(o.to_value ?? null),
    effective_on: o.effective_on || todayStr(), note: o.note ?? null, actor_id: actor?.id ?? null,
    actor_name: actor?.full_name ?? null,
  });
}

function eventType(field: string, old: any, next: any): string {
  if (field === "current_balance") return "balance_change";
  if (["rate", "spread", "index_name", "rate_floor"].includes(field)) return "rate_change";
  if (field === "status") return ["paid_off", "defeased", "refinanced"].includes(next) ? "payoff" : "status_change";
  if (field === "maturity_on" && old && next && String(next) > String(old)) return "extension";
  return "modification";
}

// --------------------------------------------------------------------------- mutations

/** Fill property_id from asset_id (and vice versa) so a loan is always tied to its collateral. */
async function resolveLinks(db: Db, values: Record<string, any>): Promise<void> {
  if (values.asset_id && !values.property_id) {
    const a = await getRow(db, assets, values.asset_id);
    if (a) values.property_id = a.property_id;
  } else if (values.property_id && !values.asset_id) {
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.property_id, values.property_id), isNull(assets.deleted_at)))
      .limit(1);
    if (a) values.asset_id = a.id;
  }
}

export async function create(db: Db, data: LoanCreate, actor: CurrentUser): Promise<Loan> {
  const values: Record<string, any> = { ...data };
  if (values.current_balance === null || values.current_balance === undefined) values.current_balance = values.original_balance;
  await resolveLinks(db, values);
  const loan = await insert(db, loans, { ...values, covenant_state: "none", created_by_id: actor.id, updated_by_id: actor.id } as never);
  if (loan.property_id) {
    await insert(db, loanProperties, { loan_id: loan.id, property_id: loan.property_id, added_by_id: actor.id });
  }
  await addEvent(db, loan, "created", actor, {
    to_value: { balance: loan.current_balance, rate: loan.rate, maturity_on: loan.maturity_on },
    effective_on: loan.originated_on,
  });
  await audit.record(db, {
    actor, action: "loan.created", entity_type: ENTITY, entity_id: loan.id, summary: loanLabel(loan), ip_address: actor.ip_address,
  });
  await events.emit(db, "loan.created", { loan_id: loan.id, property_id: loan.property_id, actor });
  await db.commit();
  return loan;
}

export async function update(db: Db, loan: Loan, data: LoanUpdate, actor: CurrentUser): Promise<Loan> {
  const { effective_on, change_note, ...raw } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  for (const k of ["guarantors", "prepayment", "extension_options"]) {
    if (k in values && values[k] === null) values[k] = k !== "prepayment" ? [] : {};
  }
  if ("asset_id" in values || "property_id" in values) await resolveLinks(db, values);
  const changes = diffObj(loan, values);
  if (!Object.keys(changes).length) return loan;
  for (const [field, ch] of Object.entries(changes)) {
    if (MATERIAL_FIELDS.has(field)) {
      await addEvent(db, loan, eventType(field, ch.from, ch.to), actor, {
        field, from_value: ch.from, to_value: ch.to, effective_on, note: change_note,
      });
    }
  }
  await patch(db, loans, loan, { ...values, updated_by_id: actor.id } as never);
  if ("property_id" in changes && loan.property_id) {
    const [exists] = await db
      .select()
      .from(loanProperties)
      .where(and(eq(loanProperties.loan_id, loan.id), eq(loanProperties.property_id, loan.property_id)))
      .limit(1);
    if (!exists) await insert(db, loanProperties, { loan_id: loan.id, property_id: loan.property_id, added_by_id: actor.id });
  }
  await audit.record(db, {
    actor, action: "loan.updated", entity_type: ENTITY, entity_id: loan.id, changes, summary: change_note,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "loan.updated", {
    loan_id: loan.id, property_id: loan.property_id, changed: new Set(Object.keys(changes)), actor,
  });
  await db.commit();
  return loan;
}

export async function archive(db: Db, loan: Loan, actor: CurrentUser): Promise<void> {
  await patch(db, loans, loan, { deleted_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "loan.archived", entity_type: ENTITY, entity_id: loan.id, summary: loanLabel(loan), ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function addCollateral(db: Db, loan: Loan, data: CollateralIn, actor: CurrentUser): Promise<LoanProperty> {
  const prop = await getRow(db, properties, data.property_id);
  if (!prop || prop.deleted_at) throw new HttpError(404, "Property not found");
  const [existing] = await db
    .select()
    .from(loanProperties)
    .where(and(eq(loanProperties.loan_id, loan.id), eq(loanProperties.property_id, data.property_id)))
    .limit(1);
  let link: LoanProperty;
  if (!existing) {
    link = await insert(db, loanProperties, {
      loan_id: loan.id, property_id: data.property_id, added_by_id: actor.id,
      allocated_amount: data.allocated_amount, release_price: data.release_price,
    });
  } else {
    link = await patch(db, loanProperties, existing, { allocated_amount: data.allocated_amount, release_price: data.release_price });
  }
  await addEvent(db, loan, "collateral_change", actor, {
    field: "collateral", to_value: data, note: `Collateral: ${prop.name || prop.address_line}`,
  });
  await audit.record(db, {
    actor, action: "loan.collateral_added", entity_type: ENTITY, entity_id: loan.id, changes: data, ip_address: actor.ip_address,
  });
  await db.commit();
  return link;
}

export async function removeCollateral(db: Db, loan: Loan, linkId: string, actor: CurrentUser): Promise<void> {
  const link = await getRow(db, loanProperties, linkId);
  if (!link || link.loan_id !== loan.id) throw new HttpError(404, "Collateral link not found");
  if (link.property_id === loan.property_id) {
    throw new HttpError(409, "The primary property cannot be removed; change the loan's property instead");
  }
  await addEvent(db, loan, "collateral_change", actor, {
    field: "collateral", from_value: { property_id: link.property_id, allocated_amount: link.allocated_amount },
    note: "Collateral released",
  });
  await remove(db, loanProperties, link);
  await audit.record(db, {
    actor, action: "loan.collateral_removed", entity_type: ENTITY, entity_id: loan.id,
    changes: { property_id: link.property_id }, ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- analysis inputs

async function assetFor(db: Db, loan: Loan): Promise<Asset | null> {
  if (loan.asset_id) return (await getRow(db, assets, loan.asset_id)) ?? null;
  if (loan.property_id) {
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.property_id, loan.property_id), isNull(assets.deleted_at)))
      .limit(1);
    return a ?? null;
  }
  return null;
}

/** NOI (TTM), trailing trend, value and occupancy for the loan's collateral asset. */
export async function operatingInputs(
  db: Db, loan: Loan, o: { verified_only: boolean; as_of?: string | null },
): Promise<Record<string, any>> {
  const a = await assetFor(db, loan);
  const out: Record<string, any> = {
    asset_id: a ? a.id : null, noi: null, noi_prior: null, period_start: null, period_end: null, months_present: 0,
    debt_service_actual: null, value: null, value_source: null, occupancy: null, occupancy_source: null, leases: null,
    building_sf: 0.0, verified_only: o.verified_only, drill: [] as Array<Record<string, string>>,
  };
  if (!a) return out;
  const since = addMonths(monthStart(o.as_of || todayStr()), -30);
  let monthly = (await assetsSvc.monthlyByCategory(db, new Set([a.id]), since, { verified_only: o.verified_only }))[a.id] ?? {};
  if (o.as_of) {
    monthly = Object.fromEntries(Object.entries(monthly).filter(([p]) => p <= (o.as_of as string)));
  }
  const [noi, end, present] = assetsSvc.ttmNoi(monthly);
  if (end) {
    Object.assign(out, { noi: r2(noi), period_end: end, period_start: addMonths(end, -11), months_present: present });
    const priorEnd = addMonths(end, -3);
    const [prior, , priorPresent] = assetsSvc.ttmNoi(
      Object.fromEntries(Object.entries(monthly).filter(([p]) => p <= priorEnd)), priorEnd,
    );
    out.noi_prior = priorPresent >= 9 ? r2(prior) : null;
    const ds = assetsSvc.windowSum(monthly, end, new Set(["debt_service"]));
    out.debt_service_actual = ds > 0 ? r2(ds) : null;
  }
  const props = await assetsSvc.loadProps(db, [a]);
  const p = props[a.property_id];
  const v = await assetsSvc.latestValuation(db, a.property_id);
  if (v && v.value_point) {
    out.value = Number(v.value_point);
    out.value_source = `valuation ${v.as_of}`;
    out.drill.push({ label: "Valuations", href: `/comps?property_id=${a.property_id}` });
  } else if (a.current_value) {
    out.value = Number(a.current_value);
    out.value_source = "asset record";
  }
  const leases = await assetsSvc.leaseData(db, new Set([a.property_id]));
  const pl = leases !== null ? (leases[a.property_id] ?? null) : null;
  if (p) {
    const [occ, , src] = assetsSvc.occupancyWale(p, pl);
    Object.assign(out, { occupancy: r2(occ), occupancy_source: src, leases: pl, building_sf: Number(p.building_area_sf || 0) });
  }
  out.drill.unshift({
    label: o.verified_only ? "Verified financials" : "Financials", href: `/assets/${a.id}?tab=financials`,
  });
  return out;
}

function market(s: Record<string, any>, overrides?: Record<string, any> | null): Record<string, number> {
  const m: Record<string, any> = { ...s.market };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== null && v !== undefined && k in m) m[k] = Number(v);
  }
  return m;
}

export async function refinance(db: Db, loan: Loan, overrides?: Record<string, any> | null): Promise<Record<string, any>> {
  const s = await getSettings(db);
  const m = market(s, overrides);
  const inp = await operatingInputs(db, loan, { verified_only: false });
  const noi: number | null = inp.noi;
  let value: number | null = inp.value;
  let valueBasis: string | null = inp.value_source;
  if (value === null && noi && m.cap_rate) {
    value = noi / (m.cap_rate / 100);
    valueBasis = `NOI capitalised at ${pyStr(m.cap_rate)}%`;
  }
  const sizing = calc.sizeLoan(noi, value, m.rate, m.amort_years, m.ltv, m.dscr, m.debt_yield);
  const [opens, inWin, mtm] = refiWindow(loan, s);
  const today = todayStr();
  const payoffOn = opens && opens > today ? (today > opens ? today : opens) : today;
  const prepay = calc.prepaymentCost(loan, payoffOn, m.treasury_rate);
  const bal = Number(loan.current_balance || 0);
  const costs = ((sizing.max_loan || 0) * m.refi_cost_pct) / 100;
  const payoff = bal + (prepay.allowed ? prepay.cost : 0);
  const net = sizing.max_loan !== null ? (sizing.max_loan || 0) - payoff - costs : null;
  const currentDs = calc.annualDebtService(loan);
  return {
    as_of: today, payoff_on: payoffOn, market: m,
    noi, noi_period_end: inp.period_end, value: r2(value), value_basis: valueBasis,
    sizing, current_balance: r2(bal), prepayment: prepay, refi_costs: r2(costs),
    payoff: r2(payoff),
    net_proceeds: net !== null && net >= 0 ? r2(net) : net !== null ? 0.0 : null,
    shortfall: net !== null && net < 0 ? r2(-net) : 0.0,
    current_annual_debt_service: currentDs, new_annual_debt_service: sizing.annual_debt_service ?? null,
    current_dscr: r2(safeDiv(noi, currentDs), 3), new_dscr: r2(safeDiv(noi, sizing.annual_debt_service), 3),
    window: { opens_on: opens, in_window: inWin, months_to_maturity: mtm, window_months: s.refi_window_months },
    drill: [...inp.drill, { label: "Loan terms", href: `/loans/${loan.id}` }],
  };
}

/** Side-by-side at current market terms (pre-tax). Dispositions adds tax modelling on top. */
export async function holdRefiSell(db: Db, loan: Loan, overrides?: Record<string, any> | null): Promise<Record<string, any>> {
  const refi = await refinance(db, loan, overrides);
  const m = refi.market;
  const noi = refi.noi || 0;
  const bal = Number(loan.current_balance || 0);
  const ds = refi.current_annual_debt_service || 0;
  const value = refi.value || 0;
  const saleCosts = (value * m.sale_cost_pct) / 100;
  const sellPrepay = calc.prepaymentCost(loan, todayStr(), m.treasury_rate);
  const sellNet = value - saleCosts - bal - (sellPrepay.allowed ? sellPrepay.cost : 0);
  const newDs = refi.new_annual_debt_service || 0;
  return {
    market: m, noi: refi.noi, value: refi.value, value_basis: refi.value_basis,
    hold: {
      annual_cash_flow: r2(noi - ds), debt_service: r2(ds), dscr: refi.current_dscr, equity: r2(value - bal),
      maturity_on: loan.maturity_on, notes: "Keeps current debt; refinance or sale required by maturity.",
    },
    refinance: {
      new_loan: refi.sizing.max_loan, binding_constraint: refi.sizing.binding, cash_out: refi.net_proceeds,
      shortfall: refi.shortfall, annual_cash_flow: refi.sizing.max_loan ? r2(noi - newDs) : null,
      debt_service: r2(newDs), dscr: refi.new_dscr, prepayment_cost: refi.prepayment.cost, costs: refi.refi_costs,
    },
    sell: {
      gross_price: r2(value), sale_costs: r2(saleCosts), debt_payoff: r2(bal),
      prepayment_cost: sellPrepay.allowed ? sellPrepay.cost : null, prepayment_allowed: sellPrepay.allowed,
      net_equity: r2(sellNet),
    },
    note: "Pre-tax comparison at current market terms. See the disposition module for after-tax modelling.",
  };
}

// --------------------------------------------------------------------------- covenants

export function effectiveWatch(cov: Covenant, s: Record<string, any>): number {
  if (cov.watch_threshold !== null && cov.watch_threshold !== undefined) return cov.watch_threshold;
  const buf = Number(s.covenant_watch_buffer_pct) / 100;
  return cov.operator === "min" ? cov.threshold * (1 + buf) : cov.threshold * (1 - buf);
}

export function classify(value: number | null, cov: Covenant, watch: number): string {
  if (value === null) return "insufficient_data";
  if (cov.operator === "min") return value < cov.threshold ? "breach" : value < watch ? "watch" : "pass";
  return value > cov.threshold ? "breach" : value > watch ? "watch" : "pass";
}

function measure(kind: string, noi: number | null, ds: number | null, bal: number, value: number | null, occ: number | null): number | null {
  if (kind === "dscr") return r2(safeDiv(noi, ds), 3);
  if (kind === "debt_yield") return pct(noi, bal);
  if (kind === "ltv") return pct(bal, value);
  if (kind === "occupancy") return occ;
  return null;
}

export async function createCovenant(db: Db, loan: Loan, data: CovenantIn, actor: CurrentUser): Promise<Covenant> {
  const values: Record<string, any> = { ...data };
  values.operator = values.operator || DEFAULT_OPERATOR[data.kind];
  values.label = values.label || KIND_LABELS[data.kind];
  const cov = await insert(db, covenants, {
    loan_id: loan.id, ...values, next_test_on: values.next_test_on ?? todayStr(),
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "loan.covenant_created", entity_type: ENTITY, entity_id: loan.id, summary: cov.label, changes: values,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return cov;
}

export async function updateCovenant(db: Db, cov: Covenant, data: CovenantIn, actor: CurrentUser): Promise<Covenant> {
  const values: Record<string, any> = { ...data };
  values.operator = values.operator || DEFAULT_OPERATOR[data.kind];
  values.label = values.label || KIND_LABELS[data.kind];
  const changes = diffObj(cov, values);
  await patch(db, covenants, cov, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "loan.covenant_updated", entity_type: ENTITY, entity_id: cov.loan_id, summary: cov.label, changes,
    ip_address: actor.ip_address,
  });
  const loan = await get(db, cov.loan_id);
  await refreshCovenantState(db, loan);
  await db.commit();
  return cov;
}

export async function refreshCovenantState(db: Db, loan: Loan): Promise<string> {
  const covs = await db
    .select()
    .from(covenants)
    .where(and(eq(covenants.loan_id, loan.id), isNull(covenants.deleted_at), eq(covenants.is_active, true)));
  const states: string[] = [];
  for (const c of covs) {
    if (c.last_state) states.push(c.last_state);
    if (c.last_projected_state === "breach" && c.last_state !== "breach") states.push("projected_breach");
  }
  let state = "none";
  if (states.length) {
    state = states[0];
    for (const x of states) if ((COVENANT_STATE_RANK[x] ?? 0) > (COVENANT_STATE_RANK[state] ?? 0)) state = x;
  }
  await patch(db, loans, loan, { covenant_state: state });
  return state;
}

const loanDict = (l: Loan) => ({
  current_balance: l.current_balance, rate: l.rate, amortization_months: l.amortization_months, io_months: l.io_months,
  originated_on: l.originated_on, maturity_on: l.maturity_on, prepayment: l.prepayment,
});

/** Computes the covenant from ACTUAL VERIFIED results and projects it forward. Does not commit. */
export async function runTest(
  db: Db, cov: Covenant, actor: Actor,
  o: { test_date?: string | null; manual_value?: number | null; notes?: string | null; scheduled?: boolean } = {},
): Promise<CovenantTest> {
  const { createTask, raiseAlert } = await import("../tasks/service");
  const s = await getSettings(db);
  const loan = await get(db, cov.loan_id);
  const testDate = o.test_date || todayStr();
  const manualValue = o.manual_value ?? null;
  const inp = await operatingInputs(db, loan, { verified_only: true, as_of: testDate });
  const bal = Number(loan.current_balance || 0);
  const ds: number | null = inp.months_present >= 12 && inp.debt_service_actual
    ? inp.debt_service_actual
    : calc.annualDebtService(loan, testDate);
  const watch = effectiveWatch(cov, s);
  const isManual = manualValue !== null;
  let value: number | null = isManual ? manualValue : measure(cov.kind, inp.noi, ds, bal, inp.value, inp.occupancy);
  if (!isManual && inp.months_present < 12 && (cov.kind === "dscr" || cov.kind === "debt_yield")) {
    value = null; // an incomplete trailing year is not a valid test basis
  }
  const state = classify(value, cov, watch);

  // Projection: trailing quarterly NOI trend carried forward; occupancy rolls off expiring leases.
  const q = Math.trunc(Number(s.projection_quarters));
  const projectedOn = addMonths(testDate, 3 * q);
  let projValue: number | null = null;
  let trend: number | null = null;
  if (!isManual && inp.noi !== null && inp.noi_prior !== null) {
    trend = inp.noi - inp.noi_prior;
    const projNoi = inp.noi + trend * q;
    const projBal = calc.balanceAfter(loan, 3 * q, testDate);
    const projDs = calc.annualDebtService({ ...loanDict(loan), current_balance: projBal }, projectedOn);
    const impliedCap = safeDiv(inp.noi, inp.value);
    const projVal = impliedCap ? projNoi / impliedCap : inp.value;
    projValue = measure(cov.kind, projNoi, projDs, projBal, projVal, null);
  }
  if (cov.kind === "occupancy" && !isManual && inp.leases && inp.leases.length && inp.building_sf) {
    const remaining = (inp.leases as assetsSvc.LeaseInfo[])
      .filter((l) => !l.expiration_on || l.expiration_on > projectedOn)
      .reduce((t, l) => t + l.rentable_sf, 0);
    projValue = r2(Math.min(100.0, (remaining / inp.building_sf) * 100));
  }
  const projState = projValue !== null ? classify(projValue, cov, watch) : null;

  const test = await insert(db, covenantTests, {
    covenant_id: cov.id, loan_id: loan.id, test_date: testDate, period_start: inp.period_start, period_end: inp.period_end,
    measured_value: value, threshold: cov.threshold, state, projected_value: projValue, projected_state: projState,
    projected_on: projValue !== null ? projectedOn : null,
    inputs: audit.toJsonable({
      noi_ttm: inp.noi, noi_prior_quarter_ttm: inp.noi_prior, quarterly_trend: trend, debt_service: ds, balance: bal,
      value: inp.value, value_source: inp.value_source, occupancy: inp.occupancy, occupancy_source: inp.occupancy_source,
      months_verified: inp.months_present, watch_threshold: watch, manual_value: manualValue, drill: inp.drill,
    }),
    basis: isManual ? "manual" : "actual_verified", is_manual: isManual, notes: o.notes ?? null,
    created_by_id: actor?.id ?? null,
  });
  const set: Record<string, any> = { last_state: state, last_projected_state: projState };
  if (o.scheduled || cov.next_test_on === null || cov.next_test_on <= testDate) {
    set.next_test_on = addMonths(testDate, FREQ_MONTHS[cov.frequency] ?? 3);
  }
  await patch(db, covenants, cov, set as never);
  await refreshCovenantState(db, loan);

  const labels = await propLabels(db, [loan.property_id]);
  const relLabel = stripChars(`${loanLabel(loan)} · ${loan.property_id ? (labels[loan.property_id] ?? "") : ""}`, " ·");
  let owner: string | null = loan.owner_id;
  if (owner === null) {
    const a = await assetFor(db, loan);
    owner = a ? a.manager_id : null;
  }
  const shown = value !== null ? fmtFixed(value, 2) : "n/a";
  if (state === "breach") {
    await raiseAlert(db, {
      title: `Covenant breach: ${cov.label}`, severity: "critical", owner_id: owner,
      reason: `${cov.label} measured ${shown} vs ${cov.operator} ${pyStr(cov.threshold)} on verified actuals.`,
      related_type: "loan", related_id: loan.id, related_label: relLabel, rule_key: "debt.covenant_breach",
      idempotency_key: `covenant:${cov.id}:breach:${inp.period_end || testDate}`,
    });
  } else if (projState === "breach") {
    // Projected breach escalates before any actual breach.
    await raiseAlert(db, {
      title: `Projected covenant breach: ${cov.label}`, severity: "high", owner_id: owner,
      reason: `${cov.label} is ${shown} today and projected at ${fmtFixed(projValue as number, 2)} by ${projectedOn} ` +
        `(threshold ${cov.operator} ${pyStr(cov.threshold)}).`,
      related_type: "loan", related_id: loan.id, related_label: relLabel, rule_key: "debt.covenant_projected_breach",
      idempotency_key: `covenant:${cov.id}:projected:${testDate.slice(0, 7)}`,
    });
    await createTask(db, {
      title: `Covenant cure plan: ${cov.label} projected breach`, assignee_id: owner,
      due_at: new Date(Date.now() + 7 * 86_400_000), task_type: "review", priority: "high",
      related_type: "loan", related_id: loan.id, related_label: relLabel, source: "debt.covenants",
      idempotency_key: `covenant:${cov.id}:cure:${testDate.slice(0, 7)}`, actor_id: actor?.id ?? null,
    });
  } else if (state === "watch") {
    await raiseAlert(db, {
      title: `Covenant on watch: ${cov.label}`, severity: "medium", owner_id: owner,
      reason: `${cov.label} measured ${shown}, within the watch band (${fmtFixed(watch, 2)}) of ${pyStr(cov.threshold)}.`,
      related_type: "loan", related_id: loan.id, related_label: relLabel, rule_key: "debt.covenant_watch",
      idempotency_key: `covenant:${cov.id}:watch:${inp.period_end || testDate}`,
    });
  }
  await audit.record(db, {
    actor, action: "loan.covenant_tested", entity_type: ENTITY, entity_id: loan.id,
    summary: `${cov.label}: ${state}` + (projState ? ` (projected ${projState})` : ""),
    changes: { value, state, projected_value: projValue, projected_state: projState },
  });
  return test;
}

export async function covenantItems(db: Db, covs: Covenant[]): Promise<Record<string, any>[]> {
  const s = await getSettings(db);
  const loanRows = covs.length
    ? await db.select().from(loans).where(inArray(loans.id, [...new Set(covs.map((c) => c.loan_id))]))
    : [];
  const loanMap = Object.fromEntries(loanRows.map((l) => [l.id, l]));
  const labels = await propLabels(db, loanRows.map((l) => l.property_id));
  const latest: Record<string, CovenantTest> = {};
  if (covs.length) {
    const tests = await db
      .select()
      .from(covenantTests)
      .where(and(inArray(covenantTests.covenant_id, covs.map((c) => c.id)), isNull(covenantTests.deleted_at)))
      .orderBy(sql`${covenantTests.test_date} desc`, sql`${covenantTests.created_at} desc`);
    for (const t of tests) if (!(t.covenant_id in latest)) latest[t.covenant_id] = t;
  }
  const keys = [
    "id", "loan_id", "kind", "label", "operator", "threshold", "watch_threshold", "frequency", "next_test_on",
    "cure_period_days", "is_active", "last_state", "last_projected_state", "notes",
  ];
  return covs.map((c) => {
    const l = loanMap[c.loan_id];
    const t = latest[c.id];
    return {
      ...Object.fromEntries(keys.map((k) => [k, (c as Record<string, any>)[k]])),
      loan_label: l ? loanLabel(l) : null, property_id: l ? l.property_id : null,
      property_label: l && l.property_id ? (labels[l.property_id] ?? null) : null,
      effective_watch: r2(effectiveWatch(c, s), 3),
      last_value: t ? t.measured_value : null, last_projected_value: t ? t.projected_value : null,
      last_tested_on: t ? t.test_date : null,
    };
  });
}

// --------------------------------------------------------------------------- reserves

export async function createReserve(db: Db, loan: Loan, data: ReserveIn, actor: CurrentUser): Promise<LoanReserve> {
  const r = await insert(db, loanReserves, { loan_id: loan.id, ...data, balance: 0, created_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "loan.reserve_created", entity_type: ENTITY, entity_id: loan.id, summary: r.label || r.reserve_type,
    changes: data, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function updateReserve(db: Db, r: LoanReserve, data: ReserveIn, actor: CurrentUser): Promise<LoanReserve> {
  const changes = diffObj(r, data);
  await patch(db, loanReserves, r, { ...data, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "loan.reserve_updated", entity_type: ENTITY, entity_id: r.loan_id, summary: r.label || r.reserve_type,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function postReserveTxn(db: Db, r: LoanReserve, data: ReserveTxnIn, actor: CurrentUser): Promise<ReserveTransaction> {
  const amt = Number(data.amount);
  if ((data.kind === "deposit" || data.kind === "release") && amt <= 0) {
    throw new HttpError(422, "Deposits and releases must be positive amounts");
  }
  const delta = data.kind === "deposit" ? amt : data.kind === "release" ? -amt : amt;
  const newBal = Number(r.balance || 0) + delta;
  if (newBal < -0.005) throw new HttpError(409, "A release cannot exceed the reserve balance");
  const txn = await insert(db, reserveTransactions, {
    reserve_id: r.id, loan_id: r.loan_id, kind: data.kind, amount: amt, occurred_on: data.occurred_on,
    balance_after: r2(newBal) as number, document_id: data.document_id, memo: data.memo,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  const old = r.balance;
  await patch(db, loanReserves, r, { balance: r2(newBal) as number, updated_by_id: actor.id });
  if (data.document_id) {
    let documents: any = null;
    try {
      documents = await import("../documents/service");
    } catch {
      documents = null;
    }
    if (documents?.link) {
      await documents.link(db, data.document_id, "reserve_transaction", txn.id, actor);
      await documents.link(db, data.document_id, "loan", r.loan_id, actor);
    }
  }
  await audit.record(db, {
    actor, action: `loan.reserve_${data.kind}`, entity_type: ENTITY, entity_id: r.loan_id,
    summary: `${r.label || r.reserve_type}: ${data.kind} ${fmtMoney(amt, 2)}`,
    changes: { balance: { from: old, to: r.balance }, document_id: data.document_id },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return txn;
}

// --------------------------------------------------------------------------- lender reporting obligations

/** Last day of the calendar-aligned period (1/3/6/12 months) that follows the period ending on/before d. */
function periodEndAfter(d: string, step: number): string {
  return addDays(addMonths(addDays(d, 1), step), -1);
}

export function nextReportDue(frequency: string, daysAfter: number, onOrAfter: string): string {
  const step = FREQ_MONTHS[frequency] ?? 3;
  const month = Number(onOrAfter.slice(5, 7));
  const startMonth = Math.floor((month - 1) / step) * step + 1;
  let prevEnd = addDays(`${onOrAfter.slice(0, 4)}-${String(startMonth).padStart(2, "0")}-01`, -1);
  let due = addDays(prevEnd, daysAfter);
  while (due < onOrAfter) {
    prevEnd = periodEndAfter(prevEnd, step);
    due = addDays(prevEnd, daysAfter);
  }
  return due;
}

/** Upsert the recurring critical date + owned task for the obligation's next due date. Does not commit. */
async function scheduleObligation(db: Db, loan: Loan, o: LenderReportingObligation, actor: Actor): Promise<void> {
  const { createTask } = await import("../tasks/service");
  if (!o.is_active || !o.next_due_on) return;
  const typeText = o.report_type.replace(/_/g, " ");
  const label = `${o.label || typeText.charAt(0).toUpperCase() + typeText.slice(1).toLowerCase()} due to ${loan.lender_name || "lender"}`;
  const key = `lender_report:${o.id}:${o.next_due_on}`;
  let contracts: any = null;
  try {
    contracts = await import("../contracts/service");
  } catch {
    contracts = null;
  }
  if (contracts?.upsertCriticalDate) {
    const cd = await contracts.upsertCriticalDate(db, {
      related_type: "loan", related_id: loan.id, date_type: "lender_reporting", label, due_on: o.next_due_on,
      property_id: loan.property_id, owner_id: o.owner_id, lead_days: 14, is_blocking: false, source: "rule",
      status: "confirmed", key, actor, related_label: loanLabel(loan),
    });
    await patch(db, lenderReportingObligations, o, { critical_date_id: cd.id });
  }
  const task = await createTask(db, {
    title: label, assignee_id: o.owner_id || loan.owner_id, due_at: dueDt(o.next_due_on), task_type: "general",
    priority: "normal", related_type: "loan", related_id: loan.id, related_label: loanLabel(loan),
    source: "debt.lender_reporting", idempotency_key: key.slice(0, 200), actor_id: actor?.id ?? null,
  });
  await patch(db, lenderReportingObligations, o, { task_id: task.id });
}

export async function createObligation(db: Db, loan: Loan, data: ObligationIn, actor: CurrentUser): Promise<LenderReportingObligation> {
  const nextDue = data.next_due_on ?? nextReportDue(data.frequency, data.days_after_period, todayStr());
  const o = await insert(db, lenderReportingObligations, {
    loan_id: loan.id, ...data, next_due_on: nextDue, created_by_id: actor.id, updated_by_id: actor.id,
  });
  await scheduleObligation(db, loan, o, actor);
  await audit.record(db, {
    actor, action: "loan.obligation_created", entity_type: ENTITY, entity_id: loan.id, summary: o.label || o.report_type,
    changes: data, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function updateObligation(
  db: Db, o: LenderReportingObligation, data: ObligationIn, actor: CurrentUser,
): Promise<LenderReportingObligation> {
  const values: Record<string, any> = { ...data };
  if (values.next_due_on === null || values.next_due_on === undefined) values.next_due_on = o.next_due_on;
  const changes = diffObj(o, values);
  await patch(db, lenderReportingObligations, o, { ...values, updated_by_id: actor.id } as never);
  if (["next_due_on", "owner_id", "is_active", "label"].some((k) => k in changes)) {
    await scheduleObligation(db, await get(db, o.loan_id), o, actor);
  }
  await audit.record(db, {
    actor, action: "loan.obligation_updated", entity_type: ENTITY, entity_id: o.loan_id, summary: o.label || o.report_type,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function submitObligation(
  db: Db, o: LenderReportingObligation, submittedOnArg: string | null | undefined, documentId: string | null | undefined,
  note: string | null | undefined, actor: CurrentUser,
): Promise<LenderReportingObligation> {
  const loan = await get(db, o.loan_id);
  const submittedOn = submittedOnArg || todayStr();
  if (o.critical_date_id) {
    let contracts: any = null;
    let contractSchema: any = null;
    try {
      contracts = await import("../contracts/service");
      contractSchema = await import("../contracts/schema");
    } catch {
      contracts = null;
    }
    const complete = contracts ? (contracts._complete ?? contracts.complete) : null;
    if (complete && contractSchema?.criticalDates) {
      const cd = await getRow(db, contractSchema.criticalDates, o.critical_date_id);
      if (cd && ((cd as any).status === "confirmed" || (cd as any).status === "missed")) {
        // completes with an event + audit entry; does not commit
        await complete(db, cd, `Lender report submitted ${submittedOn}`, actor);
      }
    }
  }
  if (o.task_id) {
    const task = await getRow(db, tasks, o.task_id);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      await patch(db, tasks, task, { status: "done", completed_at: new Date(), completed_by_id: actor.id } as never);
    }
  }
  if (documentId) {
    let documents: any = null;
    try {
      documents = await import("../documents/service");
    } catch {
      documents = null;
    }
    if (documents?.link) await documents.link(db, documentId, "loan", loan.id, actor);
  }
  const previousDue = o.next_due_on;
  const set: Record<string, any> = { last_submitted_on: submittedOn };
  if (previousDue) {
    const periodEnd = addDays(previousDue, -o.days_after_period);
    set.next_due_on = addDays(periodEndAfter(periodEnd, FREQ_MONTHS[o.frequency] ?? 3), o.days_after_period);
  } else {
    set.next_due_on = nextReportDue(o.frequency, o.days_after_period, submittedOn);
  }
  set.updated_by_id = actor.id;
  set.critical_date_id = null;
  set.task_id = null;
  await patch(db, lenderReportingObligations, o, set as never);
  await scheduleObligation(db, loan, o, actor);
  await audit.record(db, {
    actor, action: "loan.obligation_submitted", entity_type: ENTITY, entity_id: loan.id,
    summary: `${o.label || o.report_type} for due ${pyStr(previousDue)}`,
    changes: { submitted_on: submittedOn, next_due_on: o.next_due_on, document_id: documentId ?? null, note: note ?? null },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function obligationItems(db: Db, rows: LenderReportingObligation[]): Promise<Record<string, any>[]> {
  const names = await userNames(db, rows.map((r) => r.owner_id));
  const today = todayStr();
  const keys = [
    "id", "loan_id", "report_type", "label", "frequency", "days_after_period", "next_due_on", "owner_id", "is_active",
    "notes", "last_submitted_on", "critical_date_id", "task_id", "updated_at",
  ];
  return rows.map((r) => ({
    ...Object.fromEntries(keys.map((k) => [k, (r as Record<string, any>)[k]])),
    owner_name: r.owner_id ? (names[r.owner_id] ?? null) : null,
    overdue: Boolean(r.is_active && r.next_due_on && r.next_due_on < today),
  }));
}

// --------------------------------------------------------------------------- portfolio views

export async function ladder(db: Db, bucket: string, f: LoanFilters): Promise<Record<string, any>> {
  if (!f.status || !f.status.length) f.status = ["active"];
  const rows = await db.select().from(loans).where(buildWhere(f));
  const labels = await propLabels(db, rows.map((l) => l.property_id));
  type B = { key: string; balance: number; fixed_balance: number; floating_balance: number; count: number; loans: any[] };
  const buckets = new Map<string, B>();
  const undated: Loan[] = [];
  for (const l of rows) {
    if (!l.maturity_on) {
      undated.push(l);
      continue;
    }
    const d = l.maturity_on;
    const year = String(Number(d.slice(0, 4)));
    const month = Number(d.slice(5, 7));
    const key = bucket === "year" ? year : bucket === "quarter" ? `${year}-Q${Math.floor((month - 1) / 3) + 1}` : `${year}-${String(month).padStart(2, "0")}`;
    let b = buckets.get(key);
    if (!b) {
      b = { key, balance: 0.0, fixed_balance: 0.0, floating_balance: 0.0, count: 0, loans: [] };
      buckets.set(key, b);
    }
    const bal = Number(l.current_balance || 0);
    b.balance += bal;
    if (l.rate_type === "floating") b.floating_balance += bal;
    else b.fixed_balance += bal;
    b.count += 1;
    b.loans.push({
      id: l.id, label: loanLabel(l), property_label: l.property_id ? (labels[l.property_id] ?? null) : null,
      balance: bal, maturity_on: d, rate: l.rate, href: `/loans/${l.id}`,
    });
  }
  const total = [...buckets.values()].reduce((t, b) => t + b.balance, 0);
  const out = [...buckets.keys()].sort().map((k) => {
    const b = buckets.get(k)!;
    const dates = b.loans.map((x) => x.maturity_on as string);
    const min = dates.reduce((x, y) => (x < y ? x : y));
    const max = dates.reduce((x, y) => (x > y ? x : y));
    return {
      ...b, balance: r2(b.balance), fixed_balance: r2(b.fixed_balance), floating_balance: r2(b.floating_balance),
      share_pct: pct(b.balance, total), drill: `/loans?maturity_from=${min}&maturity_to=${max}`,
    };
  });
  return {
    bucket, total: r2(total), buckets: out,
    undated: undated.map((l) => ({ id: l.id, label: loanLabel(l), balance: l.current_balance })),
  };
}

export async function exposure(db: Db): Promise<Record<string, any>> {
  const s = await getSettings(db);
  const rows = await db.select().from(loans).where(and(isNull(loans.deleted_at), eq(loans.status, "active")));
  const today = todayStr();
  const bal = (l: Loan) => Number(l.current_balance || 0);
  const total = rows.reduce((t, l) => t + bal(l), 0);
  const floating = rows.filter((l) => l.rate_type === "floating");
  const hedged = floating.filter(
    (l) => (l.cap_expires_on && l.cap_expires_on >= today) || (l.swap_expires_on && l.swap_expires_on >= today),
  );
  const unhedgedBal = floating.filter((l) => !hedged.includes(l)).reduce((t, l) => t + bal(l), 0);
  const leadDays: number[] = s.cap_lead_days;
  const lead = leadDays && leadDays.length ? Math.max(...leadDays) : 90;
  const expiring = floating.filter((l) => l.cap_expires_on && today <= l.cap_expires_on && l.cap_expires_on <= addDays(today, lead));
  const wRate = safeDiv(rows.reduce((t, l) => t + bal(l) * (l.rate || 0), 0), total);
  const labels = await propLabels(db, expiring.map((l) => l.property_id));
  const floatingTotal = floating.reduce((t, l) => t + bal(l), 0);
  return {
    total_balance: r2(total), floating_balance: r2(floatingTotal), floating_pct: pct(floatingTotal, total),
    hedged_floating_balance: r2(hedged.reduce((t, l) => t + bal(l), 0)),
    unhedged_floating_balance: r2(unhedgedBal), weighted_rate: r2(wRate, 3),
    annual_cost_per_100bp_unhedged: r2(unhedgedBal * 0.01),
    caps_expiring: expiring.map((l) => ({
      id: l.id, label: loanLabel(l), property_label: l.property_id ? (labels[l.property_id] ?? null) : null,
      cap_expires_on: l.cap_expires_on, cap_strike: l.cap_strike, balance: l.current_balance, href: `/loans/${l.id}`,
    })),
    drill: "/loans?rate_type=floating",
  };
}

// --------------------------------------------------------------------------- automation scan

/** Maturity windows, refi windows, cap expirations, due covenant tests and overdue lender reports. Does not commit. */
export async function scan(db: Db, actor: Actor): Promise<Record<string, any>> {
  const { createTask, raiseAlert } = await import("../tasks/service");
  const s = await getSettings(db);
  const today = todayStr();
  const rows = await db.select().from(loans).where(and(isNull(loans.deleted_at), eq(loans.status, "active")));
  const labels = await propLabels(db, rows.map((l) => l.property_id));
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const l of rows) {
    const label = stripChars(`${loanLabel(l)} · ${l.property_id ? (labels[l.property_id] ?? "") : ""}`, " ·");
    const a = await assetFor(db, l);
    const owner = l.owner_id || (a ? a.manager_id : null);
    if (l.maturity_on) {
      const mtm = monthsBetween(today, l.maturity_on);
      for (const lead of [...(s.maturity_lead_months as number[])].sort((x, y) => x - y)) {
        if (mtm <= lead) {
          const key = `loan:${l.id}:maturity:${lead}:${l.maturity_on}`;
          const [found] = await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.idempotency_key, key)).limit(1);
          if (!found) {
            await raiseAlert(db, {
              title: `Loan matures in ${Math.max(mtm, 0)} months: ${loanLabel(l)}`,
              reason: `Maturity ${l.maturity_on} is within the ${lead}-month lead time. ` +
                `Balance ${fmtMoney(Number(l.current_balance || 0), 0)}.`,
              severity: mtm <= 3 ? "critical" : mtm <= 6 ? "high" : "medium",
              owner_id: owner, related_type: "loan", related_id: l.id, related_label: label,
              rule_key: "debt.maturity_window", idempotency_key: key, due_at: dueDt(l.maturity_on),
            });
            await events.emit(db, "loan.maturity_window", {
              loan_id: l.id, property_id: l.property_id, months_to_maturity: mtm, actor,
            });
            bump("maturity_alerts");
          }
          break;
        }
      }
      const [opens, inWin] = refiWindow(l, s);
      if (inWin) {
        const key = `loan:${l.id}:refi_window:${l.maturity_on}`;
        await createTask(db, {
          title: `Refinance analysis: ${loanLabel(l)}`, assignee_id: owner, due_at: dueDt(addDays(today, 14)),
          task_type: "review", priority: "high",
          description: `Refinance window opened ${opens} ahead of maturity ${l.maturity_on}.`,
          related_type: "loan", related_id: l.id, related_label: label, source: "debt.refi_window",
          idempotency_key: key, actor_id: actor?.id ?? null,
        });
        bump("refi_windows");
      }
    }
    if (l.rate_type === "floating" && l.cap_expires_on) {
      const days = daysBetween(l.cap_expires_on, today);
      for (const lead of [...(s.cap_lead_days as number[])].sort((x, y) => x - y)) {
        if (days >= 0 && days <= lead) {
          await raiseAlert(db, {
            title: `Rate cap expires in ${days} days: ${loanLabel(l)}`,
            reason: `Interest rate cap (${l.cap_strike ? pyStr(l.cap_strike) : "—"}% strike) expires ${l.cap_expires_on}; ` +
              "floating exposure becomes unhedged.",
            severity: days <= 30 ? "high" : "medium", owner_id: owner, related_type: "loan", related_id: l.id,
            related_label: label, rule_key: "debt.cap_expiration",
            idempotency_key: `loan:${l.id}:cap:${lead}:${l.cap_expires_on}`,
          });
          bump("cap_alerts");
          break;
        }
      }
    }
  }
  const dueCovs = await db
    .select({ c: covenants })
    .from(covenants)
    .innerJoin(loans, eq(loans.id, covenants.loan_id))
    .where(
      and(
        isNull(covenants.deleted_at), eq(covenants.is_active, true), eq(loans.status, "active"), isNull(loans.deleted_at),
        or(isNull(covenants.next_test_on), sql`${covenants.next_test_on} <= ${today}`),
      ),
    );
  for (const { c } of dueCovs) {
    if (c.kind === "net_worth") continue; // requires guarantor statements entered manually
    await runTest(db, c, actor, { scheduled: true });
    bump("covenant_tests");
  }
  const overdue = await db
    .select()
    .from(lenderReportingObligations)
    .where(
      and(
        isNull(lenderReportingObligations.deleted_at), eq(lenderReportingObligations.is_active, true),
        sql`${lenderReportingObligations.next_due_on} < ${today}`,
      ),
    );
  const loanMap = new Map(rows.map((l) => [l.id, l]));
  for (const o of overdue) {
    const l = loanMap.get(o.loan_id);
    if (!l) continue;
    await raiseAlert(db, {
      title: `Lender report overdue: ${o.label || o.report_type}`,
      reason: `Due ${o.next_due_on} to ${l.lender_name || "lender"}.`, severity: "high",
      owner_id: o.owner_id || l.owner_id, related_type: "loan", related_id: l.id, related_label: loanLabel(l),
      rule_key: "debt.lender_report_overdue", idempotency_key: `lender_report_overdue:${o.id}:${o.next_due_on}`,
    });
    bump("overdue_reports");
  }
  await audit.record(db, {
    actor, action: "loan.scan", entity_type: ENTITY, summary: `${rows.length} active loans`, changes: { ...counts },
  });
  return { loans: rows.length, ...counts };
}
