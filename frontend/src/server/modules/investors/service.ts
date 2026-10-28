import {
  and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL,
} from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySearch, inFilter } from "../../common/query";
import { type CurrentUser, loadUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError, parse } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { latestValue } from "../comps/service";
import { createTask, raiseAlert } from "../tasks/service";
import {
  capitalAccountEntries, capitalEventAllocations, capitalEvents, capitalEventVersions, capitalPartners,
  INVESTMENT_MATERIAL, investments, reportPackages, reportSchedules, waterfalls, waterfallTiers,
} from "./schema";
import type {
  CapitalAccountEntry, CapitalEvent, CapitalEventAllocation, CapitalPartner, Investment, ReportPackage, ReportSchedule,
  Waterfall, WaterfallTier,
} from "./schema";
import { eventPreviewIn } from "./schemas";
import type {
  EventCreate, EventPreviewIn, EventUpdate, FundIn, IncomeAllocationIn, InvestmentCreate, InvestmentUpdate,
  PackageCreate, PartnerCreate, PartnerUpdate, ScheduleIn, ScheduleUpdate, WaterfallIn,
} from "./schemas";
import * as wf from "./waterfall";

export const PORTAL_ROLE = "capital_partner";
// asset_financials sources that are plans/estimates rather than recorded actuals; never reported to partners.
const UNVERIFIED_SOURCES = new Set(["forecast", "estimate", "budget", "projection", "ai", "pro_forma", "proforma"]);
export const DEFAULT_GRACE_DAYS = 10;

type Id = string;

// =========================================================================== formatting helpers

const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Python prints floats with a trailing ".0" (8.0), JS prints 8. */
const pyFloat = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}, ${d.slice(0, 4)}`;
const shortDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(8, 10)}, ${d.slice(0, 4)}`;
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const isoTs = (v: unknown): any => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : v);
const pick = (row: Record<string, any>, keys: string[]): any => Object.fromEntries(keys.map((k) => [k, row[k]]));
const idList = (ids: Iterable<string>) => sql.join([...ids].map((i) => sql`${i}`), sql`, `);
const compact = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// =========================================================================== access scoping

export function isPortal(user: CurrentUser): boolean {
  return (user.user as any)?.role?.key === PORTAL_ROLE;
}

/** Partner ids a portal user may see (portal_user_id = user.id); null means unrestricted staff access. */
export async function scopeIds(db: Db, user: CurrentUser): Promise<Id[] | null> {
  if (!isPortal(user)) return null;
  const rows = await db
    .select({ id: capitalPartners.id })
    .from(capitalPartners)
    .where(and(eq(capitalPartners.portal_user_id, user.id), isNull(capitalPartners.deleted_at)));
  return rows.map((r) => r.id);
}

export function denyPortal(user: CurrentUser): void {
  if (isPortal(user)) throw new HttpError(403, "Not available in the investor portal");
}

/** Applies the portal partner scope to a condition. An empty scope matches nothing. */
export function scoped(column: any, ids: Id[] | null): SQL | undefined {
  if (ids === null) return undefined;
  return ids.length ? inArray(column, ids) : sql`false`;
}

export function checkCapitalLimit(user: CurrentUser, amount: number): void {
  if (user.is_admin) return;
  if ("capital" in (user.approval_limits ?? {}) && !user.canApprove("capital", amount)) {
    throw new HttpError(403, "Amount exceeds your capital approval limit");
  }
}

// =========================================================================== cross-module lookups

export async function userNames(db: Db, idsIn: Iterable<string | null | undefined>): Promise<Map<Id, string>> {
  const ids = [...new Set([...idsIn].filter((i): i is string => !!i))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

/** Label per asset id: the asset's property name/address, falling back to a property id hint. */
export async function assetLabels(db: Db, pairs: Array<[Id | null | undefined, Id | null | undefined]>): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  const assetIds = new Set(pairs.map(([a]) => a).filter((a): a is Id => !!a));
  if (assetIds.size) {
    const rows = await raw<{ id: Id; name: string | null; address_line: string | null; city: string | null }>(
      db,
      sql`select a.id, p.name, p.address_line, p.city from assets a left join properties p on p.id = a.property_id
          where a.id in (${idList(assetIds)})`,
    );
    for (const r of rows) {
      out.set(r.id, r.name || [r.address_line, r.city].filter(Boolean).join(", ") || `Asset ${String(r.id).slice(0, 8)}`);
    }
  }
  const missing = new Map<Id, Id>();
  for (const [a, p] of pairs) if (a && !out.has(a) && p) missing.set(p, a);
  if (missing.size) {
    const rows = await raw<{ id: Id; name: string | null; address_line: string }>(
      db,
      sql`select id, name, address_line from properties where id in (${idList(missing.keys())})`,
    );
    for (const r of rows) out.set(missing.get(r.id)!, r.name || r.address_line);
  }
  for (const a of assetIds) if (!out.has(a)) out.set(a, `Asset ${String(a).slice(0, 8)}`);
  return out;
}

export async function assetRow(db: Db, assetId: Id): Promise<Record<string, any> | null> {
  const rows = await raw(db, sql`select * from assets where id = ${assetId}`);
  return rows[0] ?? null;
}

export async function assetOptions(db: Db, q: string | undefined | null) {
  const conds: SQL[] = [sql`a.deleted_at is null`];
  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const like = `%${term}%`;
      conds.push(sql`(p.name ilike ${like} or p.address_line ilike ${like} or p.city ilike ${like})`);
    }
  }
  const rows = await raw<any>(
    db,
    sql`select a.id, a.property_id, p.name, p.address_line, p.city, a.status
        from assets a left join properties p on p.id = a.property_id
        where ${sql.join(conds, sql` and `)} limit 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    property_id: r.property_id,
    label: r.name || [r.address_line, r.city].filter(Boolean).join(", ") || String(r.id).slice(0, 8),
    status: r.status,
  }));
}

// =========================================================================== partners

export interface PartnerFilters {
  q?: string;
  type?: string[];
  status?: string[];
  owner_id?: string[];
  asset_id?: string;
  in_default?: boolean;
}

export function buildPartnerWhere(f: PartnerFilters, ids: Id[] | null, skip: Set<string> = new Set()): SQL | undefined {
  const t = capitalPartners;
  const defaulted = sql`select partner_id from capital_event_allocations
    where default_flag is true and status = 'default' and deleted_at is null`;
  return and(
    isNull(t.deleted_at),
    scoped(t.id, ids),
    applySearch(f.q, [t.name, t.email]),
    skip.has("type") ? undefined : inFilter(t.type, f.type),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    inFilter(t.owner_id, f.owner_id),
    f.asset_id
      ? sql`${t.id} in (select partner_id from investments where asset_id = ${f.asset_id} and deleted_at is null)`
      : undefined,
    f.in_default === undefined || f.in_default === null
      ? undefined
      : f.in_default
        ? sql`${t.id} in (${defaulted})`
        : sql`${t.id} not in (${defaulted})`,
  );
}

export async function getPartner(db: Db, partnerId: Id, user: CurrentUser): Promise<CapitalPartner> {
  const p = await get(db, capitalPartners, partnerId);
  const ids = await scopeIds(db, user);
  if (!p || p.deleted_at || (ids !== null && !ids.includes(p.id))) throw new HttpError(404, "Partner not found");
  return p;
}

interface Rollup {
  commitment: number;
  funded: number;
  investment_count: number;
  unfunded: number;
  in_default: boolean;
}

export async function partnerRollups(db: Db, partnerIds: Id[]): Promise<Map<Id, Rollup>> {
  const out = new Map<Id, Rollup>();
  if (!partnerIds.length) return out;
  const rows = await db
    .select({
      partner_id: investments.partner_id,
      commitment: sql<number>`coalesce(sum(${investments.commitment}), 0)::float8`,
      funded: sql<number>`coalesce(sum(${investments.funded}), 0)::float8`,
      n: sql<number>`count(*)::int`,
    })
    .from(investments)
    .where(and(inArray(investments.partner_id, partnerIds), isNull(investments.deleted_at)))
    .groupBy(investments.partner_id);
  for (const r of rows) {
    out.set(r.partner_id, {
      commitment: Number(r.commitment), funded: Number(r.funded), investment_count: Number(r.n), unfunded: 0, in_default: false,
    });
  }
  const defaulted = new Set(
    (
      await db
        .select({ partner_id: capitalEventAllocations.partner_id })
        .from(capitalEventAllocations)
        .where(and(
          inArray(capitalEventAllocations.partner_id, partnerIds), eq(capitalEventAllocations.status, "default"),
          isNull(capitalEventAllocations.deleted_at),
        ))
    ).map((r) => r.partner_id),
  );
  for (const pid of partnerIds) {
    let r = out.get(pid);
    if (!r) {
      r = { commitment: 0.0, funded: 0.0, investment_count: 0, unfunded: 0, in_default: false };
      out.set(pid, r);
    }
    r.unfunded = wf.round2(Math.max(0.0, r.commitment - r.funded));
    r.in_default = defaulted.has(pid);
  }
  return out;
}

export async function partnerItems(db: Db, rows: CapitalPartner[]) {
  const roll = await partnerRollups(db, rows.map((p) => p.id));
  return rows.map((p) => {
    const r = roll.get(p.id);
    return {
      ...pick(p, [
        "id", "name", "type", "status", "email", "organization_id", "person_id", "portal_user_id", "owner_id", "tags",
        "updated_at",
      ]),
      commitment: r?.commitment ?? 0,
      funded: r?.funded ?? 0,
      unfunded: r?.unfunded ?? 0,
      investment_count: r?.investment_count ?? 0,
      in_default: r?.in_default ?? false,
    };
  });
}

export async function partnerOut(db: Db, p: CapitalPartner) {
  let organization_name: string | null = null;
  let person_name: string | null = null;
  if (p.organization_id) {
    const org = await get(db, organizations, p.organization_id);
    organization_name = org ? org.name : null;
  }
  if (p.person_id) {
    const person = await get(db, people, p.person_id);
    person_name = person ? person.full_name : null;
  }
  const names = await userNames(db, [p.portal_user_id, p.owner_id]);
  const r = (await partnerRollups(db, [p.id])).get(p.id);
  return {
    ...pick(p, [
      "name", "type", "status", "organization_id", "person_id", "email", "phone", "reporting_requirements",
      "reporting_prefs", "communication_prefs", "portal_user_id", "owner_id", "notes", "tags", "id", "created_at",
      "updated_at",
    ]),
    organization_name,
    person_name,
    portal_user_name: p.portal_user_id ? (names.get(p.portal_user_id) ?? null) : null,
    owner_name: p.owner_id ? (names.get(p.owner_id) ?? null) : null,
    commitment: r?.commitment ?? 0,
    funded: r?.funded ?? 0,
    unfunded: r?.unfunded ?? 0,
    in_default: r?.in_default ?? false,
  };
}

async function checkPortalUser(db: Db, userId: Id | null | undefined): Promise<void> {
  if (!userId) return;
  const u = await loadUser(db, userId);
  if (!u || u.deleted_at) throw new HttpError(422, "Portal user not found");
  if (u.role?.key !== PORTAL_ROLE) throw new HttpError(422, "The portal user must have the Capital Partner role");
}

export async function createPartner(db: Db, data: PartnerCreate, actor: CurrentUser): Promise<CapitalPartner> {
  await checkPortalUser(db, data.portal_user_id);
  const { owner_id, ...values } = data;
  const p = await insert(db, capitalPartners, {
    ...values, owner_id: owner_id || actor.id, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "capital_partner.created", entity_type: "capital_partner", entity_id: p.id, summary: p.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return p;
}

export async function updatePartner(db: Db, p: CapitalPartner, data: PartnerUpdate, actor: CurrentUser): Promise<CapitalPartner> {
  const values = compact(data);
  if ("portal_user_id" in values) await checkPortalUser(db, values.portal_user_id);
  const changes = audit.diff(p, values);
  if (!Object.keys(changes).length) return p;
  await patch(db, capitalPartners, p, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "capital_partner.updated", entity_type: "capital_partner", entity_id: p.id, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return p;
}

export async function archivePartner(db: Db, p: CapitalPartner, actor: CurrentUser): Promise<void> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(investments)
    .where(and(eq(investments.partner_id, p.id), isNull(investments.deleted_at), eq(investments.status, "active")));
  if (n) throw new HttpError(409, "Partner has active investments; exit them before archiving");
  await patch(db, capitalPartners, p, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "capital_partner.archived", entity_type: "capital_partner", entity_id: p.id, summary: p.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// =========================================================================== investments

export async function getInvestment(db: Db, investmentId: Id, user: CurrentUser): Promise<Investment> {
  const inv = await get(db, investments, investmentId);
  const ids = await scopeIds(db, user);
  if (!inv || inv.deleted_at || (ids !== null && !ids.includes(inv.partner_id))) {
    throw new HttpError(404, "Investment not found");
  }
  return inv;
}

async function partnerNames(db: Db, ids: Iterable<Id>): Promise<Map<Id, string>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await db
    .select({ id: capitalPartners.id, name: capitalPartners.name })
    .from(capitalPartners)
    .where(inArray(capitalPartners.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function investmentOuts(db: Db, rows: Investment[]) {
  const labels = await assetLabels(db, rows.map((i) => [i.asset_id, i.property_id]));
  const pnames = await partnerNames(db, rows.map((i) => i.partner_id));
  const wids = [...new Set(rows.map((i) => i.waterfall_id).filter((w): w is Id => !!w))];
  const wnames = new Map<Id, string>();
  if (wids.length) {
    for (const w of await db.select({ id: waterfalls.id, name: waterfalls.name }).from(waterfalls).where(inArray(waterfalls.id, wids))) {
      wnames.set(w.id, w.name);
    }
  }
  return rows.map((i) => ({
    ...pick(i, [
      "asset_id", "property_id", "waterfall_id", "commitment", "ownership_pct", "pref_rate", "pref_compounding",
      "day_count", "waterfall_position", "status", "invested_on", "notes", "id", "partner_id",
    ]),
    partner_name: pnames.get(i.partner_id) ?? null,
    asset_label: labels.get(i.asset_id) ?? null,
    waterfall_name: i.waterfall_id ? (wnames.get(i.waterfall_id) ?? null) : null,
    funded: i.funded,
    unfunded: wf.round2(Math.max(0.0, Number(i.commitment || 0) - Number(i.funded || 0))),
    updated_at: i.updated_at,
  }));
}

export async function listInvestments(db: Db, user: CurrentUser, partnerId?: Id, assetId?: Id): Promise<Investment[]> {
  return db
    .select()
    .from(investments)
    .where(and(
      isNull(investments.deleted_at),
      scoped(investments.partner_id, await scopeIds(db, user)),
      partnerId ? eq(investments.partner_id, partnerId) : undefined,
      assetId ? eq(investments.asset_id, assetId) : undefined,
    ))
    .orderBy(asc(investments.created_at));
}

export async function createInvestment(db: Db, data: InvestmentCreate, actor: CurrentUser): Promise<Investment> {
  await getPartner(db, data.partner_id, actor);
  const row = await assetRow(db, data.asset_id);
  if (row === null) throw new HttpError(422, "Asset not found");
  const [dupe] = await db
    .select({ id: investments.id })
    .from(investments)
    .where(and(
      eq(investments.partner_id, data.partner_id), eq(investments.asset_id, data.asset_id), isNull(investments.deleted_at),
    ))
    .limit(1);
  if (dupe) throw new HttpError(409, "This partner already has an investment in this asset");
  const { provenance: prov, property_id: _pid, ...values } = data;
  const property_id = data.property_id || row?.property_id || null;
  const inv = await insert(db, investments, {
    ...values, property_id, funded: 0, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  for (const field of INVESTMENT_MATERIAL) {
    const value = (inv as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, {
        entity_type: "investment", entity_id: inv.id, field, value, prov, actor_id: actor.id,
      });
    }
  }
  await audit.record(db, {
    actor, action: "investment.created", entity_type: "investment", entity_id: inv.id,
    summary: `Commitment ${money(inv.commitment)} · ${pyFloat(inv.ownership_pct)}%`,
    changes: { partner_id: { from: null, to: String(inv.partner_id) } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return inv;
}

export async function updateInvestment(db: Db, inv: Investment, data: InvestmentUpdate, actor: CurrentUser): Promise<Investment> {
  const { provenance: prov, ...rest } = data;
  const values = compact(rest);
  const changes = await provenance.applyMaterial(db, inv, {
    entity_type: "investment", data: values, material_fields: INVESTMENT_MATERIAL, prov, actor_id: actor.id,
  });
  if (!Object.keys(changes).length) return inv;
  const set = Object.fromEntries(Object.keys(changes).map((k) => [k, (inv as Record<string, any>)[k]]));
  await patch(db, investments, inv, { ...set, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "investment.updated", entity_type: "investment", entity_id: inv.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return inv;
}

/** Investment.funded mirrors the posted contribution ledger (never edited directly). */
export async function refreshFunded(db: Db, investmentIds: Iterable<Id>): Promise<void> {
  for (const invId of investmentIds) {
    const [r] = await db
      .select({ total: sql<number>`coalesce(sum(${capitalAccountEntries.amount}), 0)::float8` })
      .from(capitalAccountEntries)
      .where(and(eq(capitalAccountEntries.investment_id, invId), eq(capitalAccountEntries.entry_type, "contribution")));
    await db.update(investments).set({ funded: wf.round2(Number(r?.total ?? 0)) }).where(eq(investments.id, invId));
  }
}

// =========================================================================== capital accounts

export async function entriesFor(db: Db, investmentIds: Id[], asOf?: string): Promise<CapitalAccountEntry[]> {
  if (!investmentIds.length) return [];
  return db
    .select()
    .from(capitalAccountEntries)
    .where(and(
      inArray(capitalAccountEntries.investment_id, investmentIds),
      asOf ? lte(capitalAccountEntries.effective_on, asOf) : undefined,
    ))
    .orderBy(asc(capitalAccountEntries.effective_on), asc(capitalAccountEntries.created_at));
}

/**
 * Capital account roll-forward for one investment from immutable ledger entries.
 *
 * ending_balance = contributions + allocated income − allocated loss − distributions
 * unreturned capital / accrued pref come from waterfall.prefAccrual (day-count accrual).
 */
export function summarizeAccount(inv: Investment, entries: CapitalAccountEntry[], asOf: string) {
  let contributions = 0.0, distributions = 0.0, roc = 0.0, prefPaid = 0.0, profit = 0.0, income = 0.0, loss = 0.0;
  const flows: wf.Flow[] = [];
  for (const e of entries) {
    if (e.effective_on > asOf) continue;
    const a = Number(e.amount || 0);
    if (e.entry_type === "contribution") {
      contributions += a;
      flows.push({ on: e.effective_on, kind: "contribution", amount: a });
    } else if (e.entry_type === "distribution") {
      distributions += a;
      if (e.component === "return_of_capital") {
        roc += a;
        flows.push({ on: e.effective_on, kind: "return_of_capital", amount: a });
      } else if (e.component === "preferred_return") {
        prefPaid += a;
        flows.push({ on: e.effective_on, kind: "pref_paid", amount: a });
      } else {
        profit += a;
      }
    } else if (e.entry_type === "income_allocation") {
      income += a;
    } else if (e.entry_type === "loss_allocation") {
      loss += a;
    }
  }
  const acc = wf.prefAccrual(
    flows, Number(inv.pref_rate || 0) / 100.0, asOf, inv.day_count || "act_365", inv.pref_compounding || "simple",
  );
  const commitment = Number(inv.commitment || 0);
  const r = wf.round2;
  return {
    investment_id: inv.id, partner_id: inv.partner_id, asset_id: inv.asset_id,
    position: inv.waterfall_position, ownership_pct: Number(inv.ownership_pct || 0),
    commitment: r(commitment), contributions: r(contributions), distributions: r(distributions),
    return_of_capital: r(roc), preferred_paid: r(prefPaid), profit_distributions: r(profit),
    income_allocated: r(income), loss_allocated: r(loss),
    unreturned_capital: r(acc.unreturned_capital), accrued_pref: r(acc.unpaid),
    pref_accrued_total: r(acc.accrued_total), unfunded: r(Math.max(0.0, commitment - contributions)),
    ending_balance: r(contributions + income - loss - distributions),
  };
}

const TOTAL_KEYS = [
  "commitment", "contributions", "distributions", "return_of_capital", "preferred_paid", "profit_distributions",
  "income_allocated", "loss_allocated", "unreturned_capital", "accrued_pref", "unfunded", "ending_balance",
] as const;

export async function accountSummaries(db: Db, invs: Investment[], asOf: string) {
  const entries = await entriesFor(db, invs.map((i) => i.id), asOf);
  const grouped = new Map<Id, CapitalAccountEntry[]>();
  for (const e of entries) {
    const list = grouped.get(e.investment_id) ?? [];
    list.push(e);
    grouped.set(e.investment_id, list);
  }
  const labels = await assetLabels(db, invs.map((i) => [i.asset_id, i.property_id]));
  const accounts = invs.map((inv) => {
    const s = summarizeAccount(inv, grouped.get(inv.id) ?? [], asOf);
    // Field order follows the AccountSummary model.
    return {
      investment_id: s.investment_id, partner_id: s.partner_id, asset_id: s.asset_id,
      asset_label: labels.get(inv.asset_id) ?? null, position: s.position, ownership_pct: s.ownership_pct,
      commitment: s.commitment, contributions: s.contributions, distributions: s.distributions,
      return_of_capital: s.return_of_capital, preferred_paid: s.preferred_paid,
      profit_distributions: s.profit_distributions, income_allocated: s.income_allocated,
      loss_allocated: s.loss_allocated, unreturned_capital: s.unreturned_capital, accrued_pref: s.accrued_pref,
      pref_accrued_total: s.pref_accrued_total, unfunded: s.unfunded, ending_balance: s.ending_balance,
    };
  });
  const totals = Object.fromEntries(
    TOTAL_KEYS.map((k) => [k, wf.round2(accounts.reduce((a, acc) => a + (acc as Record<string, any>)[k], 0))]),
  ) as Record<string, number>;
  return { accounts, totals };
}

export async function entryOuts(db: Db, entries: CapitalAccountEntry[]) {
  const ids = entries.map((e) => e.id);
  const reversedIds = new Set<string>();
  if (ids.length) {
    const rows = await db
      .select({ r: capitalAccountEntries.reverses_entry_id })
      .from(capitalAccountEntries)
      .where(inArray(capitalAccountEntries.reverses_entry_id, ids));
    for (const r of rows) if (r.r) reversedIds.add(r.r);
  }
  return entries.map((e) => ({
    ...pick(e, [
      "id", "partner_id", "investment_id", "asset_id", "event_id", "allocation_id", "entry_type", "component", "amount",
      "effective_on", "memo", "reverses_entry_id", "created_at", "created_by_id",
    ]),
    reversed: reversedIds.has(e.id),
  }));
}

export async function statement(db: Db, p: CapitalPartner, asOf: string) {
  const invs = await db
    .select()
    .from(investments)
    .where(and(eq(investments.partner_id, p.id), isNull(investments.deleted_at)));
  const { accounts, totals } = await accountSummaries(db, invs, asOf);
  const entries = await entriesFor(db, invs.map((i) => i.id), asOf);
  return { partner_id: p.id, as_of: asOf, accounts, totals, entries: await entryOuts(db, entries) };
}

function reversal(e: CapitalAccountEntry, reason: string, actor: CurrentUser) {
  const t = today();
  return {
    partner_id: e.partner_id, investment_id: e.investment_id, asset_id: e.asset_id, event_id: e.event_id,
    allocation_id: e.allocation_id, entry_type: e.entry_type, component: e.component,
    amount: -Number(e.amount || 0), effective_on: e.effective_on > t ? e.effective_on : t,
    memo: `Reversal: ${reason}`, reverses_entry_id: e.id, created_by_id: actor.id,
  };
}

export async function reverseEntry(db: Db, entryId: Id, reason: string, actor: CurrentUser): Promise<CapitalAccountEntry> {
  const e = await get(db, capitalAccountEntries, entryId);
  if (!e) throw new HttpError(404, "Entry not found");
  if (e.reverses_entry_id) throw new HttpError(409, "A reversing entry cannot itself be reversed; post a new entry instead");
  const [done] = await db
    .select({ id: capitalAccountEntries.id })
    .from(capitalAccountEntries)
    .where(eq(capitalAccountEntries.reverses_entry_id, e.id))
    .limit(1);
  if (done) throw new HttpError(409, "Entry has already been reversed");
  const rev = await insert(db, capitalAccountEntries, reversal(e, reason, actor) as never);
  if (e.entry_type === "contribution" && e.allocation_id) {
    const alloc = await get(db, capitalEventAllocations, e.allocation_id);
    if (alloc) {
      await patch(db, capitalEventAllocations, alloc, {
        funded_amount: wf.round2(Number(alloc.funded_amount || 0) - Number(e.amount || 0)),
      });
      await patch(db, capitalEventAllocations, alloc, { status: callStatus(alloc) });
    }
  }
  await refreshFunded(db, [e.investment_id]);
  await audit.record(db, {
    actor, action: "capital_entry.reversed", entity_type: "capital_partner", entity_id: e.partner_id,
    summary: `Reversed ${e.entry_type} ${money(Number(e.amount))}: ${reason}`,
    changes: { entry_id: { from: null, to: String(e.id) } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return rev;
}

/** Allocates period net income (or loss when negative) pro rata to ownership across active investments. */
export async function allocateIncome(db: Db, assetId: Id, data: IncomeAllocationIn, actor: CurrentUser): Promise<number> {
  const invs = await db
    .select()
    .from(investments)
    .where(and(eq(investments.asset_id, assetId), isNull(investments.deleted_at), eq(investments.status, "active")));
  if (!invs.length) throw new HttpError(422, "No active investments on this asset");
  if (!data.amount) throw new HttpError(422, "Amount must not be zero");
  const kind = data.amount > 0 ? "income_allocation" : "loss_allocation";
  const shares = wf.splitProRata(Math.abs(data.amount), Object.fromEntries(invs.map((i) => [String(i.id), Number(i.ownership_pct || 0)])));
  for (const inv of invs) {
    await insert(db, capitalAccountEntries, {
      partner_id: inv.partner_id, investment_id: inv.id, asset_id: assetId, entry_type: kind,
      amount: shares[String(inv.id)], effective_on: data.effective_on, memo: data.memo ?? null, created_by_id: actor.id,
    } as never);
  }
  await audit.record(db, {
    actor, action: `capital_account.${kind}`, entity_type: "asset", entity_id: assetId,
    summary: `${kind.split("_").map((w) => title(w)).join(" ")} ${money(Math.abs(data.amount))} as of ${data.effective_on}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return invs.length;
}

// =========================================================================== waterfalls

export async function getWaterfall(db: Db, waterfallId: Id): Promise<Waterfall> {
  const w = await get(db, waterfalls, waterfallId);
  if (!w || w.deleted_at) throw new HttpError(404, "Waterfall not found");
  return w;
}

export async function tiersOf(db: Db, waterfallId: Id): Promise<WaterfallTier[]> {
  return db.select().from(waterfallTiers).where(eq(waterfallTiers.waterfall_id, waterfallId)).orderBy(asc(waterfallTiers.position));
}

export async function waterfallOut(db: Db, w: Waterfall) {
  const tiers = (await tiersOf(db, w.id)).map((t) => ({
    position: t.position, name: t.name, tier_type: t.tier_type, hurdle_type: t.hurdle_type,
    hurdle_value: t.hurdle_value, lp_share: t.lp_share, gp_share: t.gp_share, catch_up_rate: t.catch_up_rate,
    catch_up_target: t.catch_up_target, id: t.id,
  }));
  return {
    id: w.id, name: w.name, asset_id: w.asset_id,
    asset_label: w.asset_id ? ((await assetLabels(db, [[w.asset_id, null]])).get(w.asset_id) ?? null) : null,
    description: w.description, version: w.version, is_active: w.is_active, tiers, updated_at: w.updated_at,
  };
}

function validateTiers(data: WaterfallIn): void {
  const positions = data.tiers.map((t) => t.position);
  if (new Set(positions).size !== positions.length) throw new HttpError(422, "Tier positions must be unique");
  for (const t of data.tiers) {
    if (t.tier_type === "split" && Math.abs(t.lp_share + t.gp_share - 1.0) > 1e-6) {
      throw new HttpError(422, `Tier ${t.position}: LP and GP shares must sum to 100%`);
    }
    if (t.tier_type === "split" && t.hurdle_type !== "none" && (t.hurdle_value === null || t.hurdle_value === undefined)) {
      throw new HttpError(422, `Tier ${t.position}: hurdle value is required`);
    }
    if (t.tier_type === "catch_up" && t.catch_up_rate <= t.catch_up_target) {
      throw new HttpError(422, `Tier ${t.position}: catch-up rate must exceed the GP target share`);
    }
  }
}

interface TierDict {
  position: number;
  name: string | null;
  tier_type: string;
  hurdle_type: string;
  hurdle_value: number | null;
  lp_share: number;
  gp_share: number;
  catch_up_rate: number;
  catch_up_target: number;
}

const tierDict = (t: Record<string, any>): TierDict => ({
  position: t.position, name: t.name ?? null, tier_type: t.tier_type, hurdle_type: t.hurdle_type,
  hurdle_value: t.hurdle_value ?? null, lp_share: t.lp_share, gp_share: t.gp_share, catch_up_rate: t.catch_up_rate,
  catch_up_target: t.catch_up_target,
});

export async function saveWaterfall(db: Db, wIn: Waterfall | null, data: WaterfallIn, actor: CurrentUser): Promise<Waterfall> {
  validateTiers(data);
  const header = {
    name: data.name, asset_id: data.asset_id ?? null, description: data.description ?? null, is_active: data.is_active,
  };
  const newTiers = [...data.tiers].sort((a, b) => a.position - b.position).map(tierDict);
  let w: Waterfall;
  let changes: Record<string, any>;
  let action: string;
  if (wIn === null) {
    w = await insert(db, waterfalls, { ...header, version: 1, created_by_id: actor.id, updated_by_id: actor.id } as never);
    changes = { tiers: { from: null, to: newTiers } };
    action = "waterfall.created";
  } else {
    w = wIn;
    const oldRows = await tiersOf(db, w.id);
    const oldTiers = oldRows.map(tierDict);
    changes = audit.diff(w, header);
    const set: Record<string, any> = { ...header };
    if (JSON.stringify(oldTiers) !== JSON.stringify(newTiers)) {
      changes.tiers = { from: oldTiers, to: newTiers };
      changes.version = { from: w.version, to: w.version + 1 };
      set.version = w.version + 1;
      await db.delete(waterfallTiers).where(eq(waterfallTiers.waterfall_id, w.id));
    }
    if (!Object.keys(changes).length) return w;
    set.updated_by_id = actor.id;
    await patch(db, waterfalls, w, set as never);
    action = "waterfall.updated";
  }
  if ("tiers" in changes) {
    for (const t of newTiers) await insert(db, waterfallTiers, { waterfall_id: w.id, ...t } as never);
  }
  await audit.record(db, {
    actor, action, entity_type: "waterfall", entity_id: w.id, summary: w.name, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return w;
}

// =========================================================================== capital events: calculation

export async function positionsFor(db: Db, assetId: Id, asOf: string): Promise<[Investment[], wf.PartnerPosition[]]> {
  const invs = await db
    .select()
    .from(investments)
    .where(and(eq(investments.asset_id, assetId), isNull(investments.deleted_at), eq(investments.status, "active")))
    .orderBy(asc(investments.created_at));
  if (!invs.length) return [[], []];
  const names = await partnerNames(db, invs.map((i) => i.partner_id));
  const grouped = new Map<Id, CapitalAccountEntry[]>();
  for (const e of await entriesFor(db, invs.map((i) => i.id), asOf)) {
    const list = grouped.get(e.investment_id) ?? [];
    list.push(e);
    grouped.set(e.investment_id, list);
  }
  const positions = invs.map((inv) => {
    const es = grouped.get(inv.id) ?? [];
    const s = summarizeAccount(inv, es, asOf);
    const flows: wf.CashFlow[] = es
      .filter((e) => e.entry_type === "contribution" || e.entry_type === "distribution")
      .map((e) => [e.effective_on, e.entry_type === "contribution" ? -Number(e.amount) : Number(e.amount)]);
    return wf.partnerPosition({
      investment_id: String(inv.id), partner_id: String(inv.partner_id), name: names.get(inv.partner_id) ?? "Partner",
      position: inv.waterfall_position || "lp", ownership_pct: Number(inv.ownership_pct || 0),
      commitment: s.commitment, contributed: s.contributions, unfunded: s.unfunded,
      unreturned_capital: s.unreturned_capital, pref_unpaid: s.accrued_pref, distributed_to_date: s.distributions,
      profit_to_date: s.preferred_paid + s.profit_distributions, cash_flows: flows,
    });
  });
  return [invs, positions];
}

export async function resolveWaterfall(db: Db, assetId: Id, waterfallId: Id | null | undefined, invs: Investment[]): Promise<Waterfall | null> {
  if (waterfallId) return getWaterfall(db, waterfallId);
  const linked = new Map<Id, number>();
  for (const i of invs) if (i.waterfall_id) linked.set(i.waterfall_id, (linked.get(i.waterfall_id) ?? 0) + 1);
  if (linked.size) {
    let best: Id | null = null;
    let bestN = 0;
    for (const [k, n] of linked) {
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return getWaterfall(db, best!);
  }
  const [w] = await db
    .select()
    .from(waterfalls)
    .where(and(eq(waterfalls.asset_id, assetId), eq(waterfalls.is_active, true), isNull(waterfalls.deleted_at)))
    .orderBy(desc(waterfalls.updated_at))
    .limit(1);
  return w ?? null;
}

/** Liquidation: net proceeds = gross − debt payoff − closing costs − reserves (when gross is given). */
export function eventAmount(eventType: string, amount: number | null | undefined, inputs: Record<string, any>): number {
  if (eventType === "liquidation" && inputs.gross_proceeds !== null && inputs.gross_proceeds !== undefined) {
    const net =
      Number(inputs.gross_proceeds) -
      ["debt_payoff", "closing_costs", "reserves"].reduce((a, k) => a + Number(inputs[k] || 0), 0);
    if (net < 0) throw new HttpError(422, "Net liquidation proceeds are negative");
    return wf.round2(net);
  }
  if (amount === null || amount === undefined || amount <= 0) throw new HttpError(422, "Amount is required");
  return wf.round2(amount);
}

/** model_dump(exclude_none=True) */
export const dumpInputs = (inputs: Record<string, any> | null | undefined): Record<string, any> =>
  Object.fromEntries(Object.entries(inputs ?? {}).filter(([, v]) => v !== null && v !== undefined));

export async function compute(db: Db, data: EventPreviewIn): Promise<[number, Record<string, any>, Waterfall | null]> {
  const inputs = dumpInputs(data.inputs);
  const amount = eventAmount(data.event_type, data.amount, inputs);
  const [invs, positions] = await positionsFor(db, data.asset_id, data.event_date);
  if (!positions.length) throw new HttpError(422, "No active investments on this asset");
  let w: Waterfall | null = null;
  let tiersCfg: TierDict[] = [];
  let result: Record<string, any>;
  if (data.event_type === "call") {
    result = wf.allocateCall(amount, positions);
  } else {
    w = await resolveWaterfall(db, data.asset_id, data.waterfall_id, invs);
    if (!w) throw new HttpError(422, "No waterfall is configured for this asset");
    tiersCfg = (await tiersOf(db, w.id)).map(tierDict);
    const tiers = tiersCfg.map((t) =>
      wf.tier({
        position: t.position, tier_type: t.tier_type, name: t.name || "", hurdle_type: t.hurdle_type,
        // IRR hurdles are stored in percent; multiples as x.
        hurdle_value: t.hurdle_type === "irr" && t.hurdle_value !== null ? t.hurdle_value / 100.0 : t.hurdle_value,
        lp_share: t.lp_share, gp_share: t.gp_share, catch_up_rate: t.catch_up_rate, catch_up_target: t.catch_up_target,
      }),
    );
    result = wf.runWaterfall(amount, data.event_date, positions, tiers);
  }
  const calc = {
    ...result,
    engine: "investors.waterfall/1",
    event_type: data.event_type,
    event_date: data.event_date,
    inputs,
    waterfall: w ? { id: String(w.id), name: w.name, version: w.version, tiers: tiersCfg } : null,
    positions: positions.map((p) => ({
      investment_id: p.investment_id, partner_id: p.partner_id, name: p.name, position: p.position,
      ownership_pct: p.ownership_pct, commitment: p.commitment, contributed: p.contributed, unfunded: p.unfunded,
      unreturned_capital: p.unreturned_capital, pref_unpaid: p.pref_unpaid, distributed_to_date: p.distributed_to_date,
    })),
    computed_at: utcnow().toISOString(),
  };
  return [amount, toJsonable(calc), w];
}

function fingerprint(calc: Record<string, any>): string {
  const rows: Array<[string, number]> = (calc.allocations ?? []).map((a: any) => [a.investment_id, a.amount]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return JSON.stringify(rows);
}

// =========================================================================== capital events: lifecycle

export interface EventFilters {
  q?: string;
  event_type?: string[];
  status?: string[];
  asset_id?: string;
}

export function buildEventWhere(f: EventFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = capitalEvents;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name]),
    skip.has("event_type") ? undefined : inFilter(t.event_type, f.event_type),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
  );
}

export async function getEvent(db: Db, eventId: Id): Promise<CapitalEvent> {
  const e = await get(db, capitalEvents, eventId);
  if (!e || e.deleted_at) throw new HttpError(404, "Capital event not found");
  return e;
}

export const EVENT_LIST_KEYS = [
  "id", "event_type", "name", "asset_id", "event_date", "due_on", "amount", "status", "version", "approved_version",
  "updated_at",
];

export function eventListItem(e: CapitalEvent, label: string | null | undefined) {
  const base = pick(e, EVENT_LIST_KEYS);
  return {
    id: base.id, event_type: base.event_type, name: base.name, asset_id: base.asset_id, asset_label: label ?? null,
    event_date: base.event_date, due_on: base.due_on, amount: base.amount, status: base.status, version: base.version,
    approved_version: base.approved_version, updated_at: base.updated_at,
  };
}

export async function eventOut(db: Db, e: CapitalEvent, user: CurrentUser) {
  const label = (await assetLabels(db, [[e.asset_id, e.property_id]])).get(e.asset_id) ?? null;
  const names = await userNames(db, [e.created_by_id, e.submitted_by_id, e.approved_by_id, e.posted_by_id, e.reversed_by_id]);
  return {
    ...eventListItem(e, label),
    ...pick(e, [
      "property_id", "waterfall_id", "waterfall_version", "inputs", "calc", "notes", "submitted_by_id", "submitted_at",
      "approved_by_id", "approved_at", "decision_note", "posted_by_id", "posted_at", "reversed_at", "reversal_reason",
      "created_by_id",
    ]),
    actor_names: Object.fromEntries(names),
    can_approve: user.can("investors", "approve") && (user.is_admin || e.submitted_by_id !== user.id) && e.status === "pending_approval",
  };
}

async function saveVersion(db: Db, e: CapitalEvent, actor: CurrentUser): Promise<void> {
  await insert(db, capitalEventVersions, {
    event_id: e.id, version: e.version, amount: e.amount, inputs: e.inputs, calc: e.calc, created_by_id: actor.id,
  } as never);
}

export async function createEvent(db: Db, data: EventCreate, actor: CurrentUser): Promise<CapitalEvent> {
  const [amount, calc, w] = await compute(db, data);
  const labels = await assetLabels(db, [[data.asset_id, null]]);
  const name = data.name || `${title(data.event_type)} · ${labels.get(data.asset_id)} · ${data.event_date}`;
  const row = await assetRow(db, data.asset_id);
  const e = await insert(db, capitalEvents, {
    event_type: data.event_type, name: name.slice(0, 200), asset_id: data.asset_id,
    property_id: row?.property_id ?? null, waterfall_id: w ? w.id : null, waterfall_version: w ? w.version : null,
    event_date: data.event_date,
    due_on: data.due_on || (data.event_type === "call" ? addDays(data.event_date, 10) : null),
    amount, inputs: dumpInputs(data.inputs), status: "draft", version: 1, calc, notes: data.notes ?? null,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await saveVersion(db, e, actor);
  await audit.record(db, {
    actor, action: "capital_event.created", entity_type: "capital_event", entity_id: e.id,
    summary: `${e.name} — ${money(amount)} (calc v1)`, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export async function recalculate(db: Db, e: CapitalEvent, data: EventUpdate | null, actor: CurrentUser): Promise<CapitalEvent> {
  if (e.status !== "draft" && e.status !== "rejected") {
    throw new HttpError(409, "Only draft or rejected events can be changed; approved calculations are locked");
  }
  const values: Record<string, any> = data ? compact(data) : {};
  const inputs = values.inputs !== undefined && values.inputs !== null ? values.inputs : e.inputs;
  const has = (k: string) => k in values;
  const preview = parse(eventPreviewIn, {
    event_type: e.event_type, asset_id: e.asset_id, amount: has("amount") ? values.amount : e.amount,
    event_date: has("event_date") ? values.event_date : e.event_date, due_on: has("due_on") ? values.due_on : e.due_on,
    waterfall_id: has("waterfall_id") ? values.waterfall_id : e.waterfall_id, inputs: inputs || {},
  });
  const [amount, calc, w] = await compute(db, preview);
  const before: Record<string, any> = { amount: e.amount, version: e.version, event_date: e.event_date, due_on: e.due_on };
  const set: Record<string, any> = {
    amount, calc, event_date: preview.event_date, due_on: preview.due_on ?? null, inputs: dumpInputs(preview.inputs),
    waterfall_id: w ? w.id : null, waterfall_version: w ? w.version : null,
  };
  if (has("name") && values.name) set.name = values.name;
  if (has("notes")) set.notes = values.notes;
  set.version = e.version + 1;
  set.status = "draft";
  set.updated_by_id = actor.id;
  await patch(db, capitalEvents, e, set as never);
  await saveVersion(db, e, actor);
  const after: Record<string, any> = { amount: e.amount, version: e.version, event_date: e.event_date, due_on: e.due_on };
  const changes: Record<string, any> = {};
  for (const k of Object.keys(before)) {
    if (before[k] !== after[k]) changes[k] = { from: toJsonable(before[k]), to: toJsonable(after[k]) };
  }
  await audit.record(db, {
    actor, action: "capital_event.recalculated", entity_type: "capital_event", entity_id: e.id,
    summary: `Calculation v${e.version}`, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

/** The stored calc must still match the ledger + config; otherwise it must be recalculated and re-approved. */
async function assertCurrent(db: Db, e: CapitalEvent): Promise<void> {
  const preview = parse(eventPreviewIn, {
    event_type: e.event_type, asset_id: e.asset_id, amount: e.amount, event_date: e.event_date, due_on: e.due_on,
    waterfall_id: e.waterfall_id, inputs: e.inputs || {},
  });
  const [, calc, w] = await compute(db, preview);
  if (fingerprint(calc) !== fingerprint(e.calc || {}) || (w && w.version !== e.waterfall_version)) {
    throw new HttpError(
      409,
      "Capital accounts or the waterfall changed since this calculation. " +
        "Return it to draft, recalculate and route it for approval again.",
    );
  }
}

export async function submitEvent(db: Db, e: CapitalEvent, actor: CurrentUser): Promise<CapitalEvent> {
  if (e.status !== "draft" && e.status !== "rejected") throw new HttpError(409, "Only draft events can be submitted");
  await patch(db, capitalEvents, e, {
    status: "pending_approval", submitted_by_id: actor.id, submitted_at: utcnow(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "capital_event.submitted", entity_type: "capital_event", entity_id: e.id,
    summary: `Submitted calc v${e.version} for approval`, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export async function decideEvent(db: Db, e: CapitalEvent, approve: boolean, note: string | null | undefined, actor: CurrentUser): Promise<CapitalEvent> {
  if (e.status !== "pending_approval") throw new HttpError(409, "Event is not awaiting approval");
  const set: Record<string, any> = {};
  if (approve) {
    if (e.submitted_by_id === actor.id && !actor.is_admin) {
      throw new HttpError(403, "A different person must approve a capital event they submitted");
    }
    checkCapitalLimit(actor, Number(e.amount));
    await assertCurrent(db, e);
    Object.assign(set, { status: "approved", approved_by_id: actor.id, approved_at: utcnow(), approved_version: e.version });
  } else {
    set.status = "rejected";
  }
  set.decision_note = note ?? null;
  set.updated_by_id = actor.id;
  await patch(db, capitalEvents, e, set as never);
  await audit.record(db, {
    actor, action: `capital_event.${approve ? "approved" : "rejected"}`, entity_type: "capital_event", entity_id: e.id,
    summary: `Calc v${e.version}${note ? `: ${note}` : ""}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export function renderCallNotice(e: CapitalEvent, a: Record<string, any>, assetLabel: string): string {
  const inp = e.inputs || {};
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: Array<string | null> = [
    "CAPITAL CALL NOTICE",
    "",
    `Notice date: ${longDate(e.event_date)}`,
    `To: ${a.name}`,
    `Investment: ${assetLabel}`,
    "",
    "Pursuant to the governing agreement, a capital contribution is requested as follows:",
    `  ${pad("Total capital call:", 36)}$${money(Number(e.amount))}`,
    `  ${pad("Your capital commitment:", 36)}$${money(Number(a.commitment || 0))}`,
    `  ${pad("Your ownership:", 36)}${Number(Number(a.ownership_pct || 0).toPrecision(4))}%`,
    `  ${pad("Unfunded commitment before call:", 36)}$${money(Number(a.unfunded_before || 0))}`,
    `  ${pad("Amount due from you:", 36)}$${money(Number(a.amount))}`,
    e.due_on ? `  ${pad("Due date:", 36)}${longDate(e.due_on)}` : "",
  ];
  if (inp.purpose) lines.push("", `Purpose: ${inp.purpose}`);
  if (inp.wire_instructions) lines.push("", "Wire instructions:", String(inp.wire_instructions));
  const rate = inp.default_rate;
  const grace = inp.grace_days ?? DEFAULT_GRACE_DAYS;
  const penalty = inp.penalty_pct;
  const terms: string[] = [];
  if (rate) terms.push(`amounts not received by the due date accrue interest at ${pyFloat(rate)}% per annum`);
  terms.push(
    `amounts outstanding more than ${grace} days after the due date may be treated as a default ` +
      "under the default provisions of the agreement",
  );
  if (penalty) terms.push(`a defaulting partner may be subject to a penalty of ${pyFloat(penalty)}% of the unfunded amount`);
  lines.push("", `Late payment: ${terms.join("; ")}.`, "", `Reference: ${e.name}`);
  return lines.filter((x) => x !== null).join("\n");
}

export async function postEvent(db: Db, e: CapitalEvent, actor: CurrentUser): Promise<CapitalEvent> {
  if (e.status !== "approved") throw new HttpError(409, "Only approved events can be posted");
  if (e.approved_version !== e.version) throw new HttpError(409, "The approved calculation version is not the current version");
  await assertCurrent(db, e);
  const label = (await assetLabels(db, [[e.asset_id, e.property_id]])).get(e.asset_id) ?? "";
  const touched = new Set<Id>();
  for (const a of (e.calc?.allocations ?? []) as any[]) {
    const amount = Number(a.amount);
    if (amount <= 0) continue;
    const invId: Id = a.investment_id;
    const partnerId: Id = a.partner_id;
    const alloc = await insert(db, capitalEventAllocations, {
      event_id: e.id, partner_id: partnerId, investment_id: invId, event_type: e.event_type, amount,
      tiers: a.tiers ?? [], due_on: e.due_on, created_by_id: actor.id, updated_by_id: actor.id,
      status: e.event_type === "call" ? "pending" : "paid",
      paid_on: e.event_type === "call" ? null : e.event_date,
      notice_text: e.event_type === "call" ? renderCallNotice(e, a, label) : null,
    } as never);
    if (e.event_type !== "call") {
      for (const t of (a.tiers ?? []) as any[]) {
        if (Number(t.amount) === 0) continue;
        await insert(db, capitalAccountEntries, {
          partner_id: partnerId, investment_id: invId, asset_id: e.asset_id, event_id: e.id, allocation_id: alloc.id,
          entry_type: "distribution", component: t.component ?? null, amount: Number(t.amount),
          effective_on: e.event_date, memo: `${e.name} — ${t.name}`, created_by_id: actor.id,
        } as never);
      }
    }
    touched.add(invId);
  }
  if (e.event_type === "liquidation") {
    const exitProv = provenance.provenanceIn.parse({
      source: `Liquidation ${e.name}`, observed_on: e.event_date, confidence: 1, verified: true,
    });
    for (const invId of touched) {
      const inv = await get(db, investments, invId);
      if (inv && inv.status !== "exited") {
        await provenance.applyMaterial(db, inv, {
          entity_type: "investment", data: { status: "exited" }, material_fields: INVESTMENT_MATERIAL, prov: exitProv,
          actor_id: actor.id,
        });
        await patch(db, investments, inv, { status: "exited" });
      }
    }
  }
  if (e.event_type === "call" && e.due_on) {
    await createTask(db, {
      title: `Confirm funding: ${e.name}`, assignee_id: e.created_by_id || actor.id,
      due_at: new Date(`${e.due_on}T17:00:00Z`), task_type: "follow_up",
      description: "Confirm receipt of each partner's capital call.", related_type: "capital_event", related_id: e.id,
      related_label: e.name, source: "automation", idempotency_key: `capital_call_funding:${e.id}`, actor_id: actor.id,
    });
  }
  await patch(db, capitalEvents, e, { status: "posted", posted_by_id: actor.id, posted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "capital_event.posted", entity_type: "capital_event", entity_id: e.id,
    summary: `Posted calc v${e.version} — ${money(Number(e.amount))}`, ip_address: actor.ip_address,
  });
  await events.emit(db, "capital_event.posted", {
    capital_event_id: e.id, asset_id: e.asset_id, event_type: e.event_type, actor,
  });
  await db.commit();
  return e;
}

export async function reverseEvent(db: Db, e: CapitalEvent, reason: string, actor: CurrentUser): Promise<CapitalEvent> {
  if (e.status !== "posted") throw new HttpError(409, "Only posted events can be reversed");
  const entries = await db
    .select()
    .from(capitalAccountEntries)
    .where(and(eq(capitalAccountEntries.event_id, e.id), isNull(capitalAccountEntries.reverses_entry_id)));
  const already = new Set<string>();
  if (entries.length) {
    const rows = await db
      .select({ r: capitalAccountEntries.reverses_entry_id })
      .from(capitalAccountEntries)
      .where(inArray(capitalAccountEntries.reverses_entry_id, entries.map((x) => x.id)));
    for (const r of rows) if (r.r) already.add(r.r);
  }
  const touched = new Set<Id>();
  for (const x of entries) {
    if (!already.has(x.id)) {
      await insert(db, capitalAccountEntries, reversal(x, reason, actor) as never);
      touched.add(x.investment_id);
    }
  }
  await db
    .update(capitalEventAllocations)
    .set({ status: "reversed", updated_by_id: actor.id })
    .where(eq(capitalEventAllocations.event_id, e.id));
  await refreshFunded(db, touched);
  await patch(db, capitalEvents, e, {
    status: "reversed", reversed_by_id: actor.id, reversed_at: utcnow(), reversal_reason: reason, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "capital_event.reversed", entity_type: "capital_event", entity_id: e.id, summary: reason,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

// =========================================================================== calls: funding & defaults

type CallLike = Pick<CapitalEventAllocation, "funded_amount" | "amount" | "due_on" | "default_flag">;

export function callStatus(a: CallLike, asOf?: string, grace = DEFAULT_GRACE_DAYS): string {
  const funded = Number(a.funded_amount || 0);
  const amount = Number(a.amount || 0);
  if (funded >= amount - 0.005) return "funded";
  const on = asOf ?? today();
  if (a.due_on && on > a.due_on) {
    return wf.daysBetween(a.due_on, on) > grace || a.default_flag ? "default" : "late";
  }
  return funded > 0 ? "partial" : "pending";
}

export async function allocationOuts(db: Db, rows: CapitalEventAllocation[], asOfIn?: string) {
  const asOf = asOfIn ?? today();
  const evs = new Map<Id, CapitalEvent>();
  if (rows.length) {
    const evRows = await db
      .select()
      .from(capitalEvents)
      .where(inArray(capitalEvents.id, [...new Set(rows.map((r) => r.event_id))]));
    for (const e of evRows) evs.set(e.id, e);
  }
  const pnames = await partnerNames(db, rows.map((r) => r.partner_id));
  const labels = await assetLabels(db, [...evs.values()].map((e) => [e.asset_id, e.property_id]));
  return rows.map((r) => {
    const ev = evs.get(r.event_id);
    let days_late = 0;
    let accrued_late_interest = 0;
    if (r.event_type === "call" && ["pending", "partial", "late", "default"].includes(r.status) && r.due_on && asOf > r.due_on) {
      const rate = ev ? Number((ev.inputs ?? {}).default_rate || 0) / 100.0 : 0.0;
      days_late = wf.daysBetween(r.due_on, asOf);
      accrued_late_interest = wf.lateInterest(Number(r.amount) - Number(r.funded_amount || 0), rate, r.due_on, asOf);
    }
    return {
      ...pick(r, [
        "id", "event_id", "partner_id", "investment_id", "event_type", "amount", "tiers", "status", "due_on",
        "funded_amount", "funded_on", "late_interest", "penalty_flag", "default_flag", "notice_text", "paid_on",
        "payment_reference",
      ]),
      partner_name: pnames.get(r.partner_id) ?? null,
      event_name: ev ? ev.name : null,
      event_date: ev ? ev.event_date : null,
      asset_label: ev ? (labels.get(ev.asset_id) ?? null) : null,
      days_late,
      accrued_late_interest,
    };
  });
}

export async function getAllocation(db: Db, allocId: Id, user: CurrentUser): Promise<CapitalEventAllocation> {
  const a = await get(db, capitalEventAllocations, allocId);
  const ids = await scopeIds(db, user);
  if (!a || a.deleted_at || (ids !== null && !ids.includes(a.partner_id))) throw new HttpError(404, "Allocation not found");
  return a;
}

export async function fundCall(db: Db, a: CapitalEventAllocation, data: FundIn, actor: CurrentUser): Promise<CapitalEventAllocation> {
  if (a.event_type !== "call" || a.status === "reversed") throw new HttpError(409, "Only open capital call items can be funded");
  const outstanding = wf.round2(Number(a.amount) - Number(a.funded_amount || 0));
  if (data.amount > outstanding + 0.005) {
    throw new HttpError(422, `Amount exceeds the outstanding call balance of ${money(outstanding)}`);
  }
  const e = await getEvent(db, a.event_id);
  await insert(db, capitalAccountEntries, {
    partner_id: a.partner_id, investment_id: a.investment_id, asset_id: e.asset_id, event_id: e.id, allocation_id: a.id,
    entry_type: "contribution", amount: data.amount, effective_on: data.funded_on,
    memo: `${e.name}${data.reference ? ` — ref ${data.reference}` : ""}`, created_by_id: actor.id,
  } as never);
  const before: Record<string, any> = { funded_amount: a.funded_amount, status: a.status };
  const set: Record<string, any> = {
    funded_amount: wf.round2(Number(a.funded_amount || 0) + data.amount), funded_on: data.funded_on,
  };
  if (data.reference) set.payment_reference = data.reference;
  const inputs = e.inputs ?? {};
  const grace = Math.trunc(Number(inputs.grace_days ?? DEFAULT_GRACE_DAYS));
  if (a.due_on && data.funded_on > a.due_on) {
    const rate = Number(inputs.default_rate || 0) / 100.0;
    set.late_interest = wf.round2(Number(a.late_interest || 0) + wf.lateInterest(data.amount, rate, a.due_on, data.funded_on));
    if (wf.daysBetween(a.due_on, data.funded_on) > grace && inputs.penalty_pct) {
      set.penalty_flag = true;
    }
  }
  set.status = callStatus({ ...a, funded_amount: set.funded_amount }, data.funded_on, grace);
  set.updated_by_id = actor.id;
  await patch(db, capitalEventAllocations, a, set as never);
  await refreshFunded(db, [a.investment_id]);
  await audit.record(db, {
    actor, action: "capital_call.funded", entity_type: "capital_event", entity_id: e.id,
    summary: `Funding ${money(data.amount)} received on ${data.funded_on}`,
    changes: Object.fromEntries(
      Object.entries(before).map(([k, v]) => [k, { from: toJsonable(v), to: toJsonable((a as Record<string, any>)[k]) }]),
    ),
    ip_address: actor.ip_address,
  });
  await db.commit();
  return a;
}

export async function markDefault(
  db: Db, a: CapitalEventAllocation, defaultFlag: boolean, penaltyFlag: boolean | null | undefined,
  note: string | null | undefined, actor: CurrentUser,
): Promise<CapitalEventAllocation> {
  if (a.event_type !== "call" || a.status === "funded" || a.status === "reversed") {
    throw new HttpError(409, "Only unfunded capital call items can be placed in or out of default");
  }
  const before: Record<string, any> = { default_flag: a.default_flag, penalty_flag: a.penalty_flag, status: a.status };
  const set: Record<string, any> = { default_flag: defaultFlag };
  if (penaltyFlag !== null && penaltyFlag !== undefined) set.penalty_flag = penaltyFlag;
  set.status = defaultFlag ? "default" : callStatus({ ...a, default_flag: defaultFlag }, undefined, 10_000);
  set.updated_by_id = actor.id;
  await patch(db, capitalEventAllocations, a, set as never);
  const changes: Record<string, any> = {};
  for (const [k, v] of Object.entries(before)) {
    const now = (a as Record<string, any>)[k];
    if (v !== now) changes[k] = { from: v, to: now };
  }
  await audit.record(db, {
    actor, action: "capital_call.default_updated", entity_type: "capital_event", entity_id: a.event_id, summary: note,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return a;
}

/** Default provisions sweep: accrues late interest and flags late/default call items; raises alerts. */
export async function runDefaults(db: Db, asOf: string) {
  const t = capitalEventAllocations;
  const rows = await db
    .select()
    .from(t)
    .where(and(
      eq(t.event_type, "call"), isNull(t.deleted_at), inArray(t.status, ["pending", "partial", "late"]), lt(t.due_on, asOf),
    ));
  let late = 0;
  let defaulted = 0;
  for (const a of rows) {
    const e = await get(db, capitalEvents, a.event_id);
    if (!e || e.status !== "posted") continue;
    const inputs = e.inputs ?? {};
    const grace = Math.trunc(Number(inputs.grace_days ?? DEFAULT_GRACE_DAYS));
    const shortfall = Number(a.amount) - Number(a.funded_amount || 0);
    const set: Record<string, any> = {
      late_interest: wf.lateInterest(shortfall, Number(inputs.default_rate || 0) / 100.0, a.due_on!, asOf),
    };
    const newStatus = callStatus(a, asOf, grace);
    if (newStatus === "default") {
      set.default_flag = true;
      set.penalty_flag = Boolean(inputs.penalty_pct);
      defaulted += 1;
    } else if (newStatus === "late") {
      late += 1;
    }
    const statusChanged = newStatus !== a.status;
    if (statusChanged) set.status = newStatus;
    await patch(db, t, a, set as never);
    if (statusChanged) {
      const partner = await get(db, capitalPartners, a.partner_id);
      await raiseAlert(db, {
        title: `Capital call ${newStatus}: ${partner ? partner.name : "partner"}`,
        reason: `${money(shortfall)} outstanding on ${e.name}, due ${a.due_on}.`,
        severity: newStatus === "default" ? "high" : "medium",
        owner_id: (partner ? partner.owner_id : null) || e.created_by_id,
        related_type: "capital_event", related_id: e.id, related_label: e.name, rule_key: "capital_call_default",
        idempotency_key: `capital_call:${a.id}:${newStatus}`,
      });
    }
  }
  await db.commit();
  return { checked: rows.length, late, default: defaulted };
}

// =========================================================================== reporting packages

export function addMonths(d: string, months: number): string {
  const total = Number(d.slice(5, 7)) - 1 + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const year = Number(d.slice(0, 4)) + y;
  const month = m + 1;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (const day of [Number(d.slice(8, 10)), 30, 29, 28]) {
    if (day <= dim) return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-28`;
}

const FREQ_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };

async function verifiedPropertyFacts(db: Db, propertyId: Id | null | undefined, excluded: any[]): Promise<Record<string, any>> {
  if (!propertyId) return {};
  const facts: Record<string, any> = {};
  const wanted = new Set(["occupancy_pct", "building_area_sf", "noi", "wale_years", "land_area_acres"]);
  for (const [field, obs] of Object.entries(await provenance.currentObservations(db, "property", propertyId))) {
    if (!wanted.has(field)) continue;
    if (obs.verification === "verified") {
      facts[field] = { value: obs.value, source: obs.source, observed_on: toJsonable(obs.observed_on) };
    } else {
      excluded.push({
        section: "property_performance", item: field, property_id: String(propertyId), reason: `${obs.verification} fact omitted`,
      });
    }
  }
  return facts;
}

async function performance(db: Db, invs: Investment[], start: string, end: string, labels: Map<Id, string>, excluded: any[]) {
  const out: any[] = [];
  for (const inv of invs) {
    const entry: Record<string, any> = {
      asset_id: String(inv.asset_id), asset: labels.get(inv.asset_id) ?? null,
      facts: await verifiedPropertyFacts(db, inv.property_id, excluded),
    };
    const rows = await raw<{ category: string; source: string | null; amount: number | string; verified: boolean | null }>(
      db,
      sql`select category, source, amount, verified from asset_financials
          where asset_id = ${inv.asset_id} and period >= ${start} and period <= ${end}
            and is_current is true and deleted_at is null`,
    );
    const totals: Record<string, number> = {};
    let skipped = 0;
    for (const r of rows) {
      // Only verified actuals: unverified rows and plan/estimate sources are left out.
      if (r.verified !== true || (r.source && UNVERIFIED_SOURCES.has(String(r.source).toLowerCase()))) {
        skipped += 1;
        continue;
      }
      totals[String(r.category)] = (totals[String(r.category)] ?? 0) + Number(r.amount || 0);
    }
    if (skipped) {
      excluded.push({
        section: "property_performance", item: "asset_financials", asset_id: String(inv.asset_id),
        reason: `${skipped} unverified or non-actual rows omitted`,
      });
    }
    const income = totals.income ?? 0.0;
    const expense = totals.expense ?? 0.0;
    entry.financials = {
      ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, wf.round2(v)])),
      noi: wf.round2(income - expense),
    };
    out.push(entry);
  }
  return out;
}

async function valuations(db: Db, invs: Investment[], labels: Map<Id, string>, excluded: any[]) {
  const out: any[] = [];
  for (const inv of invs) {
    const v = inv.property_id ? await latestValue(db, inv.property_id) : null;
    if (!v || v.value_point === null || v.value_point === undefined) {
      excluded.push({
        section: "valuation", item: labels.get(inv.asset_id) ?? null, asset_id: String(inv.asset_id),
        reason: "no approved valuation on record",
      });
      continue;
    }
    out.push({
      asset_id: String(inv.asset_id), asset: labels.get(inv.asset_id) ?? null, ...toJsonable(v),
      ownership_pct: inv.ownership_pct,
      gross_value_share: wf.round2((Number(v.value_point) * Number(inv.ownership_pct || 0)) / 100.0),
    });
  }
  return out;
}

export async function buildPackage(
  db: Db, partner: CapitalPartner, assetId: Id | null | undefined, start: string, end: string, types: string[],
  titleIn: string | null | undefined, actor: CurrentUser | null, scheduleId: Id | null = null,
): Promise<ReportPackage | null> {
  const invs = await db
    .select()
    .from(investments)
    .where(and(
      eq(investments.partner_id, partner.id), isNull(investments.deleted_at),
      assetId ? eq(investments.asset_id, assetId) : undefined,
    ));
  if (!invs.length) return null;
  const labels = await assetLabels(db, invs.map((i) => [i.asset_id, i.property_id]));
  const excluded: any[] = [];
  const sections: Record<string, any> = {};
  if (types.includes("capital_accounts")) {
    const { accounts, totals } = await accountSummaries(db, invs, end);
    sections.capital_accounts = { as_of: end, accounts: toJsonable(accounts), totals };
  }
  if (types.includes("distributions")) {
    const found = await db
      .select({ a: capitalEventAllocations })
      .from(capitalEventAllocations)
      .innerJoin(capitalEvents, eq(capitalEvents.id, capitalEventAllocations.event_id))
      .where(and(
        eq(capitalEventAllocations.partner_id, partner.id),
        inArray(capitalEventAllocations.investment_id, invs.map((i) => i.id)),
        inArray(capitalEventAllocations.event_type, ["distribution", "liquidation"]),
        eq(capitalEventAllocations.status, "paid"), eq(capitalEvents.status, "posted"),
        gte(capitalEvents.event_date, start), lte(capitalEvents.event_date, end),
      ));
    const outs = await allocationOuts(db, found.map((r) => r.a));
    sections.distributions = {
      items: outs.map((o) => ({
        event: o.event_name, date: toJsonable(o.event_date), asset: o.asset_label, type: o.event_type, amount: o.amount,
        tiers: o.tiers,
      })),
      total: wf.round2(outs.reduce((a, o) => a + Number(o.amount), 0)),
    };
  }
  if (types.includes("portfolio")) {
    const items: any[] = [];
    for (const o of await investmentOuts(db, invs)) {
      const row = await assetRow(db, o.asset_id);
      items.push({
        asset: o.asset_label, asset_status: row?.status ?? null, commitment: o.commitment, funded: o.funded,
        unfunded: o.unfunded, ownership_pct: o.ownership_pct, position: o.waterfall_position, status: o.status,
      });
    }
    sections.portfolio = {
      investments: items,
      totals: Object.fromEntries(
        ["commitment", "funded", "unfunded"].map((k) => [k, wf.round2(items.reduce((a, i) => a + Number(i[k] || 0), 0))]),
      ),
    };
  }
  if (types.includes("valuation")) sections.valuation = { items: await valuations(db, invs, labels, excluded) };
  if (types.includes("property_performance")) {
    sections.property_performance = { assets: await performance(db, invs, start, end, labels, excluded) };
  }
  const pkg = await insert(db, reportPackages, {
    partner_id: partner.id, asset_id: assetId ?? null, schedule_id: scheduleId,
    title: (titleIn || `${partner.name} — ${shortDate(start)} to ${shortDate(end)}`).slice(0, 200),
    package_types: types, period_start: start, period_end: end, status: "generated",
    snapshot: {
      partner: { id: String(partner.id), name: partner.name },
      period: { start, end },
      generated_at: utcnow().toISOString(),
      data_policy:
        "Posted capital-account entries, approved valuations, verified property facts and recorded financial actuals only.",
      sections: toJsonable(sections),
    },
    excluded, generated_at: utcnow(), created_by_id: actor ? actor.id : null, updated_by_id: actor ? actor.id : null,
  } as never);
  await audit.record(db, {
    actor, action: "report_package.generated", entity_type: "capital_partner", entity_id: partner.id, summary: pkg.title,
    ip_address: actor ? actor.ip_address : null,
  });
  return pkg;
}

export async function generatePackages(db: Db, data: PackageCreate, actor: CurrentUser): Promise<ReportPackage[]> {
  if (data.period_end < data.period_start) throw new HttpError(422, "Period end must be on or after period start");
  let partners: CapitalPartner[];
  if (data.partner_id) {
    partners = [await getPartner(db, data.partner_id, actor)];
  } else {
    partners = await db
      .select()
      .from(capitalPartners)
      .where(and(
        isNull(capitalPartners.deleted_at), eq(capitalPartners.status, "active"),
        data.asset_id
          ? sql`${capitalPartners.id} in (select partner_id from investments where asset_id = ${data.asset_id} and deleted_at is null)`
          : undefined,
      ));
  }
  const out: ReportPackage[] = [];
  for (const p of partners) {
    const pkg = await buildPackage(db, p, data.asset_id, data.period_start, data.period_end, [...data.package_types], data.title, actor);
    if (pkg) out.push(pkg);
  }
  if (!out.length) throw new HttpError(422, "No partner investments match this request");
  await db.commit();
  return out;
}

export async function issuePackage(db: Db, pkg: ReportPackage, actor: CurrentUser): Promise<ReportPackage> {
  if (pkg.status === "issued") return pkg;
  await patch(db, reportPackages, pkg, { status: "issued", issued_at: utcnow(), issued_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "report_package.issued", entity_type: "capital_partner", entity_id: pkg.partner_id, summary: pkg.title,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return pkg;
}

export async function packageItems(db: Db, rows: ReportPackage[]) {
  const names = await partnerNames(db, rows.map((r) => r.partner_id));
  return rows.map((r) => ({
    id: r.id, partner_id: r.partner_id, partner_name: names.get(r.partner_id) ?? null, asset_id: r.asset_id,
    schedule_id: r.schedule_id, title: r.title, package_types: r.package_types, period_start: r.period_start,
    period_end: r.period_end, status: r.status, generated_at: r.generated_at, issued_at: r.issued_at,
  }));
}

export async function scheduleOut(db: Db, s: ReportSchedule) {
  const names = s.partner_id ? await partnerNames(db, [s.partner_id]) : new Map<Id, string>();
  return {
    id: s.id, name: s.name, partner_id: s.partner_id, partner_name: s.partner_id ? (names.get(s.partner_id) ?? null) : null,
    asset_id: s.asset_id, package_types: s.package_types, frequency: s.frequency, next_run_on: s.next_run_on,
    is_active: s.is_active, auto_issue: s.auto_issue, last_run_at: s.last_run_at,
  };
}

export async function saveSchedule(
  db: Db, sIn: ReportSchedule | null, data: ScheduleIn | ScheduleUpdate, actor: CurrentUser,
): Promise<ReportSchedule> {
  let s: ReportSchedule;
  let changes: Record<string, any> | null;
  if (sIn === null) {
    const d = data as ScheduleIn;
    s = await insert(db, reportSchedules, {
      name: d.name, partner_id: d.partner_id ?? null, asset_id: d.asset_id ?? null, package_types: d.package_types,
      frequency: d.frequency, next_run_on: d.next_run_on, is_active: d.is_active, auto_issue: d.auto_issue,
      created_by_id: actor.id, updated_by_id: actor.id,
    } as never);
    changes = null;
  } else {
    s = sIn;
    const values = compact(data);
    changes = audit.diff(s, values);
    if (!Object.keys(changes).length) return s;
    await patch(db, reportSchedules, s, { ...values, updated_by_id: actor.id } as never);
  }
  await audit.record(db, {
    actor, action: "report_schedule.saved", entity_type: "report_schedule", entity_id: s.id, summary: s.name, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return s;
}

export async function runDueSchedules(db: Db, asOf: string, actor: CurrentUser) {
  const schedules = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.is_active, true), isNull(reportSchedules.deleted_at), lte(reportSchedules.next_run_on, asOf)));
  let generated = 0;
  for (const s of schedules) {
    const months = FREQ_MONTHS[s.frequency] ?? 3;
    let nextRun = s.next_run_on;
    for (let i = 0; i < 12; i++) { // catch up missed periods, bounded
      if (nextRun > asOf) break;
      const end = addDays(nextRun, -1);
      const start = addMonths(nextRun, -months);
      let partners: CapitalPartner[];
      if (s.partner_id) {
        const p = await get(db, capitalPartners, s.partner_id);
        partners = p && !p.deleted_at ? [p] : [];
      } else {
        partners = await db
          .select()
          .from(capitalPartners)
          .where(and(
            isNull(capitalPartners.deleted_at), eq(capitalPartners.status, "active"),
            s.asset_id
              ? sql`${capitalPartners.id} in (select partner_id from investments where asset_id = ${s.asset_id} and deleted_at is null)`
              : undefined,
          ));
      }
      for (const p of partners) {
        const pkg = await buildPackage(db, p, s.asset_id, start, end, [...s.package_types], null, actor, s.id);
        if (pkg) {
          generated += 1;
          if (s.auto_issue) await patch(db, reportPackages, pkg, { status: "issued", issued_at: utcnow(), issued_by_id: actor.id });
        }
      }
      nextRun = addMonths(nextRun, months);
    }
    await patch(db, reportSchedules, s, { next_run_on: nextRun, last_run_at: utcnow() });
  }
  await db.commit();
  return { schedules: schedules.length, packages: generated };
}

// =========================================================================== portal

/** Everything a capital partner may see — strictly limited to partners where portal_user_id = user.id. */
export async function portal(db: Db, user: CurrentUser) {
  let ids = await scopeIds(db, user);
  if (ids === null) {
    ids = (
      await db
        .select({ id: capitalPartners.id })
        .from(capitalPartners)
        .where(and(eq(capitalPartners.portal_user_id, user.id), isNull(capitalPartners.deleted_at)))
    ).map((r) => r.id);
  }
  const partners = ids.length ? await db.select().from(capitalPartners).where(inArray(capitalPartners.id, ids)) : [];
  const invs = ids.length
    ? await db.select().from(investments).where(and(inArray(investments.partner_id, ids), isNull(investments.deleted_at)))
    : [];
  const { accounts, totals } = await accountSummaries(db, invs, today());
  const allocs = ids.length
    ? (
        await db
          .select({ a: capitalEventAllocations })
          .from(capitalEventAllocations)
          .innerJoin(capitalEvents, eq(capitalEvents.id, capitalEventAllocations.event_id))
          .where(and(
            inArray(capitalEventAllocations.partner_id, ids), isNull(capitalEventAllocations.deleted_at),
            eq(capitalEvents.status, "posted"),
          ))
          .orderBy(desc(capitalEvents.event_date))
      ).map((r) => r.a)
    : [];
  const outs = await allocationOuts(db, allocs);
  const packages = ids.length
    ? await db
        .select()
        .from(reportPackages)
        .where(and(inArray(reportPackages.partner_id, ids), eq(reportPackages.status, "issued"), isNull(reportPackages.deleted_at)))
        .orderBy(desc(reportPackages.period_end))
    : [];
  const docs: Record<string, any>[] = [];
  const targets: Array<[string, Id]> = [
    ...ids.map((i): [string, Id] => ["capital_partner", i]),
    ...invs.map((i): [string, Id] => ["investment", i.id]),
    ...packages.map((p): [string, Id] => ["report_package", p.id]),
    ...allocs.map((a): [string, Id] => ["capital_event_allocation", a.id]),
  ];
  if (targets.length) {
    const conds = targets.map(([t, i]) => sql`(dl.entity_type = ${t} and dl.entity_id = ${i})`);
    const rows = await raw<any>(
      db,
      sql`select d.id, d.title, d.doc_class, d.filename, d.created_at, dl.entity_type, dl.entity_id
          from documents d join document_links dl on dl.document_id = d.id
          where (${sql.join(conds, sql` or `)}) and d.deleted_at is null
          order by d.created_at desc limit 200`,
    );
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      docs.push({
        id: String(r.id), title: r.title, doc_class: r.doc_class, filename: r.filename, created_at: isoTs(r.created_at),
        entity_type: r.entity_type, entity_id: String(r.entity_id),
      });
    }
  }
  const partnerOuts = [];
  for (const p of partners) partnerOuts.push({ ...(await partnerOut(db, p)), notes: null }); // internal notes stay internal
  return {
    partners: partnerOuts,
    investments: await investmentOuts(db, invs),
    capital_accounts: accounts,
    totals,
    distributions: outs.filter((o) => o.event_type === "distribution" || o.event_type === "liquidation"),
    capital_calls: outs.filter((o) => o.event_type === "call"),
    documents: docs,
    reports: await packageItems(db, packages),
  };
}
