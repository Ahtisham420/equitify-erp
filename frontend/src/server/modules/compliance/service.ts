/**
 * Communication compliance: send-time eligibility, consent, opt-out propagation and the outbound log.
 *
 * Public API used by other modules:
 *   checkSend(db, { channel, value, at }) -> [allowed, reasons]
 *   statusFor(db, channel, value) -> object
 *   suppressValue(...), logOutbound(...), personSuppressionReasons(...), exportWarnings(...)
 */
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { countWhere } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, patch } from "../../db/orm";
import { contactPoints, people } from "../contacts/schema";
import { sequenceEnrollments } from "../outreach/schema";
import { recordRuleRun, ruleConfig } from "../tasks/service";
import {
  CHANNELS,
  complianceRecords,
  complianceSettings,
  consentEvents,
  outboundMessages,
  providerRestrictions,
  type ComplianceRecord,
  type ComplianceSettings,
  type OutboundMessage,
} from "./schema";
import type { ConsentIn, OptOutIn, RecordUpsert, SettingsUpdate, SuppressIn } from "./schemas";

export const DEFAULT_QUIET_HOURS: Record<string, any> = {
  start: "08:00", end: "21:00", channels: ["phone", "sms"], default_utc_offset: -6,
};
export const DEFAULT_FREQUENCY_CAPS = { per_contact: { count: 3, period_days: 7 } };
export const DEFAULT_CHANNEL_CAPS = {
  phone: { count: 2, period_days: 1 },
  sms: { count: 1, period_days: 1 },
  email: { count: 2, period_days: 7 },
};

const group = (offset: number, states: string[]) => states.map((s) => [s, offset] as const);
// Standard-time UTC offsets; US daylight saving is applied by utcOffset except where not observed.
export const STATE_UTC_OFFSETS: Record<string, number> = Object.fromEntries([
  ...group(-5, ["CT", "DC", "DE", "FL", "GA", "IN", "KY", "MA", "MD", "ME", "MI", "NC", "NH", "NJ", "NY", "OH", "PA", "RI", "SC", "VA", "VT", "WV"]),
  ...group(-6, ["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"]),
  ...group(-7, ["AZ", "CO", "ID", "MT", "NM", "UT", "WY"]),
  ...group(-8, ["CA", "NV", "OR", "WA"]),
  ["AK", -9], ["HI", -10], ["PR", -4], ["GU", 10], ["VI", -4],
]);
const NO_DST = new Set(["AZ", "HI", "PR", "GU", "VI"]);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** Python `strftime("%b %d, %Y")` for a Date or a "YYYY-MM-DD" string. */
function fmtDate(d: Date | string): string {
  const x = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : d;
  return `${MONTHS[x.getUTCMonth()]} ${String(x.getUTCDate()).padStart(2, "0")}, ${x.getUTCFullYear()}`;
}
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// --------------------------------------------------------------------------- normalization & lookups

export function normalizeValue(channel: string, value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (channel === "email") return EMAIL.test(v) ? v.toLowerCase() : "";
  let digits = v.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 7 ? digits : "";
}

/** A phone number's call and text records share DNC/suppression facts. */
export const relatedChannels = (channel: string): string[] => (channel === "email" ? ["email"] : ["phone", "sms"]);

function requireNormalized(channel: string, value: string): string {
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new HttpError(422, `Unsupported channel '${channel}'`);
  const norm = normalizeValue(channel, value);
  if (!norm) throw new HttpError(422, `'${value}' is not a valid ${channel === "email" ? "email address" : "phone number"}`);
  return norm;
}

export async function getSettings(db: Db): Promise<ComplianceSettings> {
  const [s] = await db
    .select()
    .from(complianceSettings)
    .where(isNull(complianceSettings.deleted_at))
    .orderBy(asc(complianceSettings.created_at))
    .limit(1);
  if (s) return s;
  return insert(db, complianceSettings, {
    quiet_hours: { ...DEFAULT_QUIET_HOURS },
    frequency_caps: { ...DEFAULT_FREQUENCY_CAPS },
    channel_caps: { ...DEFAULT_CHANNEL_CAPS },
    scrub_validity_days: 31,
    not_interested_suppression_days: 180,
  } as never);
}

export async function records(db: Db, channel: string, norm: string): Promise<Record<string, ComplianceRecord>> {
  const rows = await db
    .select()
    .from(complianceRecords)
    .where(
      and(
        eq(complianceRecords.normalized_value, norm),
        inArray(complianceRecords.channel, relatedChannels(channel)),
        isNull(complianceRecords.deleted_at),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.channel, r]));
}

export async function upsert(
  db: Db,
  channel: string,
  norm: string,
  value: string,
  person_id: string | null | undefined = null,
  actor_id: string | null | undefined = null,
): Promise<ComplianceRecord> {
  const [found] = await db
    .select()
    .from(complianceRecords)
    .where(and(eq(complianceRecords.channel, channel), eq(complianceRecords.normalized_value, norm)))
    .limit(1);
  let rec = found;
  if (!rec) {
    rec = await insert(db, complianceRecords, {
      channel, value: value.trim().slice(0, 320), normalized_value: norm, person_id: person_id ?? null,
      phone_type: "unknown", jurisdiction_country: "US", dnc_status: "unknown", consent_state: "unknown",
      internal_suppression: false, opt_out_count: 0, created_by_id: actor_id ?? null, updated_by_id: actor_id ?? null,
    } as never);
  } else if (rec.deleted_at) {
    rec = await patch(db, complianceRecords, rec, { deleted_at: null });
  }
  if (person_id && !rec.person_id) rec = await patch(db, complianceRecords, rec, { person_id });
  return rec;
}

const suppressionActive = (r: ComplianceRecord, at: Date) =>
  Boolean(r.internal_suppression) && (r.suppressed_until === null || r.suppressed_until > at);

/** n-th Sunday of a month (month is 1-based) as a UTC day timestamp. */
function nthSunday(year: number, month: number, n: number): number {
  const first = Date.UTC(year, month - 1, 1);
  const weekday = (new Date(first).getUTCDay() + 6) % 7; // Monday = 0
  return first + ((6 - weekday) % 7) * DAY_MS + (n - 1) * 7 * DAY_MS;
}

function utcOffset(state: string | null | undefined, at: Date, fallback: number): number {
  const st = (state ?? "").toUpperCase();
  if (!(st in STATE_UTC_OFFSETS)) return fallback;
  let offset = STATE_UTC_OFFSETS[st];
  if (!NO_DST.has(st)) {
    const d = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
    if (nthSunday(at.getUTCFullYear(), 3, 2) <= d && d < nthSunday(at.getUTCFullYear(), 11, 1)) offset += 1;
  }
  return offset;
}

function minutes(hhmm: string): number {
  const [h, m] = (hhmm || "00:00").split(":");
  return parseInt(h, 10) * 60 + parseInt(m || "0", 10);
}

async function addEvent(
  db: Db,
  rec: ComplianceRecord,
  eventType: string,
  o: { source: string | null; evidence: string | null; actor: any; details?: Record<string, any> | null },
) {
  return insert(db, consentEvents, {
    record_id: rec.id, channel: rec.channel, normalized_value: rec.normalized_value, person_id: rec.person_id,
    event_type: eventType, source: o.source, evidence: o.evidence, actor_id: o.actor?.id ?? null,
    actor_name: o.actor?.full_name ?? null,
    details: o.details && Object.keys(o.details).length ? toJsonable(o.details) : null,
  } as never);
}

// --------------------------------------------------------------------------- send-time eligibility

/** Evaluates the current compliance state for an outbound call/text/email. Blocks with visible reasons. */
export async function checkSend(
  db: Db,
  o: { channel: string; value: string; at?: Date | null },
): Promise<[boolean, string[]]> {
  const { channel, value } = o;
  if (!(CHANNELS as readonly string[]).includes(channel)) return [false, [`Unsupported channel '${channel}'`]];
  const norm = normalizeValue(channel, value);
  if (!norm) return [false, [`'${value}' is not a valid ${channel === "email" ? "email address" : "phone number"}`]];
  const at = o.at ?? utcnow();
  const settings = await getSettings(db);
  const recs = await records(db, channel, norm);
  const rec = recs[channel];
  const related = Object.values(recs);
  const reasons: string[] = [];

  if (channel === "phone" || channel === "sms") {
    const scrub = rec && rec.scrub_date ? rec : related.find((r) => r.scrub_date);
    if (!scrub || scrub.dnc_status === "unknown") {
      reasons.push("No do-not-call scrub on file for this number");
    } else if (scrub.scrub_expires_on && scrub.scrub_expires_on < at.toISOString().slice(0, 10)) {
      reasons.push(
        `Do-not-call scrub expired on ${fmtDate(scrub.scrub_expires_on)} (source: ${scrub.scrub_source || "unknown"})`,
      );
    } else if (scrub.dnc_status === "listed" && !(rec && rec.consent_state === "granted")) {
      reasons.push("Number is on a do-not-call list and there is no recorded consent");
    }
    if (channel === "sms" && related.some((r) => r.phone_type === "landline")) {
      reasons.push("Landline numbers cannot receive text messages");
    }
  }

  const suppressed = related.find((r) => suppressionActive(r, at));
  if (suppressed) {
    const until = suppressed.suppressed_until ? ` until ${fmtDate(suppressed.suppressed_until)}` : "";
    reasons.push(`Internally suppressed${until}: ${suppressed.suppression_reason || "no reason recorded"}`);
  }
  const revoked = related.find((r) => r.consent_state === "revoked");
  if (revoked) {
    const when = revoked.opted_out_at ? ` on ${fmtDate(revoked.opted_out_at)}` : "";
    reasons.push(`Contact opted out / revoked consent${when}`);
  }

  const qh = { ...DEFAULT_QUIET_HOURS, ...(settings.quiet_hours ?? {}) };
  if ((qh.channels ?? []).includes(channel)) {
    const state = related.find((r) => r.jurisdiction_state)?.jurisdiction_state ?? null;
    const offset = utcOffset(state, at, Number(qh.default_utc_offset ?? -6));
    const local = new Date(at.getTime() + offset * 3_600_000);
    const start = minutes(qh.start);
    const end = minutes(qh.end);
    const nowM = local.getUTCHours() * 60 + local.getUTCMinutes();
    const inside = start < end ? start <= nowM && nowM < end : nowM >= start || nowM < end;
    if (!inside) {
      const hhmm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
      reasons.push(
        `Outside permitted contact hours (${qh.start}–${qh.end} local); it is ${hhmm} in ${state || "the default timezone"}`,
      );
    }
  }

  const personId = related.find((r) => r.person_id)?.person_id ?? null;
  const fc = (settings.frequency_caps ?? {}).per_contact;
  if (fc && fc.count !== null && fc.count !== undefined) {
    const days = Math.trunc(Number(fc.period_days ?? 7));
    const n = await countWhere(
      db,
      outboundMessages,
      and(
        personId ? eq(outboundMessages.person_id, personId) : eq(outboundMessages.normalized_value, norm),
        eq(outboundMessages.allowed, true),
        gte(outboundMessages.sent_at, new Date(at.getTime() - days * DAY_MS)),
        lte(outboundMessages.sent_at, at),
      ),
    );
    if (n >= Math.trunc(Number(fc.count))) {
      reasons.push(`Frequency cap reached: ${n} outbound touches in the last ${days} days (limit ${fc.count})`);
    }
  }
  const cc = (settings.channel_caps ?? {})[channel];
  if (cc && cc.count !== null && cc.count !== undefined) {
    const days = Math.trunc(Number(cc.period_days ?? 1));
    const n = await countWhere(
      db,
      outboundMessages,
      and(
        eq(outboundMessages.channel, channel),
        eq(outboundMessages.normalized_value, norm),
        eq(outboundMessages.allowed, true),
        gte(outboundMessages.sent_at, new Date(at.getTime() - days * DAY_MS)),
        lte(outboundMessages.sent_at, at),
      ),
    );
    if (n >= Math.trunc(Number(cc.count))) {
      reasons.push(
        `${channel === "sms" ? "SMS" : title(channel)} cap reached: ${n} in the last ${days} day${days !== 1 ? "s" : ""} (limit ${cc.count})`,
      );
    }
  }
  return [reasons.length === 0, reasons];
}

export async function statusFor(db: Db, channel: string, value: string) {
  const [allowed, reasons] = await checkSend(db, { channel, value });
  const norm = normalizeValue(channel, value);
  const rec = norm ? (await records(db, channel, norm))[channel] : undefined;
  return {
    channel, value, normalized_value: norm, allowed, reasons,
    dnc_status: rec ? rec.dnc_status : "unknown",
    consent_state: rec ? rec.consent_state : "unknown",
    suppressed: Boolean(rec && suppressionActive(rec, utcnow())),
    phone_type: rec ? rec.phone_type : null,
    record_id: rec ? rec.id : null,
  };
}

/** Appends to the immutable outbound content log. Does not commit. */
export async function logOutbound(
  db: Db,
  o: {
    channel: string;
    value: string;
    content: string | null;
    actor: any;
    allowed: boolean;
    reasons?: string[] | null;
    subject?: string | null;
    interaction_id?: string | null;
    person_id?: string | null;
  },
): Promise<OutboundMessage> {
  return insert(db, outboundMessages, {
    channel: o.channel,
    to_value: o.value.trim().slice(0, 320),
    normalized_value: normalizeValue(o.channel, o.value) || o.value.trim(),
    person_id: o.person_id ?? null,
    subject: o.subject ?? null,
    content: o.content,
    actor_id: o.actor?.id ?? null,
    actor_name: o.actor?.full_name ?? null,
    interaction_id: o.interaction_id ?? null,
    allowed: o.allowed,
    block_reasons: o.reasons ?? [],
  } as never);
}

// --------------------------------------------------------------------------- CRM lookups

async function personForValue(db: Db, channel: string, norm: string): Promise<string | null> {
  const cond =
    channel === "email"
      ? sql`lower(${contactPoints.value}) = ${norm}`
      : sql`right(regexp_replace(${contactPoints.value}, '[^0-9]', '', 'g'), 10) = ${norm.slice(-10)}`;
  const [r] = await db
    .select({ person_id: contactPoints.person_id })
    .from(contactPoints)
    .where(and(eq(contactPoints.kind, channel === "email" ? "email" : "phone"), sql`${contactPoints.person_id} is not null`, cond))
    .limit(1);
  return r?.person_id ?? null;
}

/** [kind 'phone'|'email', value, label] from contact points plus the person's primary phone/email. */
export async function personContactValues(db: Db, person_id: string): Promise<Array<[string, string, string | null]>> {
  const out: Array<[string, string, string | null]> = [];
  const cps = await db
    .select()
    .from(contactPoints)
    .where(and(eq(contactPoints.person_id, person_id), isNull(contactPoints.deleted_at)));
  for (const cp of cps) if ((cp.kind === "phone" || cp.kind === "email") && cp.value) out.push([cp.kind, cp.value, cp.label]);
  const p = await ormGet(db, people, person_id);
  if (p) {
    if (p.primary_phone) out.push(["phone", p.primary_phone, "Primary"]);
    if (p.primary_email) out.push(["email", p.primary_email, "Primary"]);
  }
  const seen = new Set<string>();
  const unique: Array<[string, string, string | null]> = [];
  for (const [kind, value, lbl] of out) {
    const n = normalizeValue(kind === "email" ? "email" : "phone", value);
    const key = `${kind}\u0000${n}`;
    if (n && !seen.has(key)) {
      seen.add(key);
      unique.push([kind, value, lbl]);
    }
  }
  return unique;
}

async function exitEnrollments(db: Db, person_id: string, reason: string): Promise<number> {
  const rows = await db
    .update(sequenceEnrollments)
    .set({ status: "exited", exit_reason: reason, exited_at: utcnow(), next_step_at: null } as never)
    .where(and(eq(sequenceEnrollments.person_id, person_id), inArray(sequenceEnrollments.status, ["active", "paused"])))
    .returning({ id: sequenceEnrollments.id });
  return rows.length;
}

// --------------------------------------------------------------------------- suppression, opt-out, consent

/** Internal suppression of a value (and its call/text sibling). Does not commit. */
export async function suppressValue(
  db: Db,
  o: {
    channel: string;
    value: string;
    reason: string;
    actor?: any;
    person_id?: string | null;
    until?: Date | null;
    source?: string;
  },
): Promise<ComplianceRecord | null> {
  const { channel, value, reason, actor = null, person_id = null, until = null, source = "manual" } = o;
  const norm = normalizeValue(channel, value);
  if (!norm) return null;
  let first: ComplianceRecord | null = null;
  for (const ch of relatedChannels(channel)) {
    const rec = await upsert(db, ch, norm, value, person_id, actor?.id ?? null);
    first = first ?? rec;
    if (suppressionActive(rec, utcnow()) && rec.suppressed_until === null) continue; // never shorten indefinite suppression
    await patch(db, complianceRecords, rec, {
      internal_suppression: true,
      suppression_reason: reason.slice(0, 200),
      suppressed_at: utcnow(),
      suppressed_until: until,
    });
    await addEvent(db, rec, "suppressed", { source, evidence: null, actor, details: { reason, until } });
  }
  return first;
}

async function applyOptOut(
  db: Db,
  o: {
    channel: string;
    value: string;
    person_id: string | null | undefined;
    source: string;
    evidence: string | null | undefined;
    actor: any;
    event_type?: string;
  },
) {
  const { channel, value, source, actor, event_type = "opt_out" } = o;
  const norm = requireNormalized(channel, value);
  const now = utcnow();
  const actorId = actor?.id ?? null;
  const rec = await upsert(db, channel, norm, value, o.person_id, actorId);
  const personId = o.person_id || rec.person_id || (await personForValue(db, channel, norm));
  await patch(db, complianceRecords, rec, {
    person_id: rec.person_id ?? personId ?? null,
    consent_state: "revoked",
    opted_out_at: now,
    opt_out_count: (rec.opt_out_count || 0) + 1,
    internal_suppression: true,
    suppression_reason: `Opted out (${source})`.slice(0, 200),
    suppressed_at: now,
    suppressed_until: null,
    updated_by_id: actorId,
  });
  await addEvent(db, rec, event_type, { source, evidence: o.evidence ?? null, actor });

  const targets = new Map<string, { ch: string; n: string; v: string }>();
  const setDefault = (ch: string, n: string, v: string) => {
    const key = `${ch}\u0000${n}`;
    if (!targets.has(key)) targets.set(key, { ch, n, v });
  };
  for (const ch of relatedChannels(channel)) setDefault(ch, norm, value);
  const [enabled] = await ruleConfig(db, "compliance.optout_propagation");
  if (enabled && personId) {
    for (const [kind, v] of await personContactValues(db, personId)) {
      for (const ch of relatedChannels(kind === "email" ? "email" : "phone")) {
        const n = normalizeValue(ch, v);
        if (n) setDefault(ch, n, v);
      }
    }
  }
  targets.delete(`${channel}\u0000${norm}`);

  let propagated = 0;
  for (const { ch, n, v } of targets.values()) {
    const r = await upsert(db, ch, n, v, personId, actorId);
    if (suppressionActive(r, now) && r.suppressed_until === null) continue;
    await patch(db, complianceRecords, r, {
      internal_suppression: true,
      suppression_reason: `Opt-out propagated from ${channel} ${value}`.slice(0, 200),
      suppressed_at: now,
      suppressed_until: null,
    });
    await addEvent(db, r, "suppressed", {
      source: "opt_out_propagation", evidence: null, actor, details: { origin_channel: channel, origin_value: norm },
    });
    propagated += 1;
  }

  const exited = personId ? await exitEnrollments(db, personId, "opted_out") : 0;
  if (enabled) await recordRuleRun(db, "compliance.optout_propagation");
  await audit.record(db, {
    actor, action: "compliance.opted_out", entity_type: "compliance_record", entity_id: rec.id,
    summary: `${channel} ${norm}`, changes: { propagated, enrollments_exited: exited, source },
    ip_address: actor?.ip_address ?? null,
  });
  if (personId) {
    await audit.record(db, {
      actor, action: "person.opted_out", entity_type: "person", entity_id: personId, summary: `Opted out via ${channel}`,
      ip_address: actor?.ip_address ?? null,
    });
  }
  await events.emit(db, "compliance.opted_out", { person_id: personId, channel, value: norm, actor });
  return { record: rec, propagated, enrollments_exited: exited };
}

export async function optOut(db: Db, data: OptOutIn, actor: CurrentUser) {
  const result = await applyOptOut(db, {
    channel: data.channel, value: data.value, person_id: data.person_id, source: data.source,
    evidence: data.evidence, actor,
  });
  await db.commit();
  return result;
}

export async function setConsent(db: Db, data: ConsentIn, actor: CurrentUser): Promise<ComplianceRecord> {
  if (data.state === "revoked") {
    const result = await applyOptOut(db, {
      channel: data.channel, value: data.value, person_id: data.person_id, source: data.source,
      evidence: data.evidence, actor, event_type: "consent_revoked",
    });
    await db.commit();
    return result.record;
  }

  const norm = requireNormalized(data.channel, data.value);
  const rec = await upsert(db, data.channel, norm, data.value, data.person_id, actor.id);
  const reversing = rec.consent_state === "revoked" || (rec.internal_suppression && data.lift_suppression);
  if (reversing) {
    // Users cannot casually reverse suppression: approval permission plus recorded evidence.
    if (!actor.can("compliance", "approve")) {
      throw new HttpError(403, "Reversing an opt-out or suppression requires compliance approval permission");
    }
    if (!data.evidence || data.evidence.trim().length < 10) {
      throw new HttpError(422, "Describe the evidence of the new consent (at least 10 characters)");
    }
  }
  const now = utcnow();
  const before = { consent_state: rec.consent_state, internal_suppression: rec.internal_suppression };
  await patch(db, complianceRecords, rec, {
    consent_state: "granted", consent_source: data.source, consent_date: now, updated_by_id: actor.id,
  });
  await addEvent(db, rec, "consent_granted", { source: data.source, evidence: data.evidence ?? null, actor });
  if (reversing && rec.internal_suppression) {
    await patch(db, complianceRecords, rec, { internal_suppression: false, suppression_reason: null, suppressed_until: null });
    await addEvent(db, rec, "suppression_lifted", {
      source: data.source, evidence: data.evidence ?? null, actor, details: { previous: before },
    });
  }
  await audit.record(db, {
    actor, action: "compliance.consent_granted", entity_type: "compliance_record", entity_id: rec.id,
    summary: `${rec.channel} ${rec.normalized_value}`,
    changes: { from: before, to: { consent_state: "granted", internal_suppression: rec.internal_suppression } },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return rec;
}

export async function manualSuppress(db: Db, data: SuppressIn, actor: CurrentUser): Promise<ComplianceRecord | null> {
  requireNormalized(data.channel, data.value);
  const rec = await suppressValue(db, {
    channel: data.channel, value: data.value, reason: data.reason, actor, person_id: data.person_id,
    until: data.until ?? null, source: "manual",
  });
  await audit.record(db, {
    actor, action: "compliance.suppressed", entity_type: "compliance_record", entity_id: rec ? rec.id : null,
    summary: `${data.channel} ${data.value}: ${data.reason}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return rec;
}

export async function personSuppressionReasons(db: Db, person_id: string): Promise<string[]> {
  const now = utcnow();
  const rows = await db
    .select()
    .from(complianceRecords)
    .where(
      and(
        eq(complianceRecords.person_id, person_id),
        isNull(complianceRecords.deleted_at),
        or(eq(complianceRecords.consent_state, "revoked"), eq(complianceRecords.internal_suppression, true)),
      ),
    );
  const reasons: string[] = [];
  for (const r of rows) {
    if (r.consent_state === "revoked") reasons.push(`Opted out on ${r.channel} ${r.value}`);
    else if (suppressionActive(r, now)) {
      reasons.push(`${title(r.channel)} ${r.value} suppressed: ${r.suppression_reason || "no reason"}`);
    }
  }
  return reasons;
}

// --------------------------------------------------------------------------- scrub facts & settings

export async function upsertRecord(db: Db, data: RecordUpsert, actor: CurrentUser): Promise<ComplianceRecord> {
  const norm = requireNormalized(data.channel, data.value);
  const rec = await upsert(db, data.channel, norm, data.value, data.person_id, actor.id);
  const { channel: _c, value: _v, ...rest } = data;
  const values = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return updateRecord(db, rec, values, actor, true);
}

export async function updateRecord(
  db: Db,
  rec: ComplianceRecord,
  input: Record<string, any>,
  actor: CurrentUser,
  created = false,
): Promise<ComplianceRecord> {
  const values: Record<string, any> = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => v !== undefined && (k !== "person_id" || v !== null)),
  );
  if (values.jurisdiction_state) values.jurisdiction_state = String(values.jurisdiction_state).toUpperCase();
  if (values.jurisdiction_country) values.jurisdiction_country = String(values.jurisdiction_country).toUpperCase();
  if ("scrub_date" in values || "dnc_status" in values) {
    const scrubDate: string | null = "scrub_date" in values ? values.scrub_date : rec.scrub_date;
    if (scrubDate) {
      const settings = await getSettings(db);
      const d = new Date(`${scrubDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + (settings.scrub_validity_days || 31));
      values.scrub_expires_on = d.toISOString().slice(0, 10);
    }
  }
  const changes = audit.diff(rec, values);
  if (!Object.keys(changes).length && !created) return rec;
  await patch(db, complianceRecords, rec, { ...values, updated_by_id: actor.id } as never);
  if (["dnc_status", "scrub_date", "scrub_source"].some((k) => k in changes)) {
    await addEvent(db, rec, "dnc_scrubbed", {
      source: rec.scrub_source, evidence: null, actor,
      details: Object.fromEntries(["dnc_status", "scrub_date", "scrub_source"].filter((k) => k in changes).map((k) => [k, changes[k]])),
    });
  }
  await audit.record(db, {
    actor, action: "compliance_record.updated", entity_type: "compliance_record", entity_id: rec.id,
    summary: `${rec.channel} ${rec.normalized_value}`, changes: Object.keys(changes).length ? changes : null,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return rec;
}

export async function updateSettings(db: Db, data: SettingsUpdate, actor: CurrentUser): Promise<ComplianceSettings> {
  const s = await getSettings(db);
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  // jsonb does not preserve key order, so compare JSON values with sorted keys.
  const canon = (v: any): any =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
  const changes = audit.diff(s, values);
  for (const [k, c] of Object.entries(changes)) {
    if (JSON.stringify(canon(c.from)) === JSON.stringify(canon(c.to))) delete changes[k];
  }
  await patch(db, complianceSettings, s, { ...values, updated_by_id: actor.id } as never);
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "compliance_settings.updated", entity_type: "compliance_settings", entity_id: s.id, changes,
      ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return s;
}

/** Warnings (and hard blocks) before exporting contact data sourced from restricted providers. */
export async function exportWarnings(
  db: Db,
  o: { providers?: string[] | null; values?: Array<[string, string]> | null },
): Promise<[boolean, string[]]> {
  const providers = new Set((o.providers ?? []).filter(Boolean));
  const warnings: string[] = [];
  let optedOut = 0;
  for (const [channel, value] of o.values ?? []) {
    const norm = normalizeValue(channel, value);
    if (!norm) continue;
    for (const r of Object.values(await records(db, channel, norm))) {
      if (r.provider) providers.add(r.provider);
      if (r.consent_state === "revoked" || suppressionActive(r, utcnow())) {
        optedOut += 1;
        break;
      }
    }
  }
  let blocked = false;
  if (providers.size) {
    const rows = await db
      .select()
      .from(providerRestrictions)
      .where(
        and(
          eq(providerRestrictions.is_active, true),
          isNull(providerRestrictions.deleted_at),
          inArray(sql`lower(${providerRestrictions.provider})`, [...providers].map((p) => p.toLowerCase())),
        ),
      );
    for (const r of rows) {
      warnings.push(`Data from ${r.provider} is restricted (${r.restriction.replace(/_/g, " ")})` + (r.notes ? `: ${r.notes}` : ""));
      blocked = blocked || r.block_export;
    }
  }
  if (optedOut) {
    warnings.push(`${optedOut} contact value${optedOut !== 1 ? "s are" : " is"} opted out or suppressed`);
  }
  return [blocked, warnings];
}
