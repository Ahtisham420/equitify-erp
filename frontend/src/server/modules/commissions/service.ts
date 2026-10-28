import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, insertMany, patch, raw } from "../../db/orm";
import { teams, users } from "../auth/schema";
import { transactionFileComplete } from "../dealroom/service";
import { properties } from "../properties/schema";
import { raiseAlert } from "../tasks/service";
import {
  agentPlans, CLOSED_STAGES, commissionEvents, commissionInvoices, commissionPayments, commissions, commissionSplits,
  EARNED_STATUSES, forecastSnapshots, LOST_STAGES, OPEN_STATUSES, splitPlans,
  type AgentPlan, type Commission, type CommissionInvoice, type CommissionPayment, type CommissionSplit,
  type ForecastSnapshot, type SplitPlan,
} from "./schema";
import { commissionCreate } from "./schemas";
import type {
  CommissionCreate, CommissionUpdate, EarnIn, InvoiceCreate, PaymentCreate, PlanIn, ReleaseIn,
} from "./schemas";

export const PAYMENT_LAG_DAYS = 30; // default expected payment date = expected close + lag
export const LOCKED = new Set(["invoiced", "paid", "cancelled"]);
export const GROUPS = ["agent", "team", "property_type", "source", "month", "quarter", "year"];

type Actor = CurrentUser | null | undefined;

// ------------------------------------------------------------------------------------------- helpers

export const r2 = (x: unknown): number => Math.round(Number(x || 0) * 100) / 100 + 0;
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toISOString().slice(0, 10);

const parseDay = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = parseDay(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
};
const daysBetween = (a: string, b: string) => Math.round((parseDay(a).getTime() - parseDay(b).getTime()) / 86_400_000);

/** First day of the month `months` after `d` (the day of month is always reset to 1). */
export function addMonths(d: string, months: number): string {
  const t = parseDay(d);
  const total = t.getUTCMonth() + months;
  const y = t.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return fmtDay(new Date(Date.UTC(y, m, 1)));
}

export const monthKey = (d: string) => d.slice(0, 7);

/** Normalises a date / timestamp coming from a raw query (string or Date) to "YYYY-MM-DD". */
function toDay(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Python `%B %d, %Y`. */
const fmtLong = (s: string) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(8, 10)}, ${s.slice(0, 4)}`;

function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEq(a[k], b[k]));
  }
  return false;
}

/** audit.diff, but JSONB key order (Postgres reorders keys) must not count as a change (Python dict equality). */
function diff(obj: Record<string, any>, data: Record<string, any>) {
  const changes = audit.diff(obj, data);
  for (const k of Object.keys(changes)) {
    if (deepEq(audit.toJsonable(obj[k] ?? null), audit.toJsonable(data[k]))) delete changes[k];
  }
  return changes;
}

const nullify = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));
const definedOnly = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const pCom = (db: Db, c: Commission, values: Record<string, any>) => patch(db, commissions, c, values as never);

// =========================================================================== visibility

/** Agents without commissions:view_sensitive only see commissions they hold a split on - and only their split. */
export function restricted(user: Actor): boolean {
  return user !== null && user !== undefined && !user.can("commissions", "view_sensitive");
}

const splitCommissionIds = (agentCond: SQL) =>
  sql`select ${commissionSplits.commission_id} from ${commissionSplits} where ${agentCond} and ${isNull(commissionSplits.deleted_at)}`;

/** WHERE fragment restricting commissions to the ones the user may see (undefined = unrestricted). */
export function visible(user: Actor): SQL | undefined {
  if (!restricted(user)) return undefined;
  const me = (user as CurrentUser).id;
  return or(eq(commissions.agent_id, me), sql`${commissions.id} in (${splitCommissionIds(eq(commissionSplits.agent_id, me))})`);
}

export async function get(db: Db, commissionId: string, user: Actor): Promise<Commission> {
  const [c] = await db
    .select()
    .from(commissions)
    .where(and(eq(commissions.id, commissionId), isNull(commissions.deleted_at), visible(user)))
    .limit(1);
  if (!c) throw new HttpError(404, "Commission not found");
  return c;
}

// =========================================================================== cross-module (guarded)

export type Deal = Record<string, any>;

/** brokerage_deals is owned by the brokerage module; it is read dynamically so load order never matters. */
export async function dealsAvailable(db: Db): Promise<boolean> {
  const rows = await raw<{ t: string | null }>(db, sql`select to_regclass('brokerage_deals')::text as t`);
  return !!rows[0]?.t;
}

/** brokerage_deals.probability may be a fraction (0-1) or a percent; returns percent. */
export function normProb(p: unknown): number | null {
  if (p === null || p === undefined) return null;
  const n = Number(p);
  return n <= 1 ? n * 100.0 : Math.min(n, 100.0);
}

function normalizeDeal(r: Record<string, any>): Deal {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...r,
    probability: num(r.probability),
    deal_value: num(r.deal_value),
    gross_commission_estimate: num(r.gross_commission_estimate),
    expected_close_on: toDay(r.expected_close_on),
    closed_on: toDay(r.closed_on),
  };
}

export async function dealRows(db: Db, idSet: Set<string> | null = null): Promise<Deal[]> {
  if (!(await dealsAvailable(db))) return [];
  if (idSet !== null && !idSet.size) return [];
  const idCond = idSet !== null ? sql` and id in (${sql.join([...idSet].map((i) => sql`${i}`), sql`, `)})` : sql``;
  const rows = await raw(db, sql`select * from brokerage_deals where deleted_at is null${idCond}`);
  return rows.map(normalizeDeal);
}

export async function dealLabels(db: Db, deals: Deal[]): Promise<Map<string, string>> {
  const pids = [...new Set(deals.map((d) => d.property_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (pids.length) {
    const rows = await db
      .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
      .from(properties)
      .where(inArray(properties.id, pids));
    for (const r of rows) names.set(r.id, r.name || r.address_line);
  }
  const out = new Map<string, string>();
  for (const d of deals) {
    out.set(d.id, d.name || d.title || names.get(d.property_id) || `Deal ${String(d.id).slice(0, 8)}`);
  }
  return out;
}

/** Release gate: dealroom.service.transactionFileComplete must be true. */
export async function complianceCheck(db: Db, dealId: string | null | undefined): Promise<[boolean, string[]]> {
  if (!dealId) return [false, ["no brokerage transaction is linked, so the transaction file cannot be verified"]];
  const [ok, reasons] = await transactionFileComplete(db, dealId);
  return [Boolean(ok), [...(reasons ?? [])]];
}

export async function userNames(db: Db, idList: Array<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set(idList.filter((i): i is string => !!i))];
  const out = new Map<string, string>();
  if (!set.length) return out;
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  for (const r of rows) out.set(r.id, r.full_name);
  return out;
}

async function userTeam(db: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const u = await ormGet(db, users, userId);
  return u ? u.team_id ?? null : null;
}

// =========================================================================== split math (pure)

function proRata(total: number, weights: Record<string, number>): Record<string, number> {
  total = r2(total);
  const keys = Object.keys(weights);
  if (!keys.length) return {};
  let s = keys.reduce((a, k) => a + Math.max(0, weights[k]), 0);
  if (s <= 0) {
    weights = Object.fromEntries(keys.map((k) => [k, 1.0]));
    s = keys.length;
  }
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = r2((total * Math.max(0, weights[k])) / s);
  const drift = r2(total - Object.values(out).reduce((a, b) => a + b, 0));
  if (drift) {
    let top = keys[0];
    for (const k of keys) if (weights[k] > weights[top]) top = k;
    out[top] = r2(out[top] + drift);
  }
  return out;
}

/**
 * Agent share of `gci` under a graduated plan keyed on YTD GCI.
 *
 * Bands: tier k covers YTD GCI in [min_k, min_{k+1}) (the first band starts at 0). The deal's GCI
 * occupies [ytd_before, ytd_before + gci); each slice earns that band's agent_pct:
 *     agent = sum_k overlap_k * agent_pct_k / 100
 */
export function graduatedAgentAmount(gci: number, ytdBefore: number, tiers: Record<string, any>[]): [number, Record<string, any>[]] {
  if (!tiers.length) {
    return [r2(gci), [{ from: ytdBefore, to: ytdBefore + gci, gci: r2(gci), agent_pct: 100.0, amount: r2(gci) }]];
  }
  const bands = [...tiers].sort((a, b) => Number(a.min_ytd_gci || 0) - Number(b.min_ytd_gci || 0));
  const lo = ytdBefore;
  const hi = ytdBefore + gci;
  let total = 0;
  const detail: Record<string, any>[] = [];
  bands.forEach((t, i) => {
    const bLo = i === 0 ? 0.0 : Number(t.min_ytd_gci || 0);
    const bHi = i + 1 < bands.length ? Number(bands[i + 1].min_ytd_gci || 0) : Infinity;
    const overlap = Math.max(0.0, Math.min(hi, bHi) - Math.max(lo, bLo));
    if (overlap > 0) {
      const pct = Number(t.agent_pct || 0);
      const amt = (overlap * pct) / 100.0;
      total += amt;
      detail.push({ from: Math.max(lo, bLo), to: Math.min(hi, bHi), gci: r2(overlap), agent_pct: pct, amount: r2(amt) });
    }
  });
  return [r2(total), detail];
}

/**
 * Commission split calculation.
 *
 * referral = referral_amount if given, else gross * referral_pct / 100      (paid off the top)
 * net      = gross - referral
 * gci_i    = net * share_i / sum(share)                                     (cent drift -> largest share)
 * agent_i  = gci_i * override_i / 100 when a per-deal override is set, else the graduated plan amount
 * cap      : house_i = gci_i - agent_i is limited to max(0, annual_cap - house_ytd_i); the excess goes to the agent
 * net_i    = agent_i - sum(deductions charged to agent i)
 * house    = sum(gci_i - agent_i)
 * Each participant: {agent_id, share_pct, override_agent_pct, plan: {name, tiers, annual_cap} | null, ytd_gci, ytd_house}.
 */
export function calculate(
  gross: number, referralPct: number | null | undefined, referralAmount: number | null | undefined,
  participants: Record<string, any>[], deductions: Record<string, any>[], primaryAgentId: string | null,
): Record<string, any> {
  gross = r2(gross);
  let referral = r2(referralAmount !== null && referralAmount !== undefined ? referralAmount : (gross * Number(referralPct || 0)) / 100.0);
  referral = Math.min(referral, gross);
  const net = r2(gross - referral);
  const shares: Record<string, number> = {};
  for (const p of participants) shares[String(p.agent_id)] = Number(p.share_pct || 0);
  const shareTotal = Object.values(shares).reduce((a, b) => a + b, 0) || 1.0;
  const gci = proRata(net, shares);
  const dedByAgent: Record<string, number> = {};
  for (const d of deductions) {
    const key = String(d.agent_id || primaryAgentId || (participants.length ? participants[0].agent_id : ""));
    dedByAgent[key] = (dedByAgent[key] ?? 0) + Number(d.amount || 0);
  }
  const lines: Record<string, any>[] = [];
  for (const p of participants) {
    const key = String(p.agent_id);
    const g = gci[key] ?? 0.0;
    const plan = p.plan || {};
    let agentAmt: number;
    let detail: Record<string, any>[];
    if (p.override_agent_pct !== null && p.override_agent_pct !== undefined) {
      agentAmt = r2((g * Number(p.override_agent_pct)) / 100.0);
      detail = [{ override: true, agent_pct: Number(p.override_agent_pct), gci: g, amount: agentAmt }];
    } else {
      [agentAmt, detail] = graduatedAgentAmount(g, Number(p.ytd_gci || 0), plan.tiers || []);
    }
    let houseI = r2(g - agentAmt);
    let capped = false;
    const cap = plan.annual_cap;
    if (cap !== null && cap !== undefined && (p.override_agent_pct === null || p.override_agent_pct === undefined)) {
      const allowed = Math.max(0.0, Number(cap) - Number(p.ytd_house || 0));
      if (houseI > allowed) {
        agentAmt = r2(agentAmt + houseI - allowed);
        houseI = r2(allowed);
        capped = true;
      }
    }
    const ded = r2(dedByAgent[key] ?? 0.0);
    lines.push({
      agent_id: key, role: key === String(primaryAgentId) ? "primary" : "co_agent",
      share_pct: round((100.0 * shares[key]) / shareTotal, 4), gci_amount: g,
      agent_pct: g ? round((100.0 * agentAmt) / g, 4) : null, amount: agentAmt, deductions: ded,
      net_amount: r2(agentAmt - ded), ytd_gci_before: r2(p.ytd_gci || 0), capped,
      plan: plan.name ?? null, bands: detail, house_amount: houseI,
    });
  }
  // sum(gci_i) = net, so this equals sum(gci_i - agent_i); with no agent participants the whole net is house.
  const house = r2(net - lines.reduce((a, l) => a + l.amount, 0));
  return {
    gross, referral, net_gci: net, house,
    agent_total: r2(lines.reduce((a, l) => a + l.amount, 0)),
    agent_net_total: r2(lines.reduce((a, l) => a + l.net_amount, 0)),
    deductions_total: r2(lines.reduce((a, l) => a + l.deductions, 0)),
    lines, computed_at: utcnow().toISOString(),
  };
}

// =========================================================================== plans & YTD

export async function planFor(db: Db, agentId: string, explicitPlanId: string | null | undefined): Promise<SplitPlan | null> {
  if (explicitPlanId) {
    const plan = await ormGet(db, splitPlans, explicitPlanId);
    if (plan && !plan.deleted_at) return plan;
  }
  const [ap] = await db.select().from(agentPlans).where(and(eq(agentPlans.agent_id, agentId), isNull(agentPlans.deleted_at))).limit(1);
  if (ap) {
    const plan = await ormGet(db, splitPlans, ap.plan_id);
    if (plan && !plan.deleted_at) return plan;
  }
  const [def] = await db
    .select()
    .from(splitPlans)
    .where(and(eq(splitPlans.is_default, true), eq(splitPlans.is_active, true), isNull(splitPlans.deleted_at)))
    .limit(1);
  return def ?? null;
}

/** (YTD GCI, YTD house share) of an agent from earned commissions in calendar `year`. */
export async function ytd(db: Db, agentId: string, year: number, excludeId: string | null = null): Promise<[number, number]> {
  const [row] = await db
    .select({
      gci: sql<number>`coalesce(sum(${commissionSplits.gci_amount}), 0)::float8`,
      house: sql<number>`coalesce(sum(${commissionSplits.gci_amount} - ${commissionSplits.amount}), 0)::float8`,
    })
    .from(commissionSplits)
    .innerJoin(commissions, eq(commissions.id, commissionSplits.commission_id))
    .where(and(
      eq(commissionSplits.agent_id, agentId), isNull(commissionSplits.deleted_at),
      inArray(commissionSplits.role, ["primary", "co_agent"]), isNull(commissions.deleted_at),
      inArray(commissions.status, [...EARNED_STATUSES]), sql`extract(year from ${commissions.earned_on}) = ${year}`,
      excludeId ? ne(commissions.id, excludeId) : undefined,
    ));
  return [Number(row?.gci ?? 0), Number(row?.house ?? 0)];
}

async function event(
  db: Db, c: Commission, action: string, actor: Actor,
  { from_status = null, to_status = null, note = null, snapshot = null }: {
    from_status?: string | null; to_status?: string | null; note?: string | null | undefined; snapshot?: Record<string, any> | null;
  } = {},
): Promise<void> {
  await insert(db, commissionEvents, {
    commission_id: c.id, action, from_status, to_status, actor_id: actor?.id ?? null, actor_name: actor?.full_name ?? null,
    note: note ?? null, snapshot: audit.toJsonable(snapshot ?? {}),
  });
}

/** Rebuild split lines. Previous lines are soft-deleted and the prior calc is kept in commission_events. */
export async function recalc(db: Db, c: Commission, actor: Actor): Promise<void> {
  if (LOCKED.has(c.status)) throw new HttpError(409, `A ${c.status} commission is locked; its splits cannot be recalculated`);
  let participants: Record<string, any>[] = [...(c.participants ?? [])];
  if (!participants.length && c.agent_id) {
    participants = [{ agent_id: String(c.agent_id), share_pct: 100, override_agent_pct: null }];
  }
  const year = Number((c.earned_on || c.expected_close_on || todayStr()).slice(0, 4));
  const enriched: Record<string, any>[] = [];
  for (const p of participants) {
    const aid = String(p.agent_id);
    const plan = await planFor(db, aid, c.split_plan_id);
    const [g, h] = await ytd(db, aid, year, c.id);
    enriched.push({
      ...p, agent_id: aid, ytd_gci: g, ytd_house: h,
      plan: plan ? { id: String(plan.id), name: plan.name, tiers: plan.tiers || [], annual_cap: plan.annual_cap } : null,
    });
  }
  const calc = calculate(Number(c.gross || 0), c.referral_pct, c.referral_amount, enriched, [...(c.deductions ?? [])], c.agent_id ? String(c.agent_id) : null);
  if (c.calc && Object.keys(c.calc).length) {
    await event(db, c, "recalculated", actor, { note: "Split calculation rebuilt", snapshot: { previous: c.calc } });
  }
  await db
    .update(commissionSplits)
    .set({ deleted_at: utcnow() })
    .where(and(eq(commissionSplits.commission_id, c.id), isNull(commissionSplits.deleted_at)));
  const by = actor?.id ?? null;
  const rows: Record<string, any>[] = calc.lines.map((line: Record<string, any>) => ({
    commission_id: c.id, agent_id: line.agent_id, role: line.role, share_pct: line.share_pct, gci_amount: line.gci_amount,
    agent_pct: line.agent_pct, amount: line.amount, deductions: line.deductions, net_amount: line.net_amount,
    ytd_gci_before: line.ytd_gci_before, capped: line.capped, detail: { plan: line.plan, bands: line.bands },
    created_by_id: by,
  }));
  if (calc.referral) {
    rows.push({
      commission_id: c.id, role: "referral", label: c.referral_party || "Referral", gci_amount: 0, amount: calc.referral,
      net_amount: calc.referral, created_by_id: by,
    });
  }
  rows.push({ commission_id: c.id, role: "house", label: "House share", gci_amount: 0, amount: calc.house, net_amount: calc.house, created_by_id: by });
  await insertMany(db, commissionSplits, rows as never);
  await pCom(db, c, { calc, house_amount: calc.house, agent_net_total: calc.agent_net_total });
}

// =========================================================================== queries

export interface CommissionFilters {
  q?: string;
  status?: string[];
  side?: string[];
  property_type?: string[];
  reconciliation_status?: string[];
  source?: string[];
  agent_id?: string[];
  brokerage_deal_id?: string;
  min_gross?: number;
  max_gross?: number;
  expected_from?: string;
  expected_to?: string;
}

/** WHERE clause for the commission filters (incl. visibility); `skip` leaves a facet's own filter out. */
export function buildQuery(f: CommissionFilters, user: Actor, skip: Set<string> = new Set()): SQL | undefined {
  const t = commissions;
  const cols: Array<[string, any]> = [
    ["status", t.status], ["side", t.side], ["property_type", t.property_type],
    ["reconciliation_status", t.reconciliation_status], ["source", t.source],
  ];
  return and(
    isNull(t.deleted_at),
    visible(user),
    applySearch(f.q, [t.title, t.source, t.referral_party]),
    ...cols.map(([key, col]) => (skip.has(key) ? undefined : inFilter(col, (f as Record<string, any>)[key]))),
    f.agent_id?.length
      ? or(
          inArray(t.agent_id, f.agent_id),
          sql`${t.id} in (${splitCommissionIds(inArray(commissionSplits.agent_id, f.agent_id))})`,
        )
      : undefined,
    f.brokerage_deal_id ? eq(t.brokerage_deal_id, f.brokerage_deal_id) : undefined,
    rangeFilter(t.gross, f.min_gross, f.max_gross),
    rangeFilter(t.expected_on, f.expected_from, f.expected_to),
  );
}

async function splitsOf(db: Db, idList: string[]): Promise<Map<string, CommissionSplit[]>> {
  const out = new Map<string, CommissionSplit[]>();
  if (!idList.length) return out;
  const rows = await db
    .select()
    .from(commissionSplits)
    .where(and(inArray(commissionSplits.commission_id, idList), isNull(commissionSplits.deleted_at)));
  for (const s of rows) {
    const list = out.get(s.commission_id) ?? [];
    list.push(s);
    out.set(s.commission_id, list);
  }
  return out;
}

export async function toItems(db: Db, rows: Commission[], user: Actor) {
  const names = await userNames(db, rows.map((c) => c.agent_id));
  const mine = restricted(user);
  const splits = mine ? await splitsOf(db, rows.map((c) => c.id)) : new Map<string, CommissionSplit[]>();
  return rows.map((c) => ({
    ...listItem(c),
    agent_name: c.agent_id ? names.get(c.agent_id) ?? null : null,
    my_net: mine
      ? r2((splits.get(c.id) ?? []).filter((s) => s.agent_id === user!.id).reduce((a, s) => a + Number(s.net_amount || 0), 0))
      : null,
    house_amount: mine ? null : Number(c.house_amount || 0),
  }));
}

function listItem(c: Commission) {
  return {
    id: c.id, brokerage_deal_id: c.brokerage_deal_id, title: c.title, agent_id: c.agent_id, agent_name: null as string | null,
    team_id: c.team_id, property_type: c.property_type, source: c.source, side: c.side, deal_volume: c.deal_volume,
    gross: c.gross, status: c.status, probability: c.probability, expected_close_on: c.expected_close_on,
    expected_on: c.expected_on, earned_on: c.earned_on, paid_on: c.paid_on, paid_total: c.paid_total,
    discrepancy: c.discrepancy, reconciliation_status: c.reconciliation_status, approved_at: c.approved_at,
    my_net: null as number | null, house_amount: null as number | null, updated_at: c.updated_at,
  };
}

export function invoiceOut(i: CommissionInvoice, commissionTitle: string | null = null) {
  return {
    id: i.id, commission_id: i.commission_id, commission_title: commissionTitle, invoice_number: i.invoice_number,
    bill_to: i.bill_to, issued_on: i.issued_on, due_on: i.due_on, amount: i.amount, status: i.status,
    rendered_text: i.rendered_text, void_reason: i.void_reason, created_at: i.created_at,
  };
}

export function paymentOut(p: CommissionPayment) {
  return {
    id: p.id, commission_id: p.commission_id, invoice_id: p.invoice_id, amount: p.amount, received_on: p.received_on,
    reference: p.reference, method: p.method, note: p.note, created_at: p.created_at,
  };
}

export function planOut(p: SplitPlan, agentCount = 0) {
  return {
    id: p.id, name: p.name, description: p.description, tiers: p.tiers ?? [], annual_cap: p.annual_cap,
    is_default: p.is_default, is_active: p.is_active, agent_count: agentCount, updated_at: p.updated_at,
  };
}

const ROLE_ORDER = ["primary", "co_agent", "referral", "house"];

export async function toOut(db: Db, c: Commission, user: Actor) {
  const mine = restricted(user);
  let splits = (await splitsOf(db, [c.id])).get(c.id) ?? [];
  if (mine) splits = splits.filter((s) => s.agent_id === user!.id);
  const names = await userNames(db, [c.agent_id, ...splits.map((s) => s.agent_id)]);
  const out: Record<string, any> = {
    ...listItem(c),
    property_id: c.property_id, split_plan_id: c.split_plan_id, participants: c.participants ?? [],
    referral_party: c.referral_party, referral_pct: c.referral_pct, referral_amount: c.referral_amount,
    deductions: c.deductions ?? [], agent_net_total: null as number | null, calc: c.calc ?? {},
    approved_by_id: c.approved_by_id, released_at: c.released_at, release_note: c.release_note, notes: c.notes,
    created_at: c.created_at, splits: [] as any[], invoices: [] as any[], payments: [] as any[], deal: null as any,
    compliance: {} as any, restricted: false,
  };
  out.agent_name = c.agent_id ? names.get(c.agent_id) ?? null : null;
  const roleIdx = (r: string) => (ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : 9);
  out.splits = [...splits]
    .sort((a, b) => roleIdx(a.role) - roleIdx(b.role))
    .map((s) => ({
      id: s.id, agent_id: s.agent_id, agent_name: s.agent_id ? names.get(s.agent_id) ?? null : null, role: s.role,
      label: s.label, share_pct: s.share_pct, gci_amount: s.gci_amount, agent_pct: s.agent_pct, amount: s.amount,
      deductions: s.deductions, net_amount: s.net_amount, ytd_gci_before: s.ytd_gci_before, capped: s.capped,
      detail: s.detail ?? {},
    }));
  const invoices = await db
    .select()
    .from(commissionInvoices)
    .where(and(eq(commissionInvoices.commission_id, c.id), isNull(commissionInvoices.deleted_at)))
    .orderBy(asc(commissionInvoices.issued_on));
  out.invoices = invoices.map((i) => invoiceOut(i, c.title));
  const payments = await db
    .select()
    .from(commissionPayments)
    .where(and(eq(commissionPayments.commission_id, c.id), isNull(commissionPayments.deleted_at)))
    .orderBy(asc(commissionPayments.received_on));
  out.payments = payments.map(paymentOut);
  if (c.brokerage_deal_id) {
    const rows = await dealRows(db, new Set([c.brokerage_deal_id]));
    if (rows.length) {
      const d = rows[0];
      out.deal = {
        id: String(d.id), label: (await dealLabels(db, rows)).get(d.id) ?? null, stage: d.stage ?? null,
        probability: normProb(d.probability), expected_close_on: audit.toJsonable(d.expected_close_on ?? null),
        gross_commission_estimate: d.gross_commission_estimate ?? null,
      };
    }
  }
  const [ok, reasons] = await complianceCheck(db, c.brokerage_deal_id);
  out.compliance = { complete: ok, reasons };
  out.restricted = mine;
  if (mine) {
    const own = String(user!.id);
    out.my_net = r2(splits.reduce((a, s) => a + Number(s.net_amount || 0), 0));
    out.house_amount = null;
    out.agent_net_total = null;
    out.calc = {};
    out.participants = (c.participants ?? []).filter((p) => String(p.agent_id) === own);
    out.deductions = (c.deductions ?? []).filter((d) => String(d.agent_id) === own || (!d.agent_id && c.agent_id === user!.id));
    out.referral_amount = null;
  } else {
    out.house_amount = Number(c.house_amount || 0);
    out.agent_net_total = Number(c.agent_net_total || 0);
  }
  return out;
}

// =========================================================================== lifecycle

async function applyDealDefaults(db: Db, values: Record<string, any>): Promise<Record<string, any>> {
  const dealId = values.brokerage_deal_id;
  if (!dealId) return values;
  const rows = await dealRows(db, new Set([dealId]));
  if (!rows.length) {
    if (await dealsAvailable(db)) throw new HttpError(422, "Brokerage transaction not found");
    return values;
  }
  const d = rows[0];
  if (!values.agent_id) values.agent_id = d.agent_id ?? null;
  if (!values.property_id) values.property_id = d.property_id ?? null;
  if (!values.side && d.side) {
    values.side = ["listing", "buyer", "tenant", "landlord", "dual"].includes(d.side) ? d.side : "other";
  }
  if (values.probability === null || values.probability === undefined) values.probability = normProb(d.probability);
  if (!values.expected_close_on) values.expected_close_on = d.expected_close_on ?? null;
  if ((values.deal_volume === null || values.deal_volume === undefined) && d.deal_value !== null && d.deal_value !== undefined) {
    values.deal_volume = Number(d.deal_value);
  }
  if (!values.gross && d.gross_commission_estimate) values.gross = Number(d.gross_commission_estimate);
  if (!values.source && d.source) values.source = d.source;
  if (!values.title) values.title = (await dealLabels(db, [d])).get(d.id) ?? null;
  return values;
}

async function propertyTypeOf(db: Db, propertyId: string | null | undefined): Promise<string | null> {
  if (!propertyId) return null;
  const p = await ormGet(db, properties, propertyId);
  return p ? p.property_type : null;
}

export async function create(
  db: Db, data: CommissionCreate, actor: Actor, { commit = true }: { commit?: boolean } = {},
): Promise<Commission> {
  let values: Record<string, any> = nullify(data);
  if (values.brokerage_deal_id) {
    const [dupe] = await db
      .select({ id: commissions.id })
      .from(commissions)
      .where(and(eq(commissions.brokerage_deal_id, values.brokerage_deal_id), isNull(commissions.deleted_at), ne(commissions.status, "cancelled")))
      .limit(1);
    if (dupe) throw new HttpError(409, "A commission record already exists for this transaction");
  }
  values = await applyDealDefaults(db, values);
  values.agent_id = values.agent_id || actor?.id || null;
  if (!(values.participants ?? []).length && values.agent_id) {
    values.participants = [{ agent_id: String(values.agent_id), share_pct: 100, override_agent_pct: null }];
  }
  values.participants = audit.toJsonable(values.participants ?? []);
  values.deductions = audit.toJsonable(values.deductions || []);
  values.property_type = values.property_type || (await propertyTypeOf(db, values.property_id));
  if (!values.expected_on && values.expected_close_on) values.expected_on = addDays(values.expected_close_on, PAYMENT_LAG_DAYS);
  values.title = String(values.title || "Commission").slice(0, 255);
  const c = await insert(db, commissions, {
    ...values, team_id: await userTeam(db, values.agent_id), status: "forecast",
    created_by_id: actor?.id ?? null, updated_by_id: actor?.id ?? null,
  } as never);
  await recalc(db, c, actor);
  await event(db, c, "created", actor, { to_status: "forecast" });
  await audit.record(db, {
    actor, action: "commission.created", entity_type: "commission", entity_id: c.id,
    summary: `${c.title} — gross ${money(Number(c.gross))}`, ip_address: actor?.ip_address ?? null,
  });
  if (commit) await db.commit();
  return c;
}

export async function update(db: Db, c: Commission, data: CommissionUpdate, actor: CurrentUser): Promise<Commission> {
  if (LOCKED.has(c.status)) throw new HttpError(409, `A ${c.status} commission cannot be edited`);
  const values = definedOnly(data);
  for (const k of ["participants", "deductions"]) {
    if (k in values && values[k] !== null) values[k] = audit.toJsonable(values[k]);
  }
  const changes = diff(c, values);
  if (!Object.keys(changes).length) return c;
  const set: Record<string, any> = { ...values };
  if ("agent_id" in changes) set.team_id = await userTeam(db, values.agent_id);
  if ("property_id" in changes && !("property_type" in values)) set.property_type = await propertyTypeOf(db, values.property_id);
  if (c.approved_at) {
    changes.approved_at = { from: audit.toJsonable(c.approved_at), to: null };
    set.approved_at = null;
    set.approved_by_id = null;
  }
  set.updated_by_id = actor.id;
  await pCom(db, c, set);
  await recalc(db, c, actor);
  await event(db, c, "updated", actor, { note: Object.keys(changes).sort().join(", "), snapshot: { changes } });
  await audit.record(db, {
    actor, action: "commission.updated", entity_type: "commission", entity_id: c.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

/** True/False when the brokerage transaction is known, null when it cannot be determined. */
async function dealClosed(db: Db, c: Commission): Promise<boolean | null> {
  if (!c.brokerage_deal_id || !(await dealsAvailable(db))) return null;
  const rows = await dealRows(db, new Set([c.brokerage_deal_id]));
  if (!rows.length) return null;
  return CLOSED_STAGES.has(String(rows[0].stage || "").toLowerCase());
}

export async function earn(
  db: Db, c: Commission, data: EarnIn, actor: Actor, { commit = true }: { commit?: boolean } = {},
): Promise<Commission> {
  if (c.status !== "forecast") throw new HttpError(409, "Only forecast commissions can be marked earned");
  const closed = await dealClosed(db, c);
  if (closed !== true && actor && !actor.can("commissions", "approve")) {
    throw new HttpError(409, "The transaction has not closed; marking it earned requires approval permission");
  }
  const prev = c.status;
  await pCom(db, c, {
    status: "earned", earned_on: data.earned_on || todayStr(), probability: 100, updated_by_id: actor?.id ?? null,
  });
  await recalc(db, c, actor); // YTD-based tiers are re-evaluated at the moment the commission is earned
  await event(db, c, "earned", actor, { from_status: prev, to_status: "earned", note: data.note });
  await audit.record(db, {
    actor, action: "commission.earned", entity_type: "commission", entity_id: c.id, summary: `Earned ${c.earned_on}`,
    ip_address: actor?.ip_address ?? null,
  });
  await events.emit(db, "commission.earned", { commission_id: c.id, brokerage_deal_id: c.brokerage_deal_id, actor });
  if (commit) await db.commit();
  return c;
}

export async function approve(db: Db, c: Commission, note: string | null | undefined, actor: CurrentUser): Promise<Commission> {
  if (c.status !== "earned" && c.status !== "invoiced") throw new HttpError(409, "Only earned or invoiced commissions can be approved");
  await pCom(db, c, { approved_at: utcnow(), approved_by_id: actor.id, updated_by_id: actor.id });
  await event(db, c, "approved", actor, { note, snapshot: { calc: c.calc } });
  await audit.record(db, {
    actor, action: "commission.approved", entity_type: "commission", entity_id: c.id, summary: note, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

export async function cancel(db: Db, c: Commission, reason: string, actor: CurrentUser): Promise<Commission> {
  if (["invoiced", "paid", "cancelled"].includes(c.status)) {
    throw new HttpError(409, "Invoiced or paid commissions cannot be cancelled; void the invoice first");
  }
  if (c.status === "earned" && !actor.can("commissions", "approve")) {
    throw new HttpError(403, "Cancelling an earned commission requires approval permission");
  }
  const prev = c.status;
  await pCom(db, c, { status: "cancelled", updated_by_id: actor.id });
  await event(db, c, "cancelled", actor, { from_status: prev, to_status: "cancelled", note: reason });
  await audit.record(db, {
    actor, action: "commission.cancelled", entity_type: "commission", entity_id: c.id, summary: reason, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

export function renderInvoice(
  c: Commission, number: string, billTo: string, issued: string, due: string, amount: number,
  memo: string | null | undefined, dealLabel: string | null | undefined,
): string {
  const lines = [
    "COMMISSION INVOICE",
    "",
    `Invoice number: ${number}`,
    `Issued: ${fmtLong(issued)}`,
    `Due: ${fmtLong(due)}`,
    "",
    "Bill to:",
    billTo,
    "",
    `Transaction: ${dealLabel || c.title}`,
  ];
  if (c.deal_volume) lines.push(`Transaction value: $${money(Number(c.deal_volume))}`);
  if (c.side) lines.push(`Representation: ${c.side.replaceAll("_", " ")}`);
  lines.push("", `Brokerage commission due: $${money(amount)}`);
  if (memo) lines.push("", memo);
  lines.push("", "Please reference the invoice number with your payment.");
  return lines.join("\n");
}

export async function createInvoice(db: Db, c: Commission, data: InvoiceCreate, actor: CurrentUser): Promise<CommissionInvoice> {
  if (c.status !== "earned") throw new HttpError(409, "Only earned commissions can be invoiced");
  const issued = data.issued_on || todayStr();
  const due = data.due_on || c.expected_on || addDays(issued, PAYMENT_LAG_DAYS);
  if (due < issued) throw new HttpError(422, "Due date must be on or after the issue date");
  const amount = r2(data.amount !== null && data.amount !== undefined ? data.amount : c.gross);
  const year = issued.slice(0, 4);
  const [cnt] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commissionInvoices)
    .where(sql`${commissionInvoices.invoice_number} like ${`INV-${year}-%`}`);
  const number = `INV-${year}-${String(Number(cnt?.n ?? 0) + 1).padStart(5, "0")}`;
  let label: string | null = null;
  if (c.brokerage_deal_id) {
    const rows = await dealRows(db, new Set([c.brokerage_deal_id]));
    label = rows.length ? (await dealLabels(db, rows)).get(c.brokerage_deal_id) ?? null : null;
  }
  const inv = await insert(db, commissionInvoices, {
    commission_id: c.id, invoice_number: number, bill_to: data.bill_to, issued_on: issued, due_on: due, amount,
    status: "issued", rendered_text: renderInvoice(c, number, data.bill_to, issued, due, amount, data.memo, label),
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  const prev = c.status;
  await pCom(db, c, { status: "invoiced", expected_on: due, updated_by_id: actor.id });
  await event(db, c, "invoiced", actor, { from_status: prev, to_status: "invoiced", note: number });
  await audit.record(db, {
    actor, action: "commission.invoiced", entity_type: "commission", entity_id: c.id,
    summary: `${number} — ${money(amount)} due ${due}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return inv;
}

export async function voidInvoice(db: Db, inv: CommissionInvoice, reason: string, actor: CurrentUser): Promise<CommissionInvoice> {
  if (inv.status !== "issued") throw new HttpError(409, "Only open invoices can be voided");
  const [paid] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commissionPayments)
    .where(and(eq(commissionPayments.invoice_id, inv.id), isNull(commissionPayments.deleted_at)));
  if (Number(paid?.n ?? 0)) throw new HttpError(409, "Payments are recorded against this invoice");
  await patch(db, commissionInvoices, inv, { status: "void", void_reason: reason, updated_by_id: actor.id } as never);
  const c = await ormGet(db, commissions, inv.commission_id);
  if (c && c.status === "invoiced") {
    const [others] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(commissionInvoices)
      .where(and(
        eq(commissionInvoices.commission_id, c.id), ne(commissionInvoices.id, inv.id), eq(commissionInvoices.status, "issued"),
        isNull(commissionInvoices.deleted_at),
      ));
    if (!Number(others?.n ?? 0)) {
      await pCom(db, c, { status: "earned" });
      await event(db, c, "invoice_voided", actor, { from_status: "invoiced", to_status: "earned", note: `${inv.invoice_number}: ${reason}` });
    }
  }
  await audit.record(db, {
    actor, action: "commission_invoice.voided", entity_type: "commission", entity_id: inv.commission_id,
    summary: `${inv.invoice_number}: ${reason}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return inv;
}

/** discrepancy = paid - gross; matched within one cent, otherwise short/over. */
function reconcileValues(c: Commission, paidTotal: number) {
  const discrepancy = r2(paidTotal - Number(c.gross || 0));
  let status: string;
  if (paidTotal <= 0) status = "unpaid";
  else if (Math.abs(discrepancy) < 0.01) status = "matched";
  else status = discrepancy < 0 ? "short" : "over";
  return { paid_total: r2(paidTotal), discrepancy, reconciliation_status: status };
}

export async function recordPayment(db: Db, c: Commission, data: PaymentCreate, actor: CurrentUser): Promise<CommissionPayment> {
  if (c.status !== "invoiced") throw new HttpError(409, "Payments can only be recorded against an invoiced commission");
  let invoiceId = data.invoice_id ?? null;
  let inv: CommissionInvoice | undefined;
  if (invoiceId) {
    inv = await ormGet(db, commissionInvoices, invoiceId);
    if (!inv || inv.commission_id !== c.id || inv.status === "void") throw new HttpError(422, "Invoice not found on this commission");
  } else {
    [inv] = await db
      .select()
      .from(commissionInvoices)
      .where(and(eq(commissionInvoices.commission_id, c.id), eq(commissionInvoices.status, "issued"), isNull(commissionInvoices.deleted_at)))
      .orderBy(desc(commissionInvoices.issued_on))
      .limit(1);
    invoiceId = inv ? inv.id : null;
  }
  const pay = await insert(db, commissionPayments, {
    commission_id: c.id, invoice_id: invoiceId, amount: data.amount, received_on: data.received_on,
    reference: data.reference ?? null, method: data.method ?? null, note: data.note ?? null,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  const [total] = await db
    .select({ s: sql<number>`coalesce(sum(${commissionPayments.amount}), 0)::float8` })
    .from(commissionPayments)
    .where(and(eq(commissionPayments.commission_id, c.id), isNull(commissionPayments.deleted_at)));
  const before = c.reconciliation_status;
  await pCom(db, c, reconcileValues(c, Number(total?.s ?? 0)));
  if (inv) {
    const [invPaid] = await db
      .select({ s: sql<number>`coalesce(sum(${commissionPayments.amount}), 0)::float8` })
      .from(commissionPayments)
      .where(and(eq(commissionPayments.invoice_id, inv.id), isNull(commissionPayments.deleted_at)));
    if (Number(invPaid?.s ?? 0) >= Number(inv.amount) - 0.005) await patch(db, commissionInvoices, inv, { status: "paid" } as never);
  }
  await event(db, c, "payment_recorded", actor, {
    note: `${money(data.amount)} received ${data.received_on}`,
    snapshot: { reconciliation: { from: before, to: c.reconciliation_status, paid_total: c.paid_total, discrepancy: c.discrepancy } },
  });
  await audit.record(db, {
    actor, action: "commission.payment_recorded", entity_type: "commission", entity_id: c.id,
    summary: `${money(data.amount)} received ${data.received_on}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return pay;
}

/** Mark paid / release to agents. Gates: earned -> invoiced -> paid, approval, payment received,
 *  reconciliation (or explicit acceptance of a discrepancy) and transaction-file compliance. */
export async function release(db: Db, c: Commission, data: ReleaseIn, actor: CurrentUser): Promise<Commission> {
  if (c.status !== "invoiced") {
    throw new HttpError(409, "Only invoiced commissions can be released; a commission must be earned and invoiced before it can be marked paid");
  }
  if (!c.approved_at) throw new HttpError(409, "Commission must be approved before release");
  if (Number(c.paid_total || 0) <= 0) throw new HttpError(409, "No payment has been recorded for this commission");
  const [ok, reasons] = await complianceCheck(db, c.brokerage_deal_id);
  if (!ok) {
    throw new HttpError(409, { message: "Release blocked: transaction file is not complete — " + reasons.join("; "), reasons });
  }
  if (c.reconciliation_status !== "matched") {
    if (!data.accept_discrepancy || !data.note) {
      throw new HttpError(
        409,
        `Paid amount differs from the expected gross by ${money(Number(c.discrepancy))}; accept the discrepancy with a note to release`,
      );
    }
    await raiseAlert(db, {
      title: `Commission discrepancy released: ${c.title}`,
      reason: `Paid ${money(Number(c.paid_total))} vs expected ${money(Number(c.gross))}. ${data.note}`,
      severity: "medium", owner_id: c.approved_by_id || actor.id, related_type: "commission", related_id: c.id,
      related_label: c.title, rule_key: "commission_discrepancy", idempotency_key: `commission_discrepancy:${c.id}`,
    });
  }
  const [last] = await db
    .select({ d: sql<string | null>`max(${commissionPayments.received_on})` })
    .from(commissionPayments)
    .where(and(eq(commissionPayments.commission_id, c.id), isNull(commissionPayments.deleted_at)));
  const prev = c.status;
  await pCom(db, c, {
    status: "paid", paid_on: toDay(last?.d) || todayStr(), released_by_id: actor.id, released_at: utcnow(),
    release_note: data.note ?? null, updated_by_id: actor.id,
  });
  await event(db, c, "released", actor, {
    from_status: prev, to_status: "paid", note: data.note,
    snapshot: { paid_total: c.paid_total, discrepancy: c.discrepancy, compliance: reasons },
  });
  await audit.record(db, {
    actor, action: "commission.released", entity_type: "commission", entity_id: c.id,
    summary: `Paid ${money(Number(c.paid_total))}`, ip_address: actor.ip_address,
  });
  await events.emit(db, "commission.paid", { commission_id: c.id, brokerage_deal_id: c.brokerage_deal_id, actor });
  await db.commit();
  return c;
}

// =========================================================================== brokerage sync

/** Create/update the commission for one brokerage deal. Does not commit. Returns the action taken. */
export async function upsertFromDeal(db: Db, d: Deal, actor: Actor): Promise<string | null> {
  const stage = String(d.stage || "").toLowerCase();
  const [existing] = await db
    .select()
    .from(commissions)
    .where(and(eq(commissions.brokerage_deal_id, d.id), isNull(commissions.deleted_at), ne(commissions.status, "cancelled")))
    .limit(1);
  let c: Commission | undefined = existing;
  if (c === undefined) {
    if (LOST_STAGES.has(stage)) return null;
    c = await create(db, commissionCreate.parse({ brokerage_deal_id: d.id, gross: 0 }), actor, { commit: false });
    if (CLOSED_STAGES.has(stage)) {
      await earn(
        db, c, { earned_on: d.closed_on || d.expected_close_on || todayStr(), note: "Transaction closed (brokerage sync)" }, null,
        { commit: false },
      );
      return "earned";
    }
    return "created";
  }
  if (c.status !== "forecast") return null;
  if (LOST_STAGES.has(stage)) {
    await pCom(db, c, { status: "cancelled" });
    await event(db, c, "cancelled", actor, {
      from_status: "forecast", to_status: "cancelled", note: `Transaction stage '${stage}' (brokerage sync)`,
    });
    return "cancelled";
  }
  const values: Record<string, any> = { probability: normProb(d.probability), expected_close_on: d.expected_close_on ?? null };
  if (d.gross_commission_estimate !== null && d.gross_commission_estimate !== undefined) values.gross = Number(d.gross_commission_estimate);
  if (d.deal_value !== null && d.deal_value !== undefined) values.deal_volume = Number(d.deal_value);
  if (d.agent_id) values.agent_id = d.agent_id;
  const changes = diff(c, values);
  const changed = Object.keys(changes).length > 0;
  if (changed) {
    const set: Record<string, any> = { ...values };
    if ("expected_close_on" in changes && values.expected_close_on) set.expected_on = addDays(values.expected_close_on, PAYMENT_LAG_DAYS);
    if ("agent_id" in changes) {
      set.team_id = await userTeam(db, values.agent_id);
      set.participants = [{ agent_id: String(values.agent_id), share_pct: 100, override_agent_pct: null }];
    }
    await pCom(db, c, set);
    await recalc(db, c, actor);
    await event(db, c, "synced", actor, { note: "Updated from brokerage transaction", snapshot: { changes } });
  }
  if (CLOSED_STAGES.has(stage)) {
    await earn(
      db, c, { earned_on: d.closed_on || d.expected_close_on || todayStr(), note: "Transaction closed (brokerage sync)" }, null,
      { commit: false },
    );
    return "earned";
  }
  return changed ? "updated" : null;
}

export async function syncFromDeals(db: Db, actor: CurrentUser) {
  if (!(await dealsAvailable(db))) {
    return { available: false, created: 0, updated: 0, earned: 0, cancelled: 0, message: "Brokerage module unavailable" };
  }
  const counts: Record<string, number> = {};
  for (const d of await dealRows(db)) {
    const action = await upsertFromDeal(db, d, actor);
    if (action) counts[action] = (counts[action] ?? 0) + 1;
  }
  await audit.record(db, {
    actor, action: "commission.synced", entity_type: "commission",
    summary: Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no changes", ip_address: actor.ip_address,
  });
  await db.commit();
  return {
    available: true, created: counts.created ?? 0, updated: counts.updated ?? 0, earned: counts.earned ?? 0,
    cancelled: counts.cancelled ?? 0, message: null,
  };
}

// =========================================================================== forecast

/**
 * Weighted forecast by expected payment month.
 *
 * weighted = open amount * weight, where weight = probability / 100 for forecast commissions and 1 for
 * earned/invoiced (open amount = gross - paid). Pipeline deals with no commission record contribute
 * gross_commission_estimate * probability at their expected close month. Restricted agents see their own
 * split net amounts instead of gross.
 */
export async function forecast(db: Db, user: Actor, months = 12, agentId: string | null = null): Promise<Record<string, any>> {
  const start = todayStr().slice(0, 8) + "01";
  const keys = Array.from({ length: months }, (_, i) => monthKey(addMonths(start, i)));
  type Bucket = { month?: string; weighted: number; unweighted: number; count: number };
  const buckets: Record<string, Bucket> = {};
  for (const k of keys) buckets[k] = { month: k, weighted: 0.0, unweighted: 0.0, count: 0 };
  const pastDue: Bucket = { weighted: 0.0, unweighted: 0.0, count: 0 };
  const unscheduled: Bucket = { weighted: 0.0, unweighted: 0.0, count: 0 };
  const byAgent: Record<string, Record<string, number>> = {};
  const items: Record<string, any>[] = [];
  const mine = restricted(user);

  const rows = await db
    .select()
    .from(commissions)
    .where(and(
      isNull(commissions.deleted_at), inArray(commissions.status, [...OPEN_STATUSES]), visible(user),
      agentId
        ? or(eq(commissions.agent_id, agentId), sql`${commissions.id} in (${splitCommissionIds(eq(commissionSplits.agent_id, agentId))})`)
        : undefined,
    ));
  const splits = mine ? await splitsOf(db, rows.map((c) => c.id)) : new Map<string, CommissionSplit[]>();

  const add = (target: Bucket, amount: number, weight: number) => {
    target.weighted += amount * weight;
    target.unweighted += amount;
    target.count += 1;
  };
  const place = (amount: number, weight: number, when: string | null, agent: string | null): string => {
    if (when === null) {
      add(unscheduled, amount, weight);
      return "unscheduled";
    }
    if (when < start) {
      add(pastDue, amount, weight);
      return "past_due";
    }
    const key = monthKey(when);
    if (key in buckets) {
      add(buckets[key], amount, weight);
      if (agent) {
        byAgent[agent] ??= {};
        byAgent[agent][key] = (byAgent[agent][key] ?? 0) + amount * weight;
      }
      return key;
    }
    return "beyond";
  };

  for (const c of rows) {
    const amount = mine
      ? (splits.get(c.id) ?? []).filter((s) => s.agent_id === user!.id).reduce((a, s) => a + Number(s.net_amount || 0), 0)
      : Math.max(0.0, Number(c.gross || 0) - Number(c.paid_total || 0));
    const weight = c.status === "earned" || c.status === "invoiced" ? 1.0 : Number(c.probability || 0) / 100.0;
    const when = c.expected_on || c.expected_close_on || null;
    const bucket = place(amount, weight, when, c.agent_id ? String(c.agent_id) : null);
    items.push({
      id: String(c.id), kind: "commission", title: c.title, status: c.status, agent_id: c.agent_id ? String(c.agent_id) : null,
      amount: r2(amount), probability: c.probability, weight, weighted: r2(amount * weight),
      expected_on: audit.toJsonable(when), bucket,
    });
  }

  let pipelineIncluded = false;
  if (await dealsAvailable(db)) {
    // Pipeline deals not yet carrying a commission record (agents only see their own deals).
    const linkedRows = await db
      .select({ d: commissions.brokerage_deal_id })
      .from(commissions)
      .where(and(isNotNull(commissions.brokerage_deal_id), isNull(commissions.deleted_at)));
    const linked = new Set(linkedRows.map((r) => r.d));
    let deals = (await dealRows(db)).filter(
      (d) => !linked.has(d.id) && !CLOSED_STAGES.has(String(d.stage || "").toLowerCase()) && !LOST_STAGES.has(String(d.stage || "").toLowerCase()),
    );
    if (mine) deals = deals.filter((d) => d.agent_id === user!.id);
    if (agentId) deals = deals.filter((d) => d.agent_id === agentId);
    const labels = await dealLabels(db, deals);
    for (const d of deals) {
      const amount = Number(d.gross_commission_estimate || 0);
      if (amount <= 0) continue;
      const weight = (normProb(d.probability) || 0) / 100.0;
      const when = d.expected_close_on ?? null;
      const bucket = place(amount, weight, when, d.agent_id ? String(d.agent_id) : null);
      items.push({
        id: String(d.id), kind: "deal", title: labels.get(d.id) ?? null, status: d.stage ?? null,
        agent_id: d.agent_id ? String(d.agent_id) : null, amount: r2(amount), probability: normProb(d.probability), weight,
        weighted: r2(amount * weight), expected_on: audit.toJsonable(when), bucket,
      });
    }
    pipelineIncluded = true;
  }

  for (const b of [...Object.values(buckets), pastDue, unscheduled]) {
    b.weighted = r2(b.weighted);
    b.unweighted = r2(b.unweighted);
  }
  const inHorizon = Object.values(buckets);
  items.sort((a, b) => {
    const ea = a.expected_on || "9999";
    const eb = b.expected_on || "9999";
    return ea < eb ? -1 : ea > eb ? 1 : b.weighted - a.weighted;
  });
  return {
    start, months: inHorizon, past_due: pastDue, unscheduled,
    total_weighted: r2(inHorizon.reduce((a, b) => a + b.weighted, 0) + pastDue.weighted),
    total_unweighted: r2(inHorizon.reduce((a, b) => a + b.unweighted, 0) + pastDue.unweighted),
    items: items.slice(0, 300), pipeline_included: pipelineIncluded, restricted: mine,
    by_agent: Object.fromEntries(
      Object.entries(byAgent).map(([k, vals]) => [k, Object.fromEntries(Object.entries(vals).map(([m, v]) => [m, r2(v)]))]),
    ),
  };
}

/** Freeze this month's company-wide forecast once (idempotent per month). Scheduler entry point. */
export async function ensureSnapshot(db: Db, actor: Actor): Promise<ForecastSnapshot> {
  const month = todayStr().slice(0, 8) + "01";
  const [snap] = await db.select().from(forecastSnapshots).where(eq(forecastSnapshots.snapshot_month, month)).limit(1);
  if (snap) return snap;
  const f = await forecast(db, null, 12);
  const created = await insert(db, forecastSnapshots, {
    snapshot_month: month, taken_by_id: actor?.id ?? null,
    buckets: Object.fromEntries(f.months.map((b: any) => [b.month, { weighted: b.weighted, unweighted: b.unweighted, count: b.count }])),
    by_agent: f.by_agent, total_weighted: f.total_weighted,
  });
  await db.commit();
  return created;
}

/**
 * Forecast accuracy per past month M.
 *
 * forecast_0 = weighted bucket M in the snapshot taken at the start of M
 * forecast_3 = weighted bucket M in the snapshot taken three months earlier
 * actual     = commission payments received during M
 * accuracy % = max(0, 1 - |actual - forecast_0| / forecast_0) * 100
 */
export async function accuracy(db: Db, months = 12) {
  const snapRows = await db.select().from(forecastSnapshots);
  const snaps = new Map(snapRows.map((s) => [s.snapshot_month, s]));
  const start = todayStr().slice(0, 8) + "01";
  const rows: Record<string, any>[] = [];
  for (let i = months; i > 0; i--) {
    const m = addMonths(start, -i);
    const key = monthKey(m);
    const s0 = snaps.get(m);
    const s3 = snaps.get(addMonths(m, -3));
    const f0: number | null = s0 ? (s0.buckets ?? {})[key]?.weighted ?? null : null;
    const f3: number | null = s3 ? (s3.buckets ?? {})[key]?.weighted ?? null : null;
    const [a] = await db
      .select({ s: sql<number>`coalesce(sum(${commissionPayments.amount}), 0)::float8` })
      .from(commissionPayments)
      .where(and(
        isNull(commissionPayments.deleted_at), sql`${commissionPayments.received_on} >= ${m}`,
        sql`${commissionPayments.received_on} < ${addMonths(m, 1)}`,
      ));
    const actual = r2(a?.s);
    const variance = f0 !== null ? r2(actual - f0) : null;
    const acc = f0 ? round(Math.max(0.0, 1 - Math.abs(actual - f0) / f0) * 100, 1) : null;
    rows.push({ month: key, forecast: f0, forecast_3m: f3, actual, variance, accuracy_pct: acc });
  }
  const scored = rows.map((r) => r.accuracy_pct).filter((x): x is number => x !== null);
  return {
    months: rows, average_accuracy_pct: scored.length ? round(scored.reduce((a, b) => a + b, 0) / scored.length, 1) : null,
    snapshots: snaps.size,
  };
}

// =========================================================================== production

function periodKey(d: string, groupBy: string): string {
  if (groupBy === "month") return monthKey(d);
  if (groupBy === "quarter") return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  return d.slice(0, 4);
}

/**
 * Production by agent/team/property type/source/period.
 *
 * count = closed transactions (agent rows credit share_pct / 100 per co-brokered deal)
 * volume = sum deal_volume (x share for agents); GCI = sum gross (agents: their GCI share)
 * avg deal size = volume / count; cycle time = mean days from deal creation to earned date
 * stage conversion = brokerage deals created in the period that reached a closed stage / all created.
 */
export async function production(
  db: Db, user: CurrentUser, groupBy = "agent", start: string | null = null, end: string | null = null,
  agentId: string | null = null, teamId: string | null = null, propertyType: string | null = null, source: string | null = null,
) {
  if (!GROUPS.includes(groupBy)) throw new HttpError(422, `group_by must be one of ${GROUPS.join(", ")}`);
  end = end || todayStr();
  start = start || `${end.slice(0, 4)}-01-01`;
  if (restricted(user)) agentId = user.id;
  const rows = await db
    .select()
    .from(commissions)
    .where(and(
      isNull(commissions.deleted_at), inArray(commissions.status, [...EARNED_STATUSES]),
      sql`${commissions.earned_on} >= ${start}`, sql`${commissions.earned_on} <= ${end}`,
      teamId ? eq(commissions.team_id, teamId) : undefined,
      propertyType ? eq(commissions.property_type, propertyType) : undefined,
      source ? eq(commissions.source, source) : undefined,
      agentId
        ? or(eq(commissions.agent_id, agentId), sql`${commissions.id} in (${splitCommissionIds(eq(commissionSplits.agent_id, agentId))})`)
        : undefined,
    ));
  const splits = await splitsOf(db, rows.map((c) => c.id));
  const dealIds = new Set(rows.map((c) => c.brokerage_deal_id).filter((x): x is string => !!x));
  const dealsById = new Map<string, Deal>();
  if (dealIds.size) for (const d of await dealRows(db, dealIds)) dealsById.set(d.id, d);

  type G = { count: number; volume: number; gci: number; cycle: number[] };
  const groups = new Map<string, G>();
  const credit = (key: string | null, share: number, volume: number, gci: number, cycle: number | null) => {
    const k = key || "unassigned";
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { count: 0.0, volume: 0.0, gci: 0.0, cycle: [] }));
    g.count += share;
    g.volume += volume * share;
    g.gci += gci;
    if (cycle !== null) g.cycle.push(cycle);
  };

  for (const c of rows) {
    const d = c.brokerage_deal_id ? dealsById.get(c.brokerage_deal_id) : undefined;
    const began = d ? d.created_at : null;
    const beganOn = toDay(began) ?? (c.created_at ? c.created_at.toISOString().slice(0, 10) : null);
    const cycle = c.earned_on && beganOn ? daysBetween(c.earned_on, beganOn) : null;
    const vol = Number(c.deal_volume || 0);
    if (groupBy === "agent") {
      for (const s of splits.get(c.id) ?? []) {
        if (!["primary", "co_agent"].includes(s.role) || (agentId && s.agent_id !== agentId)) continue;
        credit(s.agent_id ? String(s.agent_id) : null, Number(s.share_pct || 100) / 100.0, vol, Number(s.gci_amount || 0), cycle);
      }
    } else {
      const key = ["team", "property_type", "source"].includes(groupBy)
        ? ({ team: c.team_id ? String(c.team_id) : null, property_type: c.property_type, source: c.source } as Record<string, string | null>)[groupBy]
        : periodKey(c.earned_on as string, groupBy);
      credit(key, 1.0, vol, Number(c.gross || 0), cycle);
    }
  }

  // stage conversion from the brokerage pipeline (guarded)
  type Conv = { total: number; closed: number; lost: number; stages: Record<string, number> };
  const conversion = new Map<string, Conv>();
  const pipelineAvailable = await dealsAvailable(db);
  if (pipelineAvailable) {
    const allDeals = await dealRows(db);
    const teamOf = new Map<string, string | null>();
    const ptypeOf = new Map<string, string>();
    if (groupBy === "team") {
      for (const r of await db.select({ id: users.id, team_id: users.team_id }).from(users)) teamOf.set(r.id, r.team_id ?? null);
    }
    if (groupBy === "property_type" || propertyType) {
      const pids = [...new Set(allDeals.map((d) => d.property_id).filter(Boolean))] as string[];
      if (pids.length) {
        for (const r of await db.select({ id: properties.id, t: properties.property_type }).from(properties).where(inArray(properties.id, pids))) {
          ptypeOf.set(r.id, r.t);
        }
      }
    }
    for (const d of allDeals) {
      const createdOn = toDay(d.created_at);
      if (createdOn === null || createdOn < start || createdOn > end) continue;
      if (agentId && d.agent_id !== agentId) continue;
      if (propertyType && ptypeOf.get(d.property_id) !== propertyType) continue;
      if (source && d.source !== source) continue;
      if (teamId && teamOf.size && teamOf.get(d.agent_id) !== teamId) continue;
      const key = ["agent", "team", "property_type", "source"].includes(groupBy)
        ? ({
            agent: d.agent_id ? String(d.agent_id) : null,
            team: teamOf.get(d.agent_id) ? String(teamOf.get(d.agent_id)) : null,
            property_type: ptypeOf.get(d.property_id) ?? null,
            source: d.source ?? null,
          } as Record<string, string | null>)[groupBy]
        : periodKey(createdOn, groupBy);
      const stage = String(d.stage || "unknown").toLowerCase();
      const k = key || "unassigned";
      let row = conversion.get(k);
      if (!row) conversion.set(k, (row = { total: 0, closed: 0, lost: 0, stages: {} }));
      row.total += 1;
      row.stages[stage] = (row.stages[stage] ?? 0) + 1;
      if (CLOSED_STAGES.has(stage)) row.closed += 1;
      else if (LOST_STAGES.has(stage)) row.lost += 1;
    }
  }

  let labels = new Map<string, string>();
  const keys = new Set([...groups.keys(), ...conversion.keys()]);
  if (groupBy === "agent") {
    labels = await userNames(db, [...keys].filter((k) => k !== "unassigned"));
  } else if (groupBy === "team") {
    const tids = [...keys].filter((k) => k !== "unassigned");
    if (tids.length) {
      for (const r of await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, tids))) labels.set(r.id, r.name);
    }
  }

  const outRows = [...keys].map((k) => {
    const g = groups.get(k) ?? { count: 0.0, volume: 0.0, gci: 0.0, cycle: [] };
    const conv = conversion.get(k);
    const count = g.count;
    return {
      key: k, label: labels.get(k) || (k === "unassigned" ? "Unassigned" : k),
      count: round(count, 2), volume: r2(g.volume), gci: r2(g.gci),
      avg_deal_size: count ? r2(g.volume / count) : null, avg_gci: count ? r2(g.gci / count) : null,
      cycle_time_days: g.cycle.length ? round(g.cycle.reduce((a, b) => a + b, 0) / g.cycle.length, 1) : null,
      deals_total: conv ? conv.total : 0, deals_closed: conv ? conv.closed : 0, deals_lost: conv ? conv.lost : 0,
      conversion_pct: conv && conv.total ? round((100.0 * conv.closed) / conv.total, 1) : null,
      stage_counts: conv ? { ...conv.stages } : {},
    };
  });
  outRows.sort((a, b) => b.gci - a.gci || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const totalCount = outRows.reduce((a, r) => a + r.count, 0);
  const totalVolume = outRows.reduce((a, r) => a + r.volume, 0);
  const totalGci = outRows.reduce((a, r) => a + r.gci, 0);
  const cycles = [...groups.values()].flatMap((g) => g.cycle);
  return {
    group_by: groupBy, start, end, rows: outRows,
    totals: {
      count: round(totalCount, 2), volume: r2(totalVolume), gci: r2(totalGci),
      avg_deal_size: totalCount ? r2(totalVolume / totalCount) : null,
      cycle_time_days: cycles.length ? round(cycles.reduce((a, b) => a + b, 0) / cycles.length, 1) : null,
      deals_total: outRows.reduce((a, r) => a + r.deals_total, 0), deals_closed: outRows.reduce((a, r) => a + r.deals_closed, 0),
    },
    pipeline_available: pipelineAvailable, restricted: restricted(user),
  };
}

// =========================================================================== plans

export async function savePlan(db: Db, plan: SplitPlan | null, data: PlanIn, actor: CurrentUser): Promise<SplitPlan> {
  const values: Record<string, any> = nullify(data);
  values.tiers = [...values.tiers].sort((a: any, b: any) => a.min_ytd_gci - b.min_ytd_gci);
  if (values.tiers[0].min_ytd_gci !== 0) throw new HttpError(422, "The first tier must start at $0 YTD GCI");
  const mins = values.tiers.map((t: any) => t.min_ytd_gci);
  if (new Set(mins).size !== mins.length) throw new HttpError(422, "Tier thresholds must be unique");
  if (values.is_default) {
    const others = await db.select().from(splitPlans).where(and(eq(splitPlans.is_default, true), isNull(splitPlans.deleted_at)));
    for (const other of others) {
      if (plan === null || other.id !== plan.id) await patch(db, splitPlans, other, { is_default: false } as never);
    }
  }
  let changes: Record<string, any> | null;
  let action: string;
  if (plan === null) {
    plan = await insert(db, splitPlans, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
    changes = null;
    action = "split_plan.created";
  } else {
    changes = diff(plan, values);
    if (!Object.keys(changes).length) return plan;
    await patch(db, splitPlans, plan, { ...values, updated_by_id: actor.id } as never);
    action = "split_plan.updated";
  }
  await audit.record(db, {
    actor, action, entity_type: "split_plan", entity_id: plan.id, summary: plan.name, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return plan;
}

export async function agentPlansList(db: Db) {
  const assignedRows = await db.select().from(agentPlans).where(isNull(agentPlans.deleted_at));
  const assigned = new Map<string, AgentPlan>(assignedRows.map((a) => [a.agent_id, a]));
  const distinct = await db
    .selectDistinct({ a: commissions.agent_id })
    .from(commissions)
    .where(and(isNotNull(commissions.agent_id), isNull(commissions.deleted_at)));
  const agents = new Set<string>([...assigned.keys(), ...distinct.map((r) => r.a as string)]);
  if (!agents.size) return [];
  const userRows = await db.select().from(users).where(inArray(users.id, [...agents]));
  const usersById = new Map(userRows.map((u) => [u.id, u]));
  const planRows = await db.select().from(splitPlans).where(isNull(splitPlans.deleted_at));
  const plans = new Map(planRows.map((p) => [p.id, p]));
  const def = planRows.find((p) => p.is_default && p.is_active);
  const year = Number(todayStr().slice(0, 4));
  const out: Record<string, any>[] = [];
  for (const aid of agents) {
    const a = assigned.get(aid);
    const plan = a ? plans.get(a.plan_id) : def;
    const [g, h] = await ytd(db, aid, year);
    const u = usersById.get(aid);
    out.push({
      agent_id: aid, agent_name: u ? u.full_name : null, team_id: u ? u.team_id ?? null : null,
      plan_id: plan ? plan.id : null, plan_name: plan ? plan.name + (a ? "" : " (default)") : null,
      effective_from: a ? a.effective_from : null, ytd_gci: r2(g), ytd_house: r2(h),
    });
  }
  out.sort((x, y) => ((x.agent_name || "") < (y.agent_name || "") ? -1 : (x.agent_name || "") > (y.agent_name || "") ? 1 : 0));
  return out;
}

export async function assignPlan(
  db: Db, agentId: string, planId: string | null, effectiveFrom: string | null | undefined, actor: CurrentUser,
): Promise<void> {
  const [a] = await db.select().from(agentPlans).where(eq(agentPlans.agent_id, agentId)).limit(1);
  const before = a && !a.deleted_at ? String(a.plan_id) : null;
  if (planId === null) {
    if (a && !a.deleted_at) await patch(db, agentPlans, a, { deleted_at: utcnow(), updated_by_id: actor.id } as never);
  } else {
    const plan = await ormGet(db, splitPlans, planId);
    if (!plan || plan.deleted_at) throw new HttpError(422, "Plan not found");
    if (a === undefined) {
      await insert(db, agentPlans, {
        agent_id: agentId, plan_id: planId, effective_from: effectiveFrom ?? null, created_by_id: actor.id, updated_by_id: actor.id,
      });
    } else {
      await patch(db, agentPlans, a, {
        plan_id: planId, effective_from: effectiveFrom ?? null, deleted_at: null, updated_by_id: actor.id,
      } as never);
    }
  }
  await audit.record(db, {
    actor, action: "split_plan.assigned", entity_type: "user", entity_id: agentId,
    changes: { plan_id: { from: before, to: planId ? String(planId) : null } }, ip_address: actor.ip_address,
  });
  await db.commit();
}
