/**
 * Brokerage CRM & listing management (spec module 25).
 *
 * Workflow rules:
 * - Prospect stages prospect -> pitched -> engaged | lost. Pitched needs a pitch on record, engaged needs an active
 *   engagement agreement, lost needs a reason. BOV pitches must reference a comps valuation (verified comparables).
 * - Listing asking price and status are changed only through dedicated endpoints; every change appends a history row.
 * - Engagement / representation agreement expirations become critical dates (contracts engine).
 * - Brokerage deals carry the transaction workflow; agreement requirements can be overridden only with
 *   `brokerage:approve` and a reason. Commission release is gated by dealroom's transaction-file completeness check.
 */
import {
  and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql, type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { applySearch, inFilter, rangeFilter, type Page } from "../../common/query";
import type { ListParams } from "../../core/router";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, insert, insertMany, patch } from "../../db/orm";
import type { ProvenanceIn } from "../../common/provenance";
import * as provenance from "../../common/provenance";
import { users } from "../auth/schema";
import { MATERIAL_FIELDS, properties } from "../properties/schema";
import { completeness, getProperty, type PropertyFilters, buildWhere as buildPropertyWhere } from "../properties/service";
import {
  ACTIVE_DEAL_STAGES, CADENCE_DAYS, DEAL_STAGES, LIVE_LISTING_STATUSES, ONBOARDING_TEMPLATE, PROSPECT_STAGES,
  RECRUIT_STAGES, STAGE_PROBABILITY, brokerageDeals, brokerageStatusHistory, engagementAgreements, inquiries,
  listingPriceHistory, listingProspects, listings, marketingItems, proposals, prospectPitches, recruits,
  repAgreements, requirementMatches, requirementProfiles, sellerReports, showings,
  type BrokerageDeal, type EngagementAgreement, type Inquiry, type Listing, type ListingProspect, type MarketingItem,
  type Proposal, type ProspectPitch, type Recruit, type RepAgreement, type RequirementProfile, type SellerReport,
  type Showing,
} from "./schema";
import { listingCreate, type ConvertIn, type ListingCreate, type PitchIn, type PriceChangeIn, type StageMoveIn, type StatusChangeIn } from "./schemas";

type Row = Record<string, any>;
type IdTable = PgTable & { id: any };

const EMPTY_VALUES = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && v !== null && Object.keys(v).length === 0);

// ============================================================================ small helpers

export const today = (): string => utcnow().toISOString().slice(0, 10);
const dayMs = 86_400_000;
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const diffDays = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / dayMs);
const addDaysTo = (d: Date, n: number): Date => new Date(d.getTime() + n * dayMs);
const dateStr = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : ((v as string | null | undefined) ?? null));
const daysUntil = (d: string | null | undefined): number | null => (d ? diffDays(d, today()) : null);
const round2 = (x: number) => Math.round(x * 100) / 100;
const pick = (row: Row, keys: readonly string[]): Row => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const labels = (): Row => ({ property_label: null, agent_name: null, person_label: null, organization_label: null });
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Python's `try: import ... except ImportError`: resolves to null when a sibling module is not available. */
async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** A Map that also exposes its entries as plain properties, so both `m.get(id)` and `m[id]` work for callers. */
function hybridMap<V>(entries: Iterable<[string, V]>): Map<string, V> & Record<string, V> {
  const m = new Map<string, V>(entries);
  for (const [k, v] of m) (m as any)[k] = v;
  return m as Map<string, V> & Record<string, V>;
}

// ============================================================================ generic helpers

export async function getOr404<T extends IdTable>(db: Db, table: T, id: string, label: string): Promise<T["$inferSelect"]> {
  const obj = await get(db, table, id);
  if (!obj || (obj as Row).deleted_at) throw new HttpError(404, `${label} not found`);
  return obj;
}

export async function createRow<T extends IdTable>(
  db: Db, table: T, entity: string, values: Row, actor: CurrentUser, summary?: string | null,
): Promise<T["$inferSelect"]> {
  const obj = await insert(db, table, { ...values, created_by_id: actor.id, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${entity}.created`, entity_type: entity, entity_id: (obj as Row).id, summary, ip_address: actor.ip_address,
  });
  return obj;
}

export async function patchRow<T extends IdTable>(
  db: Db, table: T, obj: T["$inferSelect"], entity: string, values: Row, actor: CurrentUser,
): Promise<Record<string, { from: any; to: any }>> {
  const changes = audit.diff(obj as Row, values);
  const keys = Object.keys(changes);
  if (keys.length) {
    const set = Object.fromEntries(keys.map((k) => [k, values[k]]));
    await patch(db, table, obj, { ...set, updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: `${entity}.updated`, entity_type: entity, entity_id: (obj as Row).id, changes, ip_address: actor.ip_address,
    });
  }
  return changes;
}

export async function archiveRow<T extends IdTable>(db: Db, table: T, obj: T["$inferSelect"], entity: string, actor: CurrentUser): Promise<void> {
  await patch(db, table, obj, { deleted_at: utcnow(), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: `${entity}.archived`, entity_type: entity, entity_id: (obj as Row).id, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function statusEvent(
  db: Db, entity_type: string, entity_id: string, from_status: string | null, to_status: string,
  actor: CurrentUser | null | undefined, reason?: string | null,
): Promise<void> {
  await insert(db, brokerageStatusHistory, {
    entity_type, entity_id, from_status, to_status, reason: reason ?? null,
    actor_id: actor?.id ?? null, actor_name: actor?.full_name ?? null,
  });
}

export async function statusHistory(db: Db, entity_type: string, entity_id: string) {
  const t = brokerageStatusHistory;
  return db.select().from(t).where(and(eq(t.entity_type, entity_type), eq(t.entity_id, entity_id))).orderBy(desc(t.at));
}

/** Shared critical-date engine (contracts module). Returns the critical date id, or null when unavailable. */
export async function upsertCriticalDate(db: Db, kwargs: Row): Promise<string | null> {
  const m: any = await optional(() => import("../contracts/service"));
  if (!m) return null;
  const cd = await m.upsertCriticalDate(db, kwargs);
  return cd?.id ?? null;
}

export async function linkDocument(
  db: Db, document_id: string | null | undefined, entity_type: string, entity_id: string, actor: CurrentUser,
): Promise<void> {
  if (!document_id) return;
  const m: any = await optional(() => import("../documents/service"));
  if (!m) return;
  await m.link(db, document_id, entity_type, entity_id, actor);
}

/** True when an authorised override is used; throws when blocked. */
export function requireOverride(problems: string[], reason: string | null | undefined, actor: CurrentUser, what: string): boolean {
  if (!problems.length) return false;
  if (!(reason && reason.trim())) {
    throw new HttpError(422, {
      message: `Requirements for ${what} are not met: ${problems.join("; ")}`, unmet: problems,
    });
  }
  if (!actor.can("brokerage", "approve")) {
    throw new HttpError(403, { message: "Overriding brokerage requirements needs brokerage approval permission", unmet: problems });
  }
  return true;
}

// ---------------------------------------------------------------------------- labels

export type LabelSpec = Record<string, [string, string]>;

export async function _names(db: Db, kind: string, ids: Iterable<string>): Promise<Map<string, string> & Record<string, string>> {
  const idList = [...new Set([...ids].filter(Boolean))];
  if (!idList.length) return hybridMap<string>([]);
  if (kind === "user") {
    const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, idList));
    return hybridMap(rows.map((r) => [r.id, r.full_name] as [string, string]));
  }
  if (kind === "property") {
    const p = properties;
    const rows = await db.select({ id: p.id, name: p.name, address_line: p.address_line, city: p.city }).from(p).where(inArray(p.id, idList));
    return hybridMap(
      rows.map((r) => [r.id, [r.name || r.address_line, r.city].filter(Boolean).join(", ")] as [string, string]),
    );
  }
  const m: any = await optional(() => import("../contacts/schema"));
  if (!m) return hybridMap<string>([]);
  if (kind === "person") {
    const rows = await db.select({ id: m.people.id, name: m.people.full_name }).from(m.people).where(inArray(m.people.id, idList));
    return hybridMap(rows.map((r: Row) => [r.id, r.name] as [string, string]));
  }
  if (kind === "organization") {
    const rows = await db
      .select({ id: m.organizations.id, name: m.organizations.name })
      .from(m.organizations)
      .where(inArray(m.organizations.id, idList));
    return hybridMap(rows.map((r: Row) => [r.id, r.name] as [string, string]));
  }
  return hybridMap<string>([]);
}
export const names = _names;

/** Resolve display labels for linked ids: spec = {id_attr: [kind, label_attr]}; first non-empty label wins. */
export async function enrich<T extends Row>(db: Db, items: T[], spec: LabelSpec): Promise<T[]> {
  const wanted = new Map<string, Set<string>>();
  for (const it of items) {
    for (const [attr, [kind]] of Object.entries(spec)) {
      const v = it[attr];
      if (v) wanted.set(kind, (wanted.get(kind) ?? new Set()).add(v));
    }
  }
  const resolved = new Map<string, Map<string, string>>();
  for (const [kind, ids] of wanted) resolved.set(kind, await _names(db, kind, ids));
  for (const it of items) {
    for (const [attr, [kind, label]] of Object.entries(spec)) {
      const v = it[attr];
      if (v && !(it as Row)[label]) (it as Row)[label] = resolved.get(kind)?.get(v) ?? null;
    }
  }
  return items;
}

export const PARTY_SPEC: LabelSpec = {
  property_id: ["property", "property_label"],
  agent_id: ["user", "agent_name"],
};

export const CLIENT_SPEC: LabelSpec = {
  ...PARTY_SPEC,
  client_person_id: ["person", "person_label"],
  client_organization_id: ["organization", "organization_label"],
};

// ============================================================================ prospects

export interface ProspectFilters {
  q?: string;
  stage?: string[];
  market_status?: string[];
  agent_id?: string[];
  property_id?: string;
  person_id?: string;
  organization_id?: string;
  expiring_within_days?: number;
  mine?: boolean;
}

export function prospectQuery(f: ProspectFilters, actor: CurrentUser, skip: Set<string> = new Set()): SQL | undefined {
  const t = listingProspects;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.competitor_broker, t.source, t.notes]),
    skip.has("stage") ? undefined : inFilter(t.stage, f.stage),
    skip.has("market_status") ? undefined : inFilter(t.market_status, f.market_status),
    skip.has("agent_id") ? undefined : inFilter(t.agent_id, f.agent_id),
    f.mine ? eq(t.agent_id, actor.id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.person_id ? eq(t.owner_person_id, f.person_id) : undefined,
    f.organization_id ? eq(t.owner_organization_id, f.organization_id) : undefined,
    f.expiring_within_days !== undefined
      ? and(isNotNull(t.competitor_expires_on), lte(t.competitor_expires_on, addDays(today(), f.expiring_within_days)))
      : undefined,
  );
}

const PROSPECT_KEYS = [
  "title", "property_id", "owner_person_id", "owner_organization_id", "opportunity_id", "agent_id", "source",
  "market_status", "competitor_broker", "competitor_list_price", "competitor_listed_on", "competitor_expires_on",
  "estimated_value", "next_action", "next_action_at", "notes", "tags", "id", "stage", "stage_entered_at",
  "lost_reason", "listing_id", "created_at", "updated_at",
] as const;

export async function prospectOuts(db: Db, rows: ListingProspect[]): Promise<Row[]> {
  if (!rows.length) return [];
  const pp = prospectPitches;
  const stat = await db
    .select({ id: pp.prospect_id, n: sql<number>`count(*)::int`, last: sql<string | null>`max(${pp.pitched_on})` })
    .from(pp)
    .where(and(inArray(pp.prospect_id, rows.map((r) => r.id)), isNull(pp.deleted_at)))
    .groupBy(pp.prospect_id);
  const stats = new Map(stat.map((s) => [s.id, [Number(s.n), dateStr(s.last)] as const]));
  const outs = rows.map((r) => {
    const [n, last] = stats.get(r.id) ?? [0, null];
    return {
      ...pick(r, PROSPECT_KEYS), ...labels(), pitch_count: n, last_pitched_on: last,
      days_to_competitor_expiry: daysUntil(r.competitor_expires_on),
    };
  });
  return enrich(db, outs, {
    ...PARTY_SPEC,
    owner_person_id: ["person", "person_label"],
    owner_organization_id: ["organization", "organization_label"],
  });
}

async function defaultTitle(db: Db, property_id?: string | null, person_id?: string | null, org_id?: string | null): Promise<string> {
  for (const [kind, v] of [["property", property_id], ["organization", org_id], ["person", person_id]] as const) {
    if (v) {
      const label = (await _names(db, kind, [v])).get(v);
      if (label) return label;
    }
  }
  return "Listing prospect";
}

export async function createProspect(db: Db, data: Row, actor: CurrentUser): Promise<ListingProspect> {
  const values: Row = { ...data };
  if (!(values.property_id || values.owner_person_id || values.owner_organization_id)) {
    throw new HttpError(422, "Link the prospect to a property or an owner (person or organization)");
  }
  if (!values.title) {
    values.title = await defaultTitle(db, values.property_id, values.owner_person_id, values.owner_organization_id);
  }
  values.agent_id = values.agent_id || actor.id;
  const p = await createRow(db, listingProspects, "listing_prospect", values, actor, values.title);
  await statusEvent(db, "listing_prospect", p.id, null, p.stage, actor);
  await db.commit();
  return p;
}

export async function updateProspect(db: Db, p: ListingProspect, data: Row, actor: CurrentUser): Promise<ListingProspect> {
  const values: Row = { ...data };
  if ("title" in values && !values.title) delete values.title;
  if ("tags" in values && values.tags === null) values.tags = [];
  if ("market_status" in values && values.market_status === null) delete values.market_status;
  await patchRow(db, listingProspects, p, "listing_prospect", values, actor);
  await db.commit();
  return p;
}

export async function prospectProblems(db: Db, p: ListingProspect, to_stage: string, lost_reason?: string | null): Promise<string[]> {
  const problems: string[] = [];
  if (to_stage === "pitched") {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(prospectPitches)
      .where(and(eq(prospectPitches.prospect_id, p.id), isNull(prospectPitches.deleted_at)));
    if (!r?.n) problems.push("Record a pitch or BOV first");
  }
  if (to_stage === "engaged") {
    const e = engagementAgreements;
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(e)
      .where(and(eq(e.prospect_id, p.id), isNull(e.deleted_at), eq(e.status, "active")));
    if (!r?.n) problems.push("An active engagement agreement is required");
  }
  if (to_stage === "lost" && !(lost_reason || p.lost_reason)) problems.push("A lost reason is required");
  return problems;
}

export async function moveProspect(db: Db, p: ListingProspect, body: StageMoveIn, actor: CurrentUser): Promise<ListingProspect> {
  if (!(PROSPECT_STAGES as readonly string[]).includes(body.to_stage)) {
    throw new HttpError(422, `Unknown stage '${body.to_stage}'`);
  }
  if (body.to_stage === p.stage) return p;
  const problems = await prospectProblems(db, p, body.to_stage, body.lost_reason);
  const hard = problems.filter((x) => x.includes("lost reason"));
  if (hard.length) throw new HttpError(422, { message: hard[0], unmet: hard });
  const override = requireOverride(problems, body.reason, actor, body.to_stage);
  const old = p.stage;
  const set: Row = { stage: body.to_stage, stage_entered_at: utcnow(), updated_by_id: actor.id };
  if (body.to_stage === "lost") set.lost_reason = body.lost_reason || p.lost_reason;
  await patch(db, listingProspects, p, set as never);
  await statusEvent(db, "listing_prospect", p.id, old, p.stage, actor, ((override ? "Override: " : "") + (body.reason ?? "")) || null);
  await audit.record(db, {
    actor, action: "listing_prospect.stage_changed", entity_type: "listing_prospect", entity_id: p.id,
    changes: { stage: { from: old, to: p.stage } }, summary: override ? `Override: ${body.reason}` : null,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return p;
}

/** Values for a BOV from the comps module: an explicit valuation, else the property's latest one. */
async function compsValuation(db: Db, property_id: string | null | undefined, bov_id: string | null | undefined): Promise<Row | null> {
  const schemaMod: any = await optional(() => import("../comps/schema"));
  const Valuation = schemaMod?.valuations ?? null;
  if (bov_id) {
    if (Valuation === null) throw new HttpError(422, "Comps module is unavailable; a BOV cannot be linked yet");
    const v: Row | undefined = await get(db, Valuation, bov_id);
    if (!v) throw new HttpError(404, "Valuation not found");
    return {
      bov_id: v.id, comp_set_id: v.comp_set_id, value_low: v.value_low, value_point: v.value_point,
      value_high: v.value_high, valuation_method: v.method, valuation_as_of: v.as_of,
    };
  }
  if (!property_id) return null;
  const svc: any = await optional(() => import("../comps/service"));
  if (!svc) return null;
  const lv = await svc.latestValue(db, property_id);
  if (!lv) return null;
  const out: Row = {
    value_low: lv.value_low ?? null, value_point: lv.value_point ?? null, value_high: lv.value_high ?? null,
    valuation_method: lv.method ?? null, valuation_as_of: lv.as_of ?? null,
  };
  if (Valuation !== null) {
    const [row] = await db
      .select({ id: Valuation.id, comp_set_id: Valuation.comp_set_id })
      .from(Valuation)
      .where(eq(Valuation.property_id, property_id))
      .orderBy(desc(Valuation.as_of))
      .limit(1);
    if (row) {
      out.bov_id = row.id;
      out.comp_set_id = row.comp_set_id;
    }
  }
  return out;
}

export async function addPitch(db: Db, p: ListingProspect, data: PitchIn, actor: CurrentUser): Promise<ProspectPitch> {
  const values: Row = { ...data };
  values.pitched_on = values.pitched_on || today();
  if (data.kind === "bov") {
    const comps = await compsValuation(db, p.property_id, data.bov_id);
    if (!comps || !comps.bov_id) {
      throw new HttpError(
        422,
        "A BOV must be built from a comps valuation of verified comparables. Create the comp set and valuation in Comps first.",
      );
    }
    comps.valuation_as_of = dateStr(comps.valuation_as_of);
    Object.assign(values, comps);
  }
  const pitch = await createRow(db, prospectPitches, "prospect_pitch", { ...values, prospect_id: p.id }, actor, `${data.kind.toUpperCase()} for ${p.title}`);
  await linkDocument(db, data.document_id, "listing_prospect", p.id, actor);
  const set: Row = {};
  if (p.stage === "prospect") {
    await statusEvent(db, "listing_prospect", p.id, p.stage, "pitched", actor, "Pitch recorded");
    Object.assign(set, { stage: "pitched", stage_entered_at: utcnow(), updated_by_id: actor.id });
  }
  if (values.value_point && !p.estimated_value) set.estimated_value = values.value_point;
  if (Object.keys(set).length) await patch(db, listingProspects, p, set as never);
  await db.commit();
  return pitch;
}

export async function updatePitch(db: Db, pitch: ProspectPitch, data: Row, actor: CurrentUser): Promise<ProspectPitch> {
  let values: Row = { ...data };
  // Comps-derived values on a BOV are a snapshot of the valuation and are not hand-edited.
  if (pitch.kind === "bov") {
    for (const k of ["bov_id", "comp_set_id", "value_low", "value_point", "value_high", "kind"]) delete values[k];
  }
  values = Object.fromEntries(
    Object.entries(values).filter(([k, v]) => !(["kind", "outcome", "pitched_on"].includes(k) && v === null)),
  );
  await patchRow(db, prospectPitches, pitch, "prospect_pitch", values, actor);
  await db.commit();
  return pitch;
}

export async function convertProspect(db: Db, p: ListingProspect, body: ConvertIn, actor: CurrentUser): Promise<Listing> {
  if (!p.property_id) throw new HttpError(422, "Link the prospect to a property before converting it to a listing");
  if (p.listing_id) throw new HttpError(409, "This prospect already has a listing");
  let ea: EngagementAgreement | undefined;
  if (body.engagement_agreement_id) {
    ea = await getOr404(db, engagementAgreements, body.engagement_agreement_id, "Engagement agreement");
  } else {
    const e = engagementAgreements;
    [ea] = await db
      .select()
      .from(e)
      .where(and(eq(e.prospect_id, p.id), isNull(e.deleted_at), eq(e.status, "active")))
      .orderBy(desc(e.created_at))
      .limit(1);
  }
  if (!ea || ea.status !== "active") throw new HttpError(422, "An active engagement agreement is required to create the listing");
  const data = listingCreate.parse({
    property_id: p.property_id, prospect_id: p.id, engagement_agreement_id: ea.id,
    agent_id: p.agent_id || actor.id, seller_person_id: p.owner_person_id,
    seller_organization_id: p.owner_organization_id, listing_type: body.listing_type,
    asking_price: body.asking_price, asking_rent_psf: body.asking_rent_psf,
    listed_on: body.listed_on, expires_on: body.expires_on || ea.expires_on,
  });
  const listing = await createListingRow(db, data, actor);
  await patch(db, engagementAgreements, ea, { listing_id: listing.id } as never);
  const set: Row = { listing_id: listing.id, updated_by_id: actor.id };
  if (p.stage !== "engaged") {
    await statusEvent(db, "listing_prospect", p.id, p.stage, "engaged", actor, "Converted to listing");
    Object.assign(set, { stage: "engaged", stage_entered_at: utcnow() });
  }
  await patch(db, listingProspects, p, set as never);
  await audit.record(db, {
    actor, action: "listing_prospect.converted", entity_type: "listing_prospect", entity_id: p.id,
    changes: { listing_id: { from: null, to: String(listing.id) } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return listing;
}

// ============================================================================ agreements

function agreementProblems(values: Row): string[] {
  const problems: string[] = [];
  if (values.status === "active") {
    if (!values.signed_on) problems.push("Signed date is required for an active agreement");
    if (!values.expires_on) problems.push("Expiration date is required for an active agreement");
    const structure = values.commission_structure || "percent";
    if (structure === "percent" && values.commission_rate == null) problems.push("Commission rate is required");
    if (structure === "flat" && values.commission_flat == null) problems.push("Flat commission amount is required");
    if (structure === "tiered" && !(values.commission_tiers && values.commission_tiers.length)) {
      problems.push("Commission tiers are required");
    }
  }
  if (values.starts_on && values.expires_on && values.expires_on < values.starts_on) {
    problems.push("Expiration must be after the start date");
  }
  return problems;
}

const snapshot = (obj: Row, fields: readonly string[]): Row => Object.fromEntries(fields.map((f) => [f, obj[f] ?? null]));

const AGREEMENT_FIELDS = [
  "status", "signed_on", "starts_on", "expires_on", "commission_structure", "commission_rate", "commission_flat",
  "commission_tiers",
] as const;

async function agreementCriticalDate(
  db: Db, table: IdTable, a: Row, related_type: string, label: string, actor: CurrentUser,
): Promise<void> {
  if (!a.expires_on || a.status === "terminated") return;
  const cdId = await upsertCriticalDate(db, {
    related_type, related_id: a.id, date_type: "agreement_expiration", label, due_on: a.expires_on,
    property_id: a.property_id ?? null, owner_id: a.agent_id, lead_days: 30, is_blocking: false, source: "rule",
    status: "confirmed", key: "agreement_expiration", actor,
  });
  if (cdId) await patch(db, table, a as never, { critical_date_id: cdId } as never);
}

export async function saveEngagement(db: Db, data: Row, actor: CurrentUser, ea?: EngagementAgreement | null): Promise<EngagementAgreement> {
  let values: Row = Object.fromEntries(
    Object.entries(data).filter(
      ([k, v]) => !(ea && v === null && ["status", "exclusivity", "commission_structure", "commission_tiers"].includes(k)),
    ),
  );
  const merged = { ...(ea ? snapshot(ea, AGREEMENT_FIELDS) : {}), ...values };
  const problems = agreementProblems(merged);
  if (problems.length) throw new HttpError(422, { message: problems.join("; "), unmet: problems });
  if (!ea) {
    if (values.prospect_id) {
      const pr = await getOr404(db, listingProspects, values.prospect_id, "Prospect");
      values.property_id = values.property_id || pr.property_id;
      values.client_person_id = values.client_person_id || pr.owner_person_id;
      values.client_organization_id = values.client_organization_id || pr.owner_organization_id;
    }
    values.agent_id = values.agent_id || actor.id;
    ea = await createRow(db, engagementAgreements, "engagement_agreement", values, actor);
  } else {
    await patchRow(db, engagementAgreements, ea, "engagement_agreement", values, actor);
  }
  await agreementCriticalDate(db, engagementAgreements, ea, "engagement_agreement", "Listing engagement expires", actor);
  await linkDocument(db, ea.document_id, "engagement_agreement", ea.id, actor);
  await db.commit();
  return ea;
}

export async function saveRepAgreement(db: Db, data: Row, actor: CurrentUser, ra?: RepAgreement | null): Promise<RepAgreement> {
  const values: Row = Object.fromEntries(
    Object.entries(data).filter(
      ([k, v]) => !(ra && v === null && ["kind", "status", "exclusivity", "commission_structure"].includes(k)),
    ),
  );
  const merged = { ...(ra ? snapshot(ra, AGREEMENT_FIELDS) : {}), ...values };
  const problems = agreementProblems(merged);
  if (problems.length) throw new HttpError(422, { message: problems.join("; "), unmet: problems });
  if (
    !(merged.client_person_id || merged.client_organization_id || (ra && (ra.client_person_id || ra.client_organization_id)))
  ) {
    throw new HttpError(422, "A representation agreement needs a client (person or organization)");
  }
  if (!ra) {
    values.agent_id = values.agent_id || actor.id;
    ra = await createRow(db, repAgreements, "rep_agreement", values, actor);
  } else {
    await patchRow(db, repAgreements, ra, "rep_agreement", values, actor);
  }
  await agreementCriticalDate(db, repAgreements, ra, "rep_agreement", `${titleCase(ra.kind)} representation agreement expires`, actor);
  await linkDocument(db, ra.document_id, "rep_agreement", ra.id, actor);
  await db.commit();
  return ra;
}

const ENGAGEMENT_KEYS = [
  "prospect_id", "listing_id", "property_id", "client_person_id", "client_organization_id", "agent_id", "status",
  "exclusivity", "starts_on", "expires_on", "term_months", "commission_structure", "commission_rate",
  "commission_flat", "commission_tiers", "cobroker_rate", "tail_days", "signed_on", "document_id", "notes", "id",
  "critical_date_id", "created_at", "updated_at",
] as const;

const REP_KEYS = [
  "kind", "client_person_id", "client_organization_id", "agent_id", "status", "exclusivity", "starts_on",
  "expires_on", "territory", "commission_structure", "commission_rate", "commission_flat", "signed_on",
  "document_id", "notes", "id", "critical_date_id", "created_at", "updated_at",
] as const;

export async function engagementOuts(db: Db, rows: EngagementAgreement[]): Promise<Row[]> {
  const outs = rows.map((r) => ({ ...pick(r, ENGAGEMENT_KEYS), ...labels(), days_to_expiry: daysUntil(r.expires_on) }));
  return enrich(db, outs, CLIENT_SPEC);
}

export async function repOuts(db: Db, rows: RepAgreement[]): Promise<Row[]> {
  const outs = rows.map((r) => ({ ...pick(r, REP_KEYS), ...labels(), days_to_expiry: daysUntil(r.expires_on) }));
  return enrich(db, outs, CLIENT_SPEC);
}

// ============================================================================ listings

export interface ListingFilters {
  q?: string;
  status?: string[];
  listing_type?: string[];
  agent_id?: string[];
  property_id?: string;
  mine?: boolean;
  min_price?: number;
  max_price?: number;
  min_dom?: number;
  max_dom?: number;
}

export const domExpr = (): SQL<number> => sql<number>`coalesce(${listings.closed_on}, current_date) - ${listings.listed_on}`;

export function listingWhere(f: ListingFilters, actor: CurrentUser, skip: Set<string> = new Set()): SQL | undefined {
  const t = listings;
  const p = properties;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.headline, p.name, p.address_line, p.city, p.county]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("listing_type") ? undefined : inFilter(t.listing_type, f.listing_type),
    skip.has("agent_id") ? undefined : inFilter(t.agent_id, f.agent_id),
    f.mine ? eq(t.agent_id, actor.id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    rangeFilter(t.asking_price, f.min_price, f.max_price),
    rangeFilter(domExpr(), f.min_dom, f.max_dom),
  );
}

/** One page of listings (joined to properties for search/sort) plus the unpaginated total. */
export async function listingRows(db: Db, where: SQL | undefined, order: SQL[], p: ListParams): Promise<[Listing[], number]> {
  const join = eq(properties.id, listings.property_id);
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(listings).innerJoin(properties, join).where(where);
  const rows = await db
    .select(getTableColumns(listings))
    .from(listings)
    .innerJoin(properties, join)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [rows as Listing[], c?.n ?? 0];
}

export async function listingFacetCounts(db: Db, where: SQL | undefined, column: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(listings)
    .innerJoin(properties, eq(properties.id, listings.property_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export function daysOnMarket(listing: Row): number | null {
  if (!listing.listed_on) return null;
  return diffDays(listing.closed_on || today(), listing.listed_on);
}

const LISTING_KEYS = [
  "property_id", "prospect_id", "engagement_agreement_id", "agent_id", "seller_person_id", "seller_organization_id",
  "listing_type", "cap_rate", "listed_on", "expires_on", "headline", "description", "highlights",
  "reporting_cadence", "next_report_on", "notes", "tags", "id", "status", "status_changed_at", "asking_price",
  "asking_rent_psf", "closed_on", "closed_price", "deal_room_id", "created_at", "updated_at",
] as const;

export async function listingOuts(db: Db, rows: Listing[]): Promise<Row[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const pr = properties;
  const propRows = await db
    .select({ id: pr.id, city: pr.city, state: pr.state, property_type: pr.property_type })
    .from(pr)
    .where(inArray(pr.id, [...new Set(rows.map((r) => r.property_id as string))]));
  const props = new Map(propRows.map((r) => [r.id, r]));

  const counts = async (table: any, col: any, soft: boolean) => {
    const res = await db
      .select({ k: col, n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(inArray(col, ids), soft ? isNull(table.deleted_at) : undefined))
      .groupBy(col);
    return new Map<string, number>(res.map((r: Row) => [r.k, Number(r.n)]));
  };
  const prices = await counts(listingPriceHistory, listingPriceHistory.listing_id, false);
  const inq = await counts(inquiries, inquiries.listing_id, true);
  const shows = await counts(showings, showings.listing_id, true);
  const outs = rows.map((r) => {
    const p = props.get(r.property_id as string);
    return {
      ...pick(r, LISTING_KEYS), ...labels(),
      property_city: p?.city ?? null, property_state: p?.state ?? null, property_type: p?.property_type ?? null,
      days_on_market: daysOnMarket(r),
      price_change_count: Math.max(0, (prices.get(r.id) ?? 0) - 1),
      inquiry_count: inq.get(r.id) ?? 0, showing_count: shows.get(r.id) ?? 0,
    };
  });
  return enrich(db, outs, {
    ...PARTY_SPEC,
    seller_person_id: ["person", "person_label"],
    seller_organization_id: ["organization", "organization_label"],
  });
}

/** Listing activity is a material fact on the shared property record (status, asking price). */
async function syncProperty(db: Db, listing: Row, actor: CurrentUser): Promise<void> {
  const [p] = await db.select().from(properties).where(eq(properties.id, listing.property_id)).limit(1);
  if (!p || p.deleted_at) return;
  const data: Row = {};
  const live = (LIVE_LISTING_STATUSES as readonly string[]).includes(listing.status);
  if (live && listing.listing_type === "sale" && listing.asking_price != null) data.asking_price = listing.asking_price;
  if (live && p.status !== "listed") {
    data.status = "listed";
  } else if (listing.status === "sold" && listing.listing_type === "sale") {
    data.status = "sold";
    if (listing.closed_price != null) data.last_sale_price = listing.closed_price;
    if (listing.closed_on) data.last_sale_date = listing.closed_on;
  } else if (["withdrawn", "expired"].includes(listing.status) && p.status === "listed") {
    data.status = "tracked";
  }
  if (!Object.keys(data).length) return;
  const prov: ProvenanceIn = {
    source: "Brokerage listing", observed_on: today(), confidence: 0.95, verified: true, ai_derived: false,
  };
  const changes = await provenance.applyMaterial(db, p, {
    entity_type: "property", data, material_fields: MATERIAL_FIELDS, prov, actor_id: actor.id,
  });
  if (Object.keys(changes).length) {
    const set: Row = Object.fromEntries(Object.keys(changes).map((k) => [k, (p as Row)[k]]));
    p.completeness_score = completeness(p);
    set.completeness_score = p.completeness_score;
    set.updated_by_id = actor.id;
    await patch(db, properties, p, set as never);
    await audit.record(db, {
      actor, action: "property.updated", entity_type: "property", entity_id: p.id, changes,
      summary: "Synced from brokerage listing", ip_address: actor.ip_address,
    });
    await events.emit(db, "property.updated", { property_id: p.id, changed: new Set(Object.keys(changes)), actor });
  }
}

async function createListingRow(db: Db, data: ListingCreate, actor: CurrentUser): Promise<Listing> {
  await getProperty(db, data.property_id);
  const dup = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.property_id, data.property_id), isNull(listings.deleted_at), eq(listings.listing_type, data.listing_type),
        inArray(listings.status, ["draft", ...LIVE_LISTING_STATUSES]),
      ),
    )
    .limit(1);
  if (dup.length) {
    throw new HttpError(409, { message: "This property already has an open listing of this type", existing: [String(dup[0].id)] });
  }
  const values: Row = { ...data };
  values.agent_id = values.agent_id || actor.id;
  if ((LIVE_LISTING_STATUSES as readonly string[]).includes(values.status) && !values.listed_on) values.listed_on = today();
  if (values.reporting_cadence in CADENCE_DAYS && !values.next_report_on) {
    values.next_report_on = addDays(values.listed_on || today(), CADENCE_DAYS[values.reporting_cadence]);
  }
  const listing = await createRow(db, listings, "listing", values, actor);
  await statusEvent(db, "listing", listing.id, null, listing.status, actor);
  if (listing.asking_price != null || listing.asking_rent_psf != null) {
    await insert(db, listingPriceHistory, {
      listing_id: listing.id, price: listing.asking_price, rent_psf: listing.asking_rent_psf,
      effective_on: listing.listed_on || today(), reason: "Initial asking price", source: "Listing created",
      actor_id: actor.id, actor_name: actor.full_name,
    });
  }
  if (listing.engagement_agreement_id) {
    const ea = await get(db, engagementAgreements, listing.engagement_agreement_id);
    if (ea && !ea.listing_id) await patch(db, engagementAgreements, ea, { listing_id: listing.id } as never);
  }
  await syncProperty(db, listing, actor);
  return listing;
}

export async function createListing(db: Db, data: ListingCreate, actor: CurrentUser): Promise<Listing> {
  const listing = await createListingRow(db, data, actor);
  await db.commit();
  return listing;
}

export async function updateListing(db: Db, listing: Listing, data: Row, actor: CurrentUser): Promise<Listing> {
  const values: Row = { ...data };
  for (const k of ["listing_type", "reporting_cadence"]) if (k in values && values[k] === null) delete values[k];
  for (const k of ["highlights", "tags"]) if (k in values && values[k] === null) values[k] = [];
  await patchRow(db, listings, listing, "listing", values, actor);
  await db.commit();
  return listing;
}

export async function changePrice(db: Db, listing: Listing, body: PriceChangeIn, actor: CurrentUser): Promise<Listing> {
  const ask = body.asking_price ?? null;
  const rent = body.asking_rent_psf ?? null;
  if (ask === null && rent === null) throw new HttpError(422, "Provide a new asking price or rent");
  if (ask === (listing.asking_price ?? null) && (rent === null || rent === listing.asking_rent_psf)) {
    throw new HttpError(422, "The asking price is unchanged");
  }
  const prev = listing.asking_price;
  await insert(db, listingPriceHistory, {
    listing_id: listing.id, price: ask !== null ? ask : prev, previous_price: prev,
    rent_psf: rent !== null ? rent : listing.asking_rent_psf, effective_on: body.effective_on || today(),
    reason: body.reason ?? null, source: body.source, actor_id: actor.id, actor_name: actor.full_name,
  });
  const changes: Row = {};
  const set: Row = { updated_by_id: actor.id };
  if (ask !== null && ask !== prev) {
    changes.asking_price = { from: prev, to: ask };
    set.asking_price = ask;
  }
  if (rent !== null && rent !== listing.asking_rent_psf) {
    changes.asking_rent_psf = { from: listing.asking_rent_psf, to: rent };
    set.asking_rent_psf = rent;
  }
  await patch(db, listings, listing, set as never);
  await audit.record(db, {
    actor, action: "listing.price_changed", entity_type: "listing", entity_id: listing.id, changes,
    summary: body.reason, ip_address: actor.ip_address,
  });
  await syncProperty(db, listing, actor);
  await events.emit(db, "listing.price_changed", {
    listing_id: listing.id, property_id: listing.property_id, price: listing.asking_price, previous_price: prev, actor,
  });
  await db.commit();
  return listing;
}

export async function changeStatus(db: Db, listing: Listing, body: StatusChangeIn, actor: CurrentUser): Promise<Listing> {
  if (body.status === listing.status) return listing;
  const set: Row = {};
  if (body.status === "sold" || body.status === "leased") {
    const closedOn = body.closed_on || listing.closed_on;
    if (!closedOn) throw new HttpError(422, "Closed date is required");
    set.closed_on = closedOn;
    if (body.status === "sold") {
      if (body.closed_price == null && listing.closed_price == null) throw new HttpError(422, "Sale price is required");
    }
    if (body.closed_price != null) set.closed_price = body.closed_price;
  }
  if ((body.status === "withdrawn" || body.status === "expired") && !(body.reason && body.reason.trim())) {
    throw new HttpError(422, "A reason is required when withdrawing or expiring a listing");
  }
  if ((LIVE_LISTING_STATUSES as readonly string[]).includes(body.status) && !listing.listed_on) {
    set.listed_on = today();
    if (listing.reporting_cadence in CADENCE_DAYS && !listing.next_report_on) {
      set.next_report_on = addDays(today(), CADENCE_DAYS[listing.reporting_cadence]);
    }
  }
  const old = listing.status;
  Object.assign(set, { status: body.status, status_changed_at: utcnow(), updated_by_id: actor.id });
  await patch(db, listings, listing, set as never);
  await statusEvent(db, "listing", listing.id, old, body.status, actor, body.reason);
  await audit.record(db, {
    actor, action: "listing.status_changed", entity_type: "listing", entity_id: listing.id,
    changes: { status: { from: old, to: body.status } }, summary: body.reason, ip_address: actor.ip_address,
  });
  await syncProperty(db, listing, actor);
  await events.emit(db, "listing.status_changed", {
    listing_id: listing.id, property_id: listing.property_id, from_status: old, to_status: body.status, actor,
  });
  await db.commit();
  return listing;
}

export async function saveMarketing(
  db: Db, listing: Listing, data: Row, actor: CurrentUser, item?: MarketingItem | null,
): Promise<MarketingItem> {
  const values: Row = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => !(v === null && ["kind", "title", "status", "syndication_status"].includes(k))),
  );
  for (const k of ["channels", "document_ids"]) if (k in values && values[k] === null) values[k] = [];
  const publishing = values.status === "published" || values.syndication_status === "live";
  if (publishing && item) {
    const approved = await adReviewApproved(db, item.id);
    if (approved === false) throw new HttpError(422, "Advertising review approval is required before publishing or syndicating");
  } else if (publishing && !item) {
    throw new HttpError(422, "Create the item and get advertising approval before publishing");
  }
  if (values.syndication_status === "live" && (!item || item.syndication_status !== "live")) {
    values.syndicated_at = utcnow();
  }
  if (!item) {
    item = await createRow(db, marketingItems, "marketing_item", { ...values, listing_id: listing.id }, actor, values.title);
  } else {
    await patchRow(db, marketingItems, item, "marketing_item", values, actor);
  }
  for (const docId of item.document_ids ?? []) await linkDocument(db, docId, "listing", listing.id, actor);
  await db.commit();
  return item;
}

/** null when the compliance module is unavailable (no gate), else whether an approved review exists. */
async function adReviewApproved(db: Db, marketing_item_id: string): Promise<boolean | null> {
  const m: any = await optional(() => import("../dealroom/schema"));
  if (!m) return null;
  const a = m.adReviews;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(a)
    .where(and(eq(a.marketing_item_id, marketing_item_id), eq(a.status, "approved"), isNull(a.deleted_at)));
  return Boolean(r?.n);
}

export async function adReviewStatuses(db: Db, item_ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!item_ids.length) return out;
  const m: any = await optional(() => import("../dealroom/schema"));
  if (!m) return out;
  const a = m.adReviews;
  const rows = await db
    .select({ mid: a.marketing_item_id, st: a.status })
    .from(a)
    .where(and(inArray(a.marketing_item_id, item_ids), isNull(a.deleted_at)))
    .orderBy(asc(a.created_at));
  for (const r of rows) out.set(r.mid, r.st); // latest wins
  return out;
}

// ---------------------------------------------------------------------------- inquiries & showings

export async function createInquiry(db: Db, data: Row, actor: CurrentUser): Promise<Inquiry> {
  const tasks: any = await import("../tasks/service");
  const values: Row = { ...data };
  values.received_at = values.received_at || utcnow();
  let listing: Listing | null = null;
  if (values.listing_id) {
    listing = await getOr404(db, listings, values.listing_id, "Listing");
    values.property_id = values.property_id || listing.property_id;
  }
  if (!(values.listing_id || values.property_id)) throw new HttpError(422, "Link the inquiry to a listing or property");
  if (!(values.person_id || values.organization_id || values.contact_name)) {
    throw new HttpError(422, "Identify the prospect (person, organization or name)");
  }
  values.assigned_to_id = values.assigned_to_id || listing?.agent_id || actor.id;
  const inq = await createRow(db, inquiries, "inquiry", values, actor, values.contact_name);
  let who: string | null | undefined = values.contact_name;
  for (const [kind, key] of [["person", "person_id"], ["organization", "organization_id"]] as const) {
    if (!who && values[key]) who = (await _names(db, kind, [values[key]])).get(values[key]);
  }
  const due: Date = values.follow_up_at || addDaysTo(utcnow(), 1);
  const [related_type, related_id] = listing ? ["listing", listing.id] : ["property", values.property_id];
  const label = (await _names(db, "property", [values.property_id])).get(values.property_id);
  const task = await tasks.createTask(db, {
    title: `Follow up inquiry from ${who || "prospect"}`, assignee_id: inq.assigned_to_id, due_at: due,
    task_type: "follow_up", description: values.message, related_type, related_id, related_label: label,
    source: "brokerage.inquiry", idempotency_key: `brokerage:inquiry:${inq.id}`, actor_id: actor.id,
  });
  await patch(db, inquiries, inq, { follow_up_task_id: task.id, follow_up_at: due } as never);
  await db.commit();
  return inq;
}

export async function saveShowing(db: Db, data: Row, actor: CurrentUser, s?: Showing | null): Promise<Showing> {
  const values: Row = Object.fromEntries(
    Object.entries(data).filter(([k, v]) => !(s && v === null && ["status", "scheduled_at"].includes(k))),
  );
  if (!s) {
    if (values.listing_id) {
      const listing = await getOr404(db, listings, values.listing_id, "Listing");
      values.property_id = values.property_id || listing.property_id;
      values.shown_by_id = values.shown_by_id || listing.agent_id;
    }
    if (!(values.listing_id || values.property_id)) throw new HttpError(422, "Link the showing to a listing or property");
    values.shown_by_id = values.shown_by_id || actor.id;
    s = await createRow(db, showings, "showing", values, actor, values.contact_name);
    if (s.inquiry_id) {
      const inq = await get(db, inquiries, s.inquiry_id);
      if (inq && ["new", "contacted", "qualified", "nda_sent"].includes(inq.status)) {
        await patch(db, inquiries, inq, { status: "toured" } as never);
      }
    }
  } else {
    await patchRow(db, showings, s, "showing", values, actor);
  }
  await db.commit();
  return s;
}

/** Used by dealroom when tour feedback is captured. Does not commit. */
export async function recordShowingFromTour(
  db: Db,
  o: {
    listing_id?: string | null; property_id: string; tour_id: string; scheduled_at: Date; person_id?: string | null;
    organization_id?: string | null; interest_level?: string | null; feedback?: string | null; actor: CurrentUser;
  },
): Promise<Showing> {
  const t = showings;
  let [s] = await db
    .select()
    .from(t)
    .where(and(eq(t.tour_id, o.tour_id), eq(t.property_id, o.property_id), isNull(t.deleted_at)))
    .limit(1);
  if (!s) {
    s = await insert(db, t, {
      listing_id: o.listing_id ?? null, property_id: o.property_id, tour_id: o.tour_id, scheduled_at: o.scheduled_at,
      person_id: o.person_id ?? null, organization_id: o.organization_id ?? null, shown_by_id: o.actor.id,
      status: "completed", created_by_id: o.actor.id, updated_by_id: o.actor.id,
    });
  }
  await patch(db, t, s, { status: "completed", interest_level: o.interest_level ?? null, feedback: o.feedback ?? null });
  await audit.record(db, {
    actor: o.actor, action: "showing.recorded", entity_type: "showing", entity_id: s.id,
    summary: "From tour feedback", ip_address: o.actor.ip_address,
  });
  return s;
}

// ---------------------------------------------------------------------------- seller reports

async function offerSummary(db: Db, listing_id: string, start: Date, end: Date): Promise<Row> {
  const m: any = await optional(() => import("../dealroom/schema"));
  if (!m) return { count: 0, available: false };
  const o = m.offerSubmissions;
  const rows: Row[] = await db
    .select({ price: o.price, status: o.status })
    .from(o)
    .where(and(eq(o.listing_id, listing_id), isNull(o.deleted_at), gte(o.submitted_at, start), lt(o.submitted_at, end)));
  const prices = rows.filter((r) => r.price != null).map((r) => Number(r.price));
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    count: rows.length, high: prices.length ? Math.max(...prices) : null, low: prices.length ? Math.min(...prices) : null,
    by_status: byStatus, available: true,
  };
}

const tally = (values: Array<string | null | undefined>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) if (v) out[v] = (out[v] ?? 0) + 1;
  return out;
};

export async function generateSellerReport(
  db: Db, listing: Listing, actor: CurrentUser,
  opts: { period_start?: string | null; period_end?: string | null; commentary?: string | null; commit?: boolean } = {},
): Promise<SellerReport> {
  const { commentary = null, commit = true } = opts;
  const end = opts.period_end || today();
  let period_start = opts.period_start;
  if (!period_start) {
    const [r] = await db
      .select({ last: sql<string | null>`max(${sellerReports.period_end})` })
      .from(sellerReports)
      .where(and(eq(sellerReports.listing_id, listing.id), isNull(sellerReports.deleted_at)));
    const last = dateStr(r?.last);
    period_start = last ? addDays(last, 1) : listing.listed_on || addDays(end, -14);
  }
  if (period_start > end) throw new HttpError(422, "Report period start must be on or before its end");
  const startDt = new Date(`${period_start}T00:00:00Z`);
  const endDt = new Date(`${addDays(end, 1)}T00:00:00Z`);

  const inq = await db
    .select({ source: inquiries.source, status: inquiries.status })
    .from(inquiries)
    .where(
      and(eq(inquiries.listing_id, listing.id), isNull(inquiries.deleted_at), gte(inquiries.received_at, startDt), lt(inquiries.received_at, endDt)),
    );
  const shows = await db
    .select({ status: showings.status, interest_level: showings.interest_level, feedback: showings.feedback })
    .from(showings)
    .where(
      and(eq(showings.listing_id, listing.id), isNull(showings.deleted_at), gte(showings.scheduled_at, startDt), lt(showings.scheduled_at, endDt)),
    );
  const ph = listingPriceHistory;
  const prices = await db
    .select()
    .from(ph)
    .where(and(eq(ph.listing_id, listing.id), gte(ph.at, startDt), lt(ph.at, endDt)))
    .orderBy(asc(ph.at));
  const chanRows = await db
    .select({ channels: marketingItems.channels })
    .from(marketingItems)
    .where(
      and(eq(marketingItems.listing_id, listing.id), isNull(marketingItems.deleted_at), eq(marketingItems.syndication_status, "live")),
    );
  const liveChannels = [...new Set(chanRows.flatMap((r) => r.channels ?? []))].sort();

  const summary = {
    inquiries: { count: inq.length, by_source: tally(inq.map((r) => r.source)), by_status: tally(inq.map((r) => r.status)) },
    showings: {
      count: shows.length, completed: shows.filter((r) => r.status === "completed").length,
      by_interest: tally(shows.map((r) => r.interest_level)),
      feedback: shows.filter((r) => r.feedback).map((r) => r.feedback).slice(0, 20),
    },
    offers: await offerSummary(db, listing.id, startDt, endDt),
    price_changes: prices.map((p) => ({
      effective_on: p.effective_on, price: p.price, previous_price: p.previous_price, reason: p.reason,
    })),
    syndication_channels: liveChannels,
    asking_price: listing.asking_price,
    status: listing.status,
    days_on_market: daysOnMarket(listing),
  };
  const report = await createRow(
    db, sellerReports, "seller_report",
    { listing_id: listing.id, period_start, period_end: end, summary, commentary, generated_at: utcnow() },
    actor, `${period_start} – ${end}`,
  );
  if (listing.reporting_cadence in CADENCE_DAYS) {
    await patch(db, listings, listing, { next_report_on: addDays(end, CADENCE_DAYS[listing.reporting_cadence]) } as never);
  }
  if (commit) await db.commit();
  return report;
}

/** Generate reports for live listings whose cadence is due and task the agent to review and send them. */
export async function runDueReports(db: Db, actor: CurrentUser): Promise<number> {
  const tasks: any = await import("../tasks/service");
  const t = listings;
  const due = await db
    .select()
    .from(t)
    .where(
      and(
        isNull(t.deleted_at), inArray(t.status, [...LIVE_LISTING_STATUSES]), inArray(t.reporting_cadence, Object.keys(CADENCE_DAYS)),
        lte(t.next_report_on, today()),
      ),
    );
  for (const listing of due) {
    const report = await generateSellerReport(db, listing, actor, { commit: false });
    const label = (await _names(db, "property", [listing.property_id as string])).get(listing.property_id as string);
    await tasks.createTask(db, {
      title: `Review and send seller report: ${label || "listing"}`, assignee_id: listing.agent_id,
      due_at: addDaysTo(utcnow(), 1), task_type: "review", related_type: "listing", related_id: listing.id,
      related_label: label, source: "brokerage.seller_report", idempotency_key: `brokerage:seller_report:${report.id}`,
      actor_id: actor.id,
    });
  }
  await db.commit();
  return due.length;
}

export async function updateSellerReport(db: Db, r: SellerReport, data: Row, actor: CurrentUser): Promise<SellerReport> {
  const values: Row = Object.fromEntries(Object.entries(data).filter(([k, v]) => !(k === "status" && v === null)));
  if (values.status === "sent" && r.status !== "sent") values.sent_at = utcnow();
  await patchRow(db, sellerReports, r, "seller_report", values, actor);
  await db.commit();
  return r;
}

// ============================================================================ requirements & matching

export async function runMatch(db: Db, req: RequirementProfile, actor: CurrentUser): Promise<[number, number, Row]> {
  const nz = <T>(v: T | null | undefined) => v ?? undefined;
  const f: PropertyFilters = {
    property_type: req.property_types?.length ? req.property_types : undefined,
    state: req.states?.length ? req.states : undefined,
    min_area: nz(req.min_size_sf), max_area: nz(req.max_size_sf), min_acres: nz(req.min_acres),
    max_acres: nz(req.max_acres), min_price: nz(req.min_price), max_price: nz(req.max_price),
    near_lat: nz(req.near_lat), near_lng: nz(req.near_lng), radius_miles: nz(req.radius_miles),
  };
  const p = properties;
  const conds: Array<SQL | undefined> = [buildPropertyWhere(f)];
  if (req.cities?.length) conds.push(inArray(sql`lower(${p.city})`, req.cities.map((c) => c.toLowerCase())));
  if (req.counties?.length) conds.push(inArray(sql`lower(${p.county})`, req.counties.map((c) => c.toLowerCase())));
  if (req.territory_id) {
    const tm: any = await optional(() => import("../territories/schema"));
    if (tm?.territoryMembers) {
      conds.push(
        inArray(
          p.id,
          db.select({ id: tm.territoryMembers.property_id }).from(tm.territoryMembers).where(eq(tm.territoryMembers.territory_id, req.territory_id)),
        ),
      );
    }
  }
  conds.push(notInArray(p.status, ["rejected"]));
  const props = await db.select().from(p).where(and(...conds)).orderBy(desc(p.updated_at)).limit(500);
  const existing = new Set(
    (await db.select({ id: requirementMatches.property_id }).from(requirementMatches).where(eq(requirementMatches.requirement_id, req.id))).map(
      (r) => r.id,
    ),
  );
  const live = new Map<string, string>();
  if (props.length) {
    const rows = await db
      .select({ pid: listings.property_id, id: listings.id })
      .from(listings)
      .where(
        and(inArray(listings.property_id, props.map((x) => x.id)), isNull(listings.deleted_at), inArray(listings.status, [...LIVE_LISTING_STATUSES])),
      );
    for (const r of rows) live.set(r.pid as string, r.id);
  }
  const rawCriteria: Row = {
    property_types: req.property_types, states: req.states, cities: req.cities, counties: req.counties,
    size_sf: [req.min_size_sf, req.max_size_sf], acres: [req.min_acres, req.max_acres],
    price: [req.min_price, req.max_price], territory_id: req.territory_id ? String(req.territory_id) : null,
    radius_miles: req.radius_miles, features: req.features,
  };
  const criteria: Row = Object.fromEntries(
    Object.entries(rawCriteria).filter(
      ([, v]) => !EMPTY_VALUES(v) && !(Array.isArray(v) && v.length === 2 && v[0] == null && v[1] == null),
    ),
  );
  const wanted = new Set((req.features ?? []).map((x) => x.toLowerCase()));
  const toAdd: Row[] = [];
  for (const prop of props) {
    if (existing.has(prop.id)) continue;
    const met = Object.keys(criteria).filter((k) => k !== "features");
    for (const t of prop.tags ?? []) if (wanted.has(t.toLowerCase())) met.push(`feature:${t}`);
    toAdd.push({
      requirement_id: req.id, property_id: prop.id, listing_id: live.get(prop.id) ?? null, status: "suggested",
      criteria_met: met, created_by_id: actor.id, updated_by_id: actor.id,
    });
  }
  if (toAdd.length) await insertMany(db, requirementMatches, toAdd as never);
  const added = toAdd.length;
  await patch(db, requirementProfiles, req, { last_matched_at: utcnow() } as never);
  await audit.record(db, {
    actor, action: "requirement.matched", entity_type: "requirement", entity_id: req.id,
    summary: `${added} new matches of ${props.length}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return [added, props.length, criteria];
}

// ============================================================================ proposals

export async function reviseProposal(db: Db, parent: Proposal, data: Row, actor: CurrentUser): Promise<Proposal> {
  if (parent.status === "superseded" || parent.status === "withdrawn") {
    throw new HttpError(409, "This proposal version can no longer be revised");
  }
  const baseKeys = [
    "kind", "title", "brokerage_deal_id", "prospect_id", "listing_id", "requirement_id", "property_id",
    "recipient_person_id", "recipient_organization_id", "agent_id", "price", "rent_psf", "term_months",
    "commission_rate", "terms", "response_due_on", "document_id", "notes",
  ];
  const base: Row = Object.fromEntries(baseKeys.map((k) => [k, (parent as Row)[k]]));
  const overrides = Object.fromEntries(Object.entries(data).filter(([k]) => k in base));
  const child = await createRow(
    db, proposals, "proposal",
    { ...base, ...overrides, version: parent.version + 1, parent_proposal_id: parent.id, status: "draft" },
    actor, `Revision v${parent.version + 1}`,
  );
  const old = parent.status;
  await patch(db, proposals, parent, { status: "superseded", updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "proposal.superseded", entity_type: "proposal", entity_id: parent.id,
    changes: { status: { from: old, to: "superseded" } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return child;
}

// ============================================================================ deals

export interface DealFilters {
  q?: string;
  stage?: string[];
  side?: string[];
  agent_id?: string[];
  property_id?: string;
  listing_id?: string;
  mine?: boolean;
  closing_before?: string;
}

export function dealQuery(f: DealFilters, actor: CurrentUser, skip: Set<string> = new Set()): SQL | undefined {
  const t = brokerageDeals;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.title, t.next_action, t.notes]),
    skip.has("stage") ? undefined : inFilter(t.stage, f.stage),
    skip.has("side") ? undefined : inFilter(t.side, f.side),
    skip.has("agent_id") ? undefined : inFilter(t.agent_id, f.agent_id),
    f.mine ? eq(t.agent_id, actor.id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.listing_id ? eq(t.listing_id, f.listing_id) : undefined,
    f.closing_before ? lte(t.expected_close_on, f.closing_before) : undefined,
  );
}

export const effectiveProbability = (d: Row): number =>
  d.probability != null ? Number(d.probability) : Number(STAGE_PROBABILITY[d.stage] ?? 0);

export function grossCommission(d: Row): number | null {
  if (d.gross_commission_estimate != null) return Number(d.gross_commission_estimate);
  if (d.deal_value != null && d.commission_rate != null) return round2((Number(d.deal_value) * Number(d.commission_rate)) / 100);
  return null;
}

const DEAL_KEYS = [
  "title", "agent_id", "side", "property_id", "listing_id", "rep_agreement_id", "requirement_id", "client_person_id",
  "client_organization_id", "counterparty_person_id", "counterparty_organization_id", "is_dual_rep",
  "expected_close_on", "probability", "deal_value", "commission_rate", "gross_commission_estimate", "next_action",
  "next_action_at", "notes", "tags", "id", "stage", "stage_entered_at", "closed_on", "closed_price", "lost_reason",
  "created_at", "updated_at",
] as const;

export async function dealOuts(db: Db, rows: BrokerageDeal[], opts: { with_file?: boolean } = {}): Promise<Row[]> {
  const outs: Row[] = [];
  const dr: any = opts.with_file ? await optional(() => import("../dealroom/service")) : null;
  for (const d of rows) {
    const o: Row = { ...pick(d, DEAL_KEYS), ...labels(), effective_probability: effectiveProbability(d) };
    const g = grossCommission(d);
    o.gross_commission_estimate = g;
    o.weighted_commission = g !== null ? round2((g * o.effective_probability) / 100) : null;
    o.file_complete = null;
    if (dr) o.file_complete = (await dr.transactionFileComplete(db, d.id))[0];
    outs.push(o);
  }
  return enrich(db, outs, CLIENT_SPEC);
}

export async function createDeal(db: Db, data: Row, actor: CurrentUser): Promise<BrokerageDeal> {
  const values: Row = { ...data };
  if (values.listing_id && !values.property_id) {
    const listing = await getOr404(db, listings, values.listing_id, "Listing");
    values.property_id = listing.property_id;
  }
  if (!values.title) {
    values.title = await defaultTitle(db, values.property_id, values.client_person_id, values.client_organization_id);
  }
  if (values.side === "dual") values.is_dual_rep = true;
  values.agent_id = values.agent_id || actor.id;
  if (values.gross_commission_estimate == null && values.deal_value != null && values.commission_rate != null) {
    values.gross_commission_estimate = round2((values.deal_value * values.commission_rate) / 100);
  }
  const d = await createRow(db, brokerageDeals, "brokerage_deal", values, actor, values.title);
  await statusEvent(db, "brokerage_deal", d.id, null, d.stage, actor);
  await db.commit();
  return d;
}

export async function updateDeal(db: Db, d: BrokerageDeal, data: Row, actor: CurrentUser): Promise<BrokerageDeal> {
  const values: Row = { ...data };
  for (const k of ["title", "side", "is_dual_rep"]) if (k in values && values[k] === null) delete values[k];
  if ("tags" in values && values.tags === null) values.tags = [];
  if (values.side === "dual") values.is_dual_rep = true;
  if (("deal_value" in values || "commission_rate" in values) && !("gross_commission_estimate" in values)) {
    const dv = "deal_value" in values ? values.deal_value : d.deal_value;
    const cr = "commission_rate" in values ? values.commission_rate : d.commission_rate;
    if (dv != null && cr != null) values.gross_commission_estimate = round2((Number(dv) * Number(cr)) / 100);
  }
  await patchRow(db, brokerageDeals, d, "brokerage_deal", values, actor);
  await db.commit();
  return d;
}

/** (hard, overridable) requirements for entering `to_stage`. */
export async function dealProblems(db: Db, d: BrokerageDeal, to_stage: string): Promise<[string[], string[]]> {
  const hard: string[] = [];
  const soft: string[] = [];
  if (to_stage === "lost") return [hard, soft];
  const order = (DEAL_STAGES as readonly string[]).indexOf(to_stage);
  if (order >= DEAL_STAGES.indexOf("engaged")) {
    const needRep = ["buyer", "tenant", "dual"].includes(d.side);
    const needListing = ["listing", "landlord", "dual"].includes(d.side);
    if (needRep) {
      let ok = false;
      if (d.rep_agreement_id) {
        const ra = await get(db, repAgreements, d.rep_agreement_id);
        ok = Boolean(ra && !ra.deleted_at && ra.status === "active");
      }
      if (!ok) soft.push("Active buyer/tenant representation agreement");
    }
    if (needListing) {
      let ok = false;
      if (d.listing_id) {
        const listing = await get(db, listings, d.listing_id);
        if (listing && listing.engagement_agreement_id) {
          const ea = await get(db, engagementAgreements, listing.engagement_agreement_id);
          ok = Boolean(ea && !ea.deleted_at && ["active", "expired"].includes(ea.status));
        }
      }
      if (!ok) soft.push("Listing with an active engagement agreement");
    }
  }
  if (order >= DEAL_STAGES.indexOf("under_contract") && d.deal_value == null) {
    hard.push("Deal value is required from under contract onward");
  }
  if (to_stage === "closed") {
    if (!d.closed_on) hard.push("Closed date is required");
    if (d.closed_price == null) hard.push("Closed price is required");
  }
  return [hard, soft];
}

export async function moveDeal(db: Db, d: BrokerageDeal, body: StageMoveIn, actor: CurrentUser): Promise<BrokerageDeal> {
  if (!(DEAL_STAGES as readonly string[]).includes(body.to_stage)) throw new HttpError(422, `Unknown stage '${body.to_stage}'`);
  if (body.to_stage === d.stage) return d;
  if (body.to_stage === "lost" && !(body.lost_reason || d.lost_reason)) throw new HttpError(422, "A lost reason is required");
  const [hard, soft] = await dealProblems(db, d, body.to_stage);
  if (hard.length) throw new HttpError(422, { message: hard.join("; "), unmet: hard });
  const override = requireOverride(soft, body.reason, actor, body.to_stage.replace(/_/g, " "));
  const old = d.stage;
  const set: Row = { stage: body.to_stage, stage_entered_at: utcnow(), updated_by_id: actor.id };
  if (body.to_stage === "lost") set.lost_reason = body.lost_reason || d.lost_reason;
  await patch(db, brokerageDeals, d, set as never);
  await statusEvent(db, "brokerage_deal", d.id, old, d.stage, actor, ((override ? "Override: " : "") + (body.reason ?? "")) || null);
  await audit.record(db, {
    actor, action: "brokerage_deal.stage_changed", entity_type: "brokerage_deal", entity_id: d.id,
    changes: { stage: { from: old, to: d.stage } }, summary: override ? `Override: ${body.reason}` : body.reason,
    ip_address: actor.ip_address,
  });
  if (["under_contract", "closing", "closed"].includes(d.stage)) {
    const dr: any = await optional(() => import("../dealroom/service"));
    if (dr) await dr.ensureTransactionFile(db, d, actor);
  }
  await events.emit(db, "brokerage_deal.stage_changed", { brokerage_deal_id: d.id, from_stage: old, to_stage: d.stage, actor });
  if (d.stage === "closed") await events.emit(db, "brokerage_deal.closed", { brokerage_deal_id: d.id, actor });
  await db.commit();
  return d;
}

export async function dealBoard(db: Db, f: DealFilters, actor: CurrentUser, per_stage: number): Promise<Row[]> {
  const base = dealQuery(f, actor, new Set(["stage"]));
  const t = brokerageDeals;
  const cols: Row[] = [];
  for (const s of ACTIVE_DEAL_STAGES) {
    const rows = await db
      .select()
      .from(t)
      .where(and(base, eq(t.stage, s)))
      .orderBy(sql`${t.expected_close_on} asc nulls last`);
    const outs = await dealOuts(db, rows);
    cols.push({
      stage: s, count: outs.length,
      gross_commission: outs.reduce((a, o) => a + (o.gross_commission_estimate || 0), 0),
      weighted_commission: outs.reduce((a, o) => a + (o.weighted_commission || 0), 0),
      items: outs.slice(0, per_stage),
    });
  }
  return cols;
}

export async function workspace(db: Db, agent_id: string | null): Promise<Row> {
  const grouped = async (table: any, agentCol: any, key: any): Promise<Record<string, number>> => {
    const rows = await db
      .select({ k: key, n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(isNull(table.deleted_at), agent_id ? eq(agentCol, agent_id) : undefined))
      .groupBy(key);
    return Object.fromEntries(rows.map((r: Row) => [String(r.k), Number(r.n)]));
  };
  const prospects = await grouped(listingProspects, listingProspects.agent_id, listingProspects.stage);
  const listingsByStatus = await grouped(listings, listings.agent_id, listings.status);
  const d = brokerageDeals;
  const deals = await db.select().from(d).where(and(isNull(d.deleted_at), agent_id ? eq(d.agent_id, agent_id) : undefined));
  const byStage: Record<string, number> = {};
  let gross = 0;
  let weighted = 0;
  let expected90 = 0;
  const horizon = addDays(today(), 90);
  for (const deal of deals) {
    byStage[deal.stage] = (byStage[deal.stage] ?? 0) + 1;
    if ((ACTIVE_DEAL_STAGES as readonly string[]).includes(deal.stage)) {
      const g = grossCommission(deal) || 0;
      gross += g;
      weighted += (g * effectiveProbability(deal)) / 100;
      if (deal.expected_close_on && deal.expected_close_on <= horizon) expected90 += (g * effectiveProbability(deal)) / 100;
    }
  }
  const soon = addDays(today(), 30);
  let expiring = 0;
  for (const table of [engagementAgreements, repAgreements]) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(
        and(
          isNull(table.deleted_at), agent_id ? eq(table.agent_id, agent_id) : undefined, eq(table.status, "active"),
          isNotNull(table.expires_on), lte(table.expires_on, soon),
        ),
      );
    expiring += Number(r?.n ?? 0);
  }
  const now = utcnow();
  const [oi] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inquiries)
    .where(
      and(isNull(inquiries.deleted_at), inArray(inquiries.status, ["new", "contacted"]), agent_id ? eq(inquiries.assigned_to_id, agent_id) : undefined),
    );
  const [us] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(showings)
    .where(
      and(
        isNull(showings.deleted_at), eq(showings.status, "scheduled"), gte(showings.scheduled_at, now),
        agent_id ? eq(showings.shown_by_id, agent_id) : undefined,
      ),
    );
  const overdue = deals.filter(
    (x) => x.next_action_at && x.next_action_at < now && (ACTIVE_DEAL_STAGES as readonly string[]).includes(x.stage),
  ).length;
  return {
    agent_id, prospects_by_stage: prospects, listings_by_status: listingsByStatus, deals_by_stage: byStage,
    pipeline_gross: round2(gross), pipeline_weighted: round2(weighted), expected_close_90d: round2(expected90),
    expiring_agreements: expiring, open_inquiries: Number(oi?.n ?? 0), upcoming_showings: Number(us?.n ?? 0),
    overdue_actions: overdue,
  };
}

// ============================================================================ recruits

export const onboardingPct = (items: Row[]): number =>
  items.length ? Math.round((1000 * items.filter((i) => i.done).length) / items.length) / 10 : 0;

const RECRUIT_KEYS = [
  "full_name", "email", "phone", "person_id", "current_brokerage", "specialty", "years_experience",
  "annual_production", "license_number", "license_state", "source", "recruiter_id", "next_action_at", "start_on",
  "user_id", "notes", "id", "stage", "stage_entered_at", "onboarding", "created_at", "updated_at",
] as const;

export async function recruitOuts(db: Db, rows: Recruit[]): Promise<Row[]> {
  const nm = await _names(db, "user", rows.map((r) => r.recruiter_id as string).filter(Boolean));
  return rows.map((r) => ({
    ...pick(r, RECRUIT_KEYS), onboarding_pct: onboardingPct(r.onboarding ?? []),
    recruiter_name: r.recruiter_id ? (nm.get(r.recruiter_id) ?? null) : null,
  }));
}

const checklist = (): Row[] =>
  ONBOARDING_TEMPLATE.map(([key, label]) => ({ key, label, done: false, done_at: null, done_by: null, note: null }));

export async function createRecruit(db: Db, data: Row, actor: CurrentUser): Promise<Recruit> {
  const values: Row = { ...data };
  values.recruiter_id = values.recruiter_id || actor.id;
  const r = await createRow(db, recruits, "recruit", values, actor, values.full_name);
  await statusEvent(db, "recruit", r.id, null, r.stage, actor);
  await db.commit();
  return r;
}

export async function moveRecruit(db: Db, r: Recruit, body: StageMoveIn, actor: CurrentUser): Promise<Recruit> {
  if (!(RECRUIT_STAGES as readonly string[]).includes(body.to_stage)) throw new HttpError(422, `Unknown stage '${body.to_stage}'`);
  if (body.to_stage === r.stage) return r;
  const problems: string[] = [];
  if (body.to_stage === "active") {
    const open = (r.onboarding ?? []).filter((i: Row) => !i.done).map((i: Row) => i.label);
    if (!(r.onboarding ?? []).length) problems.push("Onboarding checklist has not been started");
    else if (open.length) problems.push(`Onboarding incomplete: ${open.join(", ")}`);
  }
  const override = requireOverride(problems, body.reason, actor, "activation");
  const old = r.stage;
  const set: Row = { stage: body.to_stage, stage_entered_at: utcnow(), updated_by_id: actor.id };
  if (["hired", "onboarding", "active"].includes(body.to_stage) && !(r.onboarding ?? []).length) set.onboarding = checklist();
  await patch(db, recruits, r, set as never);
  await statusEvent(db, "recruit", r.id, old, r.stage, actor, ((override ? "Override: " : "") + (body.reason ?? "")) || null);
  await audit.record(db, {
    actor, action: "recruit.stage_changed", entity_type: "recruit", entity_id: r.id,
    changes: { stage: { from: old, to: r.stage } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function toggleChecklist(
  db: Db, r: Recruit, key: string, done: boolean, note: string | null | undefined, actor: CurrentUser,
): Promise<Recruit> {
  const items: Row[] = ((r.onboarding ?? []).length ? r.onboarding : checklist()).map((i: Row) => ({ ...i }));
  const match = items.find((i) => i.key === key);
  if (!match) throw new HttpError(404, "Checklist item not found");
  Object.assign(match, {
    done, done_at: done ? utcnow().toISOString() : null, done_by: done ? actor.full_name : null,
    note: note != null ? note : (match.note ?? null),
  });
  await patch(db, recruits, r, { onboarding: items, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "recruit.onboarding_updated", entity_type: "recruit", entity_id: r.id,
    changes: { [key]: { from: !done, to: done } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

// ============================================================================ documents (shared picker)

export async function documentOptions(db: Db, q: string | null | undefined, limit = 15): Promise<Row[]> {
  const m: any = await optional(() => import("../documents/schema"));
  if (!m) return [];
  const d = m.documents;
  const rows: Row[] = await db
    .select()
    .from(d)
    .where(and(isNull(d.deleted_at), applySearch(q, [d.title, d.filename])))
    .orderBy(desc(d.created_at))
    .limit(limit);
  return rows.map((x) => ({ id: x.id, title: x.title || x.filename, filename: x.filename, doc_class: x.doc_class }));
}

export async function documentOption(db: Db, document_id: string): Promise<Row> {
  const m: any = await optional(() => import("../documents/schema"));
  if (!m) throw new HttpError(404, "Documents module unavailable");
  const d: Row | undefined = await get(db, m.documents, document_id);
  if (!d) throw new HttpError(404, "Document not found");
  return { id: d.id, title: d.title || d.filename, filename: d.filename, doc_class: d.doc_class };
}

export async function documentTitles(db: Db, ids: Iterable<string>): Promise<Map<string, Row> & Record<string, Row>> {
  const idList = [...new Set([...ids].filter(Boolean))];
  if (!idList.length) return hybridMap<Row>([]);
  const m: any = await optional(() => import("../documents/schema"));
  if (!m) return hybridMap<Row>([]);
  const rows: Row[] = await db.select().from(m.documents).where(inArray(m.documents.id, idList));
  return hybridMap(
    rows.map((d) => [
      d.id,
      { id: d.id, title: d.title || d.filename, filename: d.filename, doc_class: d.doc_class, mime_type: d.mime_type ?? null },
    ] as [string, Row]),
  );
}

// ============================================================================ reassignment

export async function reassignUser(db: Db, user_id: string, to_id: string): Promise<void> {
  const targets: Array<[any, string]> = [
    [listingProspects, "agent_id"], [listings, "agent_id"], [engagementAgreements, "agent_id"],
    [repAgreements, "agent_id"], [requirementProfiles, "agent_id"], [proposals, "agent_id"],
    [brokerageDeals, "agent_id"], [recruits, "recruiter_id"], [inquiries, "assigned_to_id"],
  ];
  for (const [table, col] of targets) {
    await db.update(table).set({ [col]: to_id } as never).where(and(eq(table[col], user_id), isNull(table.deleted_at)));
  }
}

export type { Page };
