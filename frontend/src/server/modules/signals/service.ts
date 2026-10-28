/**
 * Motivation, distress & market signals (spec module 10).
 *
 * Signals are sourced, dated records linked to a property and/or an owner. Each type has a configurable
 * half-life; a signal's current weight decays as 0.5 ** (age / half_life). Independent signals (different
 * type and different source) observed within the configured window "stack" and escalate priority.
 * Sensitive signals stay internal: they are redacted for users without `signals:view_sensitive` and are
 * never included in exports or outbound payloads (see `outboundSignals`).
 */
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import { organizations, people } from "../contacts/schema";
import { opportunities } from "../pipeline/schema";
import { ownershipInterests } from "../ownership/schema";
import { properties } from "../properties/schema";
import { strftime, today } from "../tasks/fmt";
import { automationRules } from "../tasks/schema";
import { raiseAlert, recordRuleRun, ruleConfig } from "../tasks/service";
import {
  CATEGORIES,
  DEFAULT_TYPES,
  signalSubscriptions,
  signalTypes,
  signals,
  type Signal,
  type SignalSubscription,
  type SignalType,
} from "./schema";
import type { SignalCreate, SignalTypeIn, SignalTypeUpdate, SignalUpdate, SubscriptionIn } from "./schemas";

export const ENTITY = "signal";
export const RULE_KEY = "signals.stacked";
export const RULE_DEFAULTS: Record<string, any> = { window_days: 90, min_independent: 2, stack_bonus: 0.25, alert_min_severity: 4 };
const MATERIAL = new Set(["observed_on", "severity", "source", "confidence", "expires_on"]);
// How strongly each category speaks to owner motivation (market/development mostly affect attractiveness).
const MOTIVATION_WEIGHTS: Record<string, number> = {
  debt: 1.0, legal: 1.0, tax: 0.9, ownership: 0.8, tenancy: 0.8, behavioral: 0.9, physical: 0.6, market: 0.4,
  development: 0.4,
};
const ALERT_SEVERITY: Record<number, string> = { 1: "low", 2: "low", 3: "medium", 4: "high", 5: "critical" };
const SEV_SCALE = ["low", "medium", "high", "critical"];
const DAY = 24 * 3600 * 1000;

// ----------------------------------------------------------------------------- pure helpers

const dayNumber = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);
export const addDays = (d: string, n: number) => new Date((dayNumber(d) + n) * DAY).toISOString().slice(0, 10);
const round = (x: number, n: number) => Math.round(x * 10 ** n) / 10 ** n;

export function decayWeight(halfLifeDays: number | null, observedOn: string, todayStr?: string): number {
  const t = todayStr ?? today();
  if (!halfLifeDays) return 1.0;
  const age = Math.max(0, dayNumber(t) - dayNumber(observedOn));
  return round(0.5 ** (age / halfLifeDays), 4);
}

export function effectiveStatus(s: Signal, todayStr?: string): string {
  const t = todayStr ?? today();
  if (s.status === "active" && s.expires_on && s.expires_on < t) return "expired";
  return s.status;
}

export function isLive(s: Signal, todayStr?: string): boolean {
  return !s.deleted_at && effectiveStatus(s, todayStr) === "active";
}

/** Largest set of independent (distinct type AND distinct source) live signals inside the window. */
export function stackGroup(rows: Signal[], windowDays: number, todayStr?: string): Signal[] {
  const t = todayStr ?? today();
  const start = addDays(t, -windowDays);
  const live = rows.filter((s) => isLive(s, t) && s.observed_on >= start);
  live.sort((a, b) => b.severity - a.severity || dayNumber(b.observed_on) - dayNumber(a.observed_on));
  const chosen: Signal[] = [];
  const types = new Set<string>();
  const sources = new Set<string>();
  for (const s of live) {
    const src = (s.source || "").trim().toLowerCase();
    if (types.has(s.signal_type) || sources.has(src)) continue;
    chosen.push(s);
    types.add(s.signal_type);
    sources.add(src);
  }
  return chosen;
}

export function signalPriority(severity: number, stacked: boolean): string {
  if (severity >= 5 || (stacked && severity >= 4)) return "urgent";
  if (severity >= 4 || stacked) return "high";
  return severity === 3 ? "normal" : "low";
}

const bump = (sev: string) => SEV_SCALE[Math.min(SEV_SCALE.length - 1, SEV_SCALE.indexOf(sev) + 1)];

const t_ = signals;
/** Effective status SQL (active signals past their expiration read as expired). Literals are inlined so the
 *  same expression can appear in SELECT and GROUP BY. */
export const statusExpr = (): SQL<string> =>
  sql<string>`(case when ${t_.status} = 'active' and ${t_.expires_on} is not null and ${t_.expires_on} < current_date then 'expired' else ${t_.status} end)`;

// ----------------------------------------------------------------------------- configuration

/** Registers the stacking automation in the shared automation registry so it can be tuned/disabled. */
export async function ensureRule(db: Db) {
  const [existing] = await db.select().from(automationRules).where(eq(automationRules.key, RULE_KEY)).limit(1);
  if (existing) return existing;
  return insert(db, automationRules, {
    key: RULE_KEY, name: "Signal stacking and severe-signal alerts", event: "signal.created", enabled: true,
    description:
      "Alerts when independent signals stack on a property inside the configured window, or a " +
      "single signal reaches the alert severity. Stacking also escalates motivation.",
    thresholds: { ...RULE_DEFAULTS }, run_count: 0, error_count: 0,
  });
}

export async function settings(db: Db): Promise<[boolean, Record<string, any>]> {
  const [enabled, th] = await ruleConfig(db, RULE_KEY);
  return [enabled, { ...RULE_DEFAULTS, ...(th ?? {}) }];
}

export async function saveSettings(db: Db, data: Record<string, any>, actor: CurrentUser): Promise<[boolean, Record<string, any>]> {
  const rule = await ensureRule(db);
  const { enabled, ...rest } = data;
  const th = {
    ...RULE_DEFAULTS, ...(rule.thresholds ?? {}),
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined)),
  };
  const hasEnabled = enabled !== null && enabled !== undefined;
  const changes = audit.diff(rule, { thresholds: th, ...(hasEnabled ? { enabled } : {}) });
  if (Object.keys(changes).length) {
    await patch(db, automationRules, rule, { thresholds: th, ...(hasEnabled ? { enabled } : {}), updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "automation_rule.updated", entity_type: "automation_rule", entity_id: rule.id, summary: RULE_KEY,
      changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return settings(db);
}

export async function ensureTypes(db: Db): Promise<void> {
  const have = new Set((await db.select({ key: signalTypes.key }).from(signalTypes)).map((r) => r.key));
  for (const [key, lbl, cat, sev, half, expiry, sensitive] of DEFAULT_TYPES) {
    if (!have.has(key)) {
      await insert(db, signalTypes, {
        key, label: lbl, category: cat, default_severity: sev, half_life_days: half, default_expiry_days: expiry,
        is_sensitive: sensitive, is_active: true,
      });
    }
  }
}

export async function typeMap(db: Db): Promise<Map<string, SignalType>> {
  const rows = await db.select().from(signalTypes).where(isNull(signalTypes.deleted_at));
  return new Map(rows.map((t) => [t.key, t]));
}

/** SignalTypeOut. */
export const typeOut = (t: SignalType, signalCount = 0) => ({
  id: t.id, key: t.key, label: t.label, category: t.category, description: t.description,
  default_severity: t.default_severity, half_life_days: t.half_life_days, default_expiry_days: t.default_expiry_days,
  is_sensitive: t.is_sensitive, is_active: t.is_active, signal_count: signalCount, updated_at: t.updated_at,
});

export async function listTypes(db: Db) {
  await ensureTypes(db);
  await db.commit();
  const countRows = await db
    .select({ k: signals.signal_type, n: sql<number>`count(*)::int` })
    .from(signals)
    .where(isNull(signals.deleted_at))
    .groupBy(signals.signal_type);
  const counts = new Map(countRows.map((r) => [r.k, Number(r.n)]));
  const rows = await db
    .select()
    .from(signalTypes)
    .where(isNull(signalTypes.deleted_at))
    .orderBy(asc(signalTypes.category), asc(signalTypes.label));
  return rows.map((t) => typeOut(t, counts.get(t.key) ?? 0));
}

export async function createType(db: Db, data: SignalTypeIn, actor: CurrentUser) {
  await ensureTypes(db);
  const [dupe] = await db.select({ id: signalTypes.id }).from(signalTypes).where(eq(signalTypes.key, data.key)).limit(1);
  if (dupe) throw new HttpError(409, `Signal type '${data.key}' already exists`);
  const t = await insert(db, signalTypes, {
    key: data.key, label: data.label, category: data.category, description: data.description ?? null,
    default_severity: data.default_severity, half_life_days: data.half_life_days ?? null,
    default_expiry_days: data.default_expiry_days ?? null, is_sensitive: data.is_sensitive, is_active: data.is_active,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "signal_type.created", entity_type: "signal_type", entity_id: t.id, summary: t.label,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function updateType(db: Db, t: SignalType, data: SignalTypeUpdate, actor: CurrentUser) {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const changes = audit.diff(t, values);
  if (!Object.keys(changes).length) return t;
  await patch(db, signalTypes, t, { ...values, updated_by_id: actor.id } as never);
  if ("half_life_days" in changes) {
    // Decay is configured by type: keep every signal of this type on the configured half-life.
    await db.update(signals).set({ half_life_days: t.half_life_days }).where(eq(signals.signal_type, t.key));
  }
  await audit.record(db, {
    actor, action: "signal_type.updated", entity_type: "signal_type", entity_id: t.id, summary: t.label, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

// ----------------------------------------------------------------------------- owner / property linkage

type Owner = [string, string];

const activeInterest = () =>
  or(isNull(ownershipInterests.effective_to), sql`${ownershipInterests.effective_to} > ${today()}`);

export async function currentOwners(db: Db, propertyId: string): Promise<Owner[]> {
  const rows = await db
    .select({
      kind: ownershipInterests.owner_kind, pid: ownershipInterests.owner_person_id,
      oid: ownershipInterests.owner_organization_id,
    })
    .from(ownershipInterests)
    .where(and(eq(ownershipInterests.property_id, propertyId), isNull(ownershipInterests.deleted_at), activeInterest()));
  const out: Owner[] = [];
  for (const r of rows) {
    if (r.kind === "person" && r.pid) out.push(["person", r.pid]);
    else if (r.kind === "organization" && r.oid) out.push(["organization", r.oid]);
  }
  return out;
}

export async function ownedProperties(db: Db, ownerKind: string, ownerId: string): Promise<string[]> {
  const col = ownerKind === "person" ? ownershipInterests.owner_person_id : ownershipInterests.owner_organization_id;
  const rows = await db
    .selectDistinct({ property_id: ownershipInterests.property_id })
    .from(ownershipInterests)
    .where(and(eq(col, ownerId), isNull(ownershipInterests.deleted_at), activeInterest()));
  return rows.map((r) => r.property_id!);
}

function ownerConditions(owners: Owner[]): SQL[] {
  const ppl = owners.filter(([k]) => k === "person").map(([, i]) => i);
  const orgs = owners.filter(([k]) => k === "organization").map(([, i]) => i);
  const conds: SQL[] = [];
  if (ppl.length) conds.push(and(eq(signals.owner_kind, "person"), inArray(signals.owner_id, ppl))!);
  if (orgs.length) conds.push(and(eq(signals.owner_kind, "organization"), inArray(signals.owner_id, orgs))!);
  return conds;
}

/** Signals on the property plus signals on its current owners. */
export async function propertySignalRows(db: Db, propertyId: string, o: { live_only?: boolean } = {}): Promise<Signal[]> {
  const conds = [eq(signals.property_id, propertyId), ...ownerConditions(await currentOwners(db, propertyId))];
  return db
    .select()
    .from(signals)
    .where(
      and(
        isNull(signals.deleted_at),
        or(...conds),
        o.live_only
          ? and(eq(signals.status, "active"), or(isNull(signals.expires_on), gte(signals.expires_on, today())))
          : undefined,
      ),
    )
    .orderBy(desc(signals.observed_on));
}

export async function motivationBreakdown(db: Db, propertyId: string) {
  const [, th] = await settings(db);
  const windowDays = Math.trunc(Number(th.window_days));
  const todayStr = today();
  const rows = await propertySignalRows(db, propertyId, { live_only: true });
  const group = stackGroup(rows, windowDays, todayStr);
  const stacked = group.length >= Math.trunc(Number(th.min_independent));
  const stackedIds = stacked ? new Set(group.map((s) => s.id)) : new Set<string>();
  let remaining = 1.0;
  const contributions = [];
  for (const s of rows) {
    const w = decayWeight(s.half_life_days, s.observed_on, todayStr);
    const c = (s.severity / 5) * Number(s.confidence || 0) * w * (MOTIVATION_WEIGHTS[s.category] ?? 0.5);
    remaining *= 1 - 0.6 * c;
    contributions.push({
      signal_id: s.id, signal_type: s.signal_type, category: s.category, severity: s.severity,
      confidence: Number(s.confidence || 0), weight: w, contribution: round(100 * 0.6 * c, 1),
      observed_on: s.observed_on, source: !s.is_sensitive ? s.source : "Internal", stacked: stackedIds.has(s.id),
    });
  }
  const base = 1 - remaining;
  const mult = stacked ? 1 + Number(th.stack_bonus) * (group.length - 1) : 1.0;
  return {
    property_id: propertyId, index: round(Math.min(100.0, 100 * base * mult), 1), base: round(100 * base, 1),
    stack_multiplier: round(mult, 2), stacked, stack_count: stacked ? group.length : 0, window_days: windowDays,
    active_signals: rows.length, contributions: contributions.sort((a, b) => b.contribution - a.contribution),
  };
}

/** 0-100 owner-motivation index from decayed, confidence-weighted and stacked live signals. */
export async function motivationIndex(db: Db, propertyId: string): Promise<number> {
  return Number((await motivationBreakdown(db, propertyId)).index);
}

/** The only signals that may be used in outbound templates/exports: live and not sensitive. */
export async function outboundSignals(db: Db, propertyId: string): Promise<Signal[]> {
  return (await propertySignalRows(db, propertyId, { live_only: true })).filter((s) => !s.is_sensitive);
}

// ----------------------------------------------------------------------------- queries

export interface SignalFilters {
  q?: string;
  category?: string[];
  severity?: number[];
  status?: string[];
  signal_type?: string[];
  verification?: string[];
  property_id?: string;
  owner_kind?: string;
  owner_id?: string;
  sensitive?: boolean;
  min_confidence?: number;
  observed_from?: string;
  observed_to?: string;
}

/** WHERE for the signals list (the query joins `properties` for search); `skip` leaves a facet's own filter out. */
export function buildWhere(f: SignalFilters, skip: Set<string> = new Set()): SQL | undefined {
  const eff = statusExpr();
  return and(
    isNull(signals.deleted_at),
    applySearch(f.q, [
      signals.title, signals.source, signals.signal_type, properties.name, properties.address_line, properties.city,
    ]),
    skip.has("category") ? undefined : inFilter(signals.category, f.category),
    skip.has("severity") ? undefined : inFilter(signals.severity, f.severity),
    skip.has("signal_type") ? undefined : inFilter(signals.signal_type, f.signal_type),
    !skip.has("status") && f.status?.length ? sql`${eff} in (${sql.join(f.status.map((s) => sql`${s}`), sql`, `)})` : undefined,
    inFilter(signals.verification, f.verification),
    f.property_id ? eq(signals.property_id, f.property_id) : undefined,
    f.owner_kind && f.owner_id ? and(eq(signals.owner_kind, f.owner_kind), eq(signals.owner_id, f.owner_id)) : undefined,
    f.sensitive !== undefined ? eq(signals.is_sensitive, f.sensitive) : undefined,
    rangeFilter(signals.confidence, f.min_confidence, null),
    rangeFilter(signals.observed_on, f.observed_from, f.observed_to),
  );
}

/** One page of signals (left-joined to properties for search) plus the unpaginated total. */
export async function listPage(
  db: Db,
  where: SQL | undefined,
  orderBy: SQL[],
  p: { page: number; page_size: number },
): Promise<[Signal[], number]> {
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals)
    .leftJoin(properties, eq(properties.id, signals.property_id))
    .where(where);
  const rows = await db
    .select({ s: signals })
    .from(signals)
    .leftJoin(properties, eq(properties.id, signals.property_id))
    .where(where)
    .orderBy(...orderBy)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [rows.map((r) => r.s), Number(c?.n ?? 0)];
}

export async function listAll(db: Db, where: SQL | undefined, orderBy: SQL[], limit: number): Promise<Signal[]> {
  const rows = await db
    .select({ s: signals })
    .from(signals)
    .leftJoin(properties, eq(properties.id, signals.property_id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);
  return rows.map((r) => r.s);
}

/** Counts per distinct value of `expr` within the filtered rows. */
export async function facetBy(db: Db, where: SQL | undefined, expr: SQL | any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: expr, n: sql<number>`count(*)::int` })
    .from(signals)
    .leftJoin(properties, eq(properties.id, signals.property_id))
    .where(where)
    .groupBy(expr);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function getSignal(db: Db, signalId: string): Promise<Signal> {
  const s = await get(db, signals, signalId);
  if (!s || s.deleted_at) throw new HttpError(404, "Signal not found");
  return s;
}

async function labels(db: Db, rows: Signal[]): Promise<[Map<string, string>, Map<string, string>]> {
  const pids = [...new Set(rows.map((s) => s.property_id).filter((i): i is string => !!i))];
  const props = new Map<string, string>();
  if (pids.length) {
    const found = await db
      .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
      .from(properties)
      .where(inArray(properties.id, pids));
    for (const r of found) props.set(r.id, r.name || r.address_line);
  }
  const owners = new Map<string, string>();
  const ppl = [...new Set(rows.filter((s) => s.owner_kind === "person" && s.owner_id).map((s) => s.owner_id!))];
  const orgs = [...new Set(rows.filter((s) => s.owner_kind === "organization" && s.owner_id).map((s) => s.owner_id!))];
  if (ppl.length) {
    for (const r of await db.select({ id: people.id, n: people.full_name }).from(people).where(inArray(people.id, ppl))) owners.set(r.id, r.n);
  }
  if (orgs.length) {
    for (const r of await db.select({ id: organizations.id, n: organizations.name }).from(organizations).where(inArray(organizations.id, orgs))) owners.set(r.id, r.n);
  }
  return [props, owners];
}

/** SignalOut: labels, decay, stacking and redaction of sensitive signals for users without view_sensitive. */
export async function toOuts(db: Db, rows: Signal[], actor: CurrentUser | null) {
  if (!rows.length) return [];
  const todayStr = today();
  const [, th] = await settings(db);
  const [props, owners] = await labels(db, rows);
  const types = await typeMap(db);
  const stackedIds = new Set<string>();
  for (const pid of new Set(rows.map((s) => s.property_id).filter((i): i is string => !!i))) {
    const group = stackGroup(await propertySignalRows(db, pid, { live_only: true }), Math.trunc(Number(th.window_days)), todayStr);
    if (group.length >= Math.trunc(Number(th.min_independent))) for (const s of group) stackedIds.add(s.id);
  }
  const canSensitive = actor != null && actor.can("signals", "view_sensitive");
  return rows.map((s) => {
    const typeLabel = types.get(s.signal_type)?.label ?? null;
    const eff = effectiveStatus(s, todayStr);
    const stacked = stackedIds.has(s.id);
    const o = {
      id: s.id,
      property_id: s.property_id,
      property_label: (s.property_id && props.get(s.property_id)) || null,
      owner_kind: s.owner_kind,
      owner_id: s.owner_id,
      owner_label: (s.owner_id && owners.get(s.owner_id)) || null,
      category: s.category,
      signal_type: s.signal_type,
      type_label: typeLabel,
      title: s.title as string | null,
      description: s.description as string | null,
      observed_on: s.observed_on,
      severity: s.severity,
      source: s.source,
      source_reference: s.source_reference as string | null,
      confidence: s.confidence,
      expires_on: s.expires_on,
      half_life_days: s.half_life_days,
      is_sensitive: s.is_sensitive,
      redacted: false,
      status: s.status,
      effective_status: eff,
      current_weight: eff === "active" ? decayWeight(s.half_life_days, s.observed_on, todayStr) : 0.0,
      age_days: Math.max(0, dayNumber(todayStr) - dayNumber(s.observed_on)),
      priority: signalPriority(s.severity, stacked),
      stacked,
      details: s.details as Record<string, any>,
      verification: s.verification,
      verified_at: s.verified_at,
      dismissed_reason: s.dismissed_reason,
      dismissed_at: s.dismissed_at,
      created_at: s.created_at,
      updated_at: s.updated_at,
      created_by_id: s.created_by_id,
    };
    if (s.is_sensitive && !canSensitive) {
      o.redacted = true;
      o.title = typeLabel || s.signal_type;
      o.description = null;
      o.source_reference = null;
      o.details = {};
    }
    return o;
  });
}

// ----------------------------------------------------------------------------- automations

async function activeOpportunityOwner(db: Db, propertyId: string): Promise<string | null> {
  const [r] = await db
    .select({ owner_id: opportunities.owner_id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.property_id, propertyId), isNull(opportunities.deleted_at),
        notInArray(opportunities.stage, ["closed", "dead"]),
      ),
    )
    .orderBy(desc(opportunities.updated_at))
    .limit(1);
  return r?.owner_id ?? null;
}

async function propertyLabel(db: Db, propertyId: string): Promise<string> {
  const [r] = await db
    .select({ name: properties.name, address_line: properties.address_line })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  return r ? r.name || r.address_line : "Property";
}

async function subscriptionMatches(
  db: Db,
  sub: SignalSubscription,
  s: Signal,
  pids: string[],
  stackedPids: Set<string>,
): Promise<boolean> {
  if (sub.categories?.length && !sub.categories.includes(s.category)) return false;
  if (sub.signal_types?.length && !sub.signal_types.includes(s.signal_type)) return false;
  if (s.severity < (sub.min_severity || 1)) return false;
  if (sub.owner_id && !(s.owner_id === sub.owner_id && s.owner_kind === sub.owner_kind)) return false;
  let candidates = [...pids];
  if (sub.property_id) {
    candidates = candidates.filter((p) => p === sub.property_id);
    if (!candidates.length) return false;
  }
  if (sub.stacked_only) {
    candidates = candidates.filter((p) => stackedPids.has(p));
    if (!candidates.length) return false;
  }
  if (sub.property_types?.length) {
    if (!candidates.length) return false;
    const rows = await db
      .select({ t: properties.property_type })
      .from(properties)
      .where(inArray(properties.id, candidates));
    if (!rows.some((r) => sub.property_types.includes(r.t))) return false;
  }
  if (sub.territory_id) {
    if (!candidates.length) return false;
    const rows = Array.from(
      (await db.execute(
        sql`select count(*)::int as n from territory_members
            where territory_id = ${sub.territory_id}
              and property_id in (${sql.join(candidates.map((c) => sql`${c}`), sql`, `)})`,
      )) as unknown as Array<{ n: number }>,
    );
    if (!rows[0]?.n) return false;
  }
  return true;
}

async function runAutomations(db: Db, s: Signal, actor: CurrentUser | null): Promise<void> {
  await ensureRule(db);
  const [enabled, th] = await settings(db);
  const types = await typeMap(db);
  const typeLabel = types.get(s.signal_type)?.label ?? s.signal_type.replace(/_/g, " ");
  let pids: string[] = s.property_id ? [s.property_id] : [];
  if (s.owner_kind && s.owner_id) {
    for (const p of await ownedProperties(db, s.owner_kind, s.owner_id)) if (!pids.includes(p)) pids.push(p);
  }
  pids = pids.slice(0, 25);
  const stackedPids = new Set<string>();

  if (enabled) {
    for (const pid of pids) {
      const m = await motivationBreakdown(db, pid);
      const lbl = await propertyLabel(db, pid);
      const inStack = m.contributions.some((c) => c.signal_id === s.id && c.stacked);
      if (m.stacked) stackedPids.add(pid);
      if (m.stacked && inStack) {
        const stackedSev = m.contributions.filter((c) => c.stacked).map((c) => c.severity);
        const top = Math.max(...(stackedSev.length ? stackedSev : [s.severity]));
        const kinds = [...new Set(m.contributions.filter((c) => c.stacked).map((c) => c.signal_type.replace(/_/g, " ")))]
          .sort()
          .join(", ");
        await raiseAlert(db, {
          title: `Stacked signals: ${lbl}`,
          reason: `${m.stack_count} independent signals within ${m.window_days} days (${kinds}). Motivation index ${m.index}.`,
          severity: bump(ALERT_SEVERITY[top] ?? "medium"), owner_id: await activeOpportunityOwner(db, pid),
          related_type: "property", related_id: pid, related_label: lbl, rule_key: RULE_KEY,
          idempotency_key: `signals.stacked:${pid}:${s.id}`,
        });
      } else if (s.severity >= Math.trunc(Number(th.alert_min_severity))) {
        await raiseAlert(db, {
          title: `${typeLabel}: ${lbl}`,
          reason:
            `Severity ${s.severity} signal observed ${strftime(s.observed_on, "%b %d, %Y")} (source: ` +
            `${s.is_sensitive ? "internal" : s.source}). Motivation index ${m.index}.`,
          severity: ALERT_SEVERITY[s.severity] ?? "medium", owner_id: await activeOpportunityOwner(db, pid),
          related_type: "property", related_id: pid, related_label: lbl, rule_key: "signals.severe",
          idempotency_key: `signals.severe:${pid}:${s.id}`,
        });
      }
    }
  }

  const subs = await db
    .select()
    .from(signalSubscriptions)
    .where(and(eq(signalSubscriptions.is_active, true), isNull(signalSubscriptions.deleted_at)));
  for (const sub of subs) {
    if (actor != null && sub.subscriber_id === actor.id) continue;
    if (!(await subscriptionMatches(db, sub, s, pids, stackedPids))) continue;
    const pid = pids.length ? pids[0] : null;
    let where = "";
    if (pid) where = ` · ${await propertyLabel(db, pid)}`;
    await raiseAlert(db, {
      title: `New signal: ${typeLabel}${where}`,
      reason: `Matches your subscription “${sub.name}”. Severity ${s.severity}, observed ${strftime(s.observed_on, "%b %d, %Y")}.`,
      severity: ALERT_SEVERITY[s.severity] ?? "medium", owner_id: sub.subscriber_id,
      related_type: pid ? "property" : s.owner_kind, related_id: pid || s.owner_id, related_label: typeLabel,
      rule_key: "signals.subscription", idempotency_key: `signals.sub:${s.id}:${sub.id}`,
    });
  }
  await recordRuleRun(db, RULE_KEY);
}

// ----------------------------------------------------------------------------- mutations

async function ensureOwner(db: Db, kind: string, ownerId: string): Promise<void> {
  const row = kind === "person" ? await get(db, people, ownerId) : await get(db, organizations, ownerId);
  if (!row || row.deleted_at) throw new HttpError(404, `${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()} not found`);
}

export async function create(db: Db, data: SignalCreate, actor: CurrentUser): Promise<Signal> {
  if (!data.property_id && !(data.owner_kind && data.owner_id)) {
    throw new HttpError(422, "Link the signal to a property and/or an owner");
  }
  if (Boolean(data.owner_kind) !== Boolean(data.owner_id)) {
    throw new HttpError(422, "Owner kind and owner are both required to link an owner");
  }
  if (data.property_id) {
    const p = await get(db, properties, data.property_id);
    if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  }
  if (data.owner_kind && data.owner_id) await ensureOwner(db, data.owner_kind, data.owner_id);
  await ensureTypes(db);
  const t = (await typeMap(db)).get(data.signal_type);
  if (!t || !t.is_active) throw new HttpError(422, `Unknown or inactive signal type '${data.signal_type}'`);
  if (data.observed_on > today()) throw new HttpError(422, "Observed date cannot be in the future");
  const expires = data.expires_on || (t.default_expiry_days ? addDays(data.observed_on, t.default_expiry_days) : null);
  if (expires && expires < data.observed_on) throw new HttpError(422, "Expiration must be on or after the observed date");
  const verified = data.verified;
  const s = await insert(db, signals, {
    property_id: data.property_id ?? null, owner_kind: data.owner_kind ?? null, owner_id: data.owner_id ?? null,
    category: t.category, signal_type: t.key, title: (data.title || "").trim() || t.label,
    description: data.description ?? null, observed_on: data.observed_on, severity: data.severity || t.default_severity,
    source: data.source.trim(), source_reference: data.source_reference ?? null, confidence: data.confidence,
    expires_on: expires, half_life_days: t.half_life_days,
    is_sensitive: data.is_sensitive === null || data.is_sensitive === undefined ? t.is_sensitive : data.is_sensitive,
    status: "active", details: data.details || {}, verification: verified ? "verified" : "unverified",
    verified_by_id: verified ? actor.id : null, verified_at: verified ? utcnow() : null,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  const summary = `${t.label} · severity ${s.severity} · ${s.source}`;
  await audit.record(db, {
    actor, action: "signal.created", entity_type: ENTITY, entity_id: s.id, summary, ip_address: actor.ip_address,
  });
  if (s.property_id) {
    await audit.record(db, {
      actor, action: "property.signal_added", entity_type: "property", entity_id: s.property_id,
      summary: s.is_sensitive ? t.label : summary, ip_address: actor.ip_address,
    });
  }
  if (s.owner_kind && s.owner_id) {
    await audit.record(db, {
      actor, action: `${s.owner_kind}.signal_added`, entity_type: s.owner_kind, entity_id: s.owner_id,
      summary: s.is_sensitive ? t.label : summary, ip_address: actor.ip_address,
    });
  }
  // Subscribers: scoring rescoring and reactivation evaluation run in their handlers (same transaction).
  await events.emit(db, "signal.created", {
    signal_id: s.id, property_id: s.property_id, owner_kind: s.owner_kind, owner_id: s.owner_id,
    category: s.category, signal_type: s.signal_type, actor,
  });
  await runAutomations(db, s, actor);
  await db.commit();
  return s;
}

async function changed(s: Signal, db: Db, actor: CurrentUser): Promise<void> {
  await events.emit(db, "signal.updated", {
    signal_id: s.id, property_id: s.property_id, owner_kind: s.owner_kind, owner_id: s.owner_id,
    category: s.category, actor,
  });
}

export async function updateSignal(db: Db, s: Signal, data: SignalUpdate, actor: CurrentUser): Promise<Signal> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  for (const k of ["source", "observed_on", "severity", "confidence"]) {
    if (k in values && values[k] === null) delete values[k];
  }
  const obs: string = values.observed_on ?? s.observed_on;
  if (obs > today()) throw new HttpError(422, "Observed date cannot be in the future");
  if (values.expires_on && values.expires_on < obs) throw new HttpError(422, "Expiration must be on or after the observed date");
  const prov = provenance.provenanceIn.parse({
    source: values.source ?? s.source, observed_on: obs, confidence: values.confidence ?? s.confidence,
  });
  // applyMaterial mutates `s` in memory; persisted below with one UPDATE.
  const changes = await provenance.applyMaterial(db, s, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL, prov, actor_id: actor.id,
  });
  if (!Object.keys(changes).length) return s;
  const set: Record<string, any> = Object.fromEntries(Object.keys(changes).map((k) => [k, (s as Record<string, any>)[k]]));
  if (Object.keys(changes).some((k) => MATERIAL.has(k)) && s.verification === "verified") {
    Object.assign(set, { verification: "unverified", verified_by_id: null, verified_at: null });
  }
  set.updated_by_id = actor.id;
  await patch(db, signals, s, set as never);
  await audit.record(db, {
    actor, action: "signal.updated", entity_type: ENTITY, entity_id: s.id, changes, ip_address: actor.ip_address,
  });
  await changed(s, db, actor);
  await db.commit();
  return s;
}

export async function dismiss(db: Db, s: Signal, reason: string, actor: CurrentUser): Promise<Signal> {
  if (s.status === "dismissed") throw new HttpError(409, "Signal is already dismissed");
  await patch(db, signals, s, {
    status: "dismissed", dismissed_reason: reason.trim(), dismissed_by_id: actor.id, dismissed_at: utcnow(),
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "signal.dismissed", entity_type: ENTITY, entity_id: s.id, summary: reason.trim(),
    ip_address: actor.ip_address,
  });
  await changed(s, db, actor);
  await db.commit();
  return s;
}

export async function restore(db: Db, s: Signal, actor: CurrentUser): Promise<Signal> {
  if (s.status !== "dismissed") throw new HttpError(409, "Only dismissed signals can be restored");
  await patch(db, signals, s, {
    status: "active", dismissed_reason: null, dismissed_by_id: null, dismissed_at: null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "signal.restored", entity_type: ENTITY, entity_id: s.id, ip_address: actor.ip_address,
  });
  await changed(s, db, actor);
  await db.commit();
  return s;
}

export async function verify(db: Db, s: Signal, state: string, actor: CurrentUser): Promise<Signal> {
  const before = s.verification;
  await patch(db, signals, s, {
    verification: state, verified_by_id: state !== "unverified" ? actor.id : null,
    verified_at: state !== "unverified" ? utcnow() : null, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `signal.${state}`, entity_type: ENTITY, entity_id: s.id,
    changes: { verification: { from: before, to: state } }, ip_address: actor.ip_address,
  });
  await changed(s, db, actor);
  await db.commit();
  return s;
}

export async function archive(db: Db, s: Signal, actor: CurrentUser): Promise<void> {
  await patch(db, signals, s, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "signal.archived", entity_type: ENTITY, entity_id: s.id, summary: s.title,
    ip_address: actor.ip_address,
  });
  await changed(s, db, actor);
  await db.commit();
}

// ----------------------------------------------------------------------------- subscriptions

export async function getSubscription(db: Db, subId: string, actor: CurrentUser): Promise<SignalSubscription> {
  const sub = await get(db, signalSubscriptions, subId);
  if (!sub || sub.deleted_at) throw new HttpError(404, "Subscription not found");
  if (sub.subscriber_id !== actor.id && !actor.can("signals", "approve")) {
    throw new HttpError(403, "You can only manage your own subscriptions");
  }
  return sub;
}

function checkSub(data: SubscriptionIn): void {
  if (Boolean(data.owner_kind) !== Boolean(data.owner_id)) {
    throw new HttpError(422, "Owner kind and owner are both required to subscribe to an owner");
  }
  const bad = data.categories.filter((c) => !(CATEGORIES as readonly string[]).includes(c));
  if (bad.length) throw new HttpError(422, `Unknown categories: ${bad.join(", ")}`);
}

/** SubscriptionIn as column values (unset optionals are null, like the pydantic dump). */
function subValues(data: SubscriptionIn) {
  return {
    name: data.name, categories: data.categories, signal_types: data.signal_types, min_severity: data.min_severity,
    property_id: data.property_id ?? null, owner_kind: data.owner_kind ?? null, owner_id: data.owner_id ?? null,
    territory_id: data.territory_id ?? null, property_types: data.property_types, stacked_only: data.stacked_only,
    is_active: data.is_active,
  };
}

/** SubscriptionOut. */
export const subscriptionOut = (s: SignalSubscription) => ({
  name: s.name, categories: s.categories, signal_types: s.signal_types, min_severity: s.min_severity,
  property_id: s.property_id, owner_kind: s.owner_kind, owner_id: s.owner_id, territory_id: s.territory_id,
  property_types: s.property_types, stacked_only: s.stacked_only, is_active: s.is_active, id: s.id,
  subscriber_id: s.subscriber_id, created_at: s.created_at,
});

export async function createSubscription(db: Db, data: SubscriptionIn, actor: CurrentUser) {
  checkSub(data);
  const sub = await insert(db, signalSubscriptions, {
    ...subValues(data), subscriber_id: actor.id, created_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "signal_subscription.created", entity_type: "signal_subscription", entity_id: sub.id,
    summary: sub.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return sub;
}

export async function updateSubscription(db: Db, sub: SignalSubscription, data: SubscriptionIn, actor: CurrentUser) {
  checkSub(data);
  const values = subValues(data);
  const changes = audit.diff(sub, values);
  if (Object.keys(changes).length) {
    await patch(db, signalSubscriptions, sub, { ...values, updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "signal_subscription.updated", entity_type: "signal_subscription", entity_id: sub.id,
      summary: sub.name, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return sub;
}

export async function deleteSubscription(db: Db, sub: SignalSubscription, actor: CurrentUser): Promise<void> {
  await patch(db, signalSubscriptions, sub, { deleted_at: utcnow(), is_active: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "signal_subscription.deleted", entity_type: "signal_subscription", entity_id: sub.id,
    summary: sub.name, ip_address: actor.ip_address,
  });
  await db.commit();
}
