import { and, asc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import * as provenance from "../../common/provenance";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get as dbGet, insert, patch } from "../../db/orm";
import { assets } from "../assets/schema";
import { users } from "../auth/schema";
import { loanReserves, loans } from "../debt/schema";
import { properties } from "../properties/schema";
import { addDays, addMonths, daysBetween, fmt0, normKey, pct, r2, rr, todayStr } from "./helpers";
import {
  PROGRESSION,
  TERMINAL,
  dispositionEvents,
  dispositionOffers,
  dispositions,
  exchangeCandidates,
  exchanges1031,
  retrades,
  type Disposition,
  type DispositionOffer,
  type Exchange1031,
  type ExchangeCandidate,
  type Retrade,
} from "./schema";
import type {
  CandidateIn,
  CompareIn,
  DispositionCreate,
  DispositionUpdate,
  ExchangeIn,
  MoveIn,
  OfferIn,
  Requirement,
  RetradeDecisionIn,
  RetradeIn,
} from "./schemas";

export const ENTITY = "disposition";
export const TAX_NOTE =
  "Tax figures (gain, depreciation recapture, capital gains, boot, deferred gain and after-tax proceeds) are " +
  "modeled estimates for comparison only and are subject to review by a qualified tax professional.";

type Property = typeof properties.$inferSelect;
type Asset = typeof assets.$inferSelect;

// Sibling services are loaded lazily (the Python imported them inside functions to avoid import cycles).
const tasksService = () => import("../tasks/service");
const assetsService = () => import("../assets/service");
const debtCalc = () => import("../debt/calc");
const debtService = () => import("../debt/service");

/** Lookup in a result that may be a Map or a plain object keyed by id. */
const at = (m: any, k: string | null | undefined): any => (k == null ? undefined : m instanceof Map ? m.get(k) : m?.[k]);
const dateStr = (v: unknown): string | null => (v == null || v === "" ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const stripUndefined = (o: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const pick = (row: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const dueDt = (d: string): Date => new Date(`${d}T17:00:00Z`);

export function nextStage(stage: string): string | null {
  const i = PROGRESSION.indexOf(stage);
  if (i < 0) return null;
  return i + 1 < PROGRESSION.length ? PROGRESSION[i + 1] : null;
}

export async function get(db: Db, disposition_id: string): Promise<Disposition> {
  const d = await dbGet(db, dispositions, disposition_id);
  if (!d || d.deleted_at) throw new HttpError(404, "Disposition not found");
  return d;
}

async function getAsset(db: Db, asset_id: string): Promise<Asset> {
  const a = await dbGet(db, assets, asset_id);
  if (!a || a.deleted_at) throw new HttpError(404, "Asset not found");
  return a;
}

async function propsOf(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, Property>> {
  const set = [...new Set(ids.filter((i): i is string => !!i))];
  if (!set.length) return new Map();
  return new Map((await db.select().from(properties).where(inArray(properties.id, set))).map((p) => [p.id, p]));
}

async function namesOf(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter((i): i is string => !!i))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((u) => [u.id, u.full_name]));
}

const label = (p: Property | undefined) => (p ? p.name || p.address_line : null);

// --------------------------------------------------------------------------- list

export interface DispositionFilters {
  q?: string;
  stage?: string[];
  owner_id?: string[];
  is_1031?: string[];
  asset_id?: string;
  property_id?: string;
  active_only?: boolean;
}

/** WHERE clause over `dispositions JOIN properties`; see `selectDispositions`. `skip` leaves a facet's own filter out. */
export function buildWhere(f: DispositionFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = dispositions;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.buyer_name, properties.name, properties.address_line, properties.city]),
    skip.has("stage") ? undefined : inFilter(t.stage, f.stage),
    skip.has("owner_id") ? undefined : inFilter(t.owner_id, f.owner_id),
    !skip.has("is_1031") && f.is_1031?.length
      ? inArray(t.is_1031, f.is_1031.map((v) => ["true", "1", "yes"].includes(v)))
      : undefined,
    f.asset_id ? eq(t.asset_id, f.asset_id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.active_only ? notInArray(t.stage, TERMINAL) : undefined,
  );
}

export function selectDispositions(db: Db, where: SQL | undefined) {
  return db
    .select({ d: dispositions })
    .from(dispositions)
    .innerJoin(properties, eq(properties.id, dispositions.property_id))
    .where(where);
}

export async function countDispositions(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dispositions)
    .innerJoin(properties, eq(properties.id, dispositions.property_id))
    .where(where);
  return r?.n ?? 0;
}

export async function facet(db: Db, where: SQL | undefined, column: any): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(dispositions)
    .innerJoin(properties, eq(properties.id, dispositions.property_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ k: unknown; n: number }>) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function toItems(db: Db, rows: Disposition[]): Promise<Record<string, any>[]> {
  const props = await propsOf(db, rows.map((d) => d.property_id));
  const names = await namesOf(db, rows.map((d) => d.owner_id));
  const ids = rows.map((d) => d.id);
  const offers = new Map<string, [number, number | null]>();
  const deadlines = new Map<string, string | null>();
  if (ids.length) {
    const o = dispositionOffers;
    const stats = await db
      .select({ did: o.disposition_id, cnt: sql<number>`count(*)::int`, best: sql<string | null>`max(${o.price})` })
      .from(o)
      .where(and(inArray(o.disposition_id, ids), isNull(o.deleted_at), notInArray(o.status, ["rejected", "withdrawn"])))
      .groupBy(o.disposition_id);
    for (const r of stats) offers.set(r.did, [Number(r.cnt), r.best !== null && r.best !== undefined ? Number(r.best) : null]);
    const today = todayStr();
    const exs = await db
      .select()
      .from(exchanges1031)
      .where(and(inArray(exchanges1031.disposition_id, ids), isNull(exchanges1031.deleted_at)));
    for (const ex of exs) {
      const upcoming = [ex.identification_deadline, ex.replacement_deadline].filter((x): x is string => !!x && x >= today);
      deadlines.set(
        ex.disposition_id,
        upcoming.length && !["completed", "failed", "cancelled"].includes(ex.status) ? upcoming.reduce((a, b) => (a < b ? a : b)) : null,
      );
    }
  }
  const now = Date.now();
  return rows.map((d) => {
    const p = props.get(d.property_id);
    const [cnt, best] = offers.get(d.id) ?? [0, null];
    return {
      id: d.id, name: d.name, asset_id: d.asset_id, property_id: d.property_id,
      property_label: p ? p.name || p.address_line : "—", city: p ? p.city : null, state: p ? p.state : null,
      stage: d.stage, stage_entered_at: d.stage_entered_at,
      days_in_stage: d.stage_entered_at ? Math.max(0, Math.floor((now - d.stage_entered_at.getTime()) / 86_400_000)) : 0,
      owner_id: d.owner_id, owner_name: d.owner_id ? (names.get(d.owner_id) ?? null) : null, is_1031: d.is_1031,
      target_price: d.target_price, best_offer: best, offer_count: cnt, contract_price: d.contract_price,
      target_closing_on: d.target_closing_on, next_exchange_deadline: deadlines.get(d.id) ?? null,
      updated_at: d.updated_at,
    };
  });
}

const DISPOSITION_OUT = [
  "id", "asset_id", "property_id", "name", "stage", "stage_entered_at", "owner_id", "reason", "is_1031", "target_price",
  "list_price", "pricing_notes", "broker_organization_id", "broker_name", "commission_pct", "marketing_launched_on",
  "offers_due_on", "accepted_offer_id", "buyer_organization_id", "buyer_name", "contract_price",
  "contract_executed_on", "dd_expires_on", "target_closing_on", "closed_on", "sale_price", "cost_lines", "tax_inputs",
  "comparison", "comparison_at", "withdrawn_reason", "notes", "created_at", "updated_at",
] as const;

export async function toOut(db: Db, d: Disposition): Promise<Record<string, any>> {
  const out: Record<string, any> = { ...pick(d, DISPOSITION_OUT), property_label: "", city: null, state: null, owner_name: null, asset_status: null };
  const p = (await propsOf(db, [d.property_id])).get(d.property_id);
  if (p) {
    out.property_label = p.name || p.address_line;
    out.city = p.city;
    out.state = p.state;
  }
  out.owner_name = d.owner_id ? ((await namesOf(db, [d.owner_id])).get(d.owner_id) ?? null) : null;
  const a = await dbGet(db, assets, d.asset_id);
  out.asset_status = a ? a.status : null;
  return out;
}

// --------------------------------------------------------------------------- create / update

async function recordEvent(
  db: Db,
  d: Disposition,
  from_stage: string | null,
  to_stage: string,
  actor: { id?: string | null; full_name?: string | null } | null | undefined,
  reason: string | null = null,
  override = false,
  unmet: unknown[] = [],
): Promise<void> {
  await insert(db, dispositionEvents, {
    disposition_id: d.id, from_stage, to_stage, actor_id: actor?.id ?? null, actor_name: actor?.full_name ?? null,
    reason, override, unmet,
  } as never);
}

export async function create(db: Db, data: DispositionCreate, actor: CurrentUser): Promise<Disposition> {
  const a = await getAsset(db, data.asset_id);
  if (a.status === "disposed") throw new HttpError(409, "This asset has already been disposed");
  const [openD] = await db
    .select()
    .from(dispositions)
    .where(and(eq(dispositions.asset_id, a.id), isNull(dispositions.deleted_at), notInArray(dispositions.stage, TERMINAL)))
    .limit(1);
  if (openD) throw new HttpError(409, { message: "This asset already has an open disposition", id: openD.id });
  const p = await dbGet(db, properties, a.property_id as string);
  const d = await insert(db, dispositions, {
    asset_id: a.id, property_id: a.property_id, name: data.name || `Sale of ${p ? p.name || p.address_line : "asset"}`,
    stage: "candidate", stage_entered_at: new Date(), owner_id: data.owner_id || a.manager_id || actor.id,
    reason: data.reason ?? null, is_1031: data.is_1031, target_price: data.target_price ?? null, cost_lines: [],
    tax_inputs: {}, comparison: {}, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await recordEvent(db, d, null, "candidate", actor, data.reason ?? null);
  await audit.record(db, {
    actor, action: "disposition.created", entity_type: ENTITY, entity_id: d.id, summary: d.name, ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function update(db: Db, d: Disposition, data: DispositionUpdate, actor: CurrentUser): Promise<Disposition> {
  const values = stripUndefined(data);
  if (d.stage === "closed") {
    const allowed = new Set(["notes", "tax_inputs", "cost_lines"]);
    if (Object.keys(values).some((k) => !allowed.has(k))) {
      throw new HttpError(409, "A closed disposition is immutable except notes, costs and tax inputs");
    }
  }
  for (const k of ["cost_lines", "tax_inputs"]) {
    if (k in values) values[k] = values[k] || (k === "cost_lines" ? [] : {});
  }
  const changes = audit.diff(d, values);
  if (!Object.keys(changes).length) return d;
  await patch(db, dispositions, d, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "disposition.updated", entity_type: ENTITY, entity_id: d.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function archive(db: Db, d: Disposition, actor: CurrentUser): Promise<void> {
  if (d.stage !== "candidate" && d.stage !== "withdrawn") {
    throw new HttpError(409, "Only candidate or withdrawn dispositions can be deleted; withdraw it first");
  }
  await patch(db, dispositions, d, { deleted_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "disposition.archived", entity_type: ENTITY, entity_id: d.id, summary: d.name, ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- stage gates

const req = (key: string, label: string, met: boolean, blocking = true, detail: string | null = null): Requirement => ({
  key, label, met, blocking, detail,
});

export async function checkGate(db: Db, d: Disposition, to_stage: string): Promise<Requirement[]> {
  const reqs: Requirement[] = [];
  if (to_stage === "withdrawn") {
    return [req("reason", "Reason for withdrawal", false, true, "Provide a reason when withdrawing")];
  }
  if (!PROGRESSION.includes(to_stage)) return reqs;
  const target = PROGRESSION.indexOf(to_stage);
  const accepted = d.accepted_offer_id ? await dbGet(db, dispositionOffers, d.accepted_offer_id) : undefined;
  const ex = await getExchange(db, d);
  if (target >= PROGRESSION.indexOf("pricing")) {
    reqs.push(
      req("comparison", "Hold / sell / refinance comparison run", Object.keys(d.comparison ?? {}).length > 0, true,
        "Compare alternatives before pricing the asset"),
    );
  }
  if (target >= PROGRESSION.indexOf("marketing")) {
    reqs.push(req("target_price", "Target or list price set", Boolean(d.target_price || d.list_price)));
  }
  if (target >= PROGRESSION.indexOf("offers")) {
    reqs.push(req("marketing_launched_on", "Marketing launch date recorded", d.marketing_launched_on != null));
  }
  if (target >= PROGRESSION.indexOf("contract")) {
    reqs.push(req("accepted_offer", "Accepted buyer offer", accepted != null));
    reqs.push(req("contract", "Contract price and execution date", Boolean(d.contract_price && d.contract_executed_on)));
  }
  if (target >= PROGRESSION.indexOf("buyer_dd")) {
    reqs.push(req("dd_expires_on", "Buyer due diligence expiration date", d.dd_expires_on != null));
  }
  if (target >= PROGRESSION.indexOf("closing")) {
    const [{ n: pending }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(retrades)
      .where(and(eq(retrades.disposition_id, d.id), isNull(retrades.deleted_at), eq(retrades.decision, "pending")));
    reqs.push(req("retrades", "No pending retrade requests", !pending, true, pending ? `${pending} pending` : null));
    reqs.push(req("target_closing_on", "Target closing date", d.target_closing_on != null));
    if (d.is_1031) {
      reqs.push(
        req("qi", "Qualified intermediary engaged before closing", Boolean(ex && (ex.qi_organization_id || ex.qi_name)), true,
          "Sale proceeds must go to the QI, never to the seller"),
      );
    }
  }
  if (target >= PROGRESSION.indexOf("closed")) {
    reqs.push(req("sale", "Final sale price and closing date", Boolean(d.sale_price && d.closed_on)));
    reqs.push(req("proceeds", "Proceeds reconciliation reviewed", true, false, "Review the proceeds waterfall before closing"));
  }
  return reqs;
}

export const unmetOf = (reqs: Requirement[]): Requirement[] => reqs.filter((r) => r.blocking && !r.met);

export async function move(db: Db, d: Disposition, body: MoveIn, actor: CurrentUser): Promise<Disposition> {
  const to = body.to_stage;
  if (d.stage === "closed") throw new HttpError(409, "A closed disposition cannot change stage");
  if (to === d.stage) throw new HttpError(409, "Already in this stage");
  let unmet: Requirement[] = [];
  if (to === "withdrawn") {
    if (!body.reason) throw new HttpError(422, "A reason is required to withdraw a disposition");
  } else {
    unmet = unmetOf(await checkGate(db, d, to));
    if (unmet.length && !body.override) throw new HttpError(409, { message: "Stage requirements are not met", unmet });
    if (unmet.length && !actor.can("dispositions", "approve")) {
      throw new HttpError(403, "Overriding stage requirements requires approval permission");
    }
    if (body.override && unmet.length && !body.reason) throw new HttpError(422, "An override requires a reason");
  }
  const a = await getAsset(db, d.asset_id);
  const old = d.stage;
  await patch(db, dispositions, d, { stage: to, stage_entered_at: new Date(), updated_by_id: actor.id });

  const accepted = d.accepted_offer_id ? await dbGet(db, dispositionOffers, d.accepted_offer_id) : undefined;
  if (to === "withdrawn") {
    await patch(db, dispositions, d, { withdrawn_reason: body.reason ?? null });
    if (a.status === "held_for_sale") await patch(db, assets, a, { status: "active" } as never);
    if (accepted && accepted.outcome === null) await patch(db, dispositionOffers, accepted, { outcome: "fell_through" });
  } else if (["marketing", "offers", "contract", "buyer_dd", "closing"].includes(to) && a.status === "active") {
    if (PROGRESSION.indexOf(to) >= PROGRESSION.indexOf("marketing")) await patch(db, assets, a, { status: "held_for_sale" } as never);
  }
  if (["contract", "buyer_dd", "closing"].includes(old) && ["candidate", "pricing", "marketing", "offers"].includes(to) && accepted) {
    await patch(db, dispositionOffers, accepted, { outcome: "fell_through", status: "withdrawn" });
    await patch(db, dispositions, d, { accepted_offer_id: null });
  }
  if (to === "closed") await closeDisposition(db, d, a, accepted, actor);

  await recordEvent(db, d, old, to, actor, body.reason ?? null, unmet.length > 0, unmet);
  await audit.record(db, {
    actor, action: "disposition.stage_changed", entity_type: ENTITY, entity_id: d.id,
    changes: { stage: { from: old, to }, override: unmet.length > 0 }, summary: body.reason ?? null,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "disposition.stage_changed", {
    disposition_id: d.id, asset_id: d.asset_id, property_id: d.property_id, from_stage: old, to_stage: to, actor,
  });
  await db.commit();
  return d;
}

async function closeDisposition(db: Db, d: Disposition, a: Asset, accepted: DispositionOffer | undefined, actor: CurrentUser): Promise<void> {
  await patch(db, assets, a, { status: "disposed", disposed_on: d.closed_on || todayStr() } as never);
  const p = await dbGet(db, properties, d.property_id);
  if (p) {
    const values = { status: "sold", last_sale_price: d.sale_price, last_sale_date: d.closed_on };
    const changes = await provenance.applyMaterial(db, p, {
      entity_type: "property", data: values, material_fields: new Set(["last_sale_price", "last_sale_date"]),
      prov: provenance.provenanceIn.parse({
        source: "Disposition closing", observed_on: d.closed_on, confidence: 1.0, verified: true,
      }),
      actor_id: actor.id,
    });
    if (Object.keys(changes).length) {
      const set = Object.fromEntries(Object.keys(changes).map((k) => [k, (p as Record<string, any>)[k]]));
      await patch(db, properties, p, { ...set, updated_by_id: actor.id } as never);
      await audit.record(db, {
        actor, action: "property.updated", entity_type: "property", entity_id: p.id, changes, summary: "Sold — disposition closed",
      });
      await events.emit(db, "property.updated", { property_id: p.id, changed: new Set(Object.keys(changes)), actor });
    }
  }
  if (accepted) await patch(db, dispositionOffers, accepted, { outcome: "closed" });
  const pendingRetrades = await db
    .select()
    .from(retrades)
    .where(and(eq(retrades.disposition_id, d.id), eq(retrades.outcome, "pending")));
  for (const r of pendingRetrades) await patch(db, retrades, r, { outcome: "closed" });
  const ex = await getExchange(db, d);
  if (ex && ex.exchange_type === "forward") {
    await patch(db, exchanges1031, ex, {
      start_on: ex.start_on || d.closed_on, relinquished_sale_price: ex.relinquished_sale_price || d.sale_price,
      status: ex.status === "planned" ? "open" : ex.status,
    });
    await scheduleExchangeDates(db, d, ex, actor);
  }
  await events.emit(db, "disposition.closed", {
    disposition_id: d.id, asset_id: d.asset_id, property_id: d.property_id, actor,
  });
}

// --------------------------------------------------------------------------- offers / retrades

export async function addOffer(db: Db, d: Disposition, data: OfferIn, actor: CurrentUser): Promise<DispositionOffer> {
  const o = await insert(db, dispositionOffers, {
    disposition_id: d.id, ...data, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "disposition.offer_received", entity_type: ENTITY, entity_id: d.id,
    summary: `${o.buyer_name} ${fmt0(o.price)}`, changes: data, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function updateOffer(db: Db, o: DispositionOffer, data: OfferIn, actor: CurrentUser): Promise<DispositionOffer> {
  const values: Record<string, any> = { ...data };
  const changes = audit.diff(o, values);
  await patch(db, dispositionOffers, o, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "disposition.offer_updated", entity_type: ENTITY, entity_id: o.disposition_id, summary: o.buyer_name,
    changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function acceptOffer(db: Db, d: Disposition, o: DispositionOffer, actor: CurrentUser): Promise<Disposition> {
  if (TERMINAL.includes(d.stage)) throw new HttpError(409, "Disposition is closed or withdrawn");
  if (d.accepted_offer_id && d.accepted_offer_id !== o.id) {
    const prev = await dbGet(db, dispositionOffers, d.accepted_offer_id);
    if (prev && prev.status === "accepted") await patch(db, dispositionOffers, prev, { status: "backup", outcome: null });
  }
  await patch(db, dispositionOffers, o, { status: "accepted", updated_by_id: actor.id });
  await patch(db, dispositions, d, {
    accepted_offer_id: o.id, buyer_name: o.buyer_name, buyer_organization_id: o.buyer_organization_id,
    contract_price: d.contract_price || o.price, updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "disposition.offer_accepted", entity_type: ENTITY, entity_id: d.id,
    summary: `${o.buyer_name} ${fmt0(o.price)}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return d;
}

export async function addRetrade(db: Db, d: Disposition, data: RetradeIn, actor: CurrentUser): Promise<Retrade> {
  const offerId = data.offer_id || d.accepted_offer_id;
  const offer = offerId ? await dbGet(db, dispositionOffers, offerId) : undefined;
  const buyer = data.buyer_name || (offer ? offer.buyer_name : null) || d.buyer_name;
  if (!buyer) throw new HttpError(422, "Buyer is required for a retrade");
  const r = await insert(db, retrades, {
    disposition_id: d.id, offer_id: offer ? offer.id : null,
    buyer_organization_id: data.buyer_organization_id || (offer ? offer.buyer_organization_id : d.buyer_organization_id),
    buyer_name: buyer, requested_on: data.requested_on, reason_category: data.reason_category, reason: data.reason,
    amount_requested: data.amount_requested, decision: "pending", outcome: "pending", notes: data.notes,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "disposition.retrade_requested", entity_type: ENTITY, entity_id: d.id,
    summary: `${buyer}: ${fmt0(data.amount_requested)} (${data.reason_category})`, changes: data, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

export async function decideRetrade(db: Db, r: Retrade, data: RetradeDecisionIn, actor: CurrentUser): Promise<Retrade> {
  const d = await get(db, r.disposition_id);
  const values = stripUndefined(data);
  const changes: Record<string, any> = audit.diff(r, values);
  if (!Object.keys(changes).length) return r;
  const wasApplied = ["accepted", "countered"].includes(r.decision) && Boolean(r.agreed_amount);
  const set: Record<string, any> = { ...values };
  const next = { ...r, ...values } as Retrade;
  if ("decision" in changes && next.decision !== "pending") {
    set.decided_on = todayStr();
    set.decided_by_id = actor.id;
    if (next.decision === "accepted" && (next.agreed_amount === null || next.agreed_amount === undefined)) {
      set.agreed_amount = next.amount_requested;
      next.agreed_amount = next.amount_requested;
    }
  }
  if (["accepted", "countered"].includes(next.decision) && next.agreed_amount && !wasApplied && d.contract_price) {
    const oldPrice = d.contract_price;
    const newPrice = r2(Number(d.contract_price) - Number(next.agreed_amount)) as number;
    await patch(db, dispositions, d, { contract_price: newPrice });
    changes.contract_price = { from: oldPrice, to: newPrice };
  }
  set.updated_by_id = actor.id;
  await patch(db, retrades, r, set as never);
  await audit.record(db, {
    actor, action: "disposition.retrade_decided", entity_type: ENTITY, entity_id: d.id,
    summary: `${r.buyer_name}: ${r.decision}`, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return r;
}

const RETRADE_OUT = [
  "id", "disposition_id", "offer_id", "buyer_organization_id", "buyer_name", "requested_on", "reason_category", "reason",
  "amount_requested", "decision", "agreed_amount", "decided_on", "outcome", "notes", "created_at",
] as const;

export async function retradeItems(db: Db, rows: Retrade[]): Promise<Record<string, any>[]> {
  const ids = [...new Set(rows.map((r) => r.disposition_id))];
  const names = ids.length
    ? new Map(
        (await db.select({ id: dispositions.id, name: dispositions.name }).from(dispositions).where(inArray(dispositions.id, ids))).map(
          (d) => [d.id, d.name],
        ),
      )
    : new Map<string, string>();
  return rows.map((r) => ({ ...pick(r, RETRADE_OUT), disposition_name: names.get(r.disposition_id) ?? null }));
}

/** Counterparty intelligence: every buyer's offers, acceptances, closes, fall-throughs and retrades. */
export async function buyerPerformance(db: Db, q?: string | null): Promise<Record<string, any>[]> {
  const offers = await db.select().from(dispositionOffers).where(isNull(dispositionOffers.deleted_at));
  const rts = await db.select().from(retrades).where(isNull(retrades.deleted_at));
  const stats = new Map<string, Record<string, any>>();

  const entry = (org_id: string | null, name: string | null) => {
    const k = org_id ? String(org_id) : normKey(name);
    let e = stats.get(k);
    if (!e) {
      e = {
        key: k, buyer_name: name, buyer_organization_id: org_id, offers: 0, accepted: 0, closed: 0, fell_through: 0,
        retrades: 0, retrade_requested: 0.0, retrade_agreed: 0.0, accepted_price: 0.0, avg_offer: 0.0, _sum: 0.0,
        last_activity: null, disposition_ids: new Set<string>(),
      };
      stats.set(k, e);
    }
    return e;
  };
  const latest = (a: string | null, b: string | null) => [a, b].filter((x): x is string => !!x).reduce((x, y) => (x > y ? x : y));

  for (const o of offers) {
    const e = entry(o.buyer_organization_id, o.buyer_name);
    e.offers += 1;
    e._sum += Number(o.price);
    if (o.status === "accepted" || o.outcome === "closed" || o.outcome === "fell_through") {
      e.accepted += 1;
      e.accepted_price += Number(o.price);
    }
    if (o.outcome === "closed") e.closed += 1;
    if (o.outcome === "fell_through") e.fell_through += 1;
    e.last_activity = latest(e.last_activity, o.received_on);
    e.disposition_ids.add(o.disposition_id);
  }
  for (const r of rts) {
    const e = entry(r.buyer_organization_id, r.buyer_name);
    e.retrades += 1;
    e.retrade_requested += Number(r.amount_requested || 0);
    e.retrade_agreed += ["accepted", "countered"].includes(r.decision) ? Number(r.agreed_amount || 0) : 0;
    e.last_activity = latest(e.last_activity, r.requested_on);
    e.disposition_ids.add(r.disposition_id);
  }
  const out: Record<string, any>[] = [];
  for (const e of stats.values()) {
    if (q && !(e.buyer_name || "").toLowerCase().includes(q.toLowerCase())) continue;
    e.avg_offer = e.offers ? r2(e._sum / e.offers) : null;
    e.close_rate = e.accepted ? pct(e.closed, e.accepted) : null;
    e.retrade_rate = e.accepted ? pct(e.retrades, e.accepted) : null;
    e.retrade_pct_of_price = e.accepted_price ? pct(e.retrade_agreed, e.accepted_price) : null;
    e.disposition_ids = [...e.disposition_ids].map(String);
    delete e._sum;
    out.push(e);
  }
  return out.sort((a, b) => b.offers - a.offers || ((a.buyer_name || "") < (b.buyer_name || "") ? -1 : (a.buyer_name || "") > (b.buyer_name || "") ? 1 : 0));
}

// --------------------------------------------------------------------------- tax / economics

export function taxEstimate(price: number, costs: number, taxBasis: number, accumulatedDepreciation: number, t: Record<string, any>) {
  const adjusted = taxBasis - accumulatedDepreciation;
  const realized = price - costs;
  const gain = realized - adjusted;
  const recapture = Math.min(Math.max(gain, 0), accumulatedDepreciation);
  const capGain = Math.max(gain - recapture, 0);
  const recTax = (recapture * Number(t.recapture_rate ?? 25)) / 100;
  const cgTax = (capGain * Number(t.cap_gains_rate ?? 20)) / 100;
  const stateTax = (Math.max(gain, 0) * Number(t.state_rate ?? 0)) / 100;
  const niit = (Math.max(gain, 0) * Number(t.niit_rate ?? 3.8)) / 100;
  return {
    amount_realized: rr(realized), tax_basis: rr(taxBasis), accumulated_depreciation: rr(accumulatedDepreciation),
    adjusted_basis: rr(adjusted), gain: rr(gain), depreciation_recapture: rr(recapture), capital_gain: rr(capGain),
    recapture_tax: rr(recTax), capital_gains_tax: rr(cgTax), state_tax: rr(stateTax), niit: rr(niit),
    total_tax: rr(recTax + cgTax + stateTax + niit), modeled_estimate: true,
  };
}

/** Asset KPIs, active loans (allocated) and reserves for the disposition's asset. */
async function economicsContext(db: Db, d: Disposition) {
  const svc = await assetsService();
  const a = await getAsset(db, d.asset_id);
  const props = await svc.loadProps(db, [a] as never);
  const k: any = at(await svc.computeKpis(db, [a] as never, props as never), a.id);
  const kLoans: any[] = k.loans ?? [];
  const loanRows = new Map<string, any>();
  const reserves = new Map<string, number>();
  if (kLoans.length) {
    for (const l of await db.select().from(loans).where(inArray(loans.id, kLoans.map((x) => x.id)))) loanRows.set(l.id, l);
  }
  if (loanRows.size) {
    const rows = await db
      .select()
      .from(loanReserves)
      .where(and(inArray(loanReserves.loan_id, [...loanRows.keys()]), isNull(loanReserves.deleted_at)));
    for (const r of rows) {
      const lid = r.loan_id as string;
      reserves.set(lid, (reserves.get(lid) ?? 0) + Number(r.balance || 0));
    }
  }
  return {
    asset: a, kpis: k,
    loans: kLoans.filter((x) => loanRows.has(x.id)).map((x) => [x, loanRows.get(x.id)] as [any, any]),
    reserves,
  };
}

export async function compare(db: Db, d: Disposition, inp: CompareIn, actor: CurrentUser): Promise<Record<string, any>> {
  const calc: any = await debtCalc();
  const market = (await (await debtService()).getSettings(db) as any).market;
  const ctx = await economicsContext(db, d);
  const { asset: a, kpis: k } = ctx;
  const today = todayStr();
  const noi: number = inp.noi !== null ? inp.noi : (k.noi_ttm || 0.0);
  const value: number = inp.value !== null ? inp.value : (k.value || (noi ? noi / (market.cap_rate / 100) : 0.0));
  const saleCostPct: number = inp.sale_cost_pct !== null ? inp.sale_cost_pct : market.sale_cost_pct;
  const exitCap: number = inp.exit_cap_rate || a.exit_cap_rate || market.cap_rate + 0.25;
  const tsy: number = inp.treasury_rate !== null ? inp.treasury_rate : market.treasury_rate;
  const n = inp.hold_years;
  const capexBasis = Number(k.capex_total || 0);
  const taxBasis: number = inp.tax_basis !== null ? inp.tax_basis : Number(a.basis || 0) + capexBasis;
  const annualDepr = (taxBasis * (1 - inp.land_pct / 100)) / inp.depreciation_years;
  const yearsHeld = a.acquired_on ? Math.max(0, daysBetween(a.acquired_on, today) / 365.25) : 0.0;
  const accDepr: number = inp.accumulated_depreciation !== null ? inp.accumulated_depreciation : annualDepr * yearsHeld;
  const rates = { cap_gains_rate: inp.cap_gains_rate, recapture_rate: inp.recapture_rate, state_rate: inp.state_rate, niit_rate: inp.niit_rate };
  const leaseTerm: number | null = inp.remaining_lease_term_years !== null ? inp.remaining_lease_term_years : k.wale ?? null;

  const ls: Array<[any, any]> = ctx.loans;
  const balance = sum(ls.map(([x]) => x.balance));
  const currentDs = sum(ls.map(([x]) => x.annual_debt_service));
  const prepayNow = sum(ls.map(([x, l]) => calc.prepaymentCost(l, today, tsy).cost * x.share));
  const lockouts = ls.filter(([, l]) => !calc.prepaymentCost(l, today, tsy).allowed).map(([, l]) => l.id);
  const maturities: string[] = ls.map(([, l]) => dateStr(l.maturity_on)).filter((m): m is string => !!m);
  const firstMaturity = maturities.length ? maturities.reduce((x, y) => (x < y ? x : y)) : null;

  // Sell now
  const costsNow = (value * saleCostPct) / 100;
  const preTaxNow = value - costsNow - balance - prepayNow;
  const taxNow = taxEstimate(value, costsNow, taxBasis, accDepr, rates);
  const afterTaxNow = preTaxNow - taxNow.total_tax;

  const exitBlock = (holdBalance: number, prepayExit: number) => {
    const exitNoi = noi * (1 + inp.noi_growth_pct / 100) ** (n + 1);
    const exitValue = exitNoi / (exitCap / 100);
    const exitCosts = (exitValue * saleCostPct) / 100;
    const t = taxEstimate(exitValue, exitCosts, taxBasis + inp.capex_planned, accDepr + annualDepr * n, rates);
    const pre = exitValue - exitCosts - holdBalance - prepayExit;
    return {
      exit_noi: r2(exitNoi), exit_value: r2(exitValue), exit_costs: r2(exitCosts), loan_balance_at_exit: r2(holdBalance),
      prepayment_at_exit: r2(prepayExit), pre_tax_proceeds: r2(pre), tax: t, after_tax_proceeds: r2(pre - t.total_tax),
    };
  };

  const scenarioFlows = (ds: number, startEquity: number, exitAfterTax: number): [any[], number[]] => {
    const rows: any[] = [];
    const flows: number[] = [-startEquity];
    for (let y = 1; y <= n; y++) {
      const yNoi = noi * (1 + inp.noi_growth_pct / 100) ** y;
      const capex = inp.capex_planned / n;
      const cf = yNoi - ds - capex;
      rows.push({ year: y, noi: r2(yNoi), debt_service: r2(ds), capex: r2(capex), cash_flow: r2(cf) });
      flows.push(cf + (y === n ? exitAfterTax : 0));
    }
    return [rows, flows];
  };

  const exitOn = addMonths(today, 12 * n);
  const holdBal = sum(ls.map(([x, l]) => calc.balanceAfter(l, 12 * n, today) * x.share));
  const holdPrepay = sum(
    ls
      .filter(([, l]) => !l.maturity_on || dateStr(l.maturity_on)! > exitOn)
      .map(([x, l]) => calc.prepaymentCost(l, exitOn, tsy).cost * x.share),
  );
  const holdExit = exitBlock(holdBal, holdPrepay);
  const [holdRows, holdFlows] = scenarioFlows(currentDs, afterTaxNow, holdExit.after_tax_proceeds as number);

  // Refinance now then hold
  const rRate: number = inp.refi_rate !== null ? inp.refi_rate : market.rate;
  const rAmort: number = inp.refi_amort_years !== null ? inp.refi_amort_years : market.amort_years;
  const sizing = calc.sizeLoan(
    noi, value, rRate, rAmort,
    inp.refi_ltv !== null ? inp.refi_ltv : market.ltv,
    inp.refi_dscr !== null ? inp.refi_dscr : market.dscr,
    inp.refi_debt_yield !== null ? inp.refi_debt_yield : market.debt_yield,
  );
  const newLoan: number = sizing.max_loan || 0.0;
  const refiCosts = (newLoan * (inp.refi_cost_pct !== null ? inp.refi_cost_pct : market.refi_cost_pct)) / 100;
  const cashOut = newLoan - balance - prepayNow - refiCosts;
  const newDs: number = sizing.annual_debt_service || 0.0;
  const newLoanTerms = {
    current_balance: newLoan, rate: rRate, amortization_months: rAmort ? Math.trunc(rAmort * 12) : null, io_months: 0,
    originated_on: today,
  };
  const refiExit = exitBlock(calc.balanceAfter(newLoanTerms, 12 * n, today), 0.0);
  const [refiRows, refiFlows] = scenarioFlows(newDs, afterTaxNow - cashOut, refiExit.after_tax_proceeds as number);

  const risks: string[] = [];
  if (leaseTerm !== null && leaseTerm < n) {
    risks.push(`Remaining lease term (${leaseTerm.toFixed(1)} years) is shorter than the ${n}-year hold; rollover risk not modeled.`);
  }
  if (firstMaturity && firstMaturity < exitOn) {
    risks.push(`Existing debt matures ${firstMaturity}, before the hold horizon; hold case assumes an extension or refinance on similar terms.`);
  }
  if (lockouts.length) {
    risks.push("Prepayment is currently locked out on at least one loan; a sale now would require assumption or defeasance.");
  }
  if (cashOut < 0) risks.push(`Refinance at market terms leaves a shortfall of ${fmt0(Math.abs(cashOut))} that equity must fund.`);

  const holdNpv = r2(calc.npv(inp.discount_rate, holdFlows) + afterTaxNow) as number;
  const result = {
    computed_at: new Date(),
    inputs: {
      ...inp, value: r2(value), noi: r2(noi), exit_cap_rate: exitCap, sale_cost_pct: saleCostPct,
      tax_basis: r2(taxBasis), accumulated_depreciation: r2(accDepr),
      accumulated_depreciation_estimated: inp.accumulated_depreciation === null, remaining_lease_term_years: r2(leaseTerm),
      debt_balance: r2(balance), debt_maturity: firstMaturity, prepayment_cost_now: r2(prepayNow), treasury_rate: tsy,
      refi_rate: rRate,
    },
    sell: {
      label: "Sell now", gross_price: r2(value), selling_costs: r2(costsNow), debt_payoff: r2(balance),
      prepayment_cost: r2(prepayNow), pre_tax_proceeds: r2(preTaxNow), tax: taxNow, after_tax_proceeds: r2(afterTaxNow),
      after_tax_if_1031: d.is_1031 ? r2(preTaxNow) : null,
    },
    hold: {
      label: `Hold ${n} years`, annual: holdRows, exit: holdExit, npv: holdNpv, irr_vs_sale: calc.irr(holdFlows),
      total_cash_flow: r2(sum(holdRows.map((r) => r.cash_flow))),
    },
    refinance: {
      label: `Refinance, hold ${n} years`, sizing, new_loan: r2(newLoan), refi_costs: r2(refiCosts), cash_out: r2(cashOut),
      new_debt_service: r2(newDs), annual: refiRows, exit: refiExit,
      npv: r2(calc.npv(inp.discount_rate, refiFlows) + afterTaxNow), irr_vs_sale: calc.irr(refiFlows),
      total_cash_flow: r2(sum(refiRows.map((r) => r.cash_flow))),
    },
    risks,
    tax_note: TAX_NOTE,
    method_note:
      "NPV is the present value at the discount rate of the scenario's after-tax equity cash flows, including any " +
      "cash-out today; IRR treats today's after-tax sale proceeds as the equity retained.",
  };
  const comparison = audit.toJsonable(result);
  await patch(db, dispositions, d, { comparison, comparison_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "disposition.compared", entity_type: ENTITY, entity_id: d.id,
    summary: `Sell ${fmt0(afterTaxNow)} after tax vs hold NPV ${fmt0(holdNpv)}`, changes: { inputs: result.inputs },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return d.comparison;
}

export async function proceeds(db: Db, d: Disposition): Promise<Record<string, any>> {
  const svc = await assetsService();
  const calc: any = await debtCalc();
  const market = (await (await debtService()).getSettings(db) as any).market;
  const ctx = await economicsContext(db, d);
  const { asset: a, kpis: k } = ctx;
  let price: number;
  let priceSource: string;
  if (d.sale_price) [price, priceSource] = [Number(d.sale_price), "Final sale price"];
  else if (d.contract_price) [price, priceSource] = [Number(d.contract_price), "Contract price (net of agreed retrades)"];
  else if (d.target_price) [price, priceSource] = [Number(d.target_price), "Target price"];
  else [price, priceSource] = [Number(k.value || 0), "Current value"];
  const closeOn = d.closed_on || d.target_closing_on || todayStr();
  const tsy = Number(market.treasury_rate);

  const costLines: Array<{ label: string; amount: number }> = (d.cost_lines ?? []).map((c: any) => ({
    label: c.label, amount: Number(c.amount || 0),
  }));
  if (d.commission_pct) {
    costLines.unshift({ label: `Brokerage commission (${Number(d.commission_pct)}%)`, amount: r2((price * d.commission_pct) / 100) as number });
  }
  const costs = sum(costLines.map((c) => c.amount));

  const debtLines: any[] = [];
  let prepayTotal = 0.0;
  let payoffTotal = 0.0;
  let reservesTotal = 0.0;
  for (const [x, l] of ctx.loans) {
    const p = calc.prepaymentCost(l, closeOn, tsy);
    const share = x.share;
    payoffTotal += x.balance;
    prepayTotal += p.cost * share;
    const rel = (ctx.reserves.get(l.id) ?? 0.0) * share;
    reservesTotal += rel;
    debtLines.push({
      loan_id: l.id, lender_name: x.lender_name, payoff: r2(x.balance), prepayment_cost: r2(p.cost * share),
      prepayment_type: p.type, prepayment_allowed: p.allowed, reserves_released: r2(rel), href: `/loans/${l.id}`,
    });
  }
  const distributable = price - costs - payoffTotal - prepayTotal + reservesTotal;

  const tIn: Record<string, any> = { cap_gains_rate: 20, recapture_rate: 25, state_rate: 0, niit_rate: 3.8, ...(d.tax_inputs ?? {}) };
  let basis: number | null = tIn.tax_basis ?? null;
  let basisSource = "Tax inputs";
  if (basis === null) {
    basis = Number(a.basis || 0) + Number(k.capex_total || 0);
    basisSource = "Asset basis + capitalised capex";
  }
  const depr = tIn.accumulated_depreciation ?? null;
  const tax = taxEstimate(price, costs, Number(basis), Number(depr || 0), tIn);
  const ex = await getExchange(db, d);
  const deferred = Boolean(d.is_1031 && ex && !["failed", "cancelled"].includes(ex.status));

  let partners: any[] | null = null;
  const stakes = await svc.partnerStakes(db, new Set([a.id]) as never);
  if (stakes !== null && stakes !== undefined) {
    const rows: any[] = at(stakes, a.id) ?? [];
    partners = rows.map((s) => ({
      partner_id: s.partner_id, name: s.name, ownership_pct: s.ownership_pct,
      amount: r2((distributable * s.ownership_pct) / 100), href: `/investors/${s.partner_id}`,
    }));
    const allocatedPct = sum(rows.map((s) => s.ownership_pct));
    if (allocatedPct < 100) {
      partners.push({
        partner_id: null, name: "Unallocated (no investor record)", ownership_pct: r2(100 - allocatedPct),
        amount: r2((distributable * (100 - allocatedPct)) / 100), href: null,
      });
    }
  }

  const recon: any[] = [
    { label: `Sale price · ${priceSource}`, amount: r2(price) },
    ...costLines.map((c) => ({ label: `Less ${c.label}`, amount: r2(-c.amount) })),
    ...debtLines.map((x) => ({ label: `Less loan payoff · ${x.lender_name}`, amount: r2(-x.payoff), href: x.href })),
    ...debtLines
      .filter((x) => x.prepayment_cost)
      .map((x) => ({ label: `Less prepayment cost · ${x.lender_name}`, amount: r2(-x.prepayment_cost), href: x.href })),
    ...debtLines
      .filter((x) => x.reserves_released)
      .map((x) => ({ label: `Plus lender reserves released · ${x.lender_name}`, amount: r2(x.reserves_released), href: x.href })),
  ];
  const reconTotal = Math.round(sum(recon.map((x) => x.amount)) * 100) / 100;
  const gainRecon = [
    { label: "Sale price", amount: r2(price) },
    { label: "Less selling costs", amount: r2(-costs) },
    { label: "Amount realized", amount: tax.amount_realized, subtotal: true },
    { label: `Less tax basis · ${basisSource}`, amount: r2(-Number(basis)) },
    { label: "Plus accumulated depreciation" + (depr === null ? " (not entered)" : ""), amount: r2(Number(depr || 0)) },
    { label: "Gain on sale", amount: tax.gain, subtotal: true },
  ];
  return {
    price: r2(price), price_source: priceSource, closing_on: closeOn, cost_lines: costLines, selling_costs: r2(costs),
    debt: debtLines, debt_payoff: r2(payoffTotal), prepayment_cost: r2(prepayTotal), reserves_released: r2(reservesTotal),
    distributable: r2(distributable), reconciliation: recon, reconciliation_total: reconTotal,
    reconciled: Math.abs(reconTotal - Math.round(distributable * 100) / 100) < 0.02,
    gain_reconciliation: gainRecon, tax, tax_deferred_1031: deferred,
    after_tax_distributable: r2(deferred ? distributable : distributable - (tax.total_tax || 0)),
    partners, partners_unavailable: stakes === null || stakes === undefined,
    partners_note: "Pro-rata by ownership percentage; the capital partner waterfall governs actual distributions.",
    tax_note: TAX_NOTE,
    drill: [{ label: "Asset", href: `/assets/${a.id}` }, ...debtLines.map((x) => ({ label: `Loan · ${x.lender_name}`, href: x.href }))],
  };
}

// --------------------------------------------------------------------------- 1031 exchange

export function exchangeDeadlines(ex: Exchange1031): [string | null, string | null] {
  if (!ex.start_on) return [null, null];
  const ident = addDays(ex.start_on, 45);
  let repl = addDays(ex.start_on, 180);
  if (ex.tax_return_due_on && ex.tax_return_due_on < repl) repl = ex.tax_return_due_on;
  return [ident, repl];
}

/** Exchange deadlines are BLOCKING critical dates (fallback: tasks + alerts). Does not commit. */
export async function scheduleExchangeDates(
  db: Db,
  d: Disposition,
  ex: Exchange1031,
  actor: { id?: string | null } | null | undefined,
): Promise<void> {
  const { createTask, raiseAlert } = await tasksService();
  const [ident, repl] = exchangeDeadlines(ex);
  await patch(db, exchanges1031, ex, { identification_deadline: ident, replacement_deadline: repl });
  if (!ident) return;
  const items: Array<[string, string, string, "id_critical_date_id" | "replacement_critical_date_id"]> = [
    ["1031_identification", ident, "1031 identification deadline (45 days)", "id_critical_date_id"],
    ["1031_replacement", repl as string, "1031 replacement property deadline (180 days)", "replacement_critical_date_id"],
  ];
  for (const [key, due, lbl, attr] of items) {
    const full = `${lbl} · ${d.name}`;
    let upsert: ((db: Db, o: Record<string, any>) => Promise<{ id: string }>) | null = null;
    try {
      upsert = (await import("../contracts/service")).upsertCriticalDate as any;
    } catch {
      upsert = null;
    }
    if (upsert) {
      const cd = await upsert(db, {
        related_type: "exchange_1031", related_id: ex.id, date_type: key, label: full, due_on: due,
        property_id: d.property_id, owner_id: d.owner_id, lead_days: 15, is_blocking: true, source: "rule",
        status: "confirmed", key, actor, related_label: d.name,
      });
      await patch(db, exchanges1031, ex, { [attr]: cd.id } as never);
    } else {
      await raiseAlert(db, {
        title: full, reason: `Statutory exchange deadline ${due} cannot be extended.`, severity: "critical",
        owner_id: d.owner_id, related_type: "disposition", related_id: d.id, related_label: d.name,
        rule_key: "dispositions.1031_deadline", due_at: dueDt(due), idempotency_key: `1031:${ex.id}:${key}:${due}`,
      });
    }
    await createTask(db, {
      title: full, assignee_id: d.owner_id, due_at: dueDt(addDays(due, -7)), task_type: "due_diligence", priority: "urgent",
      description: `Hard deadline ${due}.`, related_type: "disposition", related_id: d.id, related_label: d.name,
      source: "dispositions.1031", idempotency_key: `1031:${ex.id}:${key}:${due}`, actor_id: actor?.id ?? null,
    });
  }
}

export async function getExchange(db: Db, d: Disposition): Promise<Exchange1031 | null> {
  const [ex] = await db
    .select()
    .from(exchanges1031)
    .where(and(eq(exchanges1031.disposition_id, d.id), isNull(exchanges1031.deleted_at)))
    .limit(1);
  return ex ?? null;
}

export async function upsertExchange(db: Db, d: Disposition, data: ExchangeIn, actor: CurrentUser): Promise<Exchange1031> {
  let ex = await getExchange(db, d);
  const values = stripUndefined(data);
  let changes: Record<string, any>;
  let action: string;
  if (ex === null) {
    ex = await insert(db, exchanges1031, { disposition_id: d.id, status: "planned", created_by_id: actor.id } as never);
    changes = values;
    action = "disposition.exchange_created";
  } else {
    changes = audit.diff(ex, values);
    action = "disposition.exchange_updated";
  }
  const set: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "status" && (v === null || v === undefined)) continue;
    set[k] = v;
  }
  await patch(db, exchanges1031, ex, set as never);
  if (ex.start_on === null && d.closed_on && ex.exchange_type === "forward") {
    await patch(db, exchanges1031, ex, { start_on: d.closed_on });
  }
  if (ex.start_on && ex.status === "planned") await patch(db, exchanges1031, ex, { status: "open" });
  await patch(db, exchanges1031, ex, { updated_by_id: actor.id });
  if (!d.is_1031) await patch(db, dispositions, d, { is_1031: true });
  await scheduleExchangeDates(db, d, ex, actor);
  await audit.record(db, {
    actor, action, entity_type: ENTITY, entity_id: d.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return ex;
}

const identifiedOf = (cands: ExchangeCandidate[]) =>
  cands.filter((c) => ["identified", "under_contract", "acquired"].includes(c.status) && !c.deleted_at);

export function exchangeAnalysis(ex: Exchange1031, cands: ExchangeCandidate[]): Record<string, any> {
  const today = todayStr();
  const sale = Number(ex.relinquished_sale_price || 0);
  const costs = Number(ex.relinquished_costs || 0);
  const debtPaid = Number(ex.relinquished_debt_paid || 0);
  const basis = Number(ex.relinquished_adjusted_basis || 0);
  const cashReceived = Number(ex.cash_received || 0);
  const added = Number(ex.additional_cash_invested || 0);
  const acquired = cands.filter((c) => c.status === "acquired");
  const identified = identifiedOf(cands);
  const planned = acquired.length ? acquired : identified.filter((c) => !c.is_backup);
  const replPrice = sum(planned.map((c) => Number((c.status === "acquired" ? c.acquired_price : c.expected_price) || 0)));
  const replDebt = sum(planned.map((c) => Number((c.status === "acquired" ? c.acquired_debt : c.expected_debt) || 0)));

  const netEquity = sale - costs - debtPaid;
  const equityReinvested = replPrice - replDebt;
  let cashBoot = planned.length ? Math.max(0, netEquity - equityReinvested + added) : Math.max(0, netEquity);
  cashBoot = Math.max(cashBoot, cashReceived);
  const mortgageBoot = Math.max(0, debtPaid - replDebt - added);
  const totalBoot = cashBoot + mortgageBoot;
  const realized = sale - costs - basis;
  const recognized = Math.max(0, Math.min(realized, totalBoot));
  const deferred = Math.max(0, realized - recognized);
  const replacementBasis = replPrice ? replPrice - deferred : null;

  const warnings: string[] = [];
  if (ex.identification_rule === "three_property" && identified.length > 3) {
    warnings.push(`${identified.length} properties identified; the three-property rule allows at most 3 (backups count toward the limit).`);
  }
  if (ex.identification_rule === "two_hundred_percent") {
    const fmv = sum(identified.map((c) => Number(c.expected_price || 0)));
    if (sale && fmv > 2 * sale) warnings.push(`Identified value ${fmt0(fmv)} exceeds 200% of the relinquished price (${fmt0(2 * sale)}).`);
  }
  if (ex.identification_rule === "ninety_five_percent") {
    const fmv = sum(identified.map((c) => Number(c.expected_price || 0)));
    const got = sum(acquired.map((c) => Number(c.acquired_price || 0)));
    if (fmv && got < 0.95 * fmv) warnings.push("The 95% rule requires acquiring at least 95% of the identified value.");
  }
  if (sale && replPrice && replPrice < sale - costs) warnings.push("Replacement value is below the relinquished net sale price; boot is likely.");
  if (replDebt < debtPaid && added < debtPaid - replDebt) {
    warnings.push("Replacement debt is lower than debt paid off and not offset by added cash; mortgage boot results.");
  }

  const countdown = (dd: string | null) => (dd ? daysBetween(today, dd) : null);
  return {
    identification_deadline: ex.identification_deadline, replacement_deadline: ex.replacement_deadline,
    days_to_identification: countdown(ex.identification_deadline), days_to_replacement: countdown(ex.replacement_deadline),
    identification_open: Boolean(ex.identification_deadline && today <= ex.identification_deadline),
    identified_count: identified.length, backup_count: identified.filter((c) => c.is_backup).length,
    replacement_price: r2(replPrice), replacement_debt: r2(replDebt), net_equity_relinquished: r2(netEquity),
    equity_reinvested: r2(equityReinvested), cash_boot: r2(cashBoot), mortgage_boot: r2(mortgageBoot),
    total_boot: r2(totalBoot), realized_gain: r2(realized), recognized_gain: r2(recognized), deferred_gain: r2(deferred),
    replacement_basis: r2(replacementBasis), warnings,
    basis_note: "Replacement basis = replacement cost less deferred gain (carryover basis).",
    tax_note: TAX_NOTE,
  };
}

const EXCHANGE_COLS = [
  "id", "disposition_id", "exchange_type", "status", "qi_organization_id", "qi_name", "eat_organization_id",
  "parked_property_id", "start_on", "identification_deadline", "replacement_deadline", "tax_return_due_on",
  "identification_rule", "relinquished_sale_price", "relinquished_costs", "relinquished_debt_paid",
  "relinquished_adjusted_basis", "cash_received", "additional_cash_invested", "improvement_budget", "improvement_notes",
  "id_critical_date_id", "replacement_critical_date_id", "notes", "updated_at",
] as const;
const CANDIDATE_COLS = [
  "id", "property_id", "description", "is_backup", "rank", "status", "identified_on", "expected_price", "expected_debt",
  "acquired_on", "acquired_price", "acquired_debt", "notes",
] as const;

export async function exchangeOut(db: Db, ex: Exchange1031): Promise<Record<string, any>> {
  const c = exchangeCandidates;
  const cands = await db
    .select()
    .from(c)
    .where(and(eq(c.exchange_id, ex.id), isNull(c.deleted_at)))
    .orderBy(asc(c.is_backup), asc(c.rank));
  const props = await propsOf(db, [...cands.map((x) => x.property_id), ex.parked_property_id]);
  const pp = ex.parked_property_id ? props.get(ex.parked_property_id) : undefined;
  return {
    ...pick(ex, EXCHANGE_COLS),
    parked_property_label: label(pp),
    candidates: cands.map((x) => ({
      ...pick(x, CANDIDATE_COLS), property_label: x.property_id && props.has(x.property_id) ? label(props.get(x.property_id)) : null,
    })),
    analysis: exchangeAnalysis(ex, cands),
  };
}

export async function saveCandidate(
  db: Db,
  ex: Exchange1031,
  data: CandidateIn,
  actor: CurrentUser,
  cand: ExchangeCandidate | null = null,
): Promise<ExchangeCandidate> {
  const values: Record<string, any> = { ...data };
  if (!values.property_id && !values.description) {
    throw new HttpError(422, "Link a property or describe the replacement property");
  }
  const becomingIdentified =
    ["identified", "under_contract", "acquired"].includes(values.status) && (cand === null || cand.status === "candidate");
  if (becomingIdentified && values.status === "identified") {
    if (ex.identification_deadline && todayStr() > ex.identification_deadline) {
      throw new HttpError(409, "The 45-day identification period has ended; no new identifications are allowed");
    }
    if (ex.identification_rule === "three_property") {
      const all = await db
        .select()
        .from(exchangeCandidates)
        .where(and(eq(exchangeCandidates.exchange_id, ex.id), isNull(exchangeCandidates.deleted_at)));
      const others = all.filter((c) => cand === null || c.id !== cand.id);
      if (identifiedOf(others).length >= 3) {
        throw new HttpError(409, "The three-property rule allows at most three identified properties, including backups");
      }
    }
  }
  let changes: Record<string, any>;
  const set: Record<string, any> = { ...values, updated_by_id: actor.id };
  if (cand === null) {
    changes = values;
    if (becomingIdentified) set.identified_on = todayStr();
    cand = await insert(db, exchangeCandidates, { exchange_id: ex.id, created_by_id: actor.id, ...set } as never);
  } else {
    changes = audit.diff(cand, values);
    if (becomingIdentified && !cand.identified_on) set.identified_on = todayStr();
    await patch(db, exchangeCandidates, cand, set as never);
  }
  if (cand.status === "acquired" && ["open", "identified"].includes(ex.status)) {
    await patch(db, exchanges1031, ex, { status: "identified" });
  } else if (cand.status === "identified" && ex.status === "open") {
    await patch(db, exchanges1031, ex, { status: "identified" });
  }
  await audit.record(db, {
    actor, action: "disposition.exchange_candidate_saved", entity_type: ENTITY, entity_id: ex.disposition_id,
    summary: cand.description || String(cand.property_id ?? "None"), changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return cand;
}

// --------------------------------------------------------------------------- candidate queue

export async function queue(db: Db): Promise<Record<string, any>> {
  const svc = await assetsService();
  const rows = await db
    .select()
    .from(dispositions)
    .where(and(isNull(dispositions.deleted_at), eq(dispositions.stage, "candidate")))
    .orderBy(asc(dispositions.created_at));
  const candidates = await toItems(db, rows);
  const busy = new Set(
    (
      await db
        .select({ id: dispositions.asset_id })
        .from(dispositions)
        .where(and(isNull(dispositions.deleted_at), notInArray(dispositions.stage, TERMINAL)))
    ).map((r) => r.id),
  );
  const pool = (
    await db
      .select()
      .from(assets)
      .where(and(isNull(assets.deleted_at), inArray(assets.status, ["active", "held_for_sale"])))
  ).filter((a) => !busy.has(a.id));
  const props = await svc.loadProps(db, pool as never);
  const loansByAsset = await svc.activeLoans(db, pool as never);
  const watch = await svc.openWatchCounts(db, new Set(pool.map((a) => a.id)) as never);
  const today = todayStr();
  const suggestions: Record<string, any>[] = [];
  for (const a of pool) {
    const reasons: string[] = [];
    if (a.status === "held_for_sale") reasons.push("Marked held for sale");
    if (a.acquired_on && a.target_hold_years) {
      const target = addMonths(a.acquired_on, Math.round(a.target_hold_years * 12));
      if (target <= addMonths(today, 6)) reasons.push(`Target hold period reached ${target}`);
    }
    if (a.target_exit_on && a.target_exit_on <= addMonths(today, 6)) reasons.push(`Target exit ${a.target_exit_on}`);
    const mats = ((at(loansByAsset, a.id) ?? []) as any[])
      .map((l) => dateStr(l.maturity_on))
      .filter((m): m is string => !!m && m <= addMonths(today, 12));
    if (mats.length) reasons.push(`Debt matures ${mats.reduce((x, y) => (x < y ? x : y))}`);
    const w = at(watch, a.id);
    if (w) reasons.push(`${w} open watchlist item(s)`);
    if (reasons.length) {
      const p = at(props, a.property_id) as Property | undefined;
      suggestions.push({
        asset_id: a.id, property_id: a.property_id, property_label: p ? p.name || p.address_line : "—",
        city: p ? p.city : null, state: p ? p.state : null, reasons, href: `/assets/${a.id}`,
      });
    }
  }
  return { candidates, suggestions };
}

// --------------------------------------------------------------------------- handlers support

export async function reassignOwner(db: Db, user_id: string, reassign_to_id: string): Promise<void> {
  await db
    .update(dispositions)
    .set({ owner_id: reassign_to_id })
    .where(and(eq(dispositions.owner_id, user_id), isNull(dispositions.deleted_at), notInArray(dispositions.stage, TERMINAL)));
}
