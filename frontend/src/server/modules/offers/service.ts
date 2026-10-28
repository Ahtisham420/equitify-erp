/**
 * Offers, LOIs & negotiation (spec module 15).
 *
 * Every offer version is tied to an approved underwriting model. Sent / received versions are frozen: a counter
 * always creates a new version in the same chain (root_offer_id), so the full negotiation history is retained and
 * any two versions can be diffed. Deviations from the approved model route for named, timestamped approval.
 * Offers whose response clock runs out are expired by a scan (and on read) and always raise follow-up work.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { ListParams } from "../../core/router";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import * as contracts from "../contracts/service";
import { opportunities } from "../pipeline/schema";
import * as pipeline from "../pipeline/service";
import { properties } from "../properties/schema";
import { createTask, raiseAlert } from "../tasks/service";
import { getApproved } from "../underwriting/service";
import { TERM_FIELDS, offerApprovals, offerSettings, offers, type Offer, type OfferSettings } from "./schema";
import type {
  ApprovalIn, CounterIn, OfferCreate, OfferSettingsIn, OfferTerms, RespondIn, SendIn, TermDelta, WinningPriceIn,
} from "./schemas";

const ENTITY = "offer";
const NUMERIC_TERMS = new Set([
  "price", "earnest_money", "earnest_money_hard_days", "feasibility_days", "closing_days", "extension_count",
  "extension_days", "extension_cost", "financing_days", "title_survey_days", "exclusivity_days",
]);
const COPY_FIELDS = [...Object.keys(TERM_FIELDS), "notes", "tags"];
const DEFAULT_SETTINGS = {
  price_threshold: 10_000_000.0 as number | null,
  deviation_threshold_pct: 2.0,
  second_approval_deviation_pct: 5.0,
  approval_structures: ["assumption", "seller_financing", "joint_venture", "other"],
  max_feasibility_days: 60 as number | null,
  max_earnest_money_pct: 5.0 as number | null,
  require_approval_always: false,
  default_response_days: 3,
};
// Pipeline progression used to decide whether an accepted offer may advance the opportunity.
const PRE_OFFER_STAGES = ["sourced", "screening", "research", "underwriting", "contact", "negotiation"];

type Row = Record<string, any>;

// --- formatting helpers (Python f-string equivalents) ------------------------------------------

const money0 = (v: any) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const num2 = (v: number) => v.toFixed(2);
const round = (v: number, n: number) => Math.round(v * 10 ** n) / 10 ** n;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const aware = (d: Date | null | undefined): Date | null => d ?? null;
const strip = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// --- settings ----------------------------------------------------------------------------------

export async function getSettings(db: Db): Promise<OfferSettings> {
  const [row] = await db.select().from(offerSettings).where(eq(offerSettings.id, 1)).limit(1);
  return row ?? ({ id: 1, ...DEFAULT_SETTINGS, updated_at: null, updated_by_id: null } as unknown as OfferSettings);
}

export async function saveSettings(db: Db, data: OfferSettingsIn, actor: CurrentUser): Promise<OfferSettings> {
  const [existing] = await db.select().from(offerSettings).where(eq(offerSettings.id, 1)).limit(1);
  const values: Row = { ...data };
  let changes: Record<string, any>;
  if (!existing) {
    changes = Object.fromEntries(
      Object.entries(values)
        .filter(([k, v]) => !audit.isEqual((DEFAULT_SETTINGS as Row)[k] ?? null, v))
        .map(([k, v]) => [k, { from: (DEFAULT_SETTINGS as Row)[k] ?? null, to: v }]),
    );
  } else {
    changes = audit.diff(existing, values);
  }
  const row = existing
    ? await patch(db, offerSettings, existing, { ...values, updated_by_id: actor.id, updated_at: utcnow() } as never)
    : await insert(db, offerSettings, { id: 1, ...values, updated_by_id: actor.id, updated_at: utcnow() } as never);
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "offer.settings_updated", entity_type: "offer_settings", changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return row;
}

// --- lookups -----------------------------------------------------------------------------------

export async function get(db: Db, offerId: string): Promise<Offer> {
  const o = await ormGet(db, offers, offerId);
  if (!o || o.deleted_at) throw new HttpError(404, "Offer not found");
  return o;
}

async function opportunity(db: Db, opportunityId: string): Promise<Row> {
  const opp = (await ormGet(db, opportunities as any, opportunityId)) as Row | undefined;
  if (!opp || opp.deleted_at) throw new HttpError(404, "Opportunity not found");
  return opp;
}

/** Offers cannot exist independently of an approved underwriting model. */
async function approvedModel(db: Db, modelId: string): Promise<Row> {
  return (await getApproved(db, modelId)) as Row;
}

function modelPrice(model: Row): number | null {
  const outputs = model?.outputs || {};
  const v = typeof outputs === "object" ? outputs.purchase_price : null;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Approved underwriting models an offer can be prepared from (read via the shared `uw_models` table). */
export async function approvedModels(
  db: Db,
  o: { opportunity_id?: string | null; property_id?: string | null },
): Promise<Row[]> {
  const [{ t }] = await raw<{ t: string | null }>(db, sql`select to_regclass('uw_models')::text as t`);
  if (!t) return [];
  const [{ n }] = await raw<{ n: number }>(
    db,
    sql`select count(*)::int as n from information_schema.columns where table_name = 'uw_models' and column_name = 'deleted_at'`,
  );
  const conds: SQL[] = [];
  if (o.opportunity_id) conds.push(sql`opportunity_id = ${o.opportunity_id}`);
  if (o.property_id) conds.push(sql`property_id = ${o.property_id}`);
  const rows = await raw<Row>(
    db,
    sql`select * from uw_models where status = 'approved'
        ${n ? sql`and deleted_at is null` : sql``}
        ${conds.length ? sql`and (${sql.join(conds, sql` or `)})` : sql``}
        order by approved_at desc nulls last limit 100`,
  );
  return rows.map((r) => {
    const outputs = r.outputs || {};
    return {
      id: r.id, name: r.name ?? null, version: r.version ?? null, property_id: r.property_id ?? null,
      opportunity_id: r.opportunity_id ?? null, approved_at: r.approved_at ?? null,
      purchase_price: outputs.purchase_price ?? null, going_in_cap: outputs.going_in_cap ?? null,
      irr: outputs.irr ?? null,
    };
  });
}

// --- approval routing --------------------------------------------------------------------------

export function computeDeviation(price: number | null | undefined, modelPrice_: number | null | undefined): number | null {
  if (price === null || price === undefined || !modelPrice_) return null;
  return round(((Number(price) - Number(modelPrice_)) / Number(modelPrice_)) * 100, 3);
}

/** How many approvals this version needs and why (price / structure / deviation from the approved model). */
export function route(o: Row, s: Row): [number, string[]] {
  let levels = 0;
  const reasons: string[] = [];
  const need = (n: number, why: string) => {
    levels = Math.max(levels, n);
    reasons.push(why);
  };

  if (s.require_approval_always) need(1, "All offers require approval");
  if (s.price_threshold !== null && s.price_threshold !== undefined && o.price !== null && o.price !== undefined
    && Number(o.price) > Number(s.price_threshold)) {
    need(1, `Price exceeds approval threshold of $${money0(s.price_threshold)}`);
  }
  if (o.model_price === null || o.model_price === undefined) {
    need(1, "Approved model has no purchase price to compare against");
  } else if (o.deviation_pct !== null && o.deviation_pct !== undefined) {
    if (o.deviation_pct > s.second_approval_deviation_pct) {
      need(2, `Price is ${num2(o.deviation_pct)}% above the approved model ` +
        `(two approvals above ${s.second_approval_deviation_pct}%)`);
    } else if (o.deviation_pct > s.deviation_threshold_pct) {
      need(1, `Price is ${num2(o.deviation_pct)}% above the approved model (threshold ${s.deviation_threshold_pct}%)`);
    }
  }
  if ((s.approval_structures || []).includes(o.structure)) {
    need(1, `Non-standard structure: ${String(o.structure).replace(/_/g, " ")}`);
  }
  if (s.max_feasibility_days !== null && s.max_feasibility_days !== undefined && (o.feasibility_days || 0) > s.max_feasibility_days) {
    need(1, `Feasibility period ${o.feasibility_days} days exceeds standard ${s.max_feasibility_days}`);
  }
  if (s.max_earnest_money_pct !== null && s.max_earnest_money_pct !== undefined && o.earnest_money !== null
    && o.earnest_money !== undefined && o.price && (Number(o.earnest_money) / Number(o.price)) * 100 > s.max_earnest_money_pct) {
    need(1, `Earnest money exceeds ${s.max_earnest_money_pct}% of price`);
  }
  return [levels, reasons];
}

/** Recomputes the routing fields on `o` in memory; the caller persists them. */
async function applyRouting(db: Db, o: Row): Promise<void> {
  o.deviation_pct = computeDeviation(o.price, o.model_price);
  const [levels, reasons] = route(o, await getSettings(db));
  o.approvals_required = levels;
  o.approval_reasons = reasons;
  o.approval_required = levels > 0;
}

const routingFields = (o: Row) => ({
  deviation_pct: o.deviation_pct, approvals_required: o.approvals_required, approval_reasons: o.approval_reasons,
  approval_required: o.approval_required,
});

export async function approvalsReceived(db: Db, o: Offer): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offerApprovals)
    .where(and(
      eq(offerApprovals.offer_id, o.id), eq(offerApprovals.submission_no, o.submission_no),
      eq(offerApprovals.decision, "approved"),
    ));
  return Number(r?.n ?? 0);
}

// --- query -------------------------------------------------------------------------------------

export interface OfferFilters {
  q?: string;
  status?: string[];
  origin?: string[];
  opportunity_id?: string;
  property_id?: string;
  uw_model_id?: string;
  owner_id?: string[];
  root_offer_id?: string;
  latest_only: boolean;
  due?: string; // overdue | 24h | 72h
  min_price?: number;
  max_price?: number;
}

function dueCondition(due: string, now: Date): SQL | undefined {
  const awaiting = and(
    inArray(offers.status, ["sent", "countered"]), eq(offers.is_latest, true), sql`${offers.response_due_at} is not null`,
  );
  if (due === "overdue") return and(awaiting, sql`${offers.response_due_at} < ${now.toISOString()}::timestamptz`);
  const hours = due === "24h" ? 24 : 72;
  const until = new Date(now.getTime() + hours * 3600 * 1000);
  return and(
    awaiting, sql`${offers.response_due_at} >= ${now.toISOString()}::timestamptz`,
    sql`${offers.response_due_at} < ${until.toISOString()}::timestamptz`,
  );
}

/** WHERE for `offers JOIN opportunities LEFT JOIN properties` (see {@link joined}). */
export function buildWhere(f: OfferFilters, o: { skip?: Set<string> } = {}): SQL | undefined {
  const skip = o.skip ?? new Set<string>();
  const t = offers;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [
      opportunities.title, properties.name, properties.address_line, properties.city, t.seller_name, t.buyer_entity,
      t.sent_to,
    ]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("origin") ? undefined : inFilter(t.origin, f.origin),
    inFilter(opportunities.owner_id, f.owner_id),
    f.opportunity_id ? eq(t.opportunity_id, f.opportunity_id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.uw_model_id ? eq(t.uw_model_id, f.uw_model_id) : undefined,
    f.root_offer_id ? eq(t.root_offer_id, f.root_offer_id) : undefined,
    f.latest_only && !f.root_offer_id ? eq(t.is_latest, true) : undefined,
    f.due && !skip.has("due") && ["overdue", "24h", "72h"].includes(f.due) ? dueCondition(f.due, utcnow()) : undefined,
    rangeFilter(t.price, f.min_price, f.max_price),
  );
}

/** One page of offers matching `where`, plus the unpaginated total. */
export async function listOffers(db: Db, where: SQL | undefined, orderBy: SQL[], p: ListParams): Promise<[Offer[], number]> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offers)
    .innerJoin(opportunities, eq(opportunities.id, offers.opportunity_id))
    .leftJoin(properties, eq(properties.id, offers.property_id))
    .where(where);
  const rows = await db
    .select({ o: offers })
    .from(offers)
    .innerJoin(opportunities, eq(opportunities.id, offers.opportunity_id))
    .leftJoin(properties, eq(properties.id, offers.property_id))
    .where(where)
    .orderBy(...orderBy)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [rows.map((r) => r.o), Number(n)];
}

/** Counts per distinct value of `column` within the filtered offers. */
export async function facet(db: Db, where: SQL | undefined, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(offers)
    .innerJoin(opportunities, eq(opportunities.id, offers.opportunity_id))
    .leftJoin(properties, eq(properties.id, offers.property_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function dueCounts(db: Db, f: OfferFilters): Promise<Record<string, number>> {
  const base = buildWhere(f, { skip: new Set(["due"]) });
  const now = utcnow();
  const out: Record<string, number> = {};
  for (const key of ["overdue", "24h", "72h"]) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(offers)
      .innerJoin(opportunities, eq(opportunities.id, offers.opportunity_id))
      .leftJoin(properties, eq(properties.id, offers.property_id))
      .where(and(base, dueCondition(key, now)));
    out[key] = Number(r?.n ?? 0);
  }
  return out;
}

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function clock(o: Offer, now: Date): [number | null, boolean] {
  if (!o.response_due_at || !["sent", "countered"].includes(o.status) || !o.is_latest) return [null, false];
  const hours = round((o.response_due_at.getTime() - now.getTime()) / 3600000, 1);
  return [hours, hours < 0];
}

export async function toItems(db: Db, rows: Offer[]) {
  if (!rows.length) return [];
  const opps = new Map(
    (await db
      .select({ id: opportunities.id, title: opportunities.title, owner_id: opportunities.owner_id })
      .from(opportunities)
      .where(inArray(opportunities.id, [...new Set(rows.map((o) => o.opportunity_id))]))).map((r: Row) => [r.id, r] as [string, Row]),
  );
  const propIds = [...new Set(rows.filter((o) => o.property_id).map((o) => o.property_id!))];
  const props = new Map<string, { id: string; name: string | null; address_line: string }>(
    propIds.length
      ? (await db
        .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
        .from(properties)
        .where(inArray(properties.id, propIds))).map((r) => [r.id, r] as [string, { id: string; name: string | null; address_line: string }])
      : [],
  );
  const names = await userNames(db, [...opps.values()].map((r: Row) => r.owner_id));
  const now = utcnow();
  return rows.map((o) => {
    const opp = opps.get(o.opportunity_id) as Row | undefined;
    const p = o.property_id ? props.get(o.property_id) : undefined;
    const [hours, overdue] = clock(o, now);
    return {
      id: o.id,
      opportunity_id: o.opportunity_id,
      opportunity_title: opp ? opp.title : null,
      owner_id: opp ? opp.owner_id : null,
      owner_name: opp && opp.owner_id ? names.get(opp.owner_id) ?? null : null,
      property_id: o.property_id,
      property_label: p ? p.name || p.address_line : null,
      uw_model_id: o.uw_model_id,
      uw_model_version: o.uw_model_version,
      root_offer_id: o.root_offer_id,
      parent_offer_id: o.parent_offer_id,
      version: o.version,
      is_latest: o.is_latest,
      origin: o.origin,
      status: o.status,
      price: o.price,
      structure: o.structure,
      model_price: o.model_price,
      deviation_pct: o.deviation_pct,
      earnest_money: o.earnest_money,
      feasibility_days: o.feasibility_days,
      closing_days: o.closing_days,
      approval_required: o.approval_required,
      sent_at: o.sent_at,
      response_due_at: o.response_due_at,
      hours_to_due: hours,
      overdue,
      winning_price: o.winning_price,
      tags: o.tags,
      created_at: o.created_at,
      updated_at: o.updated_at,
    };
  });
}

export async function toOut(db: Db, o: Offer, actor: CurrentUser) {
  const item = (await toItems(db, [o]))[0];
  const [already] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offerApprovals)
    .where(and(
      eq(offerApprovals.offer_id, o.id), eq(offerApprovals.submission_no, o.submission_no),
      eq(offerApprovals.approver_id, actor.id),
    ));
  return {
    ...item,
    model_outputs: o.model_outputs,
    earnest_money_hard_days: o.earnest_money_hard_days,
    extension_count: o.extension_count,
    extension_days: o.extension_days,
    extension_cost: o.extension_cost,
    financing_contingency: o.financing_contingency,
    financing_days: o.financing_days,
    title_survey_days: o.title_survey_days,
    title_survey_terms: o.title_survey_terms,
    assignment_allowed: o.assignment_allowed,
    assignment_terms: o.assignment_terms,
    access_terms: o.access_terms,
    exclusivity_days: o.exclusivity_days,
    expiration_at: o.expiration_at,
    buyer_entity: o.buyer_entity,
    seller_name: o.seller_name,
    other_terms: o.other_terms,
    notes: o.notes,
    approvals_required: o.approvals_required,
    approval_reasons: o.approval_reasons,
    submission_no: o.submission_no,
    submitted_at: o.submitted_at,
    submitted_by_id: o.submitted_by_id,
    approved_at: o.approved_at,
    approvals_received: await approvalsReceived(db, o),
    sent_by_id: o.sent_by_id,
    sent_to: o.sent_to,
    sent_via: o.sent_via,
    critical_date_id: o.critical_date_id,
    follow_up_task_id: o.follow_up_task_id,
    escalation_task_id: o.escalation_task_id,
    responded_at: o.responded_at,
    response_note: o.response_note,
    expired_at: o.expired_at,
    winning_buyer: o.winning_buyer,
    winning_price_source: o.winning_price_source,
    winning_price_recorded_at: o.winning_price_recorded_at,
    has_loi: o.loi_payload !== null && o.loi_payload !== undefined,
    can_edit: o.status === "draft" && o.origin === "buyer" && actor.can("offers", "edit"),
    can_approve: o.status === "pending_approval" && actor.can("offers", "approve")
      && actor.canApprove("offer", Number(o.price)) && !Number(already?.n ?? 0),
    created_by_id: o.created_by_id,
  };
}

export const settingsOut = (s: OfferSettings) => ({
  price_threshold: s.price_threshold,
  deviation_threshold_pct: s.deviation_threshold_pct,
  second_approval_deviation_pct: s.second_approval_deviation_pct,
  approval_structures: s.approval_structures || [],
  max_feasibility_days: s.max_feasibility_days,
  max_earnest_money_pct: s.max_earnest_money_pct,
  require_approval_always: s.require_approval_always,
  default_response_days: s.default_response_days,
  updated_at: s.updated_at ?? null,
  updated_by_id: s.updated_by_id ?? null,
});

// --- helpers -----------------------------------------------------------------------------------

const label = (o: Pick<Offer, "version" | "price">, oppTitle?: string | null) =>
  `${oppTitle || "Offer"} · v${o.version} · $${money0(o.price)}`;

const terms = (o: Row) => toJsonable(Object.fromEntries(Object.keys(TERM_FIELDS).map((k) => [k, o[k]])));

function requireStatus(o: Offer, statuses: string[], action: string): void {
  if (!statuses.includes(o.status)) {
    throw new HttpError(409, `Cannot ${action} an offer that is ${o.status.replace(/_/g, " ")}`);
  }
}

async function chainOf(db: Db, o: Offer): Promise<Offer[]> {
  return db
    .select()
    .from(offers)
    .where(and(eq(offers.root_offer_id, o.root_offer_id || o.id), isNull(offers.deleted_at)))
    .orderBy(asc(offers.version));
}

/** Shared critical-date engine (contracts module). Optional: the offer clock works without it. */
async function upsertDate(
  db: Db,
  o: Offer,
  a: { due: Date; owner_id: string | null; actor: CurrentUser | null; status?: string },
): Promise<string | null> {
  const status = a.status ?? "confirmed";
  const c = contracts as Record<string, any>;
  if (typeof c.upsertCriticalDate !== "function") return null;
  const cd = await c.upsertCriticalDate(db, {
    related_type: "offer", related_id: o.id, date_type: "offer_response",
    label: `Offer v${o.version} response due`, due_on: a.due.toISOString().slice(0, 10), property_id: o.property_id,
    owner_id: a.owner_id, lead_days: 1, is_blocking: false, source: "rule", status, key: "offer_response",
    actor: a.actor,
  });
  // upsert never transitions an existing confirmed/missed date to completed: do it explicitly.
  if (status === "completed" && a.actor && ["confirmed", "missed"].includes(cd?.status)) {
    // `complete` is module-private in contracts; fall back to its committing wrapper `completeDate`.
    const complete = c._complete ?? c.complete ?? c.completeDate;
    await complete(db, cd, `Offer v${o.version} response recorded`, a.actor);
  }
  return cd?.id ?? null;
}

/** Offer facts the pipeline gates rely on (offer price / sent / response due). */
async function setOpportunityOfferFields(
  db: Db,
  opp: Row,
  o: Offer,
  actor: CurrentUser | null,
  a: { sent_at?: Date | null; due_at?: Date | null } = {},
): Promise<Record<string, any>> {
  if (opp.stage === "closed") return {};
  const values = strip({
    offer_price: Number(o.price), offer_sent_at: a.sent_at || o.sent_at, response_due_at: a.due_at || o.response_due_at,
  });
  for (const k of Object.keys(values)) if (values[k] === null) delete values[k];
  const changes = audit.diff(opp, values);
  if (Object.keys(changes).length) {
    await patch(db, opportunities as any, opp as never, { ...values, updated_by_id: actor?.id ?? null } as never);
    await audit.record(db, {
      actor, action: "opportunity.updated", entity_type: "opportunity", entity_id: opp.id, summary: `Offer v${o.version} terms`,
      changes: { ...changes, offer_id: String(o.id) }, ip_address: actor?.ip_address ?? null,
    });
  }
  return changes;
}

// --- mutations ---------------------------------------------------------------------------------

export async function create(db: Db, data: OfferCreate, actor: CurrentUser): Promise<Offer> {
  const opp = await opportunity(db, data.opportunity_id);
  if (opp.stage === "closed" || opp.stage === "dead") {
    throw new HttpError(409, `Opportunity is ${opp.stage}; offers cannot be created`);
  }
  const model = await approvedModel(db, data.uw_model_id);
  const modelOpp = model.opportunity_id ?? null;
  const modelProp = model.property_id ?? null;
  const sameOpp = modelOpp !== null && modelOpp === opp.id;
  const sameProp = modelProp !== null && modelProp === opp.property_id;
  if (!(sameOpp || sameProp)) {
    throw new HttpError(422, "The approved underwriting model belongs to a different opportunity / property");
  }

  const { opportunity_id: _o, uw_model_id: _m, ...rest } = data;
  const values: Row = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
  values.structure ??= "all_cash";
  values.financing_contingency ??= false;
  values.assignment_allowed ??= false;
  values.tags ??= [];
  if (values.expiration_at) values.expiration_at = aware(values.expiration_at);
  const now = utcnow();
  const id = randomUUID();
  const draft: Row = {
    ...values, id, opportunity_id: opp.id, property_id: opp.property_id || modelProp, uw_model_id: model.id,
    uw_model_version: model.version ?? null, model_price: modelPrice(model),
    model_outputs: toJsonable(model.outputs || {}), version: 1, origin: "buyer", status: "draft", is_latest: true,
    created_by_id: actor.id, updated_by_id: actor.id, root_offer_id: id, created_at: now,
  };
  await applyRouting(db, draft);
  const o = await insert(db, offers, draft as never);
  await audit.record(db, {
    actor, action: "offer.created", entity_type: ENTITY, entity_id: o.id, summary: label(o, opp.title),
    changes: { uw_model_id: String(model.id), terms: terms(o), deviation_pct: o.deviation_pct },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function update(db: Db, o: Offer, data: OfferTerms, actor: CurrentUser): Promise<Offer> {
  if (o.origin !== "buyer" || o.status !== "draft") {
    throw new HttpError(409, "Only draft versions can be edited. Create a counter version to change terms.");
  }
  const values = strip(data);
  if ("price" in values && values.price === null) delete values.price;
  if ("structure" in values && values.structure === null) delete values.structure;
  for (const b of ["financing_contingency", "assignment_allowed"]) {
    if (b in values && values[b] === null) values[b] = false;
  }
  if ("tags" in values && values.tags === null) values.tags = [];
  if (values.expiration_at) values.expiration_at = aware(values.expiration_at);
  const changes = audit.diff(o, values);
  if (!Object.keys(changes).length) return o;
  const next: Row = { ...o, ...values };
  await applyRouting(db, next);
  await patch(db, offers, o, { ...values, ...routingFields(next), updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "offer.updated", entity_type: ENTITY, entity_id: o.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function submit(db: Db, o: Offer, actor: CurrentUser): Promise<Offer> {
  requireStatus(o, ["draft"], "submit");
  if (o.origin !== "buyer") throw new HttpError(409, "Counterparty versions are not submitted for approval");
  // Re-validate the model is still approved at submission time.
  await approvedModel(db, o.uw_model_id);
  const next: Row = { ...o };
  await applyRouting(db, next);
  const now = utcnow();
  const set: Row = {
    ...routingFields(next), submission_no: o.submission_no + 1, submitted_at: now, submitted_by_id: actor.id,
    updated_by_id: actor.id,
  };
  let summary: string;
  if (next.approvals_required === 0) {
    set.status = "approved";
    set.approved_at = now;
    summary = "Submitted; within approval thresholds";
  } else {
    set.status = "pending_approval";
    summary = `Submitted for ${next.approvals_required} approval(s): ${next.approval_reasons.join("; ")}`;
  }
  await patch(db, offers, o, set as never);
  await audit.record(db, {
    actor, action: "offer.submitted", entity_type: ENTITY, entity_id: o.id, summary,
    changes: { status: { from: "draft", to: o.status }, reasons: o.approval_reasons, deviation_pct: o.deviation_pct },
    ip_address: actor.ip_address,
  });
  if (o.status === "pending_approval") {
    const opp = await opportunity(db, o.opportunity_id);
    await createTask(db, {
      title: `Approve offer: ${label(o, opp.title)}`, description: o.approval_reasons.join("; "), assignee_id: null,
      due_at: new Date(now.getTime() + 86400000), task_type: "approval", priority: "high", related_type: "offer",
      related_id: o.id, related_label: label(o, opp.title), source: "offers",
      idempotency_key: `offer-approval:${o.id}:${o.submission_no}`, actor_id: actor.id,
    });
  }
  await db.commit();
  return o;
}

export async function decide(db: Db, o: Offer, data: ApprovalIn, actor: CurrentUser): Promise<Offer> {
  requireStatus(o, ["pending_approval"], "approve");
  if (!actor.canApprove("offer", Number(o.price))) {
    throw new HttpError(403, `Your offer approval limit does not cover $${money0(o.price)}`);
  }
  const [dup] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(offerApprovals)
    .where(and(
      eq(offerApprovals.offer_id, o.id), eq(offerApprovals.submission_no, o.submission_no),
      eq(offerApprovals.approver_id, actor.id),
    ));
  if (Number(dup?.n ?? 0)) throw new HttpError(409, "You have already decided on this submission");
  if (data.decision === "rejected" && !(data.note && data.note.trim())) {
    throw new HttpError(422, "A reason is required to reject an offer");
  }
  const now = utcnow();
  await insert(db, offerApprovals, {
    offer_id: o.id, submission_no: o.submission_no, decision: data.decision, approver_id: actor.id,
    approver_name: actor.full_name, decided_at: now, note: data.note ?? null, price: o.price,
    deviation_pct: o.deviation_pct, reasons: [...(o.approval_reasons || [])],
  } as never);
  const before = o.status;
  const set: Row = { updated_by_id: actor.id };
  if (data.decision === "rejected") {
    set.status = "draft";
  } else if ((await approvalsReceived(db, o)) >= Math.max(1, o.approvals_required)) {
    set.status = "approved";
    set.approved_at = now;
  }
  await patch(db, offers, o, set as never);
  await audit.record(db, {
    actor, action: `offer.approval_${data.decision}`, entity_type: ENTITY, entity_id: o.id, summary: data.note,
    changes: { status: { from: before, to: o.status }, submission_no: o.submission_no }, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

/** New version from the latest one. Never edits the source beyond marking it countered. */
export async function counter(db: Db, src: Offer, data: CounterIn, actor: CurrentUser): Promise<Offer> {
  if (!src.is_latest) throw new HttpError(409, "Counters are created from the latest version only");
  if (data.origin === "seller") {
    if (src.origin !== "buyer" || src.status !== "sent") {
      throw new HttpError(409, "A counterparty counter can only be recorded against our sent version");
    }
  } else {
    if (["draft", "pending_approval", "approved"].includes(src.status)) {
      throw new HttpError(409, "The latest version is still unsent; edit or withdraw it instead of countering");
    }
    if (src.status === "accepted") throw new HttpError(409, "This negotiation is already accepted");
  }

  const modelId = data.uw_model_id || src.uw_model_id;
  const model = await approvedModel(db, modelId);
  const opp = await opportunity(db, src.opportunity_id);
  const now = utcnow();
  const { origin: _origin, uw_model_id: _uw, response_note: _rn, responded_at: _ra, ...rest } = data;
  const overrides = strip(rest);
  const values: Row = Object.fromEntries(COPY_FIELDS.map((k) => [k, (src as Row)[k]]));
  Object.assign(values, Object.fromEntries(
    Object.entries(overrides).filter(([k, v]) => !(["price", "structure"].includes(k) && v === null)),
  ));
  values.tags = values.tags || [];
  values.expiration_at = aware(values.expiration_at);
  for (const b of ["financing_contingency", "assignment_allowed"]) values[b] = Boolean(values[b]);
  const respondedAt = aware(data.responded_at) || now;

  const draft: Row = {
    ...values, opportunity_id: src.opportunity_id, property_id: src.property_id, uw_model_id: model.id,
    uw_model_version: model.version ?? null, model_price: modelPrice(model),
    model_outputs: toJsonable(model.outputs || {}), root_offer_id: src.root_offer_id || src.id,
    parent_offer_id: src.id, version: src.version + 1, is_latest: true, origin: data.origin, created_by_id: actor.id,
    updated_by_id: actor.id,
  };
  await applyRouting(db, draft);
  if (!("expiration_at" in overrides)) draft.expiration_at = null; // a previous version's expiration never carries over
  const srcSet: Row = { is_latest: false, updated_by_id: actor.id };
  if (data.origin === "seller") {
    // The counterparty's position is recorded verbatim and frozen; their expiration starts our clock.
    draft.status = "countered";
    draft.responded_at = respondedAt;
    draft.response_due_at = draft.expiration_at;
    Object.assign(srcSet, {
      status: "countered", responded_at: respondedAt, response_note: data.response_note ?? null,
      response_recorded_by_id: actor.id,
    });
  } else {
    draft.status = "draft";
  }
  await patch(db, offers, src, srcSet as never);
  const created = await insert(db, offers, draft as never);

  const delta = diffTerms(src, created);
  await audit.record(db, {
    actor, action: "offer.countered", entity_type: ENTITY, entity_id: created.id,
    summary: `v${src.version} → v${created.version} (${data.origin === "seller" ? "counterparty" : "our"} counter)`,
    changes: { parent_offer_id: String(src.id), delta }, ip_address: actor.ip_address,
  });
  if (data.origin === "seller") {
    await audit.record(db, {
      actor, action: "offer.response_recorded", entity_type: ENTITY, entity_id: src.id, summary: "Countered",
      changes: { status: { from: "sent", to: "countered" } }, ip_address: actor.ip_address,
    });
    await upsertDate(db, src, { due: src.response_due_at || now, owner_id: opp.owner_id, actor, status: "completed" });
    if (created.response_due_at) {
      await createTask(db, {
        title: `Respond to counter before it expires: ${label(created, opp.title)}`, assignee_id: opp.owner_id,
        due_at: created.response_due_at, task_type: "follow_up", priority: "high", related_type: "offer",
        related_id: created.id, related_label: label(created, opp.title), source: "offers",
        idempotency_key: `offer-counter-follow-up:${created.id}`, actor_id: actor.id,
      });
    }
  }
  await db.commit();
  return created;
}

/** Soft-delete an unsent first draft (no negotiation history exists yet). */
export async function withdrawOrDeleteDraft(db: Db, o: Offer, actor: CurrentUser): Promise<void> {
  if (o.status !== "draft" || o.version !== 1) {
    throw new HttpError(409, "Only an unsent first draft can be deleted; withdraw the offer instead");
  }
  await patch(db, offers, o, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "offer.deleted", entity_type: ENTITY, entity_id: o.id, summary: `v${o.version}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// --- LOI ---------------------------------------------------------------------------------------

const money = (v: any) => (v !== null && v !== undefined ? `$${money0(v)}` : "—");
const days = (v: any, unit = "days") => (v !== null && v !== undefined ? `${Math.trunc(Number(v))} ${unit}` : "—");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** Python `strftime('%B %d, %Y %I:%M %p UTC')`. */
function longDateTime(d: Date): string {
  const h = d.getUTCHours();
  const h12 = String(h % 12 || 12).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()} ` +
    `${h12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} UTC`;
}

/** Structured letter-of-intent payload generated from the version's approved terms. */
export async function buildLoi(db: Db, o: Offer): Promise<Record<string, any>> {
  const opp = await opportunity(db, o.opportunity_id);
  const p = o.property_id ? await ormGet(db, properties, o.property_id) : undefined;
  const approvals = await db
    .select()
    .from(offerApprovals)
    .where(and(
      eq(offerApprovals.offer_id, o.id), eq(offerApprovals.submission_no, o.submission_no),
      eq(offerApprovals.decision, "approved"),
    ))
    .orderBy(asc(offerApprovals.decided_at));
  let ext = "None";
  if (o.extension_count) {
    ext = `${o.extension_count} extension(s) of ${days(o.extension_days)} each` +
      (o.extension_cost ? `, at ${money(o.extension_cost)} per extension` : "");
  }
  let em = money(o.earnest_money);
  if (o.earnest_money_hard_days !== null && o.earnest_money_hard_days !== undefined) {
    em += `, becoming non-refundable ${days(o.earnest_money_hard_days)} after the effective date`;
  }
  const fin = o.financing_contingency
    ? `Buyer's obligation is contingent on obtaining financing within ${days(o.financing_days)}.`
    : "No financing contingency.";
  const paragraphs: Array<{ key: string; heading: string; text: string }> = [
    {
      key: "property", heading: "Property",
      text: [p?.name, p?.address_line, p?.city, p?.state].filter((x) => x).join(", ") || opp.title,
    },
    { key: "price", heading: "Purchase price", text: money(o.price) },
    { key: "structure", heading: "Structure", text: capitalize((o.structure || "").replace(/_/g, " ")) },
    { key: "earnest_money", heading: "Earnest money", text: em },
    { key: "feasibility", heading: "Feasibility period", text: days(o.feasibility_days) },
    {
      key: "closing", heading: "Closing",
      text: o.closing_days !== null && o.closing_days !== undefined
        ? `${days(o.closing_days)} after the end of the feasibility period` : "—",
    },
    { key: "extensions", heading: "Extensions", text: ext },
    { key: "financing", heading: "Financing", text: fin },
    {
      key: "title_survey", heading: "Title and survey",
      text: [
        o.title_survey_days !== null && o.title_survey_days !== undefined
          ? `Review period of ${days(o.title_survey_days)}.` : null,
        o.title_survey_terms,
      ].filter((x) => x).join(" ") || "—",
    },
    {
      key: "assignment", heading: "Assignment",
      text: (o.assignment_allowed ? "Buyer may assign to an affiliate." : "Not assignable without consent.") +
        (o.assignment_terms ? ` ${o.assignment_terms}` : ""),
    },
    { key: "access", heading: "Access", text: o.access_terms || "—" },
    {
      key: "exclusivity", heading: "Exclusivity",
      text: o.exclusivity_days
        ? `Seller will not market the property or negotiate with others for ${days(o.exclusivity_days)}.` : "—",
    },
    {
      key: "expiration", heading: "Expiration",
      text: o.expiration_at ? `This letter expires at ${longDateTime(o.expiration_at)}.` : "—",
    },
  ];
  if (o.other_terms) paragraphs.push({ key: "other", heading: "Other terms", text: o.other_terms });
  paragraphs.push({
    key: "non_binding", heading: "Non-binding",
    text: "This letter is a non-binding expression of intent. Except for exclusivity and confidentiality, " +
      "no party is bound until a definitive purchase agreement is executed.",
  });
  return toJsonable({
    offer_id: o.id, root_offer_id: o.root_offer_id, version: o.version, status: o.status, generated_at: utcnow(),
    opportunity_title: opp.title, buyer_entity: o.buyer_entity, seller_name: o.seller_name,
    property: p
      ? { id: p.id, name: p.name, address_line: p.address_line, city: p.city, state: p.state, postal_code: p.postal_code }
      : null,
    terms: terms(o), paragraphs,
    underwriting: {
      uw_model_id: o.uw_model_id, version: o.uw_model_version, model_price: o.model_price, deviation_pct: o.deviation_pct,
    },
    approvals: approvals.map((a) => ({ approver_name: a.approver_name, decided_at: a.decided_at })),
  });
}

export async function loi(db: Db, o: Offer): Promise<Record<string, any>> {
  if (o.loi_payload) return o.loi_payload;
  if (o.origin !== "buyer" || ["draft", "pending_approval"].includes(o.status)) {
    throw new HttpError(409, "An LOI is generated only from approved terms");
  }
  return buildLoi(db, o);
}

// --- send / respond / expire -------------------------------------------------------------------

export async function send(db: Db, o: Offer, data: SendIn, actor: CurrentUser): Promise<Offer> {
  requireStatus(o, ["approved"], "send");
  const opp = await opportunity(db, o.opportunity_id);
  const s = await getSettings(db);
  const now = utcnow();
  const due = aware(data.response_due_at) || o.expiration_at || new Date(now.getTime() + s.default_response_days * 86400000);
  if (due <= now) throw new HttpError(422, "Response due time must be in the future");
  await patch(db, offers, o, {
    status: "sent", sent_at: now, sent_by_id: actor.id, updated_by_id: actor.id, sent_to: data.sent_to ?? null,
    sent_via: data.sent_via ?? null, response_due_at: due,
  });
  await patch(db, offers, o, { loi_payload: await buildLoi(db, o) }); // frozen exactly as sent

  const criticalDateId = await upsertDate(db, o, { due, owner_id: opp.owner_id, actor });
  const followAt = new Date(Math.max(now.getTime(), due.getTime() - 24 * 3600 * 1000));
  const task = await createTask(db, {
    title: `Follow up on offer response: ${label(o, opp.title)}`,
    description: `Response due ${due.toISOString()}` + (data.sent_to ? ` from ${data.sent_to}` : ""),
    assignee_id: opp.owner_id || actor.id, due_at: followAt, task_type: "follow_up", priority: "normal",
    related_type: "offer", related_id: o.id, related_label: label(o, opp.title), source: "offers",
    idempotency_key: `offer-follow-up:${o.id}`, actor_id: actor.id,
  });
  await patch(db, offers, o, { critical_date_id: criticalDateId, follow_up_task_id: task.id });
  await setOpportunityOfferFields(db, opp, o, actor);
  await audit.record(db, {
    actor, action: "offer.sent", entity_type: ENTITY, entity_id: o.id,
    summary: `Sent to ${data.sent_to || "counterparty"}` + (data.sent_via ? ` via ${data.sent_via}` : ""),
    changes: { status: { from: "approved", to: "sent" }, response_due_at: due, note: data.note ?? null },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "offer.sent", {
    offer_id: o.id, opportunity_id: o.opportunity_id, property_id: o.property_id, response_due_at: due, actor,
  });
  await db.commit();
  return o;
}

async function expireOne(db: Db, o: Offer, actor: CurrentUser | null, now: Date): Promise<void> {
  const opp = await opportunity(db, o.opportunity_id);
  const before = o.status;
  await patch(db, offers, o, { status: "expired", expired_at: now, updated_by_id: actor?.id ?? null });
  const lbl = label(o, opp.title);
  const task = await createTask(db, {
    title: `Offer expired without response — decide next step: ${lbl}`,
    description: "The response clock ran out. Re-engage, counter, withdraw, or record the outcome " +
      "(and the winning price if discoverable).",
    assignee_id: opp.owner_id || o.sent_by_id, due_at: new Date(now.getTime() + 86400000), task_type: "follow_up",
    priority: "urgent", related_type: "offer", related_id: o.id, related_label: lbl, source: "offers",
    idempotency_key: `offer-expired:${o.id}`, actor_id: actor?.id ?? null,
  });
  await patch(db, offers, o, { escalation_task_id: task.id });
  await raiseAlert(db, {
    title: `Offer expired: ${lbl}`, reason: "Response due time passed without a recorded response", severity: "high",
    owner_id: opp.owner_id || o.sent_by_id, related_type: "offer", related_id: o.id, related_label: lbl,
    rule_key: "offers.expired", idempotency_key: `offer-expired-alert:${o.id}`,
  });
  if (o.response_due_at) {
    await upsertDate(db, o, { due: o.response_due_at, owner_id: opp.owner_id, actor, status: "missed" });
  }
  await audit.record(db, {
    actor, action: "offer.expired", entity_type: ENTITY, entity_id: o.id, summary: lbl,
    changes: { status: { from: before, to: "expired" } }, ip_address: actor?.ip_address ?? null,
  });
  await events.emit(db, "offer.expired", {
    offer_id: o.id, opportunity_id: o.opportunity_id, property_id: o.property_id, actor,
  });
}

/** Expire every awaiting version whose response clock has run out. Commits only when something expired. */
export async function expireDue(db: Db, actor: CurrentUser | null = null): Promise<string[]> {
  const now = utcnow();
  const rows = await db
    .select()
    .from(offers)
    .where(and(
      isNull(offers.deleted_at), eq(offers.is_latest, true), inArray(offers.status, ["sent", "countered"]),
      sql`${offers.response_due_at} is not null`, sql`${offers.response_due_at} < ${now.toISOString()}::timestamptz`,
    ))
    .for("update", { skipLocked: true });
  for (const o of rows) await expireOne(db, o, actor, now);
  if (rows.length) await db.commit();
  return rows.map((o) => o.id);
}

/** Accepted offer moves the opportunity toward under contract — only through the pipeline's gated move. */
async function advanceOpportunity(db: Db, o: Offer, actor: CurrentUser): Promise<void> {
  let opp = await opportunity(db, o.opportunity_id);
  // A counterparty counter we accepted has no "sent" time of its own: the chain's response time stands in.
  await setOpportunityOfferFields(db, opp, o, actor, {
    sent_at: o.sent_at || o.responded_at, due_at: o.response_due_at || o.responded_at,
  });
  const targets: string[] = [];
  if (PRE_OFFER_STAGES.includes(opp.stage)) targets.push("offer");
  if ([...PRE_OFFER_STAGES, "offer"].includes(opp.stage)) targets.push("under_contract");
  if (!targets.length) {
    await db.commit();
    return;
  }
  for (const target of targets) {
    if (target === "under_contract") {
      const unmet = pipeline.unmetOf(await pipeline.checkGate(db, opp as never, "under_contract"));
      if (unmet.length) {
        await createTask(db, {
          title: `Execute contract to move to under contract: ${opp.title}`,
          description: "Offer accepted. Record the contract executed date to pass the under-contract gate.",
          assignee_id: opp.owner_id || actor.id, due_at: new Date(Date.now() + 3 * 86400000), task_type: "follow_up",
          priority: "high", related_type: "opportunity", related_id: opp.id, related_label: opp.title,
          source: "offers", idempotency_key: `offer-accepted-contract:${o.id}`, actor_id: actor.id,
        });
        await db.commit();
        return;
      }
    }
    try {
      opp = (await pipeline.move(db, opp as never, { to_stage: target, fields: {}, override_reason: null } as never, actor)) as Row; // commits
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await audit.record(db, {
        actor, action: "offer.pipeline_move_blocked", entity_type: ENTITY, entity_id: o.id,
        summary: `Could not move opportunity to ${target}`, changes: { detail: toJsonable(e.detail) },
        ip_address: actor.ip_address,
      });
      await db.commit();
      return;
    }
  }
}

function winningValues(data: RespondIn, actor: CurrentUser, now: Date): Row {
  if (data.winning_price === null || data.winning_price === undefined) return {};
  if (!["rejected", "expired", "withdrawn"].includes(data.outcome)) {
    throw new HttpError(422, "Winning price applies only to lost offers");
  }
  return {
    winning_price: data.winning_price, winning_buyer: data.winning_buyer ?? null,
    winning_price_source: data.winning_price_source || "Recorded with outcome", winning_price_recorded_at: now,
    winning_price_recorded_by_id: actor.id,
  };
}

export async function respond(db: Db, o: Offer, data: RespondIn, actor: CurrentUser): Promise<Offer> {
  if (data.outcome === "countered") {
    if (!data.counter_terms) throw new HttpError(422, "Counter terms are required");
    const body = {
      ...strip(data.counter_terms), origin: "seller", response_note: data.note, responded_at: data.responded_at,
    } as CounterIn;
    return counter(db, o, body, actor);
  }

  if (!o.is_latest) throw new HttpError(409, "Outcomes are recorded on the latest version");
  const now = utcnow();
  const before = o.status;
  const opp = await opportunity(db, o.opportunity_id);
  const extra: Row = {};

  if (data.outcome === "accepted") {
    if (o.origin === "buyer") {
      requireStatus(o, ["sent"], "accept");
    } else {
      // Accepting the counterparty's counter commits us to their terms: needs a named approval.
      requireStatus(o, ["countered"], "accept");
      if (!actor.can("offers", "approve") || !actor.canApprove("offer", Number(o.price))) {
        throw new HttpError(403, "Accepting a counter requires offer approval permission within your limit");
      }
      const submissionNo = o.submission_no + 1;
      await insert(db, offerApprovals, {
        offer_id: o.id, submission_no: submissionNo, decision: "approved", approver_id: actor.id,
        approver_name: actor.full_name, decided_at: now, note: data.note || "Accepted counterparty counter",
        price: o.price, deviation_pct: o.deviation_pct, reasons: [...(o.approval_reasons || [])],
      } as never);
      extra.submission_no = submissionNo;
      extra.approved_at = now;
    }
  } else if (data.outcome === "rejected") {
    requireStatus(o, ["sent", "countered"], "reject");
  } else if (data.outcome === "withdrawn") {
    requireStatus(o, ["draft", "pending_approval", "approved", "sent", "countered"], "withdraw");
  } else if (data.outcome === "expired") {
    requireStatus(o, ["sent", "countered"], "expire");
    await expireOne(db, o, actor, now);
    await patch(db, offers, o, winningValues(data, actor, now) as never);
    await db.commit();
    return o;
  }

  await patch(db, offers, o, {
    ...extra, status: data.outcome, responded_at: aware(data.responded_at) || now, response_note: data.note ?? null,
    response_recorded_by_id: actor.id, updated_by_id: actor.id, ...winningValues(data, actor, now),
  } as never);
  if (o.response_due_at && ["sent", "countered"].includes(before)) {
    await upsertDate(db, o, { due: o.response_due_at, owner_id: opp.owner_id, actor, status: "completed" });
  }
  await audit.record(db, {
    actor, action: `offer.${data.outcome}`, entity_type: ENTITY, entity_id: o.id,
    summary: data.note || label(o, opp.title),
    changes: { status: { from: before, to: o.status }, ...(o.winning_price ? { winning_price: o.winning_price } : {}) },
    ip_address: actor.ip_address,
  });
  if (data.outcome === "accepted") {
    await events.emit(db, "offer.accepted", {
      offer_id: o.id, opportunity_id: o.opportunity_id, property_id: o.property_id, uw_model_id: o.uw_model_id,
      price: Number(o.price), actor,
    });
    await advanceOpportunity(db, o, actor); // commits
    return o;
  }
  await db.commit();
  return o;
}

export async function recordWinningPrice(db: Db, o: Offer, data: WinningPriceIn, actor: CurrentUser): Promise<Offer> {
  if (!["rejected", "expired", "withdrawn"].includes(o.status)) {
    throw new HttpError(409, "Winning price can only be captured on a lost offer");
  }
  const changes = audit.diff(o, {
    winning_price: data.winning_price, winning_buyer: data.winning_buyer ?? null,
    winning_price_source: data.winning_price_source,
  });
  await patch(db, offers, o, {
    winning_price: data.winning_price, winning_buyer: data.winning_buyer ?? null,
    winning_price_source: data.winning_price_source, winning_price_recorded_at: utcnow(),
    winning_price_recorded_by_id: actor.id, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "offer.winning_price_recorded", entity_type: ENTITY, entity_id: o.id, changes,
    summary: `$${money0(data.winning_price)} (${data.winning_price_source})`, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

// --- delta -------------------------------------------------------------------------------------

export function diffTerms(a: Row, b: Row): TermDelta[] {
  const out: TermDelta[] = [];
  for (const [field, lbl] of Object.entries(TERM_FIELDS)) {
    const x = a[field];
    const y = b[field];
    if (audit.isEqual(x, y)) continue;
    const d: TermDelta = { field, label: lbl, from_value: toJsonable(x ?? null), to_value: toJsonable(y ?? null), change: null, change_pct: null };
    if (NUMERIC_TERMS.has(field) && x !== null && x !== undefined && y !== null && y !== undefined) {
      d.change = round(Number(y) - Number(x), 2);
      d.change_pct = Number(x) ? round(((Number(y) - Number(x)) / Number(x)) * 100, 2) : null;
    }
    out.push(d);
  }
  return out;
}

export async function delta(db: Db, o: Offer, againstId: string | null | undefined) {
  if (!againstId) {
    if (!o.parent_offer_id) throw new HttpError(422, "This is the first version; choose a version to compare");
    againstId = o.parent_offer_id;
  }
  const other = await get(db, againstId);
  if ((other.root_offer_id || other.id) !== (o.root_offer_id || o.id)) {
    throw new HttpError(422, "Versions belong to different negotiations");
  }
  const [a, b] = other.version <= o.version ? [other, o] : [o, other];
  const changes = diffTerms(a, b);
  const changed = new Set(changes.map((c) => c.field));
  return {
    from_offer_id: a.id, from_version: a.version, to_offer_id: b.id, to_version: b.version, changes,
    unchanged: Object.keys(TERM_FIELDS).filter((k) => !changed.has(k)),
  };
}

export async function chain(db: Db, o: Offer): Promise<Offer[]> {
  return chainOf(db, o);
}

// --- handlers support --------------------------------------------------------------------------

export async function reassignUser(db: Db, userId: string, reassignToId: string | null | undefined): Promise<void> {
  if (reassignToId) {
    await db
      .update(offers)
      .set({ sent_by_id: reassignToId })
      .where(and(eq(offers.sent_by_id, userId), inArray(offers.status, ["sent", "countered"])));
  }
}
