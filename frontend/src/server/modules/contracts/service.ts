/**
 * Contracts, critical dates & due diligence (spec 16).
 *
 * Public API used by other modules (import lazily inside functions):
 *
 *     const { upsertCriticalDate, addBusinessDays } = await import("../contracts/service");
 *
 * `upsertCriticalDate` is idempotent on (related_type, related_id, key or date_type) and never commits.
 * AI-sourced dates are always stored as 'proposed'; a computed/AI value never overwrites a human-confirmed
 * date (it is parked in `proposed_due_on` for review instead).
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { auditEvents } from "../../common/schema";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { newId } from "../../db/columns";
import { get, insert, insertMany, patch, remove } from "../../db/orm";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { addDays, diffDays, endOfDay, isIsoDate, mod, today, weekday, yearOf, ymd } from "./dates";
import {
  CRITICAL_DATE_STATUSES, DD_DONE, EXCEPTION_OPEN, HIGH_SEVERITIES, OPEN_DATE_STATUSES, contractDecisions, contracts,
  criticalDateEvents, criticalDates, ddItems, ddTemplates, estoppels, holidayCalendars, holidays, riskItems,
  thirdPartyReports, titleExceptions,
  type Contract, type ContractDecision, type CriticalDate, type DDItem, type DDTemplate, type Estoppel,
  type HolidayCalendar, type RiskItem, type ThirdPartyReport, type TitleException,
} from "./schema";
import type {
  ConfirmIn, ContractCreate, ContractUpdate, CriticalDateCreate, CriticalDateUpdate, DDItemCreate, DDItemUpdate,
  DDTemplateCreate, DDTemplateUpdate, DecisionCreate, EstoppelCreate, EstoppelUpdate, ExecuteIn, HolidayCalendarCreate,
  ReportCreate, ReportUpdate, RiskCreate, RiskDecideIn, RiskUpdate, TitleExceptionCreate, TitleExceptionUpdate,
} from "./schemas";

export { today };

export const ENTITY = "contract";
export const US_FEDERAL = "US_FEDERAL";

type Row = Record<string, any>;
type Actor = CurrentUser | null | undefined;

const OPEN = OPEN_DATE_STATUSES as readonly string[];
const DONE = DD_DONE as readonly string[];
const HIGH = HIGH_SEVERITIES as readonly string[];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const pick = (row: Row, keys: readonly string[]): Row => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/** Python truthiness for JSON-ish values. */
function truthy(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter(Boolean))] as string[];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function managerOf(db: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [r] = await db.select({ m: users.manager_id }).from(users).where(eq(users.id, userId)).limit(1);
  return r?.m ?? null;
}

async function propertyInfo(
  db: Db,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, [string | null, string | null]>> {
  const set = [...new Set([...ids].filter(Boolean))] as string[];
  if (!set.length) return new Map();
  const rows = await db
    .select({ id: properties.id, name: properties.name, address: properties.address_line, type: properties.property_type })
    .from(properties)
    .where(inArray(properties.id, set));
  return new Map(rows.map((r) => [r.id, [r.name || r.address || null, r.type] as [string | null, string | null]]));
}

/** Diff `values` against the row, persist the changed fields and return `{field: {from, to}}`. */
async function apply(db: Db, table: any, obj: Row, values: Row): Promise<Record<string, { from: any; to: any }>> {
  const changes = audit.diff(obj, values);
  const keys = Object.keys(changes);
  if (keys.length) await patch(db, table, obj as never, Object.fromEntries(keys.map((k) => [k, values[k]])) as never);
  return changes;
}

// =========================================================================== holiday calendars

function nthWeekday(year: number, month: number, wd: number, n: number): string {
  const first = ymd(year, month, 1);
  return addDays(first, mod(wd - weekday(first), 7) + 7 * (n - 1));
}

function lastWeekday(year: number, month: number, wd: number): string {
  const last = addDays(month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1), -1);
  return addDays(last, -mod(weekday(last) - wd, 7));
}

/** Observed US federal holidays for `year` (5 U.S.C. 6103). Saturday -> Friday, Sunday -> Monday. */
export function usFederalHolidays(year: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const fixed: Array<[number, number, string]> = [
    [1, 1, "New Year's Day"], [7, 4, "Independence Day"], [11, 11, "Veterans Day"], [12, 25, "Christmas Day"],
  ];
  if (year >= 2021) fixed.push([6, 19, "Juneteenth National Independence Day"]);
  for (const [month, day, name] of fixed) {
    const d = ymd(year, month, day);
    const wd = weekday(d);
    if (wd === 5) out.push([addDays(d, -1), `${name} (observed)`]);
    else if (wd === 6) out.push([addDays(d, 1), `${name} (observed)`]);
    else out.push([d, name]);
  }
  out.push(
    [nthWeekday(year, 1, 0, 3), "Birthday of Martin Luther King, Jr."],
    [nthWeekday(year, 2, 0, 3), "Washington's Birthday"],
    [lastWeekday(year, 5, 0), "Memorial Day"],
    [nthWeekday(year, 9, 0, 1), "Labor Day"],
    [nthWeekday(year, 10, 0, 2), "Columbus Day"],
    [nthWeekday(year, 11, 3, 4), "Thanksgiving Day"],
  );
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** Seeds computed holidays for rule-based calendars for any year not yet seeded (idempotent, no commit). */
export async function ensureHolidays(db: Db, cal: HolidayCalendar, years: Iterable<number>): Promise<void> {
  if (cal.rule_set !== "us_federal") return;
  const have = new Set<number>(cal.seeded_years ?? []);
  const missing = [...new Set([...years].map(Number))].filter((y) => !have.has(y)).sort((a, b) => a - b);
  if (!missing.length) return;
  const rows = missing.flatMap((y) =>
    usFederalHolidays(y).map(([d, name]) => ({
      id: newId(), calendar_id: cal.id, holiday_on: d, name, source: "rule", created_at: utcnow(),
    })),
  );
  await db.insert(holidays).values(rows).onConflictDoNothing({ target: [holidays.calendar_id, holidays.holiday_on] });
  await patch(db, holidayCalendars, cal, { seeded_years: [...new Set([...have, ...missing])].sort((a, b) => a - b) });
}

export async function ensureDefaultCalendar(db: Db): Promise<HolidayCalendar> {
  const find = async () =>
    (await db.select().from(holidayCalendars).where(eq(holidayCalendars.code, US_FEDERAL)).limit(1))[0];
  let cal = await find();
  if (!cal) {
    const now = utcnow();
    await db
      .insert(holidayCalendars)
      .values({
        id: newId(), code: US_FEDERAL, name: "US federal holidays",
        description: "Observed US federal holidays, computed from statutory rules.",
        weekend_days: [5, 6], is_default: true, rule_set: "us_federal", seeded_years: [],
        created_at: now, updated_at: now,
      })
      .onConflictDoNothing({ target: holidayCalendars.code });
    cal = await find();
  }
  const y = yearOf(today());
  await ensureHolidays(db, cal, range(y, y + 3));
  return cal;
}

export async function getCalendar(db: Db, calendar_id?: string | null): Promise<HolidayCalendar> {
  if (calendar_id) {
    const cal = await get(db, holidayCalendars, calendar_id);
    if (cal && !cal.deleted_at) return cal;
  }
  const [def] = await db
    .select()
    .from(holidayCalendars)
    .where(and(eq(holidayCalendars.is_default, true), isNull(holidayCalendars.deleted_at)))
    .orderBy(asc(holidayCalendars.created_at))
    .limit(1);
  return def ?? (await ensureDefaultCalendar(db));
}

async function holidaysBetween(db: Db, cal: HolidayCalendar, lo: string, hi: string): Promise<Set<string>> {
  // +1 year: a Saturday New Year's Day is observed on Dec 31 of the prior year.
  await ensureHolidays(db, cal, range(yearOf(lo), yearOf(hi) + 2));
  const rows = await db
    .select({ d: holidays.holiday_on })
    .from(holidays)
    .where(and(eq(holidays.calendar_id, cal.id), gte(holidays.holiday_on, lo), lte(holidays.holiday_on, hi)));
  return new Set(rows.map((r) => r.d));
}

/** `start` + `days` business days (negative counts backwards). The start day itself is never counted;
 *  weekends and holidays of the calendar (default: US federal) are skipped. Does not commit. */
export async function addBusinessDays(db: Db, start: string, days: number, calendar_id?: string | null): Promise<string> {
  const cal = await getCalendar(db, asUuid(calendar_id));
  const weekend = new Set<number>(cal.weekend_days?.length ? cal.weekend_days : [5, 6]);
  if (weekend.size >= 7) throw new HttpError(422, "Calendar has no business days");
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(days));
  const span = remaining * 2 + 14;
  const other = addDays(start, step * span);
  let [lo, hi] = start <= other ? [start, other] : [other, start];
  let hol = await holidaysBetween(db, cal, lo, hi);
  let d = start;
  while (remaining > 0) {
    d = addDays(d, step);
    if (d < lo || d > hi) {
      const a = addDays(d, -400);
      const b = addDays(d, 400);
      lo = a < lo ? a : lo;
      hi = b > hi ? b : hi;
      hol = await holidaysBetween(db, cal, lo, hi);
    }
    if (!weekend.has(weekday(d)) && !hol.has(d)) remaining -= 1;
  }
  return d;
}

export async function createCalendar(db: Db, data: HolidayCalendarCreate, actor: CurrentUser): Promise<HolidayCalendar> {
  const [dupe] = await db.select({ id: holidayCalendars.id }).from(holidayCalendars).where(eq(holidayCalendars.code, data.code)).limit(1);
  if (dupe) throw new HttpError(409, "A calendar with this code already exists");
  const weekend = [...new Set(data.weekend_days.map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (weekend.length >= 7) throw new HttpError(422, "A calendar needs at least one business day");
  const cal = await insert(db, holidayCalendars, {
    code: data.code, name: data.name, description: data.description ?? null, weekend_days: weekend,
    is_default: false, rule_set: null, seeded_years: [], created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  if (data.copy_from_id) {
    const src = await getCalendar(db, data.copy_from_id);
    const y = yearOf(today());
    await ensureHolidays(db, src, range(y, y + 3));
    const rows = await db.select().from(holidays).where(eq(holidays.calendar_id, src.id));
    await insertMany(
      db,
      holidays,
      rows.map((h) => ({
        calendar_id: cal.id, holiday_on: h.holiday_on, name: h.name, source: "manual", created_by_id: actor.id,
      })) as never,
    );
  }
  await audit.record(db, {
    actor, action: "holiday_calendar.created", entity_type: "holiday_calendar", entity_id: cal.id, summary: cal.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return cal;
}

export async function listHolidays(db: Db, cal: HolidayCalendar, year: number) {
  await ensureHolidays(db, cal, [year]);
  const rows = await db
    .select()
    .from(holidays)
    .where(and(eq(holidays.calendar_id, cal.id), gte(holidays.holiday_on, `${year}-01-01`), lte(holidays.holiday_on, `${year}-12-31`)))
    .orderBy(asc(holidays.holiday_on));
  await db.commit();
  return rows;
}

export async function addHoliday(db: Db, cal: HolidayCalendar, holiday_on: string, name: string, actor: CurrentUser) {
  await ensureHolidays(db, cal, [yearOf(holiday_on)]);
  const [dupe] = await db
    .select({ id: holidays.id })
    .from(holidays)
    .where(and(eq(holidays.calendar_id, cal.id), eq(holidays.holiday_on, holiday_on)))
    .limit(1);
  if (dupe) throw new HttpError(409, "This calendar already has a holiday on that date");
  const h = await insert(db, holidays, {
    calendar_id: cal.id, holiday_on, name, source: "manual", created_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "holiday_calendar.holiday_added", entity_type: "holiday_calendar", entity_id: cal.id,
    summary: `${holiday_on} ${name}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return h;
}

export async function deleteHoliday(db: Db, cal: HolidayCalendar, holiday_id: string, actor: CurrentUser): Promise<void> {
  const h = await get(db, holidays, holiday_id);
  if (!h || h.calendar_id !== cal.id) throw new HttpError(404, "Holiday not found");
  await audit.record(db, {
    actor, action: "holiday_calendar.holiday_removed", entity_type: "holiday_calendar", entity_id: cal.id,
    summary: `${h.holiday_on} ${h.name}`, ip_address: actor.ip_address,
  });
  await remove(db, holidays, h);
  await db.commit();
}

export async function isBusinessDay(db: Db, d: string, calendar_id?: string | null): Promise<boolean> {
  const cal = await getCalendar(db, asUuid(calendar_id));
  const weekend = new Set<number>(cal.weekend_days?.length ? cal.weekend_days : [5, 6]);
  if (weekend.has(weekday(d))) return false;
  return !(await holidaysBetween(db, cal, d, d)).has(d);
}

/** Next business day on or after `d` (calendar-day deadlines landing on a weekend/holiday). */
export async function rollForward(db: Db, d: string, calendar_id?: string | null): Promise<string> {
  if (await isBusinessDay(db, d, calendar_id)) return d;
  return addBusinessDays(db, d, 1, calendar_id);
}

/** Evaluates {"from": anchor, "days": n, "business_days": bool, "calendar_id": id, "roll_forward": bool}. */
export async function computeRuleDate(
  db: Db,
  rule: Row,
  anchors: Record<string, string>,
  default_calendar_id?: string | null,
): Promise<string | null> {
  const base = anchors[rule.from || "effective_on"];
  if (base === undefined || base === null) return null;
  const days = Math.trunc(Number(rule.days || 0));
  const cal = asUuid(rule.calendar_id) || default_calendar_id;
  if (rule.business_days) return addBusinessDays(db, base, days, cal);
  let d = addDays(base, days);
  if (rule.roll_forward) d = await rollForward(db, d, cal);
  return d;
}

// =========================================================================== critical-date engine

async function dateEvent(
  db: Db,
  cd: CriticalDate,
  kind: string,
  actor: Actor,
  o: { from_status?: string | null; to_status?: string | null; from_due?: string | null; to_due?: string | null;
    reason?: string | null; data?: Row | null } = {},
): Promise<void> {
  await db.insert(criticalDateEvents).values({
    critical_date_id: cd.id, kind, from_status: o.from_status ?? null, to_status: o.to_status ?? null,
    from_due_on: o.from_due ?? null, to_due_on: o.to_due ?? null, reason: o.reason ?? null,
    actor_id: actor?.id ?? null, actor_name: actor?.full_name ?? null, at: utcnow(),
    data: audit.toJsonable(o.data ?? {}),
  });
}

async function defaultOwner(db: Db, related_type: string, related_id: string): Promise<string | null> {
  if (related_type === "contract") {
    const [r] = await db.select({ o: contracts.owner_id }).from(contracts).where(eq(contracts.id, related_id)).limit(1);
    return r?.o ?? null;
  }
  if (related_type === "opportunity") {
    const [r] = await db.select({ o: opportunities.owner_id }).from(opportunities).where(eq(opportunities.id, related_id)).limit(1);
    return r?.o ?? null;
  }
  return null;
}

export interface UpsertOpts {
  related_type: string;
  related_id: string;
  date_type: string;
  label: string;
  due_on: string;
  property_id?: string | null;
  owner_id?: string | null;
  lead_days?: number;
  is_blocking?: boolean;
  source?: string;
  status?: string;
  key?: string | null;
  actor?: Actor;
  related_label?: string | null;
  rule?: Row | null;
  business_days?: boolean;
  calendar_id?: string | null;
  citation?: Row | null;
  notes?: string | null;
}

/**
 * Create or update the critical date identified by (related_type, related_id, key or date_type).
 *
 * - source='ai' is always stored as 'proposed' (human confirmation is mandatory).
 * - A 'proposed' value never overwrites a confirmed/missed date; it is parked in `proposed_due_on`.
 * - Completed/waived dates are left untouched.
 * - Every change is written to critical_date_events and the audit log. Does not commit.
 */
export async function upsertCriticalDate(db: Db, o: UpsertOpts): Promise<CriticalDate> {
  const { related_type, related_id, date_type, label, due_on, property_id, owner_id, related_label, citation, notes, actor } = o;
  const lead_days = o.lead_days ?? 14;
  const is_blocking = o.is_blocking ?? false;
  const source = o.source ?? "rule";
  const business_days = o.business_days ?? false;
  const calendar_id = o.calendar_id ?? null;
  let status = o.status ?? "confirmed";
  if (!(CRITICAL_DATE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid critical date status '${status}'`);
  }
  if (source === "ai") status = "proposed";
  const k = (o.key || date_type).slice(0, 80);
  const now = utcnow();
  const actor_id = actor?.id ?? null;
  const where = and(eq(criticalDates.related_type, related_type), eq(criticalDates.related_id, related_id), eq(criticalDates.key, k));
  const rule_json = o.rule && truthy(o.rule) ? audit.toJsonable(o.rule) : null;

  let [cd] = await db.select().from(criticalDates).where(where).limit(1);
  if (!cd) {
    const [ins] = await db
      .insert(criticalDates)
      .values({
        related_type, related_id, related_label: related_label ? related_label.slice(0, 300) : null, key: k,
        property_id: property_id ?? null, date_type, label: label.slice(0, 300), due_on, original_due_on: due_on,
        rule: rule_json, business_days, calendar_id, status, source,
        citation: citation && truthy(citation) ? audit.toJsonable(citation) : null,
        owner_id: owner_id || (await defaultOwner(db, related_type, related_id)), lead_days, is_blocking,
        notes: notes ?? null, escalation_level: 0, created_by_id: actor_id, updated_by_id: actor_id,
        ...(status === "confirmed"
          ? {
              confirmed_at: now, confirmed_by_id: actor_id,
              confirm_note: actor_id ? null : `Confirmed from verified ${source} source record`,
            }
          : {}),
      })
      // created concurrently: fall through to update
      .onConflictDoNothing({ target: [criticalDates.related_type, criticalDates.related_id, criticalDates.key] })
      .returning();
    if (ins) {
      await dateEvent(db, ins, "created", actor, {
        to_status: status, to_due: due_on, reason: `Source: ${source}`, data: { rule: rule_json, citation: ins.citation },
      });
      await audit.record(db, {
        actor, action: "critical_date.created", entity_type: "critical_date", entity_id: ins.id,
        summary: `${ins.label} · ${due_on} (${status})`,
      });
      return ins;
    }
    [cd] = await db.select().from(criticalDates).where(where).limit(1);
    if (!cd) throw new Error("critical date upsert failed");
  }

  const changes: Record<string, any> = {};
  const meta: Row = { label: label.slice(0, 300), date_type };
  if (related_label) meta.related_label = related_label.slice(0, 300);
  if (property_id && !cd.property_id) meta.property_id = property_id;
  if (owner_id && !cd.owner_id) meta.owner_id = owner_id;
  Object.assign(changes, await apply(db, criticalDates, cd, meta));

  if (cd.deleted_at !== null && cd.deleted_at !== undefined) {
    const prev_status = cd.status;
    const prev_due = cd.due_on;
    await patch(db, criticalDates, cd, { deleted_at: null });
    Object.assign(changes, await apply(db, criticalDates, cd, { status, due_on, source, rule: rule_json, proposed_due_on: null }));
    await dateEvent(db, cd, "restored", actor, {
      from_status: prev_status, to_status: status, from_due: prev_due, to_due: due_on, reason: `Re-created by ${source}`,
    });
  } else if (cd.status === "completed" || cd.status === "waived") {
    // finished dates are left untouched
  } else if ((cd.status === "confirmed" || cd.status === "missed") && status === "proposed") {
    // Never overwrite a human-confirmed deadline with a computed or AI value.
    const new_proposal = due_on !== cd.due_on ? due_on : null;
    if (new_proposal !== (cd.proposed_due_on ?? null)) {
      Object.assign(changes, await apply(db, criticalDates, cd, { proposed_due_on: new_proposal }));
      if (new_proposal) {
        await dateEvent(db, cd, "proposal_differs", actor, {
          from_due: cd.due_on, to_due: due_on, reason: `New ${source} value differs from the confirmed date`,
          data: { citation, rule: rule_json },
        });
      }
    }
  } else if (cd.status === "proposed") {
    if (due_on !== cd.due_on) {
      await dateEvent(db, cd, "rescheduled", actor, {
        from_due: cd.due_on, to_due: due_on, reason: `Recomputed (${source})`, data: { rule: rule_json },
      });
    }
    Object.assign(
      changes,
      await apply(db, criticalDates, cd, { due_on, source, rule: rule_json, business_days, calendar_id, proposed_due_on: null }),
    );
    if (citation && truthy(citation)) await patch(db, criticalDates, cd, { citation: audit.toJsonable(citation) });
    if (status === "confirmed") {
      Object.assign(changes, await apply(db, criticalDates, cd, { status: "confirmed", confirmed_at: now, confirmed_by_id: actor_id }));
      await dateEvent(db, cd, "confirmed", actor, {
        from_status: "proposed", to_status: "confirmed", reason: `Confirmed by verified ${source} source`,
      });
    }
  } else {
    // confirmed/missed date updated from a verified system of record (e.g. an amended lease).
    if (due_on !== cd.due_on) {
      await dateEvent(db, cd, "rescheduled", actor, {
        from_due: cd.due_on, to_due: due_on, reason: `Updated from verified ${source} source`,
      });
      Object.assign(changes, await apply(db, criticalDates, cd, { due_on, proposed_due_on: null }));
      if (cd.status === "missed" && due_on >= today()) {
        Object.assign(changes, await apply(db, criticalDates, cd, { status: "confirmed", escalation_level: 0 }));
      }
    }
    if (rule_json) Object.assign(changes, await apply(db, criticalDates, cd, { rule: rule_json }));
  }

  if (Object.keys(changes).length) {
    await patch(db, criticalDates, cd, { updated_by_id: actor_id });
    await audit.record(db, {
      actor, action: "critical_date.upserted", entity_type: "critical_date", entity_id: cd.id, summary: cd.label, changes,
    });
  }
  return cd;
}

export async function getDate(db: Db, date_id: string): Promise<CriticalDate> {
  const cd = await get(db, criticalDates, date_id);
  if (!cd || cd.deleted_at) throw new HttpError(404, "Critical date not found");
  return cd;
}

const DATE_OUT_KEYS = [
  "id", "related_type", "related_id", "related_label", "key", "property_id", "date_type", "label", "due_on",
  "original_due_on", "proposed_due_on", "rule", "business_days", "calendar_id", "status", "source", "citation",
  "confirmed_by_id", "confirmed_at", "confirm_note", "owner_id", "lead_days", "is_blocking", "completed_at",
  "completed_by_id", "resolution_note", "escalation_level", "notes", "updated_at",
] as const;

export async function dateOuts(db: Db, rows: CriticalDate[]): Promise<Row[]> {
  const names = await userNames(db, [...rows.map((r) => r.owner_id), ...rows.map((r) => r.confirmed_by_id)]);
  const props = await propertyInfo(db, rows.map((r) => r.property_id));
  const t = today();
  return rows.map((r) => ({
    ...pick(r, DATE_OUT_KEYS),
    property_label: (r.property_id && props.get(r.property_id)?.[0]) || null,
    confirmed_by_name: (r.confirmed_by_id && names.get(r.confirmed_by_id)) || null,
    owner_name: (r.owner_id && names.get(r.owner_id)) || null,
    days_until: diffDays(r.due_on, t),
  }));
}

const EVENT_OUT_KEYS = [
  "id", "critical_date_id", "kind", "from_status", "to_status", "from_due_on", "to_due_on", "reason", "actor_id",
  "actor_name", "at", "data",
] as const;
export const dateEventOut = (e: Row) => pick(e, EVENT_OUT_KEYS);

export interface DateFilters {
  q?: string;
  related_type?: string[];
  related_id?: string;
  property_id?: string;
  owner_id?: string[];
  status?: string[];
  date_type?: string[];
  source?: string[];
  window?: string; // overdue | 7 | 30 | 90
  blocking?: boolean;
  due_from?: string;
  due_to?: string;
  mine?: boolean;
}

export function buildDateQuery(f: DateFilters, o: { skip?: Set<string>; user_id?: string | null } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = today();
  const c = criticalDates;
  return and(
    isNull(c.deleted_at),
    applySearch(f.q, [c.label, c.related_label]),
    skip.has("related_type") ? undefined : inFilter(c.related_type, f.related_type),
    skip.has("status") ? undefined : inFilter(c.status, f.status),
    skip.has("date_type") ? undefined : inFilter(c.date_type, f.date_type),
    skip.has("owner_id") ? undefined : inFilter(c.owner_id, f.owner_id),
    inFilter(c.source, f.source),
    f.related_id ? eq(c.related_id, f.related_id) : undefined,
    f.property_id ? eq(c.property_id, f.property_id) : undefined,
    f.blocking ? eq(c.is_blocking, true) : undefined,
    f.mine && o.user_id ? eq(c.owner_id, o.user_id) : undefined,
    rangeFilter(c.due_on, f.due_from, f.due_to),
    f.window === "overdue" ? and(lt(c.due_on, t), inArray(c.status, [...OPEN])) : undefined,
    f.window === "7" || f.window === "30" || f.window === "90"
      ? and(gte(c.due_on, t), lte(c.due_on, addDays(t, Number(f.window))), inArray(c.status, ["proposed", "confirmed"]))
      : undefined,
  );
}

export async function dateSummary(db: Db, f: DateFilters, user_id?: string | null): Promise<Record<string, number>> {
  const where = buildDateQuery({ ...f, window: undefined, status: undefined }, { user_id });
  const c = criticalDates;
  const t = today();
  const openIn = sql`${c.status} in ('proposed', 'confirmed', 'missed')`;
  const upcoming = sql`${c.status} in ('proposed', 'confirmed')`;
  const n = (cond: SQL) => sql<number>`(count(*) filter (where ${cond}))::int`;
  const [row] = await db
    .select({
      overdue: n(sql`${c.due_on} < ${t} and ${openIn}`),
      next_7: n(sql`${upcoming} and ${c.due_on} >= ${t} and ${c.due_on} <= ${addDays(t, 7)}`),
      next_30: n(sql`${upcoming} and ${c.due_on} >= ${t} and ${c.due_on} <= ${addDays(t, 30)}`),
      next_90: n(sql`${upcoming} and ${c.due_on} >= ${t} and ${c.due_on} <= ${addDays(t, 90)}`),
      proposed: n(sql`${c.status} = 'proposed'`),
      blocking_open: n(sql`${c.is_blocking} is true and ${openIn}`),
      missed: n(sql`${c.status} = 'missed'`),
    })
    .from(c)
    .where(where);
  const keys = ["overdue", "next_7", "next_30", "next_90", "proposed", "blocking_open", "missed"] as const;
  return Object.fromEntries(keys.map((k) => [k, Number(row?.[k] ?? 0)]));
}

/** A date entered by a person directly from a source document is recorded as confirmed by them. */
export async function createManualDate(db: Db, data: CriticalDateCreate, actor: CurrentUser): Promise<CriticalDate> {
  const key = data.key || `manual:${newId().replace(/-/g, "").slice(0, 12)}`;
  let property_id = data.property_id;
  let related_label = data.related_label;
  if (data.related_type === "contract") {
    const c = await getContract(db, data.related_id);
    property_id = property_id || c.property_id;
    related_label = related_label || c.title;
  }
  const cd = await upsertCriticalDate(db, {
    related_type: data.related_type, related_id: data.related_id, date_type: data.date_type, label: data.label,
    due_on: data.due_on, property_id, owner_id: data.owner_id, lead_days: data.lead_days,
    is_blocking: data.is_blocking, source: "manual", status: "confirmed", key, actor, related_label, notes: data.notes,
  });
  await db.commit();
  return cd;
}

export async function updateDate(db: Db, cd: CriticalDate, data: CriticalDateUpdate, actor: CurrentUser): Promise<CriticalDate> {
  const changes = await apply(db, criticalDates, cd, data);
  if (Object.keys(changes).length) {
    await patch(db, criticalDates, cd, { updated_by_id: actor.id });
    if ("owner_id" in changes) await dateEvent(db, cd, "owner_changed", actor, { data: { owner_id: changes.owner_id } });
    await audit.record(db, {
      actor, action: "critical_date.updated", entity_type: "critical_date", entity_id: cd.id, summary: cd.label, changes,
      ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return cd;
}

/** Human confirmation against the source document. Returns true when the due date was corrected. */
async function confirm(db: Db, cd: CriticalDate, data: ConfirmIn, actor: CurrentUser): Promise<boolean> {
  if (cd.status !== "proposed") {
    throw new HttpError(409, `Only proposed dates can be confirmed (this one is ${cd.status})`);
  }
  const corrected = Boolean(data.due_on && data.due_on !== cd.due_on);
  const values: Row = {
    status: "confirmed", confirmed_by_id: actor.id, confirmed_at: utcnow(), confirm_note: data.note ?? null,
    proposed_due_on: null, updated_by_id: actor.id,
  };
  if (corrected) {
    await dateEvent(db, cd, "rescheduled", actor, {
      from_due: cd.due_on, to_due: data.due_on, reason: `Corrected against source${data.note ? ": " + data.note : ""}`,
    });
    values.due_on = data.due_on;
  }
  await patch(db, criticalDates, cd, values as never);
  await dateEvent(db, cd, "confirmed", actor, { from_status: "proposed", to_status: "confirmed", reason: data.note });
  await audit.record(db, {
    actor, action: "critical_date.confirmed", entity_type: "critical_date", entity_id: cd.id,
    summary: `${cd.label} · ${cd.due_on}`, ip_address: actor.ip_address,
    changes: { status: { from: "proposed", to: "confirmed" }, note: data.note ?? null },
  });
  return corrected;
}

export async function confirmDate(db: Db, cd: CriticalDate, data: ConfirmIn, actor: CurrentUser): Promise<CriticalDate> {
  const corrected = await confirm(db, cd, data, actor);
  if (corrected && cd.related_type === "contract") await recomputeDependents(db, cd.related_id, actor);
  await db.commit();
  return cd;
}

/** Completes a critical date without committing (callers in offers/debt rely on that). */
export async function complete(db: Db, cd: CriticalDate, note: string | null | undefined, actor: CurrentUser): Promise<void> {
  if (cd.status === "proposed") throw new HttpError(409, "Confirm this date against the source document before completing it");
  if (cd.status !== "confirmed" && cd.status !== "missed") throw new HttpError(409, `Date is already ${cd.status}`);
  const prev = cd.status;
  await patch(db, criticalDates, cd, {
    status: "completed", completed_at: utcnow(), completed_by_id: actor.id, resolution_note: note ?? null,
    updated_by_id: actor.id,
  });
  await dateEvent(db, cd, "completed", actor, { from_status: prev, to_status: "completed", reason: note });
  await audit.record(db, {
    actor, action: "critical_date.completed", entity_type: "critical_date", entity_id: cd.id, summary: cd.label,
    changes: { status: { from: prev, to: "completed" }, note: note ?? null }, ip_address: actor?.ip_address,
  });
}

export async function completeDate(db: Db, cd: CriticalDate, note: string | null | undefined, actor: CurrentUser) {
  await complete(db, cd, note, actor);
  await db.commit();
  return cd;
}

async function waive(db: Db, cd: CriticalDate, note: string, actor: CurrentUser): Promise<void> {
  if (!OPEN.includes(cd.status)) throw new HttpError(409, `Date is already ${cd.status}`);
  const prev = cd.status;
  await patch(db, criticalDates, cd, {
    status: "waived", completed_at: utcnow(), completed_by_id: actor.id, resolution_note: note, updated_by_id: actor.id,
  });
  await dateEvent(db, cd, "waived", actor, { from_status: prev, to_status: "waived", reason: note });
  await audit.record(db, {
    actor, action: "critical_date.waived", entity_type: "critical_date", entity_id: cd.id, summary: cd.label,
    changes: { status: { from: prev, to: "waived" }, note }, ip_address: actor?.ip_address,
  });
}

export async function waiveDate(db: Db, cd: CriticalDate, note: string, actor: CurrentUser) {
  await waive(db, cd, note, actor);
  await db.commit();
  return cd;
}

async function reschedule(db: Db, cd: CriticalDate, due_on: string, reason: string, actor: CurrentUser): Promise<void> {
  if (!OPEN.includes(cd.status)) throw new HttpError(409, `A ${cd.status} date cannot be rescheduled`);
  if (due_on === cd.due_on) return;
  const prev_due = cd.due_on;
  const prev_status = cd.status;
  const values: Row = { due_on, updated_by_id: actor.id };
  if (cd.proposed_due_on === due_on) values.proposed_due_on = null;
  if (cd.status === "missed" && due_on >= today()) {
    values.status = "confirmed";
    values.escalation_level = 0;
  }
  await patch(db, criticalDates, cd, values as never);
  await dateEvent(db, cd, "rescheduled", actor, {
    from_status: prev_status, to_status: cd.status, from_due: prev_due, to_due: due_on, reason,
  });
  await audit.record(db, {
    actor, action: "critical_date.rescheduled", entity_type: "critical_date", entity_id: cd.id,
    summary: `${cd.label}: ${reason}`, ip_address: actor?.ip_address,
    changes: { due_on: { from: prev_due, to: due_on }, reason },
  });
}

export async function rescheduleDate(db: Db, cd: CriticalDate, due_on: string, reason: string, actor: CurrentUser) {
  await reschedule(db, cd, due_on, reason, actor);
  if (cd.related_type === "contract") await recomputeDependents(db, cd.related_id, actor);
  await db.commit();
  return cd;
}

export async function bulkDates(db: Db, ids: string[], action: string, note: string | null | undefined, actor: CurrentUser) {
  const rows = await db.select().from(criticalDates).where(and(inArray(criticalDates.id, ids), isNull(criticalDates.deleted_at)));
  let done = 0;
  const skipped: string[] = [];
  for (const cd of rows) {
    try {
      if (action === "confirm") await confirm(db, cd, { note }, actor);
      else await complete(db, cd, note, actor);
      done += 1;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      skipped.push(`${cd.label}: ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}`);
    }
  }
  await db.commit();
  return { updated: done, skipped };
}

export async function dateEvents(db: Db, date_id: string) {
  return db.select().from(criticalDateEvents).where(eq(criticalDateEvents.critical_date_id, date_id)).orderBy(desc(criticalDateEvents.at));
}

// --------------------------------------------------------------------------- scan / escalation

export const SCAN_RULE_KEY = "contracts.critical_dates";
export const SCAN_DEFAULTS = { imminent_days: 3, escalate_after_days: 2, risk_decision_window_days: 7 };

async function scanConfig(db: Db): Promise<[boolean, Row]> {
  const { automationRules } = await import("../tasks/schema");
  const { ruleConfig } = await import("../tasks/service");
  const [rule] = await db.select().from(automationRules).where(eq(automationRules.key, SCAN_RULE_KEY)).limit(1);
  if (!rule) {
    await insert(db, automationRules, {
      key: SCAN_RULE_KEY, name: "Critical dates: lead time and escalation", event: "schedule", enabled: true,
      description:
        "Creates owner tasks as critical dates enter their lead window, asks for confirmation of " +
        "proposed dates, alerts on imminent deadlines and escalates missed dates, overdue DD items, " +
        "late third-party reports and high-severity risks without a decision before feasibility.",
      thresholds: { ...SCAN_DEFAULTS }, run_count: 0, error_count: 0,
    } as never);
  }
  const [enabled, cfg] = await ruleConfig(db, SCAN_RULE_KEY);
  return [enabled, { ...SCAN_DEFAULTS, ...cfg }];
}

/** Lead-window tasks, imminent alerts and missed-date escalation. Idempotent (keys); does not commit. */
export async function scanCriticalDates(db: Db, actor?: Actor, opts: { on?: string | null } = {}): Promise<Row> {
  const { createTask, raiseAlert, recordRuleRun } = await import("../tasks/service");

  const [enabled, cfg] = await scanConfig(db);
  if (!enabled) return { skipped: true };
  const t = opts.on || today();
  const started = utcnow();
  const imminent = Math.trunc(Number(cfg.imminent_days ?? 3));
  const esc_after = Math.trunc(Number(cfg.escalate_after_days ?? 2));
  const counts = { scanned: 0, tasks: 0, alerts: 0, missed: 0, escalated: 0 };

  const fresh = (obj: Row) => obj.created_at !== null && obj.created_at !== undefined && obj.created_at >= started;
  const alert = async (kw: Row) => {
    const a = await raiseAlert(db, { rule_key: SCAN_RULE_KEY, ...kw } as never);
    if (fresh(a as Row)) counts.alerts += 1;
  };
  const task = async (kw: Row) => {
    const tk = await createTask(db, { source: SCAN_RULE_KEY, actor_id: actor?.id ?? null, ...kw } as never);
    if (fresh(tk as Row)) counts.tasks += 1;
  };

  const rows = await db
    .select()
    .from(criticalDates)
    .where(and(isNull(criticalDates.deleted_at), inArray(criticalDates.status, [...OPEN]), lte(criticalDates.due_on, addDays(t, 366))));
  for (const cd of rows) {
    counts.scanned += 1;
    const days = diffDays(cd.due_on, t);
    const label = cd.related_label ? `${cd.label} — ${cd.related_label}` : cd.label;
    const link = { related_type: cd.related_type, related_id: cd.related_id, related_label: cd.related_label || cd.label };
    const base_key = `critical_date:${cd.id}:${cd.due_on}`;
    if (days < 0) {
      if (cd.status === "proposed" || cd.status === "confirmed") {
        const prev = cd.status;
        await patch(db, criticalDates, cd, {
          status: "missed", escalation_level: Math.max(cd.escalation_level || 0, 1), escalated_at: utcnow(),
        });
        counts.missed += 1;
        await dateEvent(db, cd, "missed", actor, { from_status: prev, to_status: "missed", reason: "Due date passed without completion" });
        const why = prev === "proposed" ? "was never confirmed against the source and " : "";
        await alert({
          title: `Missed critical date: ${label}`, severity: cd.is_blocking ? "critical" : "high",
          reason: `${cd.label} ${why}passed on ${cd.due_on} without being completed or waived.`,
          owner_id: cd.owner_id, due_at: endOfDay(cd.due_on), idempotency_key: `${base_key}:missed`, ...link,
        });
        const manager = await managerOf(db, cd.owner_id);
        if (manager) {
          await alert({
            title: `Escalation: missed critical date ${label}`, severity: "high",
            reason: `Owner did not complete ${cd.label} due ${cd.due_on}.`,
            owner_id: manager, idempotency_key: `${base_key}:missed:manager`, ...link,
          });
        }
        await events.emit(db, "critical_date.missed", {
          critical_date_id: cd.id, related_type: cd.related_type, related_id: cd.related_id,
          property_id: cd.property_id, actor,
        });
      } else if (cd.status === "missed" && (cd.escalation_level || 0) < 2 && -days >= esc_after) {
        await patch(db, criticalDates, cd, { escalation_level: 2, escalated_at: utcnow() });
        counts.escalated += 1;
        const target = (await managerOf(db, cd.owner_id)) || cd.owner_id;
        await alert({
          title: `Still unresolved: ${label}`, severity: "critical",
          reason: `${cd.label} was due ${cd.due_on} (${-days} days ago) and remains open.`,
          owner_id: target, idempotency_key: `${base_key}:escalation2`, ...link,
        });
        await dateEvent(db, cd, "escalated", actor, { reason: `Escalation level 2 after ${-days} days` });
      }
      continue;
    }
    if (days > (cd.lead_days || 0) && days > imminent) continue;
    const due_at = endOfDay(cd.due_on);
    if (cd.status === "proposed") {
      await task({
        title: `Confirm against source: ${label}`, assignee_id: cd.owner_id, due_at, task_type: "review",
        priority: cd.is_blocking ? "high" : "normal",
        description: `Proposed date ${cd.due_on} (${cd.source}) must be verified against the source contract before it can be relied on.`,
        idempotency_key: `critical_date:${cd.id}:confirm`, ...link,
      });
    } else {
      await task({
        title: `Due ${cd.due_on}: ${label}`, assignee_id: cd.owner_id, due_at,
        task_type: cd.related_type === "contract" ? "due_diligence" : "follow_up",
        priority: cd.is_blocking && days <= imminent ? "urgent" : cd.is_blocking ? "high" : "normal",
        idempotency_key: `${base_key}:lead`, ...link,
      });
    }
    if (days <= imminent) {
      await alert({
        title: `Critical date in ${days} day${days !== 1 ? "s" : ""}: ${label}`,
        severity: cd.is_blocking ? "critical" : "high",
        reason: `${cd.label} is due ${cd.due_on}${cd.status === "proposed" ? " and is still unconfirmed" : ""}.`,
        owner_id: cd.owner_id, due_at, idempotency_key: `${base_key}:imminent`, ...link,
      });
    }
  }

  // DD items past due
  const ddRows = await db
    .select({ item: ddItems, c_title: contracts.title, c_owner: contracts.owner_id })
    .from(ddItems)
    .innerJoin(contracts, eq(contracts.id, ddItems.contract_id))
    .where(
      and(
        isNull(ddItems.deleted_at), lt(ddItems.due_on, t), notInArray(ddItems.status, [...DONE]),
        isNull(contracts.deleted_at), eq(contracts.status, "executed"),
      ),
    );
  for (const { item, c_title, c_owner } of ddRows) {
    const owner = item.owner_id || c_owner;
    const link = { related_type: "contract", related_id: item.contract_id, related_label: c_title };
    const overdue = diffDays(t, item.due_on as string);
    const key = `dd_item:${item.id}:${item.due_on}`;
    if ((item.escalation_level || 0) < 1) {
      await patch(db, ddItems, item, { escalation_level: 1, escalated_at: utcnow() });
      counts.escalated += 1;
    }
    await alert({
      title: `DD item overdue: ${item.title}`, owner_id: owner,
      severity: item.severity && HIGH.includes(item.severity) ? "high" : "medium",
      reason: `Due ${item.due_on} (${overdue} days ago), status ${item.status}.`,
      idempotency_key: `${key}:overdue`, ...link,
    });
    if (overdue >= esc_after && (item.escalation_level || 0) < 2) {
      await patch(db, ddItems, item, { escalation_level: 2, escalated_at: utcnow() });
      await alert({
        title: `Escalation: DD item overdue ${item.title}`, severity: "high",
        owner_id: (await managerOf(db, owner)) || c_owner,
        reason: `${item.title} is ${overdue} days overdue on ${c_title}.`,
        idempotency_key: `${key}:escalation2`, ...link,
      });
    }
  }

  // Late third-party reports
  const repRows = await db
    .select({ rep: thirdPartyReports, c_title: contracts.title, c_owner: contracts.owner_id })
    .from(thirdPartyReports)
    .innerJoin(contracts, eq(contracts.id, thirdPartyReports.contract_id))
    .where(
      and(
        isNull(thirdPartyReports.deleted_at), lt(thirdPartyReports.expected_on, t),
        inArray(thirdPartyReports.status, ["ordered", "in_progress"]), isNull(contracts.deleted_at),
      ),
    );
  for (const { rep, c_title, c_owner } of repRows) {
    await alert({
      title: `Late ${rep.report_type.replace(/_/g, " ")} report: ${c_title}`, severity: "medium",
      owner_id: rep.owner_id || c_owner,
      reason: `Expected ${rep.expected_on} from ${rep.vendor_name || "vendor"}; not delivered.`,
      related_type: "contract", related_id: rep.contract_id, related_label: c_title,
      idempotency_key: `third_party_report:${rep.id}:${rep.expected_on}:late`,
    });
  }

  // High-severity risks without a decision as the feasibility deadline approaches
  const window = Math.trunc(Number(cfg.risk_decision_window_days ?? 7));
  const feas = await db
    .select({ related_id: criticalDates.related_id, due_on: criticalDates.due_on })
    .from(criticalDates)
    .where(
      and(
        eq(criticalDates.related_type, "contract"), eq(criticalDates.key, "feasibility_expiry"),
        isNull(criticalDates.deleted_at), inArray(criticalDates.status, [...OPEN]),
        lte(criticalDates.due_on, addDays(t, window)),
      ),
    );
  const feasByContract = new Map(feas.map((r) => [r.related_id, r.due_on]));
  if (feasByContract.size) {
    const riskRows = await db
      .select({ risk: riskItems, c_title: contracts.title, c_owner: contracts.owner_id })
      .from(riskItems)
      .innerJoin(contracts, eq(contracts.id, riskItems.contract_id))
      .where(
        and(
          inArray(riskItems.contract_id, [...feasByContract.keys()]), isNull(riskItems.deleted_at),
          inArray(riskItems.severity, [...HIGH]), eq(riskItems.decision_required, true), isNull(riskItems.decision),
          ne(riskItems.status, "closed"), eq(contracts.status, "executed"),
        ),
      );
    for (const { risk, c_title, c_owner } of riskRows) {
      const fd = feasByContract.get(risk.contract_id) as string;
      await alert({
        title: `Decision required before feasibility: ${risk.title}`, severity: "critical",
        owner_id: risk.owner_id || c_owner,
        reason: `${cap(risk.severity)} risk on ${c_title} has no recorded decision; feasibility expires ${fd}.`,
        related_type: "contract", related_id: risk.contract_id, related_label: c_title,
        idempotency_key: `risk_item:${risk.id}:${fd}:decision`,
      });
    }
  }

  await recordRuleRun(db, SCAN_RULE_KEY);
  return counts;
}

// =========================================================================== contracts

// Day counts read from Contract.key_terms. Defaults (marked `assumed` in the rule) apply only to the core
// PSA deadlines so execution always yields a reviewable candidate set; all are 'proposed' until confirmed.
export const TERM_DEFAULTS: Record<string, number> = {
  deposit_days: 3, feasibility_days: 30, title_objection_days: 20, title_cure_days: 10, survey_days: 25, closing_days: 30,
};
export const TERM_KEYS = [
  "deposit_days", "additional_deposit_days", "feasibility_days", "title_objection_days", "title_cure_days",
  "survey_days", "financing_days", "estoppel_days", "snda_days", "closing_days", "extension_count",
  "extension_days", "post_close_days",
];
// [key, date_type, label, from, term, business_days default, blocking, lead_days, roll_forward]
type DateRule = [string, string, string, string, string | null, boolean, boolean, number, boolean];
const DATE_RULES: DateRule[] = [
  ["effective", "effective", "Effective date", "effective_on", null, false, false, 0, false],
  ["deposit", "deposit", "Earnest money deposit due", "effective_on", "deposit_days", true, true, 2, false],
  ["feasibility_expiry", "feasibility_expiry", "Feasibility / due diligence period expires", "effective_on",
    "feasibility_days", false, true, 10, true],
  ["additional_deposit", "additional_deposit", "Additional deposit due", "feasibility_expiry",
    "additional_deposit_days", true, true, 2, false],
  ["title_objection", "title_objection", "Title objection deadline", "effective_on", "title_objection_days",
    false, true, 7, true],
  ["title_cure", "title_cure", "Seller title cure period ends", "title_objection", "title_cure_days", false, false, 5,
    true],
  ["survey", "survey", "Survey objection deadline", "effective_on", "survey_days", false, true, 7, true],
  ["financing", "financing", "Financing contingency expires", "effective_on", "financing_days", false, true, 10, true],
  ["estoppel", "estoppel", "Tenant estoppels due", "effective_on", "estoppel_days", false, false, 7, true],
  ["snda", "snda", "SNDAs due", "effective_on", "snda_days", false, false, 7, true],
  ["closing", "closing", "Closing", "feasibility_expiry", "closing_days", false, true, 14, true],
  ["post_close", "post_close", "Post-closing obligations due", "closing", "post_close_days", false, false, 14, false],
];
export const RULE_ANCHORS = ["effective_on", "executed_on", ...DATE_RULES.map((r) => r[0])];

/** Python `int(v)` for the value shapes that can appear in JSON; throws when Python would. */
function pyInt(v: any): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("not an int");
    return Math.trunc(v);
  }
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new Error("not an int");
}

function cleanTerms(terms: Row | null | undefined): Row {
  const out: Row = { ...(terms ?? {}) };
  for (const k of TERM_KEYS) {
    if (k in out) {
      const v = out[k];
      if (v === null || v === undefined || v === "") {
        delete out[k];
        continue;
      }
      try {
        out[k] = pyInt(v);
      } catch {
        throw new HttpError(422, `key_terms.${k} must be a whole number of days`);
      }
      if (out[k] < 0 || out[k] > 3650) throw new HttpError(422, `key_terms.${k} is out of range`);
    }
  }
  if ("closing_from" in out && !RULE_ANCHORS.includes(out.closing_from)) {
    throw new HttpError(422, "key_terms.closing_from is not a known anchor");
  }
  const rules = truthy(out.rules) ? out.rules : [];
  if (!Array.isArray(rules)) throw new HttpError(422, "key_terms.rules must be a list");
  for (const r of rules) {
    if (!r || typeof r !== "object" || Array.isArray(r) || !truthy(r.key) || !truthy(r.label) || !truthy(r.from)) {
      throw new HttpError(422, "Each custom rule needs key, label and from");
    }
  }
  return out;
}

/** Ordered rule set for a contract: defaults driven by key_terms, then custom `key_terms.rules`. */
export function contractRules(c: Pick<Contract, "key_terms" | "calendar_id" | "additional_deposit">): Row[] {
  const terms: Row = c.key_terms || {};
  const global_bd = terms.business_days;
  const roll = "roll_forward" in terms ? terms.roll_forward : true;
  const calId = c.calendar_id ? String(c.calendar_id) : null;
  let rules: Row[] = [];
  for (const [key, date_type, label, from0, term, bd, blocking, lead, roll_default] of DATE_RULES) {
    let from = from0;
    if (key === "closing") from = terms.closing_from || from;
    let days: number;
    let assumed: boolean;
    if (term === null) {
      days = 0;
      assumed = false;
    } else if (terms[term] !== undefined && terms[term] !== null) {
      days = pyInt(terms[term]);
      assumed = false;
    } else if (term in TERM_DEFAULTS) {
      days = TERM_DEFAULTS[term];
      assumed = true;
    } else if (key === "additional_deposit" && c.additional_deposit) {
      days = 2;
      assumed = true;
    } else {
      continue;
    }
    const business = global_bd !== undefined && global_bd !== null && term !== "deposit_days" ? truthy(global_bd) : bd;
    rules.push({
      key, date_type, label, from, days, business_days: business,
      roll_forward: truthy(roll) && roll_default && !business, calendar_id: calId, is_blocking: blocking,
      lead_days: lead, term, assumed,
    });
  }
  const extCount = truthy(terms.extension_count) ? pyInt(terms.extension_count) : 0;
  for (let i = 1; i <= extCount; i++) {
    const ext_days = truthy(terms.extension_days) ? pyInt(terms.extension_days) : 30;
    rules.push({
      key: `extension_${i}`, date_type: "extension", label: `Extended closing (extension ${i})`, from: "closing",
      days: ext_days * i, business_days: false, roll_forward: truthy(roll), calendar_id: calId, is_blocking: false,
      lead_days: 14, term: "extension_days", assumed: terms.extension_days === undefined || terms.extension_days === null,
    });
  }
  for (const r of terms.rules || []) {
    const custom = {
      date_type: "other", days: 0, business_days: truthy(global_bd), roll_forward: false, calendar_id: calId,
      is_blocking: false, lead_days: 7, assumed: false, ...r, custom: true,
    };
    rules = [...rules.filter((x) => x.key !== custom.key), custom];
  }
  return rules;
}

export async function contractDates(db: Db, contract_id: string): Promise<CriticalDate[]> {
  return db
    .select()
    .from(criticalDates)
    .where(and(eq(criticalDates.related_type, "contract"), eq(criticalDates.related_id, contract_id), isNull(criticalDates.deleted_at)))
    .orderBy(asc(criticalDates.due_on));
}

/** Candidate dates from the contract's terms. All are 'proposed' until a person confirms them against the
 *  source. Anchors use confirmed values where they exist. Does not commit. */
export async function generateDates(
  db: Db,
  c: Contract,
  actor?: Actor,
  o: { source?: string; overrides?: Record<string, number> | null; citations?: Record<string, Row> | null } = {},
): Promise<CriticalDate[]> {
  const source = o.source ?? "rule";
  const { overrides, citations } = o;
  if (!c.effective_on) throw new HttpError(422, "Set the effective date before generating dates");
  const anchors: Record<string, string> = { effective_on: c.effective_on, executed_on: c.executed_on || c.effective_on };
  const existing = new Map((await contractDates(db, c.id)).map((d) => [d.key, d]));
  const out: CriticalDate[] = [];
  for (let rule of contractRules(c)) {
    if (overrides && rule.term && Object.prototype.hasOwnProperty.call(overrides, rule.term)) {
      rule = { ...rule, days: overrides[rule.term], assumed: false };
    } else if (overrides) {
      // Extraction-driven runs only touch the dates the extraction speaks to; keep anchors flowing.
      const ex = existing.get(rule.key);
      if (ex) anchors[rule.key] = ex.due_on;
      continue;
    }
    const due = rule.key === "effective" ? c.effective_on : await computeRuleDate(db, rule, anchors, c.calendar_id);
    if (due === null || due === undefined) continue;
    const cd = await upsertCriticalDate(db, {
      related_type: "contract", related_id: c.id, date_type: rule.date_type, label: rule.label, due_on: due,
      property_id: c.property_id, owner_id: c.owner_id, lead_days: Math.trunc(Number(rule.lead_days || 7)),
      is_blocking: Boolean(rule.is_blocking), source, status: "proposed", key: rule.key, actor,
      related_label: c.title, rule, business_days: Boolean(rule.business_days), calendar_id: c.calendar_id,
      citation: (citations ?? {})[rule.term || ""],
    });
    anchors[rule.key] = cd.due_on;
    out.push(cd);
  }
  return out;
}

async function recomputeDependents(db: Db, contract_id: string, actor: Actor): Promise<void> {
  const c = await get(db, contracts, contract_id);
  if (c && !c.deleted_at && c.status === "executed" && c.effective_on) await generateDates(db, c, actor);
}

export async function getContract(db: Db, contract_id: string): Promise<Contract> {
  const c = await get(db, contracts, contract_id);
  if (!c || c.deleted_at) throw new HttpError(404, "Contract not found");
  return c;
}

export interface ContractFilters {
  q?: string;
  status?: string[];
  contract_type?: string[];
  owner_id?: string[];
  property_id?: string;
  opportunity_id?: string;
  effective_from?: string;
  effective_to?: string;
}

export function buildContractQuery(f: ContractFilters, skip: Set<string> = new Set()): SQL | undefined {
  const c = contracts;
  return and(
    isNull(c.deleted_at),
    applySearch(f.q, [c.title, c.notes]),
    skip.has("status") ? undefined : inFilter(c.status, f.status),
    skip.has("contract_type") ? undefined : inFilter(c.contract_type, f.contract_type),
    skip.has("owner_id") ? undefined : inFilter(c.owner_id, f.owner_id),
    f.property_id ? eq(c.property_id, f.property_id) : undefined,
    f.opportunity_id ? eq(c.opportunity_id, f.opportunity_id) : undefined,
    rangeFilter(c.effective_on, f.effective_from, f.effective_to),
  );
}

const CONTRACT_LIST_KEYS = [
  "id", "title", "contract_type", "status", "property_id", "opportunity_id", "owner_id", "effective_on",
  "purchase_price", "tags", "updated_at",
] as const;
const CONTRACT_FULL_KEYS = [
  "document_id", "offer_id", "executed_on", "executed_at", "earnest_money", "additional_deposit", "parties",
  "key_terms", "calendar_id", "attorney_person_id", "attorney_organization_id", "terminated_at", "notes",
  "created_at", "created_by_id",
] as const;

export async function contractItems(db: Db, rows: Contract[], full = false): Promise<Row[]> {
  const ids = rows.map((c) => c.id);
  const names = await userNames(db, rows.map((c) => c.owner_id));
  const props = await propertyInfo(db, rows.map((c) => c.property_id));
  const oppIds = [...new Set(rows.map((c) => c.opportunity_id).filter(Boolean))] as string[];
  const opps = new Map<string, string>();
  if (oppIds.length) {
    for (const r of await db
      .select({ id: opportunities.id, title: opportunities.title })
      .from(opportunities)
      .where(inArray(opportunities.id, oppIds))) {
      opps.set(r.id, r.title);
    }
  }
  const keyDates = new Map<string, string>();
  const dd = new Map<string, [number, number]>();
  const blockers = new Map<string, number>();
  if (ids.length) {
    for (const r of await db
      .select({ rid: criticalDates.related_id, key: criticalDates.key, due: criticalDates.due_on })
      .from(criticalDates)
      .where(
        and(
          eq(criticalDates.related_type, "contract"), inArray(criticalDates.related_id, ids),
          inArray(criticalDates.key, ["feasibility_expiry", "closing"]), isNull(criticalDates.deleted_at),
          ne(criticalDates.status, "waived"),
        ),
      )) {
      keyDates.set(`${r.rid}|${r.key}`, r.due);
    }
    for (const r of await db
      .select({
        cid: ddItems.contract_id,
        total: sql<number>`count(*)::int`,
        done: sql<number>`(count(*) filter (where ${inArray(ddItems.status, [...DONE])}))::int`,
      })
      .from(ddItems)
      .where(and(inArray(ddItems.contract_id, ids), isNull(ddItems.deleted_at)))
      .groupBy(ddItems.contract_id)) {
      dd.set(r.cid, [Number(r.total), Number(r.done)]);
    }
    const counted = [
      await db
        .select({ cid: criticalDates.related_id, n: sql<number>`count(*)::int` })
        .from(criticalDates)
        .where(
          and(
            eq(criticalDates.related_type, "contract"), inArray(criticalDates.related_id, ids), isNull(criticalDates.deleted_at),
            or(eq(criticalDates.status, "missed"), and(eq(criticalDates.status, "proposed"), eq(criticalDates.is_blocking, true))),
          ),
        )
        .groupBy(criticalDates.related_id),
      await db
        .select({ cid: riskItems.contract_id, n: sql<number>`count(*)::int` })
        .from(riskItems)
        .where(
          and(
            inArray(riskItems.contract_id, ids), isNull(riskItems.deleted_at), inArray(riskItems.severity, [...HIGH]),
            eq(riskItems.decision_required, true), isNull(riskItems.decision), ne(riskItems.status, "closed"),
          ),
        )
        .groupBy(riskItems.contract_id),
      await db
        .select({ cid: ddItems.contract_id, n: sql<number>`count(*)::int` })
        .from(ddItems)
        .where(
          and(
            inArray(ddItems.contract_id, ids), isNull(ddItems.deleted_at), inArray(ddItems.severity, [...HIGH]),
            notInArray(ddItems.status, [...DONE]),
          ),
        )
        .groupBy(ddItems.contract_id),
    ];
    for (const list of counted) for (const r of list) blockers.set(r.cid, (blockers.get(r.cid) ?? 0) + Number(r.n));
  }
  const t = today();
  return rows.map((c) => {
    const [property_label, property_type] = (c.property_id && props.get(c.property_id)) || [null, null];
    const feasibility_on = keyDates.get(`${c.id}|feasibility_expiry`) ?? null;
    const [dd_total, dd_done] = dd.get(c.id) ?? [0, 0];
    return {
      ...pick(c, CONTRACT_LIST_KEYS),
      property_label, property_type,
      opportunity_label: (c.opportunity_id && opps.get(c.opportunity_id)) || null,
      owner_name: (c.owner_id && names.get(c.owner_id)) || null,
      feasibility_on,
      days_to_feasibility: feasibility_on ? diffDays(feasibility_on, t) : null,
      closing_on: keyDates.get(`${c.id}|closing`) ?? null,
      open_blockers: blockers.get(c.id) ?? 0,
      dd_total, dd_done,
      ...(full ? pick(c, CONTRACT_FULL_KEYS) : {}),
    };
  });
}

export async function contractOut(db: Db, c: Contract): Promise<Row> {
  return (await contractItems(db, [c], true))[0];
}

/** Fill property/opportunity from the linked offer or opportunity when not given. */
async function resolveLinks(db: Db, values: Row): Promise<void> {
  if (values.offer_id && !(values.opportunity_id && values.property_id)) {
    let offers: any = null;
    try {
      offers = (await import("../offers/schema")).offers;
    } catch {
      offers = null;
    }
    if (offers) {
      const [row] = await db
        .select({ opportunity_id: offers.opportunity_id, property_id: offers.property_id })
        .from(offers)
        .where(eq(offers.id, values.offer_id))
        .limit(1);
      if (row) {
        values.opportunity_id = values.opportunity_id || row.opportunity_id;
        values.property_id = values.property_id || row.property_id;
      }
    }
  }
  if (values.opportunity_id && !values.property_id) {
    const [r] = await db
      .select({ p: opportunities.property_id })
      .from(opportunities)
      .where(eq(opportunities.id, values.opportunity_id))
      .limit(1);
    values.property_id = r?.p ?? null;
  }
}

/** Pydantic dumps every Party field (None when unset). */
const partyJson = (p: Row): Row => ({
  role: p.role, name: p.name, person_id: p.person_id ?? null, organization_id: p.organization_id ?? null, notes: p.notes ?? null,
});

export async function createContract(db: Db, data: ContractCreate, actor: CurrentUser): Promise<Contract> {
  const { title: rawTitle, ...rest } = data;
  const values: Row = { ...rest };
  values.parties = values.parties.map((p: Row) => audit.toJsonable(partyJson(p)));
  values.key_terms = audit.toJsonable(cleanTerms(values.key_terms));
  await resolveLinks(db, values);
  let title = (rawTitle || "").trim();
  if (!title) {
    const label = (values.property_id && (await propertyInfo(db, [values.property_id])).get(values.property_id)?.[0]) || null;
    title = label ? `Purchase agreement — ${label}` : "Purchase agreement";
  }
  const c = await insert(db, contracts, {
    ...values, title, status: "draft", created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "contract.created", entity_type: ENTITY, entity_id: c.id, summary: c.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

async function execute(
  db: Db,
  c: Contract,
  actor: CurrentUser,
  effective_on?: string | null,
  executed_on?: string | null,
): Promise<void> {
  if (c.status !== "draft") throw new HttpError(409, `Contract is already ${c.status}`);
  const effective = effective_on || c.effective_on || executed_on || c.executed_on || today();
  await patch(db, contracts, c, {
    effective_on: effective, executed_on: executed_on || c.executed_on || effective, status: "executed",
    executed_at: utcnow(), executed_by_id: actor.id, updated_by_id: actor.id,
  });
  await generateDates(db, c, actor);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ddItems)
    .where(and(eq(ddItems.contract_id, c.id), isNull(ddItems.deleted_at)));
  if (!n) await applyTemplate(db, c, null, actor);
  await audit.record(db, {
    actor, action: "contract.executed", entity_type: ENTITY, entity_id: c.id, summary: c.title,
    changes: { status: { from: "draft", to: "executed" }, effective_on: c.effective_on }, ip_address: actor?.ip_address,
  });
  await events.emit(db, "contract.executed", {
    contract_id: c.id, opportunity_id: c.opportunity_id, property_id: c.property_id, actor,
  });
}

export async function executeContract(db: Db, c: Contract, data: ExecuteIn, actor: CurrentUser): Promise<Contract> {
  await execute(db, c, actor, data.effective_on, data.executed_on);
  await db.commit();
  return c;
}

export async function updateContract(db: Db, c: Contract, data: ContractUpdate, actor: CurrentUser): Promise<Contract> {
  const values: Row = { ...data };
  const new_status = values.status;
  delete values.status;
  if ("parties" in values) values.parties = (values.parties || []).map((p: Row) => audit.toJsonable(partyJson(p)));
  if ("key_terms" in values) values.key_terms = audit.toJsonable(cleanTerms(values.key_terms));
  if ((c.status === "closed" || c.status === "terminated") && Object.keys(values).length) {
    throw new HttpError(409, `A ${c.status} contract cannot be edited`);
  }
  const old_owner = c.owner_id;
  const changes = await apply(db, contracts, c, values);
  if (Object.keys(changes).length) {
    await patch(db, contracts, c, { updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "contract.updated", entity_type: ENTITY, entity_id: c.id, summary: c.title, changes,
      ip_address: actor.ip_address,
    });
    if (c.status === "executed" && ["key_terms", "effective_on", "executed_on", "calendar_id"].some((k) => k in changes)) {
      await generateDates(db, c, actor);
    }
    if ("owner_id" in changes && c.owner_id) {
      for (const cd of await contractDates(db, c.id)) {
        if (cd.owner_id === null || cd.owner_id === old_owner) await patch(db, criticalDates, cd, { owner_id: c.owner_id });
      }
    }
  }
  if (new_status && new_status !== c.status) {
    if (new_status === "executed") {
      await execute(db, c, actor);
    } else if (new_status === "terminated") {
      throw new HttpError(422, "Record a termination decision with reasoning instead");
    } else if (new_status === "closed") {
      if (c.status !== "executed") throw new HttpError(409, "Only executed contracts can be closed");
      const prev = c.status;
      await patch(db, contracts, c, { status: "closed", updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: "contract.closed", entity_type: ENTITY, entity_id: c.id, summary: c.title,
        changes: { status: { from: prev, to: "closed" } }, ip_address: actor.ip_address,
      });
    } else {
      throw new HttpError(409, "A contract cannot return to draft");
    }
  }
  await db.commit();
  return c;
}

export async function archiveContract(db: Db, c: Contract, actor: CurrentUser): Promise<void> {
  if (c.status !== "draft") throw new HttpError(409, "Only draft contracts can be deleted; executed contracts are retained");
  const now = utcnow();
  await patch(db, contracts, c, { deleted_at: now, updated_by_id: actor.id });
  for (const cd of await contractDates(db, c.id)) await patch(db, criticalDates, cd, { deleted_at: now });
  await audit.record(db, {
    actor, action: "contract.archived", entity_type: ENTITY, entity_id: c.id, summary: c.title, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function regenerateDates(db: Db, c: Contract, actor: CurrentUser): Promise<CriticalDate[]> {
  const rows = await generateDates(db, c, actor);
  await audit.record(db, {
    actor, action: "contract.dates_generated", entity_type: ENTITY, entity_id: c.id,
    summary: `${rows.length} candidate dates`, ip_address: actor.ip_address,
  });
  await db.commit();
  return contractDates(db, c.id);
}

export async function feasibilityDate(db: Db, contract_id: string): Promise<CriticalDate | undefined> {
  const [r] = await db
    .select()
    .from(criticalDates)
    .where(
      and(
        eq(criticalDates.related_type, "contract"), eq(criticalDates.related_id, contract_id),
        eq(criticalDates.key, "feasibility_expiry"), isNull(criticalDates.deleted_at),
      ),
    )
    .limit(1);
  return r;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function contractStatus(db: Db, c: Contract): Promise<Row> {
  const t = today();
  const dates = await contractDates(db, c.id);
  const byKey = new Map(dates.map((d) => [d.key, d]));
  const feas = byKey.get("feasibility_expiry");
  const closing = byKey.get("closing");
  const blockers: Row[] = [];
  const blocker = (kind: string, id: string, label: string, severity: string, detail: string | null) =>
    blockers.push({ kind, id, label, severity, detail });
  for (const d of dates) {
    if (d.status === "missed") blocker("critical_date", d.id, `Missed: ${d.label}`, "critical", `Was due ${d.due_on}`);
    else if (d.status === "proposed" && d.is_blocking) {
      blocker("critical_date", d.id, `Unconfirmed: ${d.label}`, "high", "Verify against the source contract");
    } else if (d.status === "confirmed" && d.proposed_due_on) {
      blocker("critical_date", d.id, `Conflicting value: ${d.label}`, "medium", `New value ${d.proposed_due_on} differs`);
    }
  }
  const items = await db.select().from(ddItems).where(and(eq(ddItems.contract_id, c.id), isNull(ddItems.deleted_at)));
  for (const i of items) {
    if (DONE.includes(i.status)) continue;
    if (i.severity && HIGH.includes(i.severity)) {
      blocker("dd_item", i.id, `Open finding: ${i.title}`, i.severity, (i.findings || "").slice(0, 160) || null);
    } else if (i.due_on && i.due_on < t) {
      blocker("dd_item", i.id, `Overdue: ${i.title}`, "medium", `Was due ${i.due_on}`);
    }
  }
  const risks = await db.select().from(riskItems).where(and(eq(riskItems.contract_id, c.id), isNull(riskItems.deleted_at)));
  for (const r of risks) {
    if (needsDecision(r)) {
      const due = r.decision_due_on || (feas ? feas.due_on : null);
      blocker("risk", r.id, `Decision required: ${r.title}`, r.severity, due ? `Decide before ${due}` : null);
    }
  }
  const ests = await db.select().from(estoppels).where(and(eq(estoppels.contract_id, c.id), isNull(estoppels.deleted_at)));
  for (const e of ests) {
    if (e.has_discrepancy && !e.discrepancy_resolved_at) {
      blocker(
        "estoppel", e.id, `${e.kind.toUpperCase()} discrepancy: ${e.tenant_name}`, "high",
        (e.discrepancies || []).map((x: Row) => (x.label !== undefined ? x.label : (x.field ?? ""))).join(", "),
      );
    }
  }
  const excs = await db.select().from(titleExceptions).where(and(eq(titleExceptions.contract_id, c.id), isNull(titleExceptions.deleted_at)));
  for (const x of excs) {
    if (x.status === "objected" || x.status === "cure_pending" || x.status === "uncured") {
      blocker(
        "title_exception", x.id, `Title: ${x.description.slice(0, 80)}`,
        x.status === "uncured" ? "critical" : x.severity || "medium", x.status.replace(/_/g, " "),
      );
    }
  }
  const reps = await db.select().from(thirdPartyReports).where(and(eq(thirdPartyReports.contract_id, c.id), isNull(thirdPartyReports.deleted_at)));
  for (const r of reps) {
    if (r.expected_on && r.expected_on < t && (r.status === "ordered" || r.status === "in_progress")) {
      blocker("third_party_report", r.id, `Late report: ${r.report_type.replace(/_/g, " ")}`, "medium", `Expected ${r.expected_on}`);
    }
  }
  blockers.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
  const n = <T>(list: T[], pred: (x: T) => boolean) => list.filter(pred).length;
  const counts = {
    dates_total: dates.length, dates_proposed: n(dates, (d) => d.status === "proposed"),
    dates_confirmed: n(dates, (d) => d.status === "confirmed"), dates_missed: n(dates, (d) => d.status === "missed"),
    dd_total: items.length, dd_done: n(items, (i) => DONE.includes(i.status)),
    dd_open_high: n(items, (i) => !DONE.includes(i.status) && !!i.severity && HIGH.includes(i.severity)),
    reports_total: reps.length, reports_delivered: n(reps, (r) => r.status === "delivered" || r.status === "reviewed"),
    title_open: n(excs, (x) => (EXCEPTION_OPEN as readonly string[]).includes(x.status)), estoppels_total: ests.length,
    estoppels_received: n(ests, (e) => e.status === "received" || e.status === "approved"),
    discrepancies: n(ests, (e) => e.has_discrepancy && !e.discrepancy_resolved_at),
    risks_open: n(risks, (r) => r.status !== "closed"), risks_need_decision: n(risks, needsDecision),
  };
  const live = (d: CriticalDate | undefined): d is CriticalDate => !!d && d.status !== "waived";
  return {
    contract_id: c.id, status: c.status, effective_on: c.effective_on,
    feasibility_on: live(feas) ? feas.due_on : null, feasibility_status: feas ? feas.status : null,
    days_to_feasibility: live(feas) && OPEN.includes(feas.status) ? diffDays(feas.due_on, t) : null,
    closing_on: live(closing) ? closing.due_on : null,
    days_to_closing: live(closing) && OPEN.includes(closing.status) ? diffDays(closing.due_on, t) : null,
    blockers, counts,
  };
}

// Extracted field name -> contract date key (direct dates) or term (day counts).
const EXTRACTED_DATE_FIELDS: Record<string, string> = {
  effective_date: "effective", effective_on: "effective", deposit_due_date: "deposit", deposit_date: "deposit",
  earnest_money_due: "deposit", feasibility_expiration: "feasibility_expiry", feasibility_expiry: "feasibility_expiry",
  due_diligence_expiration: "feasibility_expiry", dd_expiration: "feasibility_expiry",
  additional_deposit_due: "additional_deposit", title_objection_deadline: "title_objection",
  title_cure_deadline: "title_cure", survey_deadline: "survey", financing_deadline: "financing",
  financing_contingency_expiration: "financing", estoppel_deadline: "estoppel", snda_deadline: "snda",
  closing_date: "closing", outside_closing_date: "extension_1", post_closing_deadline: "post_close",
};
const EXTRACTED_TERM_FIELDS = new Set(TERM_KEYS.filter((k) => k !== "extension_count" && k !== "extension_days"));

const normField = (name: string) => name.trim().toLowerCase().replace(/ /g, "_").replace(/-/g, "_");

function extractedScalar(value: any): any {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of ["value", "date", "days", "normalized"]) if (k in value) return value[k];
    return null;
  }
  return value;
}

/** Python repr() of a scalar JSON value (for skip messages). */
function pyRepr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const esc = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return q + (q === "'" ? esc.replace(/'/g, "\\'") : esc) + q;
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return JSON.stringify(v);
}

/** Reviewer-confirmed extracted values (documents module) recorded as *proposed* dates only. */
export async function proposeFromExtracted(db: Db, c: Contract, actor: CurrentUser): Promise<Row> {
  let extractedValues: any;
  try {
    extractedValues = (await import("../documents/schema")).extractedValues;
  } catch {
    return { proposed: [], skipped: [], message: "Document extraction is not available" };
  }
  const conds: SQL[] = [
    and(eq(extractedValues.target_entity_type, "contract"), eq(extractedValues.target_entity_id, c.id)) as SQL,
  ];
  if (c.document_id) conds.push(eq(extractedValues.document_id, c.document_id));
  const rows: Row[] = await db
    .select()
    .from(extractedValues)
    .where(and(or(...conds), inArray(extractedValues.status, ["confirmed", "edited"])))
    .orderBy(sql`${extractedValues.reviewed_at} asc nulls first`);
  if (!c.effective_on) {
    return { proposed: [], skipped: [], message: "Set the contract's effective date (verified against the document) first" };
  }

  const rules = new Map(contractRules(c).map((r) => [r.key, r]));
  const direct = new Map<string, [string, Row]>();
  const terms: Record<string, number> = {};
  const citations: Record<string, Row> = {};
  const skipped: string[] = [];
  for (const ev of rows) {
    const field = normField(ev.field);
    const cite = {
      document_id: ev.document_id, page: ev.page, clause: ev.clause, text: ev.citation_text, confidence: ev.confidence,
      extracted_value_id: ev.id, ai_model: ev.ai_model ?? null,
    };
    const raw = extractedScalar(ev.value);
    if (field in EXTRACTED_DATE_FIELDS) {
      const s = String(raw).slice(0, 10);
      if (raw !== null && raw !== undefined && isIsoDate(s)) direct.set(EXTRACTED_DATE_FIELDS[field], [s, cite]);
      else skipped.push(`${ev.field}: not a date (${pyRepr(raw)})`);
    } else if (EXTRACTED_TERM_FIELDS.has(field)) {
      try {
        terms[field] = pyInt(raw);
        citations[field] = cite;
      } catch {
        skipped.push(`${ev.field}: not a number of days (${pyRepr(raw)})`);
      }
    }
  }
  const out: CriticalDate[] = [];
  if (truthy(terms)) out.push(...(await generateDates(db, c, actor, { source: "ai", overrides: terms, citations })));
  for (const [key, [due, cite]] of direct) {
    const r = rules.get(key) ?? {
      date_type: key.startsWith("extension") ? "extension" : key, label: cap(key.replace(/_/g, " ")),
      is_blocking: false, lead_days: 7,
    };
    out.push(
      await upsertCriticalDate(db, {
        related_type: "contract", related_id: c.id, date_type: r.date_type, label: r.label, due_on: due,
        property_id: c.property_id, owner_id: c.owner_id, lead_days: Math.trunc(Number(r.lead_days || 7)),
        is_blocking: Boolean(r.is_blocking), source: "ai", status: "proposed", key, actor, related_label: c.title,
        citation: cite,
      }),
    );
  }
  await audit.record(db, {
    actor, action: "contract.dates_proposed", entity_type: ENTITY, entity_id: c.id,
    summary: `${out.length} proposed from confirmed extraction`, ip_address: actor.ip_address,
  });
  await db.commit();
  const seen = new Map(out.map((d) => [d.id, d]));
  return {
    proposed: await dateOuts(db, [...seen.values()]), skipped,
    message: out.length ? null : "No confirmed date fields were found in extraction",
  };
}

export async function contractActivity(db: Db, c: Contract, limit = 200) {
  const child: Array<[string, SQL | any]> = [
    ["critical_date", db.select({ id: criticalDates.id }).from(criticalDates).where(and(eq(criticalDates.related_type, "contract"), eq(criticalDates.related_id, c.id)))],
    ["dd_item", db.select({ id: ddItems.id }).from(ddItems).where(eq(ddItems.contract_id, c.id))],
    ["third_party_report", db.select({ id: thirdPartyReports.id }).from(thirdPartyReports).where(eq(thirdPartyReports.contract_id, c.id))],
    ["title_exception", db.select({ id: titleExceptions.id }).from(titleExceptions).where(eq(titleExceptions.contract_id, c.id))],
    ["estoppel", db.select({ id: estoppels.id }).from(estoppels).where(eq(estoppels.contract_id, c.id))],
    ["risk_item", db.select({ id: riskItems.id }).from(riskItems).where(eq(riskItems.contract_id, c.id))],
  ];
  const conds: SQL[] = [and(eq(auditEvents.entity_type, ENTITY), eq(auditEvents.entity_id, c.id)) as SQL];
  for (const [et, sub] of child) conds.push(and(eq(auditEvents.entity_type, et), inArray(auditEvents.entity_id, sub)) as SQL);
  return db.select().from(auditEvents).where(or(...conds)).orderBy(desc(auditEvents.occurred_at)).limit(limit);
}

// =========================================================================== DD templates & items

function ti(
  key: string,
  category: string,
  title: string,
  due_days: number | null = null,
  depends_on: string[] = [],
  o: { report_type?: string | null; severity?: string | null; description?: string | null } = {},
): Row {
  return {
    key, category, title, description: o.description ?? null, severity: o.severity ?? null, due_days,
    depends_on: [...depends_on], report_type: o.report_type ?? null,
  };
}

const _TITLE_SURVEY = [
  ti("title_commitment", "title", "Order and review title commitment and exception documents", 10, [], { report_type: "title" }),
  ti("survey_order", "survey", "Order ALTA/NSPS survey", 3, [], { report_type: "survey" }),
  ti("survey_review", "survey", "Review survey for encroachments, easements and access", 21, ["survey_order"]),
  ti("title_objection_letter", "title", "Deliver title and survey objection letter", 20, ["title_commitment", "survey_review"]),
];
const _ENV = [ti("phase_i", "environmental", "Phase I environmental site assessment", 21, [], { report_type: "phase_i" })];
const _PHYS = [ti("pca", "physical", "Property condition assessment", 21, [], { report_type: "pca" })];
const _ZONING = [ti("zoning", "zoning", "Zoning report and compliance confirmation", 21, [], { report_type: "zoning" })];
const _FIN = [
  ti("appraisal", "financial", "Appraisal", 25, [], { report_type: "appraisal" }),
  ti("financials", "financial", "Review operating statements, tax bills and utility history", 14),
  ti("insurance", "financial", "Insurance quote and loss runs", 20),
];
const _LEGAL = [
  ti("service_contracts", "legal", "Review service contracts and warranties", 20),
  ti("seller_authority", "legal", "Seller entity, authority and closing deliverables", 25),
];
const _LEASE_SINGLE = [
  ti("lease_review", "tenancy", "Abstract and review the lease and amendments", 10),
  ti("lease_audit", "tenancy", "Lease audit", 15, ["lease_review"], { report_type: "lease_audit" }),
  ti("tenant_credit", "financial", "Tenant and guarantor credit review", 14),
  ti("rofr", "legal", "Confirm tenant ROFR / ROFO waiver or expiration", 15, ["lease_review"]),
  ti("estoppel_snda", "tenancy", "Tenant estoppel and SNDA", 25, ["lease_review"]),
];
const _LEASE_MULTI = [
  ti("rent_roll", "tenancy", "Reconcile rent roll to leases", 10),
  ti("lease_audit", "tenancy", "Lease audit", 15, ["rent_roll"], { report_type: "lease_audit" }),
  ti("cam_recon", "financial", "Review CAM reconciliations and recoveries", 15),
  ti("co_tenancy", "legal", "Review co-tenancy, exclusives and radius restrictions", 14, ["rent_roll"]),
  ti("estoppels", "tenancy", "Tenant estoppels (all tenants)", 25, ["rent_roll"]),
  ti("sndas", "tenancy", "SNDAs for lender", 25, ["rent_roll"]),
];

export const DEFAULT_TEMPLATES: Row[] = [
  {
    code: "stnl", name: "Single-tenant net lease", property_types: ["stnl", "ground_lease"], is_generic: false,
    items: [..._TITLE_SURVEY, ..._ENV, ..._PHYS, ..._ZONING, ..._LEASE_SINGLE, ..._FIN, ..._LEGAL],
  },
  {
    code: "multi_tenant_retail", name: "Multi-tenant retail", property_types: ["multi_tenant_retail", "retail"],
    is_generic: false, items: [..._TITLE_SURVEY, ..._ENV, ..._PHYS, ..._ZONING, ..._LEASE_MULTI, ..._FIN, ..._LEGAL],
  },
  {
    code: "gas_convenience", name: "Gas / convenience", property_types: ["gas_convenience"], is_generic: false,
    items: [
      ..._TITLE_SURVEY, ..._ENV,
      ti("ust_records", "environmental", "UST registrations, tank tightness and release history", 14),
      ti("phase_ii", "environmental", "Phase II subsurface investigation (if Phase I recommends)", 28, ["phase_i"],
        { report_type: "phase_ii", severity: "high" }),
      ti("env_permits", "environmental", "Environmental permits and regulatory compliance history", 14),
      ti("fuel_supply", "legal", "Review fuel supply and branding agreements", 14),
      ..._PHYS, ..._ZONING, ..._LEASE_SINGLE, ..._FIN, ..._LEGAL,
    ],
  },
  {
    code: "medical", name: "Medical office", property_types: ["medical"], is_generic: false,
    items: [
      ..._TITLE_SURVEY, ..._ENV, ..._PHYS, ..._ZONING,
      ti("healthcare_licensing", "legal", "Healthcare licensing / certificate-of-need review", 14),
      ti("medical_waste", "environmental", "Medical waste and hazardous materials handling review", 14),
      ti("ada", "physical", "ADA accessibility review", 20, ["pca"]),
      ..._LEASE_MULTI, ..._FIN, ..._LEGAL,
    ],
  },
  {
    code: "land", name: "Land", property_types: ["land"], is_generic: false,
    items: [
      ..._TITLE_SURVEY, ..._ENV, ..._ZONING,
      ti("entitlements", "zoning", "Entitlement and land-use path review", 20, ["zoning"]),
      ti("utilities", "physical", "Utility availability and capacity letters", 20),
      ti("geotech", "physical", "Geotechnical investigation", 25),
      ti("wetlands_flood", "environmental", "Wetlands delineation and flood determination", 20),
      ti("access", "physical", "Access, curb cuts and traffic review", 15, ["survey_review"]),
      ti("appraisal", "financial", "Appraisal", 25, [], { report_type: "appraisal" }),
      ti("seller_authority", "legal", "Seller entity, authority and closing deliverables", 25),
    ],
  },
  {
    code: "office_industrial", name: "Office / industrial (generic)",
    property_types: ["office", "industrial", "mixed_use", "multifamily", "hospitality", "other"], is_generic: true,
    items: [..._TITLE_SURVEY, ..._ENV, ..._PHYS, ..._ZONING, ..._LEASE_MULTI, ..._FIN, ..._LEGAL],
  },
];

export async function ensureTemplates(db: Db): Promise<DDTemplate[]> {
  const load = () => db.select().from(ddTemplates).where(isNull(ddTemplates.deleted_at));
  let rows = await load();
  const have = new Set(rows.map((r) => r.code));
  const missing = DEFAULT_TEMPLATES.filter((t) => !have.has(t.code));
  if (missing.length) {
    const now = utcnow();
    await db
      .insert(ddTemplates)
      .values(
        missing.map((t) => ({
          id: newId(), code: t.code, name: t.name, property_types: t.property_types, is_generic: t.is_generic,
          is_active: true, version: 1, items: t.items, created_at: now, updated_at: now,
        })),
      )
      .onConflictDoNothing({ target: ddTemplates.code });
    rows = await load();
  }
  return rows.sort((a, b) =>
    a.is_generic !== b.is_generic ? (a.is_generic ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

export async function getTemplate(db: Db, template_id: string): Promise<DDTemplate> {
  const t = await get(db, ddTemplates, template_id);
  if (!t || t.deleted_at) throw new HttpError(404, "DD template not found");
  return t;
}

export async function templateFor(db: Db, property_type: string | null | undefined): Promise<DDTemplate | undefined> {
  const rows = (await ensureTemplates(db)).filter((t) => t.is_active);
  for (const t of rows) if (property_type && (t.property_types || []).includes(property_type)) return t;
  return rows.find((t) => t.is_generic) ?? rows[0];
}

/** Creates DD items (and their third-party report placeholders) from a template. Items whose key already
 *  exists on the contract are skipped, so re-applying is safe. Does not commit. */
export async function applyTemplate(db: Db, c: Contract, template_id: string | null | undefined, actor: Actor): Promise<DDItem[]> {
  let tpl: DDTemplate | undefined;
  if (template_id) tpl = await getTemplate(db, template_id);
  else {
    const ptype = c.property_id ? (await propertyInfo(db, [c.property_id])).get(c.property_id)?.[1] : null;
    tpl = await templateFor(db, ptype);
  }
  if (!tpl) return [];
  const existing = new Map<string, { id: string }>();
  for (const i of await db.select().from(ddItems).where(and(eq(ddItems.contract_id, c.id), isNull(ddItems.deleted_at)))) {
    if (i.key) existing.set(i.key, i);
  }
  const reports = new Map<string, { id: string }>();
  for (const r of await db
    .select()
    .from(thirdPartyReports)
    .where(and(eq(thirdPartyReports.contract_id, c.id), isNull(thirdPartyReports.deleted_at)))) {
    reports.set(r.report_type, r);
  }
  const actor_id = actor?.id ?? null;
  const created: Array<{ id: string; spec: Row; due: string | null; n: number }> = [];
  const newReports: Row[] = [];
  const base_order = existing.size;
  (tpl.items || []).forEach((spec: Row, n: number) => {
    if (existing.has(spec.key)) return;
    const due = c.effective_on && spec.due_days !== null && spec.due_days !== undefined
      ? addDays(c.effective_on, Math.trunc(Number(spec.due_days)))
      : null;
    const id = newId();
    const rt = spec.report_type;
    if (rt && !reports.has(rt)) {
      const rid = newId();
      newReports.push({
        id: rid, contract_id: c.id, property_id: c.property_id, report_type: rt, status: "not_ordered", expected_on: due,
        owner_id: c.owner_id, created_by_id: actor_id, updated_by_id: actor_id,
      });
      reports.set(rt, { id: rid });
    }
    created.push({ id, spec, due, n });
    existing.set(spec.key, { id });
  });
  // Items are inserted with their final dependencies / report links (ids are generated up front).
  const createdRows = await insertMany(
    db,
    ddItems,
    created.map(({ id, spec, due, n }) => ({
      id, contract_id: c.id, property_id: c.property_id, template_id: tpl!.id, key: spec.key,
      category: spec.category || "general", title: spec.title, description: spec.description ?? null,
      owner_id: c.owner_id, status: "not_started", due_on: due,
      depends_on: (spec.depends_on || []).filter((k: string) => existing.has(k)).map((k: string) => existing.get(k)!.id),
      source: "template", severity: spec.severity ?? null, escalation_level: 0, sort_order: base_order + n,
      report_id: spec.report_type && reports.has(spec.report_type) ? reports.get(spec.report_type)!.id : null,
      created_by_id: actor_id, updated_by_id: actor_id,
    })) as never,
  );
  await insertMany(db, thirdPartyReports, newReports as never);
  if (created.length) {
    await audit.record(db, {
      actor, action: "contract.dd_template_applied", entity_type: ENTITY, entity_id: c.id,
      summary: `${tpl.name} v${tpl.version}: ${created.length} items`, ip_address: actor?.ip_address,
    });
  }
  return createdRows;
}

export async function applyTemplateCommit(db: Db, c: Contract, template_id: string | null | undefined, actor: CurrentUser) {
  const items = await applyTemplate(db, c, template_id, actor);
  await db.commit();
  return items;
}

export async function saveTemplate(
  db: Db,
  t: DDTemplate | null,
  data: DDTemplateCreate | DDTemplateUpdate,
  actor: CurrentUser,
): Promise<DDTemplate> {
  const values: Row = { ...data };
  if (values.items !== undefined) {
    // Pydantic dumps every template-item field (None when unset).
    values.items = (values.items ?? []).map((i: Row) => ({
      key: i.key, category: i.category, title: i.title, description: i.description ?? null, severity: i.severity ?? null,
      due_days: i.due_days ?? null, depends_on: i.depends_on, report_type: i.report_type ?? null,
    }));
    const keys: string[] = values.items.map((i: Row) => i.key);
    if (keys.length !== new Set(keys).size) throw new HttpError(422, "Template item keys must be unique");
    for (const i of values.items) {
      const unknown = (i.depends_on as string[]).filter((k) => !keys.includes(k)).sort();
      if (unknown.length) throw new HttpError(422, `Unknown dependency ${unknown[0]}`);
    }
  }
  if (t === null) {
    const [dupe] = await db.select({ id: ddTemplates.id }).from(ddTemplates).where(eq(ddTemplates.code, values.code)).limit(1);
    if (dupe) throw new HttpError(409, "A template with this code already exists");
    t = await insert(db, ddTemplates, {
      ...values, is_generic: false, is_active: true, version: 1, created_by_id: actor.id, updated_by_id: actor.id,
    } as never);
    await audit.record(db, {
      actor, action: "dd_template.created", entity_type: "dd_template", entity_id: t.id, summary: t.name,
      ip_address: actor.ip_address,
    });
  } else {
    const changes = await apply(db, ddTemplates, t, values);
    if (Object.keys(changes).length) {
      if ("items" in changes) {
        await patch(db, ddTemplates, t, { version: (t.version || 1) + 1 });
        changes.items = {
          from: `${(changes.items.from || []).length} items`,
          to: `${values.items.length} items (v${t.version})`,
        };
      }
      await patch(db, ddTemplates, t, { updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: "dd_template.updated", entity_type: "dd_template", entity_id: t.id, summary: t.name, changes,
        ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return t;
}

export async function getDdItem(db: Db, item_id: string): Promise<DDItem> {
  const i = await get(db, ddItems, item_id);
  if (!i || i.deleted_at) throw new HttpError(404, "DD item not found");
  return i;
}

const DD_OUT_KEYS = [
  "id", "contract_id", "template_id", "key", "category", "title", "description", "owner_id", "status", "due_on",
  "depends_on", "source", "findings", "severity", "cost_impact", "resolution", "escalation_level", "escalated_at",
  "escalation_note", "report_id", "completed_at", "sort_order", "updated_at",
] as const;

export async function ddOuts(db: Db, items: DDItem[]): Promise<Row[]> {
  const names = await userNames(db, items.map((i) => i.owner_id));
  const depIds = [...new Set(items.flatMap((i) => (i.depends_on || []).map(asUuid)).filter(Boolean))] as string[];
  const deps = new Map<string, DDItem>();
  if (depIds.length) for (const d of await db.select().from(ddItems).where(inArray(ddItems.id, depIds))) deps.set(d.id, d);
  const t = today();
  return items.map((i) => ({
    ...pick(i, DD_OUT_KEYS),
    owner_name: (i.owner_id && names.get(i.owner_id)) || null,
    blocked_by: (i.depends_on || [])
      .map((x) => deps.get(asUuid(x) as string))
      .filter((d): d is DDItem => !!d && !d.deleted_at && !DONE.includes(d.status))
      .map((d) => ({ id: d.id, title: d.title, status: d.status })),
    is_overdue: Boolean(i.due_on && i.due_on < t && !DONE.includes(i.status)),
  }));
}

async function validateDeps(db: Db, contract_id: string, item_id: string | null, dep_ids: string[]): Promise<string[]> {
  if (!dep_ids.length) return [];
  if (item_id && dep_ids.includes(item_id)) throw new HttpError(422, "An item cannot depend on itself");
  const rows = await db.select().from(ddItems).where(and(eq(ddItems.contract_id, contract_id), isNull(ddItems.deleted_at)));
  const graph = new Map<string, Array<string | null>>(rows.map((r) => [r.id, (r.depends_on || []).map(asUuid)]));
  if (dep_ids.some((d) => !graph.has(d))) throw new HttpError(422, "Dependencies must be DD items on the same contract");
  if (item_id) {
    graph.set(item_id, [...dep_ids]);
    const stack: string[] = [...dep_ids];
    const seen = new Set<string>();
    while (stack.length) {
      const n = stack.pop() as string;
      if (n === item_id) throw new HttpError(422, "Dependency would create a cycle");
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...((graph.get(n) ?? []).filter(Boolean) as string[]));
    }
  }
  return [...new Set(dep_ids)];
}

async function checkCompletable(db: Db, depends_on: any[]): Promise<void> {
  const dep_ids = (depends_on || []).map(asUuid).filter(Boolean) as string[];
  if (!dep_ids.length) return;
  const open_deps = await db
    .select()
    .from(ddItems)
    .where(and(inArray(ddItems.id, dep_ids), isNull(ddItems.deleted_at), notInArray(ddItems.status, [...DONE])));
  if (open_deps.length) {
    throw new HttpError(409, {
      message: "Complete the items this depends on first",
      open_dependencies: open_deps.map((d) => ({ id: d.id, title: d.title, status: d.status })),
    });
  }
}

export async function createDdItem(db: Db, c: Contract, data: DDItemCreate, actor: CurrentUser): Promise<DDItem> {
  const values: Row = { ...data };
  values.depends_on = await validateDeps(db, c.id, null, values.depends_on);
  const [m] = await db.select({ m: sql<number | null>`max(${ddItems.sort_order})` }).from(ddItems).where(eq(ddItems.contract_id, c.id));
  const max_order = Number(m?.m ?? 0) || 0;
  if (DONE.includes(values.status)) {
    await checkCompletable(db, values.depends_on);
    values.completed_at = utcnow();
    values.completed_by_id = actor.id;
  }
  const i = await insert(db, ddItems, {
    ...values, contract_id: c.id, property_id: c.property_id, escalation_level: 0, sort_order: max_order + 1,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "dd_item.created", entity_type: "dd_item", entity_id: i.id, summary: i.title, ip_address: actor.ip_address,
  });
  await db.commit();
  return i;
}

export async function updateDdItem(db: Db, i: DDItem, data: DDItemUpdate, actor: CurrentUser): Promise<DDItem> {
  const values: Row = { ...data };
  if ("depends_on" in values) values.depends_on = await validateDeps(db, i.contract_id, i.id, values.depends_on || []);
  const new_status = values.status;
  if (new_status && new_status !== i.status) {
    if (new_status === "complete") await checkCompletable(db, "depends_on" in values ? values.depends_on : i.depends_on);
    if (DONE.includes(new_status)) {
      values.completed_at = utcnow();
      values.completed_by_id = actor.id;
    } else if (DONE.includes(i.status)) {
      values.completed_at = null;
      values.completed_by_id = null;
    }
  }
  const changes = await apply(db, ddItems, i, values);
  if (Object.keys(changes).length) {
    await patch(db, ddItems, i, { updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "dd_item.updated", entity_type: "dd_item", entity_id: i.id, summary: i.title, changes,
      ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return i;
}

export async function escalateDdItem(db: Db, i: DDItem, note: string, actor: CurrentUser): Promise<DDItem> {
  const { raiseAlert } = await import("../tasks/service");
  const c = await getContract(db, i.contract_id);
  await patch(db, ddItems, i, {
    escalation_level: (i.escalation_level || 0) + 1, escalated_at: utcnow(), escalation_note: note, updated_by_id: actor.id,
  });
  const target = (await managerOf(db, i.owner_id)) || c.owner_id || i.owner_id;
  await raiseAlert(db, {
    title: `Escalated DD item: ${i.title}`, reason: note,
    severity: i.severity && HIGH.includes(i.severity) ? "high" : "medium", owner_id: target,
    related_type: "contract", related_id: c.id, related_label: c.title, rule_key: "contracts.dd_escalation",
    idempotency_key: `dd_item:${i.id}:escalation:${i.escalation_level}`,
  } as never);
  await audit.record(db, {
    actor, action: "dd_item.escalated", entity_type: "dd_item", entity_id: i.id, summary: `${i.title}: ${note}`,
    changes: { escalation_level: i.escalation_level }, ip_address: actor.ip_address,
  });
  await db.commit();
  return i;
}

export async function softDelete(db: Db, table: any, obj: Row, entity_type: string, label: string, actor: CurrentUser): Promise<void> {
  await patch(db, table, obj as never, { deleted_at: utcnow(), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${entity_type}.archived`, entity_type, entity_id: obj.id, summary: label, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function deleteDdItem(db: Db, i: DDItem, actor: CurrentUser): Promise<void> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ddItems)
    .where(
      and(
        eq(ddItems.contract_id, i.contract_id), isNull(ddItems.deleted_at),
        sql`${ddItems.depends_on} @> ${JSON.stringify([i.id])}::jsonb`,
      ),
    );
  if (n) throw new HttpError(409, "Other items depend on this one; remove the dependency first");
  await softDelete(db, ddItems, i, "dd_item", i.title, actor);
}

export const ddTemplateOut = (t: Row) =>
  pick(t, ["id", "code", "name", "property_types", "is_generic", "is_active", "version", "items", "updated_at"]);

// =========================================================================== third-party reports

export async function child<T extends { id: any; deleted_at: any }>(db: Db, table: T, obj_id: string, what: string): Promise<any> {
  const obj = await get(db, table as never, obj_id);
  if (!obj || (obj as Row).deleted_at) throw new HttpError(404, `${what} not found`);
  return obj;
}

async function orgNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter(Boolean))] as string[];
  if (!set.length) return new Map();
  const { organizations } = await import("../contacts/schema");
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, set));
  return new Map(rows.map((r: Row) => [r.id, r.name]));
}

async function personNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter(Boolean))] as string[];
  if (!set.length) return new Map();
  const { people } = await import("../contacts/schema");
  const rows = await db.select({ id: people.id, name: people.full_name }).from(people).where(inArray(people.id, set));
  return new Map(rows.map((r: Row) => [r.id, r.name]));
}

const REPORT_OUT_KEYS = [
  "id", "contract_id", "vendor_organization_id", "vendor_name", "report_type", "status", "ordered_on", "expected_on",
  "delivered_on", "cost", "findings", "severity", "document_id", "owner_id", "notes", "updated_at",
] as const;

export async function reportOuts(db: Db, rows: ThirdPartyReport[]): Promise<Row[]> {
  const orgs = await orgNames(db, rows.map((r) => r.vendor_organization_id));
  const names = await userNames(db, rows.map((r) => r.owner_id));
  const t = today();
  return rows.map((r) => ({
    ...pick(r, REPORT_OUT_KEYS),
    vendor_label: (r.vendor_organization_id && orgs.get(r.vendor_organization_id)) || r.vendor_name || null,
    owner_name: (r.owner_id && names.get(r.owner_id)) || null,
    is_late: Boolean(r.expected_on && r.expected_on < t && ["not_ordered", "ordered", "in_progress"].includes(r.status)),
  }));
}

function reportDefaults(values: Row, current?: ThirdPartyReport): void {
  const st = values.status;
  if ((st === "ordered" || st === "in_progress") && !values.ordered_on && !(current && current.ordered_on)) {
    values.ordered_on = today();
  }
  if ((st === "delivered" || st === "reviewed") && !values.delivered_on && !(current && current.delivered_on)) {
    values.delivered_on = today();
  }
}

export async function createReport(db: Db, c: Contract, data: ReportCreate, actor: CurrentUser): Promise<ThirdPartyReport> {
  const values: Row = { ...data };
  reportDefaults(values);
  const r = await insert(db, thirdPartyReports, {
    ...values, contract_id: c.id, property_id: c.property_id, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "third_party_report.created", entity_type: "third_party_report", entity_id: r.id,
    summary: r.report_type, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function updateReport(db: Db, r: ThirdPartyReport, data: ReportUpdate, actor: CurrentUser): Promise<ThirdPartyReport> {
  const values: Row = { ...data };
  reportDefaults(values, r);
  const changes = await apply(db, thirdPartyReports, r, values);
  if (Object.keys(changes).length) {
    await patch(db, thirdPartyReports, r, { updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "third_party_report.updated", entity_type: "third_party_report", entity_id: r.id,
      summary: r.report_type, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return r;
}

// =========================================================================== title & survey

const EXCEPTION_OUT_KEYS = [
  "id", "contract_id", "kind", "source", "schedule_ref", "description", "recording_ref", "severity", "status",
  "objection_sent_on", "cure_due_on", "cure_response", "resolved_on", "attorney_person_id",
  "attorney_organization_id", "document_id", "notes", "updated_at",
] as const;

export async function exceptionOuts(db: Db, rows: TitleException[]): Promise<Row[]> {
  const people = await personNames(db, rows.map((r) => r.attorney_person_id));
  const orgs = await orgNames(db, rows.map((r) => r.attorney_organization_id));
  return rows.map((r) => ({
    ...pick(r, EXCEPTION_OUT_KEYS),
    attorney_label:
      [r.attorney_person_id && people.get(r.attorney_person_id), r.attorney_organization_id && orgs.get(r.attorney_organization_id)]
        .filter(Boolean)
        .join(" · ") || null,
  }));
}

function exceptionDefaults(values: Row, current?: TitleException): void {
  const st = values.status;
  if (st === "objected" && !values.objection_sent_on && !(current && current.objection_sent_on)) {
    values.objection_sent_on = today();
  }
  if (["cured", "accepted", "waived"].includes(st) && !values.resolved_on) values.resolved_on = today();
  if (["open", "objected", "cure_pending", "uncured"].includes(st) && current && current.resolved_on) values.resolved_on = null;
}

export async function createException(db: Db, c: Contract, data: TitleExceptionCreate, actor: CurrentUser): Promise<TitleException> {
  const values: Row = { ...data };
  exceptionDefaults(values);
  if (!values.attorney_person_id && !values.attorney_organization_id) {
    values.attorney_person_id = c.attorney_person_id;
    values.attorney_organization_id = c.attorney_organization_id;
  }
  const x = await insert(db, titleExceptions, {
    ...values, contract_id: c.id, property_id: c.property_id, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "title_exception.created", entity_type: "title_exception", entity_id: x.id,
    summary: x.description.slice(0, 200), ip_address: actor.ip_address,
  });
  await db.commit();
  return x;
}

export async function updateException(db: Db, x: TitleException, data: TitleExceptionUpdate, actor: CurrentUser): Promise<TitleException> {
  const values: Row = { ...data };
  exceptionDefaults(values, x);
  const changes = await apply(db, titleExceptions, x, values);
  if (Object.keys(changes).length) {
    await patch(db, titleExceptions, x, { updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "title_exception.updated", entity_type: "title_exception", entity_id: x.id,
      summary: x.description.slice(0, 200), changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return x;
}

// =========================================================================== estoppels / SNDA

/** Compares tenant-reported values with lease / rent-roll values. Only fields with both values are compared. */
export function detectDiscrepancies(e: Estoppel): Row[] {
  const out: Row[] = [];
  const money = (field: string, label: string, expected: number | null, reported: number | null, tolerance_pct: number) => {
    if (expected === null || expected === undefined || reported === null || reported === undefined) return;
    const tol = Math.max(1.0, Math.abs(expected) * tolerance_pct);
    if (Math.abs(Number(reported) - Number(expected)) > tol) {
      out.push({ field, label, expected, reported, delta: Math.round((Number(reported) - Number(expected)) * 100) / 100 });
    }
  };
  money("monthly_rent", "Monthly rent", e.expected_monthly_rent, e.reported_monthly_rent, 0.005);
  money("security_deposit", "Security deposit", e.expected_security_deposit, e.reported_security_deposit, 0.0);
  if (e.expected_expiration_on && e.reported_expiration_on && e.expected_expiration_on !== e.reported_expiration_on) {
    out.push({
      field: "expiration_on", label: "Lease expiration", expected: e.expected_expiration_on,
      reported: e.reported_expiration_on, delta: diffDays(e.reported_expiration_on, e.expected_expiration_on),
    });
  }
  if (e.reported_landlord_default) {
    out.push({ field: "landlord_default", label: "Tenant reports landlord default", expected: false, reported: true, delta: null });
  }
  return out;
}

/** Python `str()` of a JSON scalar (floats keep their ".0"; amounts are float columns). */
function pyStr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(1) : String(v);
  return String(v);
}

/** Stable signature of the reported discrepancy values (same digest the Python service produced). */
function discrepancySig(list: Row[]): string {
  const pairs = list.map((d) => [String(d.field), pyStr(d.reported)] as [string, string]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const repr = "[" + pairs.map(([f, v]) => `(${pyRepr(f)}, ${pyRepr(v)})`).join(", ") + "]";
  return createHash("sha1").update(repr).digest("hex").slice(0, 12);
}

/** Fills expected values from the leases module when a lease is linked (guarded: module may be absent). */
async function prefillFromLease(db: Db, e: Estoppel): Promise<void> {
  if (!e.lease_id) return;
  let leaseSchema: any;
  try {
    leaseSchema = await import("../leases/schema");
  } catch {
    return;
  }
  const { leases, rentSteps } = leaseSchema;
  if (!leases) return;
  const [lease] = await db.select().from(leases).where(eq(leases.id, e.lease_id)).limit(1);
  if (!lease) return;
  const set: Row = {};
  if (e.expected_expiration_on === null || e.expected_expiration_on === undefined) {
    set.expected_expiration_on = lease.expiration_on ?? null;
  }
  if ((e.expected_monthly_rent === null || e.expected_monthly_rent === undefined) && rentSteps) {
    const t = today();
    const [step] = await db
      .select()
      .from(rentSteps)
      .where(and(eq(rentSteps.lease_id, e.lease_id), lte(rentSteps.start_on, t), or(sql`${rentSteps.end_on} is null`, gte(rentSteps.end_on, t))))
      .orderBy(desc(rentSteps.start_on))
      .limit(1);
    if (step) {
      const monthly = step.monthly_rent;
      const annual = step.annual_rent;
      set.expected_monthly_rent = monthly !== null && monthly !== undefined ? monthly : annual ? Math.round((annual / 12) * 100) / 100 : null;
    }
  }
  if (!e.tenant_name && lease.tenant_name) set.tenant_name = lease.tenant_name;
  if (Object.keys(set).length) await patch(db, estoppels, e, set as never);
}

async function refreshDiscrepancies(db: Db, e: Estoppel, c: Contract): Promise<void> {
  const { raiseAlert } = await import("../tasks/service");
  const found = detectDiscrepancies(e);
  const sig = discrepancySig(found);
  const old_sig = discrepancySig(e.discrepancies || []);
  const values: Row = { discrepancies: audit.toJsonable(found), has_discrepancy: found.length > 0 };
  if (sig !== old_sig) {
    values.discrepancy_resolution = null;
    values.discrepancy_resolved_at = null;
    values.discrepancy_resolved_by_id = null;
  }
  await patch(db, estoppels, e, values as never);
  if (found.length && sig !== old_sig) {
    await raiseAlert(db, {
      title: `${e.kind.toUpperCase()} discrepancy: ${e.tenant_name}`, severity: "high", owner_id: c.owner_id,
      reason: found.map((d) => `${d.label}: expected ${pyStr(d.expected)}, reported ${pyStr(d.reported)}`).join("; "),
      related_type: "contract", related_id: c.id, related_label: c.title, rule_key: "contracts.estoppel_discrepancy",
      idempotency_key: `estoppel:${e.id}:discrepancy:${sig}`,
    } as never);
  }
}

function estoppelDefaults(values: Row, current?: Estoppel): void {
  const st = values.status;
  if (st === "requested" && !values.requested_on && !(current && current.requested_on)) values.requested_on = today();
  if ((st === "received" || st === "approved") && !values.received_on && !(current && current.received_on)) {
    values.received_on = today();
  }
}

const ESTOPPEL_OUT_KEYS = [
  "id", "contract_id", "kind", "lease_id", "tenant_name", "status", "requested_on", "due_on", "received_on",
  "expected_monthly_rent", "expected_expiration_on", "expected_security_deposit", "reported_monthly_rent",
  "reported_expiration_on", "reported_security_deposit", "reported_landlord_default", "reported_notes", "document_id",
  "notes", "discrepancies", "has_discrepancy", "discrepancy_resolution", "discrepancy_resolved_at", "updated_at",
] as const;
export const estoppelOut = (e: Row) => pick(e, ESTOPPEL_OUT_KEYS);

export async function createEstoppel(db: Db, c: Contract, data: EstoppelCreate, actor: CurrentUser): Promise<Estoppel> {
  const values: Row = { ...data };
  estoppelDefaults(values);
  if (values.status === "approved") throw new HttpError(422, "Record the estoppel as received before approving it");
  const e = await insert(db, estoppels, {
    ...values, contract_id: c.id, property_id: c.property_id, discrepancies: [], has_discrepancy: false,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await prefillFromLease(db, e);
  await refreshDiscrepancies(db, e, c);
  await audit.record(db, {
    actor, action: "estoppel.created", entity_type: "estoppel", entity_id: e.id, summary: `${e.kind}: ${e.tenant_name}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export async function updateEstoppel(db: Db, e: Estoppel, data: EstoppelUpdate, actor: CurrentUser): Promise<Estoppel> {
  const c = await getContract(db, e.contract_id);
  const values: Row = { ...data };
  estoppelDefaults(values, e);
  const changes = await apply(db, estoppels, e, values);
  if (!Object.keys(changes).length) return e;
  if ("lease_id" in changes) await prefillFromLease(db, e);
  await refreshDiscrepancies(db, e, c);
  if (e.status === "approved" && e.has_discrepancy && !e.discrepancy_resolved_at) {
    throw new HttpError(409, "Resolve the reported discrepancies before approving");
  }
  await patch(db, estoppels, e, { updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "estoppel.updated", entity_type: "estoppel", entity_id: e.id, summary: `${e.kind}: ${e.tenant_name}`,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

export async function resolveEstoppel(db: Db, e: Estoppel, note: string, actor: CurrentUser): Promise<Estoppel> {
  if (!e.has_discrepancy) throw new HttpError(409, "No discrepancy to resolve");
  await patch(db, estoppels, e, {
    discrepancy_resolution: note, discrepancy_resolved_at: utcnow(), discrepancy_resolved_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "estoppel.discrepancy_resolved", entity_type: "estoppel", entity_id: e.id,
    summary: `${e.tenant_name}: ${note}`, changes: { discrepancies: e.discrepancies }, ip_address: actor.ip_address,
  });
  await db.commit();
  return e;
}

// =========================================================================== risks

export function needsDecision(r: Pick<RiskItem, "decision_required" | "decision" | "status" | "severity">): boolean {
  return Boolean(r.decision_required && (r.decision === null || r.decision === undefined) && r.status !== "closed" && HIGH.includes(r.severity));
}

const RISK_OUT_KEYS = [
  "id", "contract_id", "title", "description", "category", "severity", "status", "source_type", "source_id", "owner_id",
  "cost_impact", "mitigation", "decision_required", "decision_due_on", "decision", "decision_reason", "decided_by_id",
  "decided_at", "updated_at",
] as const;

export async function riskOuts(db: Db, rows: RiskItem[]): Promise<Row[]> {
  const names = await userNames(db, [...rows.map((r) => r.owner_id), ...rows.map((r) => r.decided_by_id)]);
  return rows.map((r) => ({
    ...pick(r, RISK_OUT_KEYS),
    owner_name: (r.owner_id && names.get(r.owner_id)) || null,
    decided_by_name: (r.decided_by_id && names.get(r.decided_by_id)) || null,
    needs_decision: needsDecision(r),
  }));
}

export async function createRisk(db: Db, c: Contract, data: RiskCreate, actor: CurrentUser): Promise<RiskItem> {
  const values: Row = { ...data };
  if (values.decision_required === null || values.decision_required === undefined) {
    values.decision_required = HIGH.includes(values.severity);
  }
  if (values.decision_due_on === null || values.decision_due_on === undefined) {
    const feas = await feasibilityDate(db, c.id);
    values.decision_due_on = feas ? feas.due_on : null;
  }
  if (values.owner_id === null || values.owner_id === undefined) values.owner_id = c.owner_id;
  const r = await insert(db, riskItems, {
    ...values, contract_id: c.id, property_id: c.property_id, status: "open", created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "risk_item.created", entity_type: "risk_item", entity_id: r.id, summary: `${r.severity}: ${r.title}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function updateRisk(db: Db, r: RiskItem, data: RiskUpdate, actor: CurrentUser): Promise<RiskItem> {
  const changes = await apply(db, riskItems, r, data);
  if (Object.keys(changes).length) {
    await patch(db, riskItems, r, { updated_by_id: actor.id });
    await audit.record(db, {
      actor, action: "risk_item.updated", entity_type: "risk_item", entity_id: r.id, summary: r.title, changes,
      ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return r;
}

/** Every decision (including revisions) is kept in the audit trail with its reasoning. */
export async function decideRisk(db: Db, r: RiskItem, data: RiskDecideIn, actor: CurrentUser): Promise<RiskItem> {
  const prev = { decision: r.decision, reason: r.decision_reason };
  await patch(db, riskItems, r, {
    decision: data.decision, decision_reason: data.reason, decided_by_id: actor.id, decided_at: utcnow(),
    ...(r.status === "open" || r.status === "mitigating" ? { status: "decided" } : {}),
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "risk_item.decided", entity_type: "risk_item", entity_id: r.id, summary: `${data.decision}: ${r.title}`,
    ip_address: actor.ip_address,
    changes: { decision: { from: prev.decision, to: data.decision }, reason: { from: prev.reason, to: data.reason } },
  });
  await db.commit();
  return r;
}

// =========================================================================== extension / termination decisions

/** Immutable decision history. Extensions reschedule the targeted date (default: closing) with the reasoning;
 *  termination waives open dates; proceeding requires every high-severity risk to have a decision. */
export async function recordDecision(db: Db, c: Contract, data: DecisionCreate, actor: CurrentUser): Promise<ContractDecision> {
  if (c.status !== "executed") throw new HttpError(409, "Decisions are recorded on executed contracts");
  const dates = new Map((await contractDates(db, c.id)).map((d) => [d.key, d]));
  let target: CriticalDate | undefined;
  if (data.critical_date_id) {
    target = [...dates.values()].find((d) => d.id === data.critical_date_id);
    if (!target) throw new HttpError(422, "Critical date is not on this contract");
  }
  let previous_due: string | null = target ? target.due_on : null;
  const extra: Row = {};

  if (data.kind === "extend") {
    target = target || dates.get("closing") || dates.get("feasibility_expiry");
    if (!target || !data.new_due_on) throw new HttpError(422, "An extension needs the date to extend and the new date");
    if (data.new_due_on <= target.due_on) throw new HttpError(422, "The extended date must be after the current date");
    previous_due = target.due_on;
    if (target.status === "proposed") await confirm(db, target, { note: "Confirmed when recording extension" }, actor);
    await reschedule(db, target, data.new_due_on, `Extension: ${data.reasoning}`, actor);
    await recomputeDependents(db, c.id, actor);
  } else if (data.kind === "terminate") {
    let waived = 0;
    for (const d of dates.values()) {
      if (OPEN.includes(d.status)) {
        await waive(db, d, `Contract terminated: ${data.reasoning}`, actor);
        waived += 1;
      }
    }
    const prev = c.status;
    await patch(db, contracts, c, { status: "terminated", terminated_at: utcnow(), updated_by_id: actor.id });
    extra.waived_dates = waived;
    await audit.record(db, {
      actor, action: "contract.terminated", entity_type: ENTITY, entity_id: c.id, summary: data.reasoning.slice(0, 300),
      changes: { status: { from: prev, to: "terminated" } }, ip_address: actor.ip_address,
    });
  } else if (data.kind === "proceed") {
    const risks = await db.select().from(riskItems).where(and(eq(riskItems.contract_id, c.id), isNull(riskItems.deleted_at)));
    const pending = risks.filter(needsDecision);
    if (pending.length) {
      throw new HttpError(422, {
        message: "Record a decision on every high-severity risk before proceeding past feasibility",
        risks: pending.map((r) => ({ id: r.id, title: r.title, severity: r.severity })),
      });
    }
    const feas = target || dates.get("feasibility_expiry");
    if (feas && OPEN.includes(feas.status)) {
      if (feas.status === "proposed") throw new HttpError(422, "Confirm the feasibility deadline against the contract first");
      await complete(db, feas, `Proceeding: ${data.reasoning}`, actor);
      target = feas;
    }
  } else if (data.kind === "waive_contingency") {
    if (!target) throw new HttpError(422, "Choose the contingency date being waived");
    await waive(db, target, `Contingency waived: ${data.reasoning}`, actor);
  }

  const d = await insert(db, contractDecisions, {
    contract_id: c.id, kind: data.kind, reasoning: data.reasoning, critical_date_id: target ? target.id : null,
    previous_due_on: previous_due, new_due_on: data.kind === "extend" ? (data.new_due_on ?? null) : null,
    effective_on: data.effective_on || today(), decided_by_id: actor.id, decided_by_name: actor.full_name,
    decided_at: utcnow(), data: audit.toJsonable({ ...extra, target_label: target ? target.label : null }),
  } as never);
  await audit.record(db, {
    actor, action: "contract.decision_recorded", entity_type: ENTITY, entity_id: c.id,
    summary: `${data.kind}: ${data.reasoning.slice(0, 200)}`, ip_address: actor.ip_address,
    changes: { decision_id: d.id, kind: data.kind, new_due_on: d.new_due_on },
  });
  await db.commit();
  return d;
}
