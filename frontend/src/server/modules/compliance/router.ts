import { and, desc, eq, gte, ilike, isNull, lt, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, applySort, facetCounts, inFilter, page, paginate } from "../../common/query";
import { created, HttpError } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import { get as ormGet, insert, patch } from "../../db/orm";
import {
  CHANNELS,
  CONSENT_STATES,
  DNC_STATUSES,
  EVENT_TYPES,
  PHONE_TYPES,
  RESTRICTIONS,
  complianceRecords,
  consentEvents,
  outboundMessages,
  providerRestrictions,
  type ComplianceRecord,
  type ComplianceSettings,
  type ProviderRestriction,
} from "./schema";
import {
  checkIn,
  consentIn,
  exportCheckIn,
  optOutIn,
  recordUpdate,
  recordUpsert,
  restrictionIn,
  settingsUpdate,
  suppressIn,
} from "./schemas";
import * as service from "./service";

export const router = new Router();

const R = complianceRecords;
const RECORD_SORTS = {
  value: R.normalized_value, channel: R.channel, dnc_status: R.dnc_status, consent_state: R.consent_state,
  scrub_expires_on: R.scrub_expires_on, updated_at: R.updated_at, opted_out_at: R.opted_out_at,
};

interface RecordFilters {
  q?: string;
  channel?: string[];
  dnc_status?: string[];
  consent_state?: string[];
  phone_type?: string[];
  suppressed?: string[];
  person_id?: string;
  scrub_expired: boolean;
  provider?: string;
}

function recordFilters(ctx: Ctx): RecordFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    channel: q.strs("channel"),
    dnc_status: q.strs("dnc_status"),
    consent_state: q.strs("consent_state"),
    phone_type: q.strs("phone_type"),
    suppressed: q.strs("suppressed"), // 'suppressed' and/or 'active'
    person_id: q.uuid("person_id"),
    scrub_expired: q.bool("scrub_expired") ?? false,
    provider: q.str("provider"),
  };
}

function recordWhere(f: RecordFilters, skip: Set<string> = new Set()): SQL | undefined {
  let search: SQL | undefined;
  if (f.q) {
    const digits = f.q.replace(/\D/g, "");
    search = applySearch(digits.length >= 3 && !f.q.includes("@") ? digits : f.q, [R.value, R.normalized_value, R.suppression_reason]);
  }
  return and(
    isNull(R.deleted_at),
    search,
    skip.has("channel") ? undefined : inFilter(R.channel, f.channel),
    skip.has("dnc_status") ? undefined : inFilter(R.dnc_status, f.dnc_status),
    skip.has("consent_state") ? undefined : inFilter(R.consent_state, f.consent_state),
    skip.has("phone_type") ? undefined : inFilter(R.phone_type, f.phone_type),
    !skip.has("suppressed") && f.suppressed && new Set(f.suppressed).size === 1
      ? eq(R.internal_suppression, f.suppressed[0] === "suppressed")
      : undefined,
    f.person_id ? eq(R.person_id, f.person_id) : undefined,
    f.scrub_expired ? lt(R.scrub_expires_on, new Date().toISOString().slice(0, 10)) : undefined,
    f.provider ? ilike(R.provider, `%${f.provider}%`) : undefined,
  );
}

/** Recording an opt-out is protective, so anyone who works outreach may do it. */
async function canRecordOptOut(ctx: Ctx) {
  const user = await ctx.authed();
  if (!(user.can("compliance", "edit") || user.can("outreach", "create"))) {
    throw new HttpError(403, "Missing permission compliance:edit");
  }
  return user;
}

const recordOut = (r: ComplianceRecord) => ({
  id: r.id,
  channel: r.channel,
  value: r.value,
  normalized_value: r.normalized_value,
  person_id: r.person_id,
  phone_type: r.phone_type,
  jurisdiction_state: r.jurisdiction_state,
  jurisdiction_country: r.jurisdiction_country,
  dnc_status: r.dnc_status,
  scrub_date: r.scrub_date,
  scrub_source: r.scrub_source,
  scrub_expires_on: r.scrub_expires_on,
  internal_suppression: r.internal_suppression,
  suppression_reason: r.suppression_reason,
  suppressed_at: r.suppressed_at,
  suppressed_until: r.suppressed_until,
  consent_state: r.consent_state,
  consent_source: r.consent_source,
  consent_date: r.consent_date,
  opted_out_at: r.opted_out_at,
  opt_out_count: r.opt_out_count,
  provider: r.provider,
  notes: r.notes,
  updated_at: r.updated_at,
});

const settingsOut = (s: ComplianceSettings) => ({
  quiet_hours: s.quiet_hours,
  frequency_caps: s.frequency_caps,
  channel_caps: s.channel_caps,
  scrub_validity_days: s.scrub_validity_days,
  not_interested_suppression_days: s.not_interested_suppression_days,
  counsel_reviewed_at: s.counsel_reviewed_at,
  counsel_reviewed_by: s.counsel_reviewed_by,
  updated_at: s.updated_at,
});

const restrictionOut = (r: ProviderRestriction) => ({
  provider: r.provider,
  restriction: r.restriction,
  block_export: r.block_export,
  notes: r.notes,
  is_active: r.is_active,
  id: r.id,
  updated_at: r.updated_at,
});

router.get("/compliance/meta", async (ctx) => {
  await ctx.require("compliance", "view");
  return {
    channels: CHANNELS,
    phone_types: PHONE_TYPES,
    dnc_statuses: DNC_STATUSES,
    consent_states: CONSENT_STATES,
    event_types: EVENT_TYPES,
    restrictions: RESTRICTIONS,
    state_utc_offsets: service.STATE_UTC_OFFSETS,
  };
});

router.get("/compliance/records", async (ctx) => {
  await ctx.require("compliance", "view");
  const p = ctx.listParams();
  const order = applySort(p.sort, RECORD_SORTS, desc(R.updated_at));
  const [items, total] = await paginate(ctx.db, R, recordWhere(recordFilters(ctx)), order, p);
  return page(items.map(recordOut), total, p);
});

router.get("/compliance/records/facets", async (ctx) => {
  await ctx.require("compliance", "view");
  const f = recordFilters(ctx);
  const flags = await ctx.db
    .select({ k: R.internal_suppression, n: sql<number>`count(*)::int` })
    .from(R)
    .where(recordWhere(f, new Set(["suppressed"])))
    .groupBy(R.internal_suppression);
  return {
    channel: await facetCounts(ctx.db, R, recordWhere(f, new Set(["channel"])), R.channel),
    dnc_status: await facetCounts(ctx.db, R, recordWhere(f, new Set(["dnc_status"])), R.dnc_status),
    consent_state: await facetCounts(ctx.db, R, recordWhere(f, new Set(["consent_state"])), R.consent_state),
    phone_type: await facetCounts(ctx.db, R, recordWhere(f, new Set(["phone_type"])), R.phone_type),
    suppressed: Object.fromEntries(flags.map((r) => [r.k ? "suppressed" : "active", Number(r.n)])),
  };
});

/** Create or update scrub/classification facts (phone type, jurisdiction, DNC scrub, provider). */
router.post("/compliance/records", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(recordUpsert);
  return created(recordOut(await service.upsertRecord(ctx.db, body, user)));
});

router.get("/compliance/records/{record_id}", async (ctx) => {
  await ctx.require("compliance", "view");
  const rec = await ormGet(ctx.db, R, ctx.uuid("record_id"));
  if (!rec || rec.deleted_at) throw new HttpError(404, "Compliance record not found");
  const events = await ctx.db
    .select()
    .from(consentEvents)
    .where(
      and(
        eq(consentEvents.normalized_value, rec.normalized_value),
        sql`${consentEvents.channel} in (${sql.join(service.relatedChannels(rec.channel).map((c) => sql`${c}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(consentEvents.occurred_at))
    .limit(200);
  const [allowed, reasons] = await service.checkSend(ctx.db, { channel: rec.channel, value: rec.value });
  await ctx.db.commit(); // checkSend may lazily create the settings row
  return { ...recordOut(rec), events, allowed, reasons };
});

router.patch("/compliance/records/{record_id}", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(recordUpdate);
  const rec = await ormGet(ctx.db, R, ctx.uuid("record_id"));
  if (!rec || rec.deleted_at) throw new HttpError(404, "Compliance record not found");
  return recordOut(await service.updateRecord(ctx.db, rec, body, user));
});

/** Send-time eligibility test for a value. Nothing is sent or logged. */
router.post("/compliance/check", async (ctx) => {
  await ctx.require("compliance", "view");
  const body = await ctx.body(checkIn);
  const [allowed, reasons] = await service.checkSend(ctx.db, { channel: body.channel, value: body.value, at: body.at });
  const norm = service.normalizeValue(body.channel, body.value);
  const rec = norm ? (await service.records(ctx.db, body.channel, norm))[body.channel] : undefined;
  await ctx.db.commit();
  return {
    channel: body.channel,
    value: body.value,
    normalized_value: norm,
    allowed,
    reasons,
    record: rec ? recordOut(rec) : null,
  };
});

/** Records an opt-out; immediately suppresses all of the person's contact points and exits sequences. */
router.post("/compliance/opt-out", async (ctx) => {
  const user = await canRecordOptOut(ctx);
  const body = await ctx.body(optOutIn);
  const result = await service.optOut(ctx.db, body, user);
  return {
    record: recordOut(result.record),
    propagated: result.propagated,
    enrollments_exited: result.enrollments_exited,
  };
});

/** Records consent granted/revoked. Reversing a suppression needs compliance:approve and evidence. */
router.post("/compliance/consent", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(consentIn);
  return recordOut(await service.setConsent(ctx.db, body, user));
});

router.post("/compliance/suppress", async (ctx) => {
  const user = await canRecordOptOut(ctx);
  const body = await ctx.body(suppressIn);
  return recordOut((await service.manualSuppress(ctx.db, body, user))!);
});

router.get("/compliance/events", async (ctx) => {
  await ctx.require("compliance", "view");
  const p = ctx.listParams();
  const personId = ctx.query.uuid("person_id");
  const where = and(
    applySearch(p.q, [consentEvents.normalized_value, consentEvents.source, consentEvents.evidence, consentEvents.actor_name]),
    inFilter(consentEvents.event_type, ctx.query.strs("event_type")),
    inFilter(consentEvents.channel, ctx.query.strs("channel")),
    personId ? eq(consentEvents.person_id, personId) : undefined,
  );
  const [items, total] = await paginate(ctx.db, consentEvents, where, [desc(consentEvents.occurred_at)], p);
  return page(items, total, p);
});

/** Immutable outbound content log (read-only). */
router.get("/compliance/outbound", async (ctx) => {
  await ctx.require("compliance", "view");
  const p = ctx.listParams();
  const q = ctx.query;
  const M = outboundMessages;
  const allowed = q.strs("allowed"); // 'true' and/or 'false'
  const personId = q.uuid("person_id");
  const interactionId = q.uuid("interaction_id");
  const dateFrom = q.date("date_from");
  const dateTo = q.date("date_to");
  const where = and(
    applySearch(p.q, [M.to_value, M.normalized_value, M.content, M.actor_name]),
    inFilter(M.channel, q.strs("channel")),
    allowed && new Set(allowed).size === 1 ? eq(M.allowed, allowed[0] === "true") : undefined,
    personId ? eq(M.person_id, personId) : undefined,
    interactionId ? eq(M.interaction_id, interactionId) : undefined,
    dateFrom ? gte(M.sent_at, new Date(`${dateFrom}T00:00:00Z`)) : undefined,
    dateTo ? lt(M.sent_at, new Date(new Date(`${dateTo}T00:00:00Z`).getTime() + 86_400_000)) : undefined,
  );
  const order = applySort(p.sort, { sent_at: M.sent_at, channel: M.channel }, desc(M.sent_at));
  const [items, total] = await paginate(ctx.db, M, where, order, p);
  return page(items, total, p);
});

router.get("/compliance/settings", async (ctx) => {
  await ctx.require("compliance", "view");
  const s = await service.getSettings(ctx.db);
  await ctx.db.commit();
  return settingsOut(s);
});

router.patch("/compliance/settings", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(settingsUpdate);
  if (!user.is_admin) throw new HttpError(403, "Only administrators can change compliance settings");
  return settingsOut(await service.updateSettings(ctx.db, body, user));
});

router.get("/compliance/provider-restrictions", async (ctx) => {
  await ctx.require("compliance", "view");
  const rows = await ctx.db
    .select()
    .from(providerRestrictions)
    .where(isNull(providerRestrictions.deleted_at))
    .orderBy(providerRestrictions.provider);
  return rows.map(restrictionOut);
});

router.post("/compliance/provider-restrictions", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(restrictionIn);
  const [existing] = await ctx.db.select().from(providerRestrictions).where(eq(providerRestrictions.provider, body.provider));
  if (existing && !existing.deleted_at) throw new HttpError(409, "This provider already has a restriction");
  const values = { ...body, notes: body.notes ?? null, deleted_at: null, updated_by_id: user.id };
  const r = existing
    ? await patch(ctx.db, providerRestrictions, existing, values)
    : await insert(ctx.db, providerRestrictions, { ...values, created_by_id: user.id } as never);
  await audit.record(ctx.db, {
    actor: user, action: "provider_restriction.created", entity_type: "provider_restriction", entity_id: r.id,
    summary: `${r.provider}: ${r.restriction}`, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return created(restrictionOut(r));
});

router.patch("/compliance/provider-restrictions/{restriction_id}", async (ctx) => {
  const user = await ctx.require("compliance", "edit");
  const body = await ctx.body(restrictionIn);
  const r = await ormGet(ctx.db, providerRestrictions, ctx.uuid("restriction_id"));
  if (!r || r.deleted_at) throw new HttpError(404, "Restriction not found");
  const data = { ...body, notes: body.notes ?? null };
  const changes = audit.diff(r, data);
  await patch(ctx.db, providerRestrictions, r, { ...data, updated_by_id: user.id });
  if (Object.keys(changes).length) {
    await audit.record(ctx.db, {
      actor: user, action: "provider_restriction.updated", entity_type: "provider_restriction", entity_id: r.id,
      changes, ip_address: user.ip_address,
    });
  }
  await ctx.db.commit();
  return restrictionOut(r);
});

/** Warnings/blocks before exporting contact data (restricted providers, opted-out values). */
router.post("/compliance/export-check", async (ctx) => {
  await ctx.authed();
  const body = await ctx.body(exportCheckIn);
  const [blocked, warnings] = await service.exportWarnings(ctx.db, {
    providers: body.providers,
    values: body.values.map((v) => [v.channel, v.value] as [string, string]),
  });
  return { blocked, warnings };
});
