/**
 * Reactivation / dead deal intelligence (spec module 30).
 *
 * When an opportunity is marked dead its structured reactivation rule becomes an armed trigger (plus a
 * time backstop by dead reason). Triggers are evaluated on related events and by a periodic scan. A fired
 * trigger creates a queue item that carries the original context (dead reason, prior price discussion, last
 * stage, owner) and an explanation of what changed, optionally rescoring the property and creating a task
 * for the opportunity owner. Users reactivate (via the pipeline stage gates), snooze or dismiss with a reason;
 * dismissals are counted as noise per trigger type.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import { organizations, people } from "../contacts/schema";
import { loans } from "../debt/schema";
import { interactions } from "../outreach/schema";
import { ownershipInterests } from "../ownership/schema";
import { ACTIVE_STAGES, opportunities, opportunityEvents } from "../pipeline/schema";
import { opportunityUpdate } from "../pipeline/schemas";
import * as pipeline from "../pipeline/service";
import { properties } from "../properties/schema";
import * as scoring from "../scoring/service";
import { propertySignalRows } from "../signals/service";
import { automationRules } from "../tasks/schema";
import { createTask, recordRuleRun, ruleConfig } from "../tasks/service";
import {
  REVISIT_DAYS_BY_REASON,
  reactivationItems,
  reactivationTriggers,
  type ReactivationItem,
  type ReactivationTrigger,
} from "./schema";

export const RULE_KEY = "reactivation.trigger_fired";
export const RULE_DEFAULTS: Record<string, any> = {
  task_due_days: 2, debt_window_days: 180, development_radius_miles: 3.0, rescore: true, backstop_by_dead_reason: true,
};
export const POSITIVE_DISPOSITIONS = new Set(["connected", "callback", "information_requested", "offer_requested"]);
export const CONVERTED_STAGES = new Set(["offer", "under_contract", "due_diligence", "closing", "closed"]);
export const FIELD_OPERATORS = ["lt", "lte", "gt", "gte", "eq", "neq", "changed"];
const FIELD_EXCLUDE = new Set([
  "id", "location", "created_at", "updated_at", "created_by_id", "updated_by_id", "deleted_at",
  "normalized_address", "alternate_addresses", "tags", "notes",
]);
export const TYPE_LABELS: Record<string, string> = {
  time: "Time", debt: "Debt event", price: "Price / listing", ownership: "Ownership / entity",
  lease: "Lease / tenant", market: "Market / rate / comps", development: "Development / infrastructure",
  relationship: "Relationship / warm path", manual: "Manual field / threshold",
};
const MARKET_TYPES: Record<string, string> = {
  cap_rate: "cap_rate_shift", interest_rate: "interest_rate_shift", comp_price_psf: "comp_sale_nearby",
};

type Params = Record<string, any>;
type Change = Record<string, any>;

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const todayStr = () => new Date().toISOString().slice(0, 10);
const humanize = (s: string) => s.replace(/_/g, " ");
const commas = (v: number) => Math.round(v).toLocaleString("en-US");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
/** `strftime("%b %d, %Y")` */
const fmtDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}, ${d.slice(0, 4)}`;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY_MS).toISOString().slice(0, 10);
const isNone = (v: unknown) => v === null || v === undefined;

function parseDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && v) {
    const s = v.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function propertyFields(): Array<{ key: string; type: string }> {
  const out: Array<{ key: string; type: string }> = [];
  for (const [key, col] of Object.entries(getTableColumns(properties))) {
    if (FIELD_EXCLUDE.has(key)) continue;
    const t = col.getSQLType();
    out.push({ key, type: /^(integer|bigint|double|numeric|real)/.test(t) ? "number" : t === "date" ? "date" : "text" });
  }
  return out;
}

export function describe(triggerType: string, params: Params | null | undefined): string {
  const p = params ?? {};
  if (triggerType === "time") {
    return p.on_date ? `Revisit on ${p.on_date}` : `Revisit after ${p.after_days ?? "None"} days`;
  }
  if (triggerType === "debt") {
    return `Debt: ${humanize(String(p.event ?? "event"))}` + (p.date ? ` (expected ${p.date})` : "");
  }
  if (triggerType === "price") {
    const parts: string[] = [];
    if (p.target_price) parts.push(`price at or below $${commas(Number(p.target_price))}`);
    if (p.drop_pct) parts.push(`price drops ${p.drop_pct}%`);
    if (p.on_listing) parts.push("listed for sale");
    return "Price: " + (parts.join(", ") || "change");
  }
  if (triggerType === "ownership") return `Ownership: ${humanize(String(p.event ?? "any_change"))}`;
  if (triggerType === "lease") {
    return `Lease: ${humanize(String(p.event ?? "event"))}` + (p.date ? ` (expected ${p.date})` : "");
  }
  if (triggerType === "market") {
    return `Market: ${humanize(String(p.metric ?? ""))} ${p.direction ?? ""} ${p.threshold ?? ""}`.trim();
  }
  if (triggerType === "manual" && p.field) return `Field: ${p.field} ${p.operator ?? ""} ${p.value ?? ""}`.trim();
  return `${TYPE_LABELS[triggerType] ?? triggerType}: ${p.description || ""}`.replace(/^[: ]+|[: ]+$/g, "");
}

// ----------------------------------------------------------------------------- configuration

export async function ensureRule(db: Db): Promise<void> {
  const [existing] = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.key, RULE_KEY)).limit(1);
  if (!existing) {
    await insert(db, automationRules, {
      key: RULE_KEY, name: "Dead deal reactivation", event: "opportunity.dead", enabled: true,
      description: "Arms reactivation triggers when an opportunity dies and, when one fires, queues the deal " +
        "with its original context and creates a task for the owner.",
      thresholds: { ...RULE_DEFAULTS }, run_count: 0, error_count: 0,
    } as never);
  }
}

export async function settings(db: Db): Promise<[boolean, Record<string, any>]> {
  const [enabled, th] = await ruleConfig(db, RULE_KEY);
  return [enabled, { ...RULE_DEFAULTS, ...(th ?? {}) }];
}

// ----------------------------------------------------------------------------- state snapshots

async function currentOwners(db: Db, propertyId: string | null | undefined): Promise<string[]> {
  if (!propertyId) return [];
  const today = todayStr();
  const rows = await db
    .select({ k: ownershipInterests.owner_kind, p: ownershipInterests.owner_person_id, o: ownershipInterests.owner_organization_id })
    .from(ownershipInterests)
    .where(
      and(
        eq(ownershipInterests.property_id, propertyId),
        isNull(ownershipInterests.deleted_at),
        or(isNull(ownershipInterests.effective_to), sql`${ownershipInterests.effective_to} > ${today}`),
      ),
    );
  return [...new Set(rows.filter((r) => r.p || r.o).map((r) => `${r.k}:${r.p || r.o}`))].sort();
}

async function baselineOf(db: Db, opp: { property_id: string | null }, triggerType: string, params: Params): Promise<Record<string, any>> {
  const base: Record<string, any> = { owners: await currentOwners(db, opp.property_id) };
  const p = opp.property_id ? await get(db, properties, opp.property_id) : undefined;
  if (p) {
    base.asking_price = p.asking_price;
    base.property_status = p.status;
    const field = params.field;
    if (triggerType === "manual" && field && field in p) base.field_value = toJsonable((p as Record<string, any>)[field]);
  }
  if (triggerType === "debt") {
    const [, th] = await settings(db);
    const flags = await loanFlags(db, opp.property_id, params.event, todayStr(), th);
    base.debt_flags = flags.map((c) => c.label);
  }
  return toJsonable(base);
}

function fireOn(triggerType: string, params: Params, armed: string, th: Params): string | null {
  const window = Math.trunc(Number(th.debt_window_days ?? 180));
  if (triggerType === "time") {
    if (params.on_date) return parseDate(params.on_date);
    if (num(params.after_days)) return addDays(armed, Math.trunc(Number(params.after_days)));
  }
  if ((triggerType === "debt" || triggerType === "lease") && parseDate(params.date)) {
    return addDays(parseDate(params.date)!, -window);
  }
  if (triggerType === "manual" && parseDate(params.review_on)) return parseDate(params.review_on);
  return null;
}

function validate(triggerType: string, params: Params): void {
  const problems: string[] = pipeline.ruleProblems({ type: triggerType, params });
  if (triggerType === "manual" && params.field) {
    const keys = new Set(propertyFields().map((f) => f.key));
    if (!keys.has(params.field)) problems.push(`Unknown property field '${params.field}'`);
    if (!FIELD_OPERATORS.includes(params.operator)) problems.push("Choose an operator: " + FIELD_OPERATORS.join(", "));
    if (params.operator !== "changed" && (isNone(params.value) || params.value === "")) {
      problems.push("A threshold value is required");
    }
  }
  if (problems.length) throw new HttpError(422, problems.join("; "));
}

async function arm(
  db: Db,
  opp: { id: string; property_id: string | null; dead_reason: string | null },
  triggerType: string,
  params: Params,
  o: { origin: string; th: Params; actor?: CurrentUser | null },
): Promise<ReactivationTrigger> {
  const { origin, th, actor = null } = o;
  const now = utcnow();
  const t = await insert(db, reactivationTriggers, {
    opportunity_id: opp.id, property_id: opp.property_id, trigger_type: triggerType, params: toJsonable(params),
    origin, status: "armed", armed_at: now, fire_on: fireOn(triggerType, params, now.toISOString().slice(0, 10), th),
    baseline: await baselineOf(db, opp, triggerType, params), dead_reason: opp.dead_reason, check_count: 0,
    created_by_id: actor?.id ?? null, updated_by_id: actor?.id ?? null,
  });
  await audit.record(db, {
    actor, action: "opportunity.reactivation_armed", entity_type: "opportunity", entity_id: opp.id,
    summary: describe(triggerType, params) + ` (${humanize(origin)})`,
  });
  return t;
}

async function cancelArmed(db: Db, opportunityId: string, reason: string, o: { keep?: string | null } = {}): Promise<void> {
  const rows = await db
    .select()
    .from(reactivationTriggers)
    .where(
      and(
        eq(reactivationTriggers.opportunity_id, opportunityId),
        eq(reactivationTriggers.status, "armed"),
        isNull(reactivationTriggers.deleted_at),
      ),
    );
  for (const t of rows) {
    if (t.id !== o.keep) await patch(db, reactivationTriggers, t, { status: "cancelled", cancelled_reason: reason });
  }
}

/** Arms the opportunity's reactivation rule plus a time backstop by dead reason. Does not commit. */
export async function armFromOpportunity(db: Db, opp: any, actor: CurrentUser | null = null): Promise<ReactivationTrigger[]> {
  await ensureRule(db);
  const [enabled, th] = await settings(db);
  if (!enabled) return [];
  await cancelArmed(db, opp.id, "Re-armed at dead disposition");
  const rule = opp.reactivation_rule && typeof opp.reactivation_rule === "object" && !Array.isArray(opp.reactivation_rule)
    ? opp.reactivation_rule
    : {};
  const out: ReactivationTrigger[] = [];
  const rtype = rule.type;
  const params = rule.params || {};
  if (rtype && rtype in TYPE_LABELS) out.push(await arm(db, opp, rtype, params, { origin: "rule", th, actor }));
  if ((th.backstop_by_dead_reason ?? true) && rtype !== "time") {
    const days = REVISIT_DAYS_BY_REASON[opp.dead_reason || "other"] ?? 365;
    out.push(await arm(db, opp, "time", { after_days: days }, { origin: "dead_reason_backstop", th, actor }));
  }
  return out;
}

// ----------------------------------------------------------------------------- evaluation

async function newSignals(db: Db, t: ReactivationTrigger, categories: Set<string>): Promise<any[]> {
  if (!t.property_id) return [];
  const rows = await propertySignalRows(db, t.property_id, { live_only: true });
  return rows.filter((s: any) => categories.has(s.category) && s.created_at.getTime() >= t.armed_at.getTime());
}

function signalChange(s: any): Change {
  const label = !s.is_sensitive ? s.title || humanize(s.signal_type) : humanize(s.signal_type);
  return {
    label: `New ${s.category} signal: ${label} (severity ${s.severity})`, from: null, to: String(s.observed_on),
    source: s.is_sensitive ? "Internal" : s.source, observed_on: String(s.observed_on), signal_id: String(s.id),
  };
}

function dateReached(t: ReactivationTrigger, today: string, label: string): Change[] {
  if (t.fire_on && today >= t.fire_on) {
    return [{ label, from: t.armed_at.toISOString().slice(0, 10), to: t.fire_on, source: "Reactivation rule", observed_on: today }];
  }
  return [];
}

function compare(actual: any, op: string, value: any, baseline: any = null): boolean {
  if (op === "changed") return !audit.isEqual(toJsonable(actual), baseline);
  if (isNone(actual)) return false;
  let a: any = num(actual);
  let v: any = num(value);
  if (a === null || v === null) {
    a = String(actual).trim().toLowerCase();
    v = String(value).trim().toLowerCase();
  }
  const r: Record<string, boolean> = { lt: a < v, lte: a <= v, gt: a > v, gte: a >= v, eq: a === v, neq: a !== v };
  return r[op] ?? false;
}

async function evalDebt(db: Db, t: ReactivationTrigger, today: string, th: Params): Promise<Change[]> {
  const p = t.params ?? {};
  const event = p.event;
  const known = new Set<string>((t.baseline ?? {}).debt_flags ?? []);
  // Only debt conditions that were not already known when the deal died count as "what changed".
  const changes = (await loanFlags(db, t.property_id, event, today, th)).filter((c) => !known.has(c.label));
  const cats = new Set(["debt"]);
  if (event === "lien_or_default") cats.add("legal");
  changes.push(...(await newSignals(db, t, cats)).map(signalChange));
  return changes.length ? changes : dateReached(t, today, `Expected ${humanize(String(event || "debt"))} window reached`);
}

async function loanFlags(db: Db, propertyId: string | null | undefined, event: string | null | undefined, today: string, th: Params): Promise<Change[]> {
  const window = Math.trunc(Number(th.debt_window_days ?? 180));
  const horizon = addDays(today, window);
  const changes: Change[] = [];
  if (!propertyId) return changes;
  const rows = await db.select().from(loans).where(and(eq(loans.property_id, propertyId), isNull(loans.deleted_at)));
  for (const loan of rows as Array<Record<string, any>>) {
    const lender = loan.lender_name || "lender";
    const maturity = parseDate(loan.maturity_on);
    if ((isNone(event) || event === "maturity") && maturity && maturity <= horizon) {
      changes.push({
        label: `Loan with ${lender} matures ${fmtDate(maturity)}`, from: null, to: maturity, source: "Debt module", observed_on: today,
      });
    }
    const cap = parseDate(loan.cap_expires_on);
    if (event === "rate_reset" && cap && cap <= horizon) {
      changes.push({
        label: `Rate cap with ${lender} expires ${fmtDate(cap)}`, from: null, to: cap, source: "Debt module", observed_on: today,
      });
    }
    if (event === "lockout_end" || event === "defeasance_window") {
      const pp = loan.prepayment && typeof loan.prepayment === "object" ? loan.prepayment : {};
      const keys = event === "lockout_end"
        ? ["lockout_end", "lockout_ends_on", "lockout_until"]
        : ["defeasance_open", "defeasance_from", "defeasance_window_start", "open_prepayment_on"];
      for (const k of keys) {
        const d = parseDate(pp[k]);
        if (d && d <= horizon) {
          changes.push({
            label: `${capitalize(humanize(event))} on ${fmtDate(d)}`, from: null, to: d, source: "Debt module", observed_on: today,
          });
          break;
        }
      }
    }
    const loanStatus = String(loan.status || "").toLowerCase();
    if (event === "lien_or_default" && ["default", "defaulted", "delinquent", "special_servicing"].includes(loanStatus)) {
      changes.push({
        label: `Loan with ${lender} is ${humanize(loanStatus)}`, from: null, to: loanStatus, source: "Debt module", observed_on: today,
      });
    }
  }
  return changes;
}

/** Returns the list of changes that satisfy the trigger (empty = not fired). */
export async function evaluate(db: Db, t: ReactivationTrigger, th: Params, todayArg?: string): Promise<Change[]> {
  const today = todayArg ?? todayStr();
  const p = t.params ?? {};
  const prop = t.property_id ? await get(db, properties, t.property_id) : undefined;
  const base = t.baseline ?? {};
  const kind = t.trigger_type;

  if (kind === "time") {
    const reason = (t.dead_reason || "").replace(/_/g, " ");
    return dateReached(t, today, "Revisit date reached" + (reason ? ` (dead reason: ${reason})` : ""));
  }

  if (kind === "debt") return evalDebt(db, t, today, th);

  if (kind === "price") {
    const changes: Change[] = [];
    const asking = prop ? prop.asking_price : null;
    const before = num(base.asking_price);
    const target = num(p.target_price);
    const drop = num(p.drop_pct);
    if (!isNone(asking) && target !== null && asking! <= target) {
      changes.push({
        label: `Asking price $${commas(asking!)} is at or below target $${commas(target)}`, from: before, to: asking,
        source: "Property record", observed_on: today,
      });
    }
    if (!isNone(asking) && before && drop && asking! <= before * (1 - drop / 100)) {
      changes.push({
        label: `Asking price dropped ${((100 * (before - asking!)) / before).toFixed(1)}% ($${commas(before)} → $${commas(asking!)})`,
        from: before, to: asking, source: "Property record", observed_on: today,
      });
    }
    if (p.on_listing) {
      if (prop && prop.status === "listed" && base.property_status !== "listed") {
        changes.push({
          label: "Property is now listed for sale", from: base.property_status ?? null, to: "listed",
          source: "Property record", observed_on: today,
        });
      }
      changes.push(
        ...(await newSignals(db, t, new Set(["behavioral"])))
          .filter((s) => ["listed_for_sale", "price_reduction"].includes(s.signal_type))
          .map(signalChange),
      );
    }
    return changes;
  }

  if (kind === "ownership") {
    const event = p.event || "any_change";
    const nowOwners = new Set(await currentOwners(db, t.property_id));
    const was = new Set<string>(base.owners ?? []);
    const changes: Change[] = [];
    const sameSet = nowOwners.size === was.size && [...nowOwners].every((x) => was.has(x));
    const changed = !sameSet;
    const sale = was.size > 0 && nowOwners.size > 0 && ![...nowOwners].some((x) => was.has(x));
    if ((event === "any_change" && changed) || (event === "sale" && sale) || (event === "entity_change" && changed && !sale)) {
      changes.push({
        label: "Ownership changed" + (sale ? " (sold to a new owner)" : ""), from: [...was].sort(), to: [...nowOwners].sort(),
        source: "Ownership records", observed_on: today,
      });
    }
    let sig = await newSignals(db, t, event === "estate_or_succession" ? new Set(["ownership", "legal"]) : new Set(["ownership"]));
    if (event === "estate_or_succession") {
      sig = sig.filter((s) => ["probate_estate", "owner_age_succession"].includes(s.signal_type) || s.category === "ownership");
    }
    changes.push(...sig.map(signalChange));
    return changes;
  }

  if (kind === "lease") {
    const changes = (await newSignals(db, t, new Set(["tenancy"]))).map(signalChange);
    return changes.length ? changes : dateReached(t, today, `Expected lease ${humanize(String(p.event ?? "event"))} window reached`);
  }

  if (kind === "market") {
    const { metric, direction } = p;
    const threshold = num(p.threshold);
    const changes: Change[] = [];
    for (const s of await newSignals(db, t, new Set(["market"]))) {
      const details = s.details ?? {};
      const value = num(details.value);
      if (value !== null && threshold !== null && (isNone(details.metric) || details.metric === metric)) {
        if ((direction === "above" && value > threshold) || (direction === "below" && value < threshold)) {
          const ch = signalChange(s);
          ch.label = `${capitalize(humanize(String(metric)))} ${value} is ${direction} ${threshold}`;
          changes.push(ch);
        }
      } else if (s.signal_type === MARKET_TYPES[metric]) {
        changes.push(signalChange(s));
      }
    }
    return changes;
  }

  if (kind === "development") {
    const changes = (await newSignals(db, t, new Set(["development"]))).map(signalChange);
    if (prop && !isNone(prop.latitude) && !isNone(prop.longitude)) {
      const point = sql`ST_SetSRID(ST_MakePoint(${prop.longitude}::float8, ${prop.latitude}::float8), 4326)::geography`;
      const radius = Number(th.development_radius_miles ?? 3.0) * 1609.344;
      const rows = await raw<Record<string, any>>(
        db,
        sql`select kind, name, event_date, source, observed_on from growth_records
            where deleted_at is null and created_at >= ${t.armed_at.toISOString()}::timestamptz and location is not null
              and ST_DWithin(location::geography, ${point}, ${radius}::float8)
            limit 10`,
      );
      for (const g of rows) {
        changes.push({
          label: `New ${g.kind} nearby: ${g.name}`, from: null, to: g.event_date ? String(g.event_date).slice(0, 10) : null,
          source: g.source, observed_on: String(g.observed_on ?? today).slice(0, 10),
        });
      }
    }
    return changes;
  }

  if (kind === "relationship") return evalRelationship(db, t);

  if (kind === "manual") {
    const changes: Change[] = [];
    const { field, operator: op } = p;
    if (prop && field && op && field in prop) {
      const actual = (prop as Record<string, any>)[field];
      if (compare(actual, op, p.value, base.field_value)) {
        let label = `${capitalize(humanize(field))} is now ${toJsonable(actual)}`;
        label += op === "changed" ? " (changed)" : ` (${op} ${p.value})`;
        changes.push({
          label, from: base.field_value ?? null, to: toJsonable(actual), source: "Property record", observed_on: today,
        });
      }
    }
    return changes.length
      ? changes
      : dateReached(t, today, `Manual review date reached: ${p.description || ""}`.replace(/^[: ]+|[: ]+$/g, ""));
  }
  return [];
}

async function evalRelationship(db: Db, t: ReactivationTrigger): Promise<Change[]> {
  const opp = await get(db, opportunities, t.opportunity_id);
  const conds: SQL[] = [eq(interactions.opportunity_id, t.opportunity_id)];
  if (t.property_id) conds.push(eq(interactions.property_id, t.property_id));
  if (opp && opp.primary_person_id) conds.push(eq(interactions.person_id, opp.primary_person_id));
  if (opp && opp.primary_organization_id) conds.push(eq(interactions.organization_id, opp.primary_organization_id));
  for (const owner of ((t.baseline ?? {}).owners ?? []) as string[]) {
    const i = owner.indexOf(":");
    const kind = i >= 0 ? owner.slice(0, i) : owner;
    const oid = i >= 0 ? owner.slice(i + 1) : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oid)) continue;
    conds.push(kind === "person" ? eq(interactions.person_id, oid) : eq(interactions.organization_id, oid));
  }
  const rows = await db
    .select()
    .from(interactions)
    .where(
      and(
        isNull(interactions.deleted_at),
        gte(interactions.occurred_at, t.armed_at),
        or(...conds),
        or(
          inArray(interactions.disposition, [...POSITIVE_DISPOSITIONS]),
          and(eq(interactions.direction, "inbound"), eq(interactions.is_meaningful, true)),
        ),
      ),
    )
    .orderBy(desc(interactions.occurred_at))
    .limit(5);
  return rows.map((i) => ({
    label: `${i.direction === "inbound" ? "Inbound" : "Positive"} ${i.channel}` +
      (i.disposition ? ` (${humanize(i.disposition)})` : "") + (i.summary ? `: ${i.summary.slice(0, 140)}` : ""),
    from: null, to: i.disposition, source: "Outreach log", observed_on: i.occurred_at.toISOString().slice(0, 10),
    interaction_id: String(i.id),
  }));
}

// ----------------------------------------------------------------------------- firing

export async function originalContext(db: Db, opp: any, t: ReactivationTrigger | null = null): Promise<Record<string, any>> {
  const [last] = await db
    .select({ s: opportunityEvents.from_stage })
    .from(opportunityEvents)
    .where(and(eq(opportunityEvents.opportunity_id, opp.id), eq(opportunityEvents.to_stage, "dead")))
    .orderBy(desc(opportunityEvents.at))
    .limit(1);
  let ownerName: string | null = null;
  if (opp.owner_id) {
    const [u] = await db.select({ n: users.full_name }).from(users).where(eq(users.id, opp.owner_id)).limit(1);
    ownerName = u?.n ?? null;
  }
  const p = opp.property_id ? await get(db, properties, opp.property_id) : undefined;
  const ctx: Record<string, any> = {
    title: opp.title, dead_reason: opp.dead_reason, dead_notes: opp.dead_notes, dead_at: opp.dead_at,
    last_stage: last?.s ?? null, price_gap: opp.price_gap, price_expectation: opp.price_expectation,
    offer_price: opp.offer_price, estimated_value: opp.estimated_value, owner_id: opp.owner_id,
    owner_name: ownerName, property_label: p ? p.name || p.address_line : null,
    asking_price_at_dead: t ? (t.baseline ?? {}).asking_price ?? null : null,
    asking_price_now: p ? p.asking_price : null,
    reactivation_rule: opp.reactivation_rule,
  };
  if (opp.primary_person_id) {
    const [r] = await db.select({ n: people.full_name }).from(people).where(eq(people.id, opp.primary_person_id)).limit(1);
    ctx.primary_person = r?.n ?? null;
  }
  if (opp.primary_organization_id) {
    const [r] = await db
      .select({ n: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, opp.primary_organization_id))
      .limit(1);
    ctx.primary_organization = r?.n ?? null;
  }
  return toJsonable(ctx);
}

export async function fire(
  db: Db, t: ReactivationTrigger, changes: Change[], th: Params, actor: CurrentUser | null = null,
): Promise<ReactivationItem | null> {
  const opp = await get(db, opportunities, t.opportunity_id);
  if (!opp || opp.deleted_at || opp.stage !== "dead") {
    await patch(db, reactivationTriggers, t, { status: "cancelled", cancelled_reason: "Opportunity is no longer dead" });
    return null;
  }
  const now = utcnow();
  await patch(db, reactivationTriggers, t, { status: "fired", fired_at: now });
  await cancelArmed(db, opp.id, `Superseded by fired ${t.trigger_type} trigger`, { keep: t.id });
  let scoreBefore: number | null = null;
  let scoreAfter: number | null = null;
  if (opp.property_id) {
    const cur = await scoring.currentScore(db, opp.property_id);
    scoreBefore = cur ? cur.score : null;
    if (th.rescore ?? true) {
      const row = await scoring.rescoreProperty(db, opp.property_id, actor, { trigger: "reactivation" });
      scoreAfter = row ? row.score : null;
    }
  }
  const what = changes.map((c) => c.label).join("; ");
  let item = await insert(db, reactivationItems, {
    opportunity_id: opp.id, property_id: opp.property_id, trigger_id: t.id, trigger_type: t.trigger_type,
    owner_id: opp.owner_id, status: "pending", fired_at: now, what_changed: what.slice(0, 4000),
    changes: toJsonable(changes), original_context: await originalContext(db, opp, t),
    score_before: scoreBefore, score_after: scoreAfter, created_by_id: actor?.id ?? null, updated_by_id: actor?.id ?? null,
  });
  const reason = humanize(opp.dead_reason || "unspecified");
  const task = await createTask(db, {
    title: `Review reactivation: ${opp.title}`,
    description: `Trigger: ${describe(t.trigger_type, t.params)}.\nWhat changed: ${what}\nOriginally dead: ${reason}` +
      (opp.price_gap ? ` (price gap $${commas(Number(opp.price_gap))})` : ""),
    assignee_id: opp.owner_id, due_at: new Date(now.getTime() + Math.trunc(Number(th.task_due_days ?? 2)) * DAY_MS),
    task_type: "follow_up", priority: "high", related_type: "opportunity", related_id: opp.id, related_label: opp.title,
    source: "reactivation", idempotency_key: `reactivation:${item.id}`, actor_id: actor?.id ?? null,
  });
  item = await patch(db, reactivationItems, item, { task_id: task.id });
  await audit.record(db, {
    actor, action: "opportunity.reactivation_triggered", entity_type: "opportunity", entity_id: opp.id,
    summary: what.slice(0, 500), changes: { trigger: t.trigger_type, item_id: String(item.id) },
  });
  await recordRuleRun(db, RULE_KEY);
  await events.emit(db, "reactivation.fired", {
    item_id: item.id, opportunity_id: opp.id, property_id: opp.property_id, trigger_type: t.trigger_type, actor,
  });
  return item;
}

/** Evaluates armed triggers and fires the satisfied ones (first one per opportunity). Does not commit. */
export async function checkTriggers(db: Db, triggers: ReactivationTrigger[], actor: CurrentUser | null = null): Promise<ReactivationItem[]> {
  if (!triggers.length) return [];
  await ensureRule(db);
  const [enabled, th] = await settings(db);
  if (!enabled) return [];
  const fired: ReactivationItem[] = [];
  const done = new Set<string>();
  const now = utcnow();
  for (const t of triggers) {
    if (t.status !== "armed" || done.has(t.opportunity_id)) continue;
    await patch(db, reactivationTriggers, t, { last_checked_at: now, check_count: (t.check_count || 0) + 1 });
    const changes = await evaluate(db, t, th);
    if (changes.length) {
      const item = await fire(db, t, changes, th, actor);
      done.add(t.opportunity_id);
      if (item) fired.push(item);
    }
  }
  return fired;
}

const armedWhere = () => and(eq(reactivationTriggers.status, "armed"), isNull(reactivationTriggers.deleted_at));

export async function checkProperty(
  db: Db, propertyId: string | null | undefined, o: { types?: Set<string> | null; actor?: CurrentUser | null } = {},
): Promise<ReactivationItem[]> {
  if (!propertyId) return [];
  const { types = null, actor = null } = o;
  const rows = await db
    .select()
    .from(reactivationTriggers)
    .where(
      and(
        armedWhere(),
        eq(reactivationTriggers.property_id, propertyId),
        types && types.size ? inArray(reactivationTriggers.trigger_type, [...types]) : undefined,
      ),
    );
  return checkTriggers(db, rows, actor);
}

export async function checkOpportunities(
  db: Db, opportunityIds: string[], o: { types?: Set<string> | null; actor?: CurrentUser | null } = {},
): Promise<ReactivationItem[]> {
  if (!opportunityIds.length) return [];
  const { types = null, actor = null } = o;
  const rows = await db
    .select()
    .from(reactivationTriggers)
    .where(
      and(
        armedWhere(),
        inArray(reactivationTriggers.opportunity_id, opportunityIds),
        types && types.size ? inArray(reactivationTriggers.trigger_type, [...types]) : undefined,
      ),
    );
  return checkTriggers(db, rows, actor);
}

/** Periodic scan of every armed trigger plus waking snoozed items whose date has arrived. */
export async function scan(db: Db, actor: CurrentUser) {
  const today = todayStr();
  const woken = await db
    .select()
    .from(reactivationItems)
    .where(
      and(
        eq(reactivationItems.status, "snoozed"),
        sql`${reactivationItems.snoozed_until} <= ${today}`,
        isNull(reactivationItems.deleted_at),
      ),
    );
  for (const item of woken) {
    await patch(db, reactivationItems, item, { status: "pending", updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "reactivation_item.woken", entity_type: "reactivation_item", entity_id: item.id,
      summary: `Snooze ended ${item.snoozed_until}`,
    });
  }
  const triggers = await db.select().from(reactivationTriggers).where(armedWhere()).orderBy(reactivationTriggers.armed_at).limit(5000);
  let fired: ReactivationItem[];
  try {
    fired = await checkTriggers(db, triggers, actor);
    await audit.record(db, {
      actor, action: "reactivation.scanned", entity_type: "reactivation",
      summary: `${triggers.length} triggers checked, ${fired.length} fired, ${woken.length} woken`, ip_address: actor.ip_address,
    });
    await db.commit();
  } catch (exc) {
    // observable failure on the automation registry, then re-raised
    await db.rollback();
    const e = exc as Error;
    await recordRuleRun(db, RULE_KEY, { error: `${e?.name ?? "Error"}: ${e?.message ?? exc}` });
    await db.commit();
    throw exc;
  }
  return { checked: triggers.length, fired: fired.length, woken: woken.length, items: fired.map((i) => i.id) };
}

// ----------------------------------------------------------------------------- queue

export const effectiveStatusExpr = () =>
  sql<string>`case when ${reactivationItems.status} = 'snoozed' and ${reactivationItems.snoozed_until} <= current_date then 'pending' else ${reactivationItems.status} end`;

export interface ItemFilters {
  q?: string;
  status_?: string[];
  trigger_type?: string[];
  owner_id?: string[];
  opportunity_id?: string;
  property_id?: string;
  actor_id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WHERE clause over reactivation_items joined to opportunities. */
export function itemWhere(f: ItemFilters, skip: Set<string> = new Set()): SQL | undefined {
  const eff = effectiveStatusExpr();
  let ownerCond: SQL | undefined;
  if (!skip.has("owner_id") && f.owner_id?.length) {
    const ids: string[] = [];
    for (const o of f.owner_id) {
      if (o === "me" && f.actor_id) ids.push(f.actor_id);
      else if (UUID_RE.test(o)) ids.push(o.toLowerCase());
    }
    if (ids.length) ownerCond = inArray(reactivationItems.owner_id, ids);
  }
  return and(
    isNull(reactivationItems.deleted_at),
    applySearch(f.q, [opportunities.title, reactivationItems.what_changed]),
    !skip.has("status") && f.status_?.length ? inArray(eff, f.status_) : undefined,
    skip.has("trigger_type") ? undefined : inFilter(reactivationItems.trigger_type, f.trigger_type),
    ownerCond,
    f.opportunity_id ? eq(reactivationItems.opportunity_id, f.opportunity_id) : undefined,
    f.property_id ? eq(reactivationItems.property_id, f.property_id) : undefined,
  );
}

export async function itemOuts(db: Db, rows: ReactivationItem[]) {
  if (!rows.length) return [];
  const opps = new Map(
    (await db.select().from(opportunities).where(inArray(opportunities.id, [...new Set(rows.map((r) => r.opportunity_id))]))).map(
      (o) => [o.id, o],
    ),
  );
  const trigIds = [...new Set(rows.map((r) => r.trigger_id).filter((x): x is string => !!x))];
  const trigs = trigIds.length
    ? new Map((await db.select().from(reactivationTriggers).where(inArray(reactivationTriggers.id, trigIds))).map((t) => [t.id, t]))
    : new Map<string, ReactivationTrigger>();
  const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter((x): x is string => !!x))];
  const names = ownerIds.length
    ? new Map((await db.select({ id: users.id, n: users.full_name }).from(users).where(inArray(users.id, ownerIds))).map((u) => [u.id, u.n]))
    : new Map<string, string>();
  const today = todayStr();
  return rows.map((r) => {
    const opp = opps.get(r.opportunity_id);
    const t = r.trigger_id ? trigs.get(r.trigger_id) : undefined;
    return {
      id: r.id,
      opportunity_id: r.opportunity_id,
      opportunity_title: opp ? opp.title : null,
      opportunity_stage: opp ? opp.stage : null,
      property_id: r.property_id,
      property_label: (r.original_context ?? {}).property_label ?? null,
      trigger_id: r.trigger_id,
      trigger_type: r.trigger_type,
      trigger_description: t ? describe(t.trigger_type, t.params) : null,
      owner_id: r.owner_id,
      owner_name: r.owner_id ? names.get(r.owner_id) ?? null : null,
      status: r.status,
      effective_status: r.status === "snoozed" && r.snoozed_until && r.snoozed_until <= today ? "pending" : r.status,
      fired_at: r.fired_at,
      what_changed: r.what_changed,
      changes: r.changes,
      original_context: r.original_context,
      score_before: r.score_before,
      score_after: r.score_after,
      snoozed_until: r.snoozed_until,
      decided_by_id: r.decided_by_id,
      decided_at: r.decided_at,
      decision_reason: r.decision_reason,
      reactivated_to_stage: r.reactivated_to_stage,
      converted: r.converted,
      converted_at: r.converted_at,
      task_id: r.task_id,
      created_at: r.created_at,
    };
  });
}

export async function triggerOuts(db: Db, rows: ReactivationTrigger[]) {
  if (!rows.length) return [];
  const titles = new Map(
    (
      await db
        .select({ id: opportunities.id, title: opportunities.title })
        .from(opportunities)
        .where(inArray(opportunities.id, [...new Set(rows.map((r) => r.opportunity_id))]))
    ).map((o) => [o.id, o.title]),
  );
  const pids = [...new Set(rows.map((r) => r.property_id).filter((x): x is string => !!x))];
  const props = pids.length
    ? new Map(
        (
          await db
            .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
            .from(properties)
            .where(inArray(properties.id, pids))
        ).map((p) => [p.id, p.name || p.address_line]),
      )
    : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    opportunity_id: r.opportunity_id,
    opportunity_title: titles.get(r.opportunity_id) ?? null,
    property_id: r.property_id,
    property_label: r.property_id ? props.get(r.property_id) ?? null : null,
    trigger_type: r.trigger_type,
    params: r.params,
    origin: r.origin,
    status: r.status,
    armed_at: r.armed_at,
    fire_on: r.fire_on,
    fired_at: r.fired_at,
    last_checked_at: r.last_checked_at,
    check_count: r.check_count,
    baseline: r.baseline,
    dead_reason: r.dead_reason,
    cancelled_reason: r.cancelled_reason,
    description: describe(r.trigger_type, r.params),
  }));
}

export async function getItem(db: Db, itemId: string): Promise<ReactivationItem> {
  const item = await get(db, reactivationItems, itemId);
  if (!item || item.deleted_at) throw new HttpError(404, "Reactivation item not found");
  return item;
}

export async function getTrigger(db: Db, triggerId: string): Promise<ReactivationTrigger> {
  const t = await get(db, reactivationTriggers, triggerId);
  if (!t || t.deleted_at) throw new HttpError(404, "Trigger not found");
  return t;
}

function assertOpen(item: ReactivationItem): void {
  if (!["pending", "snoozed"].includes(item.status)) throw new HttpError(409, `This item was already ${item.status}`);
}

export async function reactivate(
  db: Db, item: ReactivationItem, toStage: string, overrideReason: string | null | undefined, note: string | null | undefined,
  fields: Record<string, any>, actor: CurrentUser,
): Promise<ReactivationItem> {
  assertOpen(item);
  if (!actor.can("pipeline", "edit")) throw new HttpError(403, "Reactivating an opportunity requires pipeline:edit");
  if (![...ACTIVE_STAGES, "nurture"].includes(toStage as never)) throw new HttpError(422, "Choose an active pipeline stage or nurture");
  const opp = await pipeline.get(db, item.opportunity_id);
  if (opp.stage !== "dead") throw new HttpError(409, `The opportunity is already in ${humanize(opp.stage)}`);
  const now = utcnow();
  await patch(db, reactivationItems, item, {
    status: "reactivated", decided_by_id: actor.id, decided_at: now, reactivated_to_stage: toStage,
    decision_reason: (note || "").trim() || null, updated_by_id: actor.id,
  });
  await cancelArmed(db, opp.id, "Opportunity reactivated");
  await audit.record(db, {
    actor, action: "reactivation_item.reactivated", entity_type: "reactivation_item", entity_id: item.id,
    summary: `→ ${humanize(toStage)}`, ip_address: actor.ip_address,
    changes: item.decision_reason ? { note: item.decision_reason } : null,
  });
  await audit.record(db, {
    actor, action: "opportunity.reactivated", entity_type: "opportunity", entity_id: opp.id,
    summary: `Reactivated to ${humanize(toStage)} — ${item.what_changed.slice(0, 300)}`, ip_address: actor.ip_address,
  });
  const parsed = opportunityUpdate.safeParse(fields);
  if (!parsed.success) {
    throw new HttpError(422, `Invalid opportunity fields: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  }
  // Stage gates apply; an override needs a reason and pipeline:approve. move() commits everything above.
  await pipeline.move(db, opp, { to_stage: toStage, fields: parsed.data, override_reason: overrideReason ?? null } as never, actor);
  return item;
}

export async function snooze(
  db: Db, item: ReactivationItem, until: string, reason: string | null | undefined, actor: CurrentUser,
): Promise<ReactivationItem> {
  assertOpen(item);
  if (until <= todayStr()) throw new HttpError(422, "Snooze until a future date");
  const before = item.snoozed_until;
  await patch(db, reactivationItems, item, {
    status: "snoozed", snoozed_until: until, updated_by_id: actor.id,
    decision_reason: (reason || "").trim() || item.decision_reason,
  });
  await audit.record(db, {
    actor, action: "reactivation_item.snoozed", entity_type: "reactivation_item", entity_id: item.id,
    summary: `Until ${fmtDate(until)}` + (reason ? `: ${reason}` : ""),
    changes: { snoozed_until: { from: toJsonable(before), to: until } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return item;
}

export async function dismiss(
  db: Db, item: ReactivationItem, reason: string, rearm: boolean, actor: CurrentUser,
): Promise<ReactivationItem> {
  assertOpen(item);
  const now = utcnow();
  await patch(db, reactivationItems, item, {
    status: "dismissed", decided_by_id: actor.id, decided_at: now, decision_reason: reason.trim(), updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "reactivation_item.dismissed", entity_type: "reactivation_item", entity_id: item.id,
    summary: reason.trim(), ip_address: actor.ip_address,
  });
  const opp = await get(db, opportunities, item.opportunity_id);
  const trig = item.trigger_id ? await get(db, reactivationTriggers, item.trigger_id) : undefined;
  if (rearm && opp && opp.stage === "dead" && trig) {
    const params = await rearmParams(db, trig, opp);
    if (params !== null) {
      const [, th] = await settings(db);
      await arm(db, opp, trig.trigger_type, params, { origin: "rearm", th, actor });
    }
  }
  await db.commit();
  return item;
}

/** Same watch again from now; dates already passed are dropped so the trigger does not fire immediately. */
async function rearmParams(db: Db, trig: ReactivationTrigger, opp: { dead_reason: string | null }): Promise<Params | null> {
  const params: Params = { ...(trig.params ?? {}) };
  const today = todayStr();
  if (trig.trigger_type === "time") {
    const days = num(params.after_days) || REVISIT_DAYS_BY_REASON[opp.dead_reason || "other"] || 365;
    return { after_days: Math.trunc(days) };
  }
  const [, th] = await settings(db);
  let d = parseDate(params.date);
  if (d && addDays(d, -Math.trunc(Number(th.debt_window_days ?? 180))) <= today) delete params.date;
  d = parseDate(params.review_on);
  if (d && d <= today) delete params.review_on;
  if (trig.trigger_type === "manual" && !params.field && !params.review_on) return null;
  return params;
}

export async function updateTrigger(db: Db, t: ReactivationTrigger, params: Params, actor: CurrentUser): Promise<ReactivationTrigger> {
  if (t.status !== "armed") throw new HttpError(409, "Only armed triggers can be edited");
  validate(t.trigger_type, params);
  const [, th] = await settings(db);
  const before = t.params;
  await patch(db, reactivationTriggers, t, {
    params: toJsonable(params), fire_on: fireOn(t.trigger_type, params, t.armed_at.toISOString().slice(0, 10), th),
    updated_by_id: actor.id,
  });
  const opp = await get(db, opportunities, t.opportunity_id);
  if (opp && t.trigger_type === "manual") {
    await patch(db, reactivationTriggers, t, { baseline: await baselineOf(db, opp, t.trigger_type, params) });
  }
  await audit.record(db, {
    actor, action: "reactivation_trigger.updated", entity_type: "opportunity", entity_id: t.opportunity_id,
    summary: describe(t.trigger_type, params), changes: { params: { from: before, to: t.params } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function cancelTrigger(db: Db, t: ReactivationTrigger, reason: string, actor: CurrentUser): Promise<ReactivationTrigger> {
  if (t.status !== "armed") throw new HttpError(409, "Only armed triggers can be cancelled");
  await patch(db, reactivationTriggers, t, { status: "cancelled", cancelled_reason: reason.trim(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "reactivation_trigger.cancelled", entity_type: "opportunity", entity_id: t.opportunity_id,
    summary: `${describe(t.trigger_type, t.params)}: ${reason.trim()}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function armManual(
  db: Db, opportunityId: string, triggerType: string | null | undefined, params: Params | null | undefined, actor: CurrentUser,
): Promise<ReactivationTrigger[]> {
  const opp = await pipeline.get(db, opportunityId);
  if (opp.stage !== "dead") throw new HttpError(409, "Only dead opportunities can be armed for reactivation");
  let rows: ReactivationTrigger[];
  if (triggerType) {
    validate(triggerType, params ?? {});
    const [, th] = await settings(db);
    rows = [await arm(db, opp, triggerType, params ?? {}, { origin: "manual", th, actor })];
  } else {
    rows = await armFromOpportunity(db, opp, actor);
  }
  await db.commit();
  return rows;
}

// ----------------------------------------------------------------------------- analytics

export async function analytics(db: Db, sinceDays?: number | null) {
  const conds: SQL[] = [isNull(reactivationItems.deleted_at)];
  if (sinceDays) conds.push(gte(reactivationItems.fired_at, new Date(utcnow().getTime() - sinceDays * DAY_MS)));
  const itemRows = await db
    .select({
      t: reactivationItems.trigger_type, s: reactivationItems.status, c: reactivationItems.converted,
      n: sql<number>`count(*)::int`,
    })
    .from(reactivationItems)
    .where(and(...conds))
    .groupBy(reactivationItems.trigger_type, reactivationItems.status, reactivationItems.converted);
  const armedRows = await db
    .select({ t: reactivationTriggers.trigger_type, n: sql<number>`count(*)::int` })
    .from(reactivationTriggers)
    .where(armedWhere())
    .groupBy(reactivationTriggers.trigger_type);
  const armed = new Map(armedRows.map((r) => [r.t, Number(r.n)]));
  const lagRows = await db
    .select({
      t: reactivationItems.trigger_type,
      a: sql<string | null>`avg(extract(epoch from (${reactivationItems.fired_at} - ${reactivationTriggers.armed_at})) / 86400)`,
    })
    .from(reactivationItems)
    .innerJoin(reactivationTriggers, eq(reactivationTriggers.id, reactivationItems.trigger_id))
    .where(and(...conds))
    .groupBy(reactivationItems.trigger_type);
  const lag = new Map(lagRows.map((r) => [r.t, r.a]));

  const blank = () => ({ fired: 0, pending: 0, snoozed: 0, reactivated: 0, converted: 0, dismissed: 0 });
  const agg: Record<string, Record<string, number>> = {};
  for (const { t, s, c, n } of itemRows) {
    const a = (agg[t] ??= blank());
    a.fired += Number(n);
    if (s in a) a[s] += Number(n);
    if (c) a.converted += Number(n);
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const byType = Object.keys(TYPE_LABELS).map((ttype) => {
    const a = agg[ttype] ?? blank();
    const decided = a.reactivated + a.dismissed;
    const l = lag.get(ttype);
    return {
      trigger_type: ttype, label: TYPE_LABELS[ttype], armed: armed.get(ttype) ?? 0, ...a,
      noise_rate: decided ? r3(a.dismissed / decided) : null,
      reactivation_rate: decided ? r3(a.reactivated / decided) : null,
      conversion_rate: a.reactivated ? r3(a.converted / a.reactivated) : null,
      avg_days_dead_to_fire: l !== null && l !== undefined ? Math.round(Number(l) * 10) / 10 : null,
    };
  });
  const reasons = await db
    .select({
      t: reactivationItems.trigger_type, r: reactivationItems.decision_reason, n: sql<number>`count(*)::int`,
    })
    .from(reactivationItems)
    .where(and(...conds, eq(reactivationItems.status, "dismissed")))
    .groupBy(reactivationItems.trigger_type, reactivationItems.decision_reason)
    .orderBy(desc(sql`count(*)`))
    .limit(10);
  const totals = Object.fromEntries(
    ["armed", "fired", "pending", "snoozed", "reactivated", "converted", "dismissed"].map((k) => [
      k, byType.reduce((acc, t) => acc + ((t as Record<string, any>)[k] as number), 0),
    ]),
  );
  return {
    totals, by_type: byType,
    top_dismiss_reasons: reasons.map((r) => ({ trigger_type: r.t, reason: r.r, count: Number(r.n) })),
  };
}

export async function markConverted(db: Db, opportunityId: string): Promise<void> {
  const now = utcnow();
  const rows = await db
    .select()
    .from(reactivationItems)
    .where(
      and(
        eq(reactivationItems.opportunity_id, opportunityId),
        eq(reactivationItems.status, "reactivated"),
        eq(reactivationItems.converted, false),
      ),
    );
  for (const item of rows) await patch(db, reactivationItems, item, { converted: true, converted_at: now });
}

/** Opportunity moved out of dead outside the queue: close open items and disarm triggers. */
export async function onLeftDead(db: Db, opportunityId: string, toStage: string, actor: CurrentUser | null = null): Promise<void> {
  const now = utcnow();
  await cancelArmed(db, opportunityId, `Opportunity moved to ${humanize(toStage)}`);
  const rows = await db
    .select()
    .from(reactivationItems)
    .where(and(eq(reactivationItems.opportunity_id, opportunityId), inArray(reactivationItems.status, ["pending", "snoozed"])));
  for (const item of rows) {
    await patch(db, reactivationItems, item, {
      status: "reactivated", decided_at: now, decided_by_id: actor?.id ?? null, reactivated_to_stage: toStage,
      decision_reason: item.decision_reason || "Moved out of dead in the pipeline",
    });
  }
}
