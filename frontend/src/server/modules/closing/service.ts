/**
 * Closing & post-close handoff (spec 17).
 *
 * A closing cannot complete until every blocking checklist item is satisfied and the current wire instructions
 * passed an independent callback (phone number sourced separately from the instructions). Completion writes an
 * immutable transaction snapshot, converts the opportunity into an owned Asset (retryable if the assets module is
 * unavailable), carries acquisition knowledge into an operations handoff package, turns open DD items into asset
 * tasks and schedules the 90-day post-close audit whose variances feed back to acquisitions.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get as dbGet, insert, insertMany, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import {
  CHECKLIST_TEMPLATE,
  HANDOFF_SECTIONS,
  SATISFIED_STATUSES,
  closingChecklistItems,
  closingSnapshots,
  closings,
  handoffPackages,
  wireVerifications,
  type Closing,
  type ClosingChecklistItem,
  type HandoffPackage,
  type WireVerification,
} from "./schema";
import type {
  AuditCompleteIn,
  AuditMetric,
  Blocker,
  CallbackIn,
  ChecklistItemIn,
  ChecklistItemUpdate,
  ClosingCreate,
  ClosingUpdate,
  CompleteIn,
  HandoffUpdate,
  PostCloseAuditOut,
  SourcesUsesIn,
  WireIn,
} from "./schemas";

export const ENTITY = "closing";
const CLOSED_DD_STATUSES = [
  "done", "completed", "complete", "closed", "resolved", "waived", "cleared", "cancelled", "not_applicable", "n_a",
];
const DEBT_KINDS = ["senior_debt", "mezzanine", "seller_financing"];

// Sibling services are loaded lazily (the Python imported them inside functions to avoid import cycles).
const tasksService = () => import("../tasks/service");
const pipelineService = () => import("../pipeline/service");

const r2 = (v: number): number => Math.round(v * 100) / 100;
const fmt0 = (v: number): string => Math.round(v).toLocaleString("en-US");
const today = (): string => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const at1700 = (d: string): Date => new Date(`${d}T17:00:00Z`);
const dateStr = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};
const actorId = (actor: { id?: string | null } | null | undefined): string | null => actor?.id ?? null;
const stripUndefined = (o: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const pick = (row: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

// ----------------------------------------------------------------------------- lookups

export async function get(db: Db, closing_id: string): Promise<Closing> {
  const c = await dbGet(db, closings, closing_id);
  if (!c || c.deleted_at) throw new HttpError(404, "Closing not found");
  return c;
}

export async function getItem(db: Db, item_id: string): Promise<ClosingChecklistItem> {
  const i = await dbGet(db, closingChecklistItems, item_id);
  if (!i || i.deleted_at) throw new HttpError(404, "Checklist item not found");
  return i;
}

export async function getWire(db: Db, wire_id: string): Promise<WireVerification> {
  const w = await dbGet(db, wireVerifications, wire_id);
  if (!w || w.deleted_at) throw new HttpError(404, "Wire instructions not found");
  return w;
}

async function opportunity(db: Db, opportunity_id: string) {
  const opp = await dbGet(db, opportunities, opportunity_id);
  if (!opp || opp.deleted_at) throw new HttpError(404, "Opportunity not found");
  return opp;
}

async function acceptedOffer(db: Db, opportunity_id: string): Promise<Record<string, any> | null> {
  let offers: any;
  try {
    offers = (await import("../offers/schema")).offers;
  } catch {
    return null;
  }
  const [row] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.opportunity_id, opportunity_id), eq(offers.status, "accepted"), isNull(offers.deleted_at)))
    .orderBy(sql`${offers.responded_at} desc nulls last`)
    .limit(1);
  return (row as Record<string, any>) ?? null;
}

/** Column names of an optional table owned by another module, or null when the table does not exist. */
async function tableColumns(db: Db, name: string): Promise<Set<string> | null> {
  const rows = await raw<{ column_name: string }>(
    db,
    sql`select column_name from information_schema.columns where table_schema = current_schema() and table_name = ${name}`,
  );
  return rows.length ? new Set(rows.map((r) => r.column_name)) : null;
}

/** Approved underwriting (shared `uw_models` contract), read without depending on the module's classes. */
async function uwModelRow(db: Db, model_id: string | null | undefined): Promise<Record<string, any> | null> {
  if (!model_id || !(await tableColumns(db, "uw_models"))) return null;
  const rows = await raw(db, sql`select * from uw_models where id = ${model_id} limit 1`);
  return rows[0] ?? null;
}

function requireOpen(c: Closing): void {
  if (c.status !== "open") {
    throw new HttpError(409, `Closing is ${c.status}; the final transaction record cannot be changed`);
  }
}

// ----------------------------------------------------------------------------- creation

function templateRow(c: Closing, t: (typeof CHECKLIST_TEMPLATE)[number], n: number, by: string | null) {
  return {
    closing_id: c.id, template_key: t.key, category: t.category, title: t.title, is_blocking: t.blocking,
    status: "open", owner_id: c.coordinator_id, due_on: t.blocking ? c.scheduled_closing_on : null, sort_order: n,
    created_by_id: by, updated_by_id: by,
  };
}

/** Idempotent per opportunity. Seeds the checklist from the template. Does not commit. */
export async function ensureClosing(
  db: Db,
  opportunity_id: string,
  actor: CurrentUser | null | undefined,
  opts: { scheduled_closing_on?: string | null; coordinator_id?: string | null; manager_id?: string | null } = {},
): Promise<[Closing, boolean]> {
  const [existing] = await db
    .select()
    .from(closings)
    .where(and(eq(closings.opportunity_id, opportunity_id), isNull(closings.deleted_at)))
    .limit(1);
  if (existing) return [existing, false];
  const opp = await opportunity(db, opportunity_id);
  const offer = await acceptedOffer(db, opportunity_id);
  const price: number | null = offer ? Number(offer.price) : (opp.closed_price || opp.offer_price || null);
  const by = actorId(actor);
  const c = await insert(db, closings, {
    opportunity_id: opp.id, property_id: opp.property_id, offer_id: offer ? offer.id : null,
    uw_model_id: offer ? offer.uw_model_id : null, status: "open",
    coordinator_id: opts.coordinator_id || opp.owner_id, manager_id: opts.manager_id ?? null,
    scheduled_closing_on: opts.scheduled_closing_on || opp.closing_date, purchase_price: price,
    sources: [],
    uses: price ? [{ label: "Purchase price", kind: "purchase_price", amount: Number(price), capitalized: true }] : [],
    total_sources: 0.0, total_uses: price ? Number(price) : null, capital_structure: {},
    created_by_id: by, updated_by_id: by,
  } as never);
  await insertMany(db, closingChecklistItems, CHECKLIST_TEMPLATE.map((t, n) => templateRow(c, t, n, by)) as never);
  await audit.record(db, {
    actor, action: "closing.created", entity_type: ENTITY, entity_id: c.id, summary: opp.title,
    changes: { opportunity_id: opp.id, offer_id: offer ? offer.id : null }, ip_address: actor?.ip_address ?? null,
  });
  return [c, true];
}

export async function create(db: Db, data: ClosingCreate, actor: CurrentUser): Promise<Closing> {
  const opp = await opportunity(db, data.opportunity_id);
  if (opp.stage === "dead" || opp.stage === "nurture") throw new HttpError(409, `Opportunity is ${opp.stage}`);
  const [c, created] = await ensureClosing(db, opp.id, actor, {
    scheduled_closing_on: data.scheduled_closing_on, coordinator_id: data.coordinator_id, manager_id: data.manager_id,
  });
  if (!created) throw new HttpError(409, { message: "This opportunity already has a closing", closing_id: c.id });
  await db.commit();
  return c;
}

export async function applyTemplate(db: Db, c: Closing, actor: CurrentUser): Promise<number> {
  requireOpen(c);
  const have = new Set(
    (
      await db
        .select({ k: closingChecklistItems.template_key })
        .from(closingChecklistItems)
        .where(and(eq(closingChecklistItems.closing_id, c.id), isNull(closingChecklistItems.deleted_at)))
    ).map((r) => r.k),
  );
  const rows = CHECKLIST_TEMPLATE.map((t, n) => [t, n] as const)
    .filter(([t]) => !have.has(t.key))
    .map(([t, n]) => templateRow(c, t, n, actor.id));
  await insertMany(db, closingChecklistItems, rows as never);
  if (rows.length) {
    await audit.record(db, {
      actor, action: "closing.template_applied", entity_type: ENTITY, entity_id: c.id,
      summary: `${rows.length} checklist items added`, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return rows.length;
}

export async function update(db: Db, c: Closing, data: ClosingUpdate, actor: CurrentUser): Promise<Closing> {
  const values = stripUndefined(data);
  if (c.status !== "open") {
    // After completion only the narrative carry-forward fields may be annotated; economics are frozen.
    if (Object.keys(values).some((k) => k !== "notes")) {
      throw new HttpError(409, "Completed closings are frozen; only notes can change");
    }
  }
  const changes = audit.diff(c, values);
  if (!Object.keys(changes).length) return c;
  await patch(db, closings, c, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "closing.updated", entity_type: ENTITY, entity_id: c.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

// ----------------------------------------------------------------------------- checklist

const ITEM_OUT = [
  "id", "closing_id", "template_key", "category", "title", "owner_id", "due_on", "status", "is_blocking",
  "document_id", "notes", "waived_reason", "completed_at", "completed_by_id", "sort_order", "updated_at",
] as const;

export async function items(db: Db, c: Closing): Promise<Record<string, any>[]> {
  const t = closingChecklistItems;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.closing_id, c.id), isNull(t.deleted_at)))
    .orderBy(asc(t.sort_order), asc(t.created_at));
  const names = await userNames(db, rows.map((i) => i.owner_id));
  const now = today();
  return rows.map((i) => ({
    ...pick(i, ITEM_OUT),
    owner_name: i.owner_id ? (names[i.owner_id] ?? null) : null,
    overdue: Boolean(i.due_on && i.due_on < now && !SATISFIED_STATUSES.includes(i.status)),
  }));
}

export async function addItem(db: Db, c: Closing, data: ChecklistItemIn, actor: CurrentUser): Promise<ClosingChecklistItem> {
  requireOpen(c);
  const t = closingChecklistItems;
  const [{ n }] = await db
    .select({ n: sql<number>`coalesce(max(${t.sort_order}), 0)::int` })
    .from(t)
    .where(eq(t.closing_id, c.id));
  const i = await insert(db, t, {
    ...data, closing_id: c.id, status: "open", sort_order: Number(n || 0) + 1,
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "closing.item_added", entity_type: ENTITY, entity_id: c.id, summary: i.title,
    changes: { item_id: i.id, is_blocking: i.is_blocking }, ip_address: actor.ip_address,
  });
  await db.commit();
  return i;
}

export async function updateItem(
  db: Db,
  i: ClosingChecklistItem,
  data: ChecklistItemUpdate,
  actor: CurrentUser,
): Promise<ClosingChecklistItem> {
  const c = await get(db, i.closing_id);
  requireOpen(c);
  const values = stripUndefined(data);
  if ("title" in values && !values.title) delete values.title;
  if ("category" in values && values.category === null) delete values.category;
  if ("is_blocking" in values && values.is_blocking === null) delete values.is_blocking;
  if ("status" in values && values.status === null) delete values.status;
  const isBlocking: boolean = "is_blocking" in values ? values.is_blocking : i.is_blocking;
  const newStatus: string = "status" in values ? values.status : i.status;

  // Blocking control is enforced here, not in the UI.
  if (i.is_blocking && values.is_blocking === false && !actor.can("closing", "approve")) {
    throw new HttpError(403, "Removing the blocking flag requires closing approval");
  }
  if ((newStatus === "waived" || newStatus === "not_applicable") && newStatus !== i.status) {
    const reason = values.waived_reason || i.waived_reason;
    if (!(reason && reason.trim())) {
      throw new HttpError(422, "A reason is required to waive or mark an item not applicable");
    }
    if (isBlocking && !actor.can("closing", "approve")) {
      throw new HttpError(403, "Waiving a blocking item requires closing approval");
    }
  }

  const changes = audit.diff(i, values);
  if (!Object.keys(changes).length) return i;
  const set: Record<string, any> = { ...values };
  if ("status" in changes) {
    if (SATISFIED_STATUSES.includes(newStatus)) {
      set.completed_at = new Date();
      set.completed_by_id = actor.id;
    } else {
      set.completed_at = null;
      set.completed_by_id = null;
    }
  }
  set.updated_by_id = actor.id;
  await patch(db, closingChecklistItems, i, set as never);
  await audit.record(db, {
    actor, action: "closing.item_updated", entity_type: ENTITY, entity_id: c.id, summary: i.title,
    changes: { ...changes, item_id: i.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return i;
}

export async function deleteItem(db: Db, i: ClosingChecklistItem, actor: CurrentUser): Promise<void> {
  const c = await get(db, i.closing_id);
  requireOpen(c);
  if (i.is_blocking && !actor.can("closing", "approve")) {
    throw new HttpError(403, "Removing a blocking item requires closing approval");
  }
  await patch(db, closingChecklistItems, i, { deleted_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "closing.item_removed", entity_type: ENTITY, entity_id: c.id, summary: i.title,
    changes: { item_id: i.id, is_blocking: i.is_blocking }, ip_address: actor.ip_address,
  });
  await db.commit();
}

// ----------------------------------------------------------------------------- wire verification

const normSource = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "").slice(-10);

export function mask(account: string): string {
  return "•".repeat(Math.max(0, Math.min(account.length - 4, 8))) + account.slice(-4);
}

const WIRE_OUT = [
  "id", "closing_id", "is_current", "beneficiary_name", "bank_name", "routing_number", "account_number", "amount",
  "instruction_source", "instruction_received_from", "instruction_contact_phone", "received_at", "callback_phone",
  "callback_phone_source", "callback_contact_name", "verified_by_id", "verified_by_name", "verified_at", "result",
  "result_notes", "created_at", "created_by_id",
] as const;

export function wireOut(w: WireVerification, actor: CurrentUser): Record<string, any> {
  const out = pick(w, WIRE_OUT);
  if (!actor.can("closing", "view_sensitive")) out.account_number = mask(w.account_number);
  return out;
}

export async function currentWire(db: Db, closing_id: string): Promise<WireVerification | null> {
  const t = wireVerifications;
  const [w] = await db
    .select()
    .from(t)
    .where(and(eq(t.closing_id, closing_id), eq(t.is_current, true), isNull(t.deleted_at)))
    .orderBy(desc(t.created_at))
    .limit(1);
  return w ?? null;
}

/** New instructions always supersede the previous set and must be verified again from scratch. */
export async function addWire(db: Db, c: Closing, data: WireIn, actor: CurrentUser): Promise<WireVerification> {
  requireOpen(c);
  const previous = await currentWire(db, c.id);
  if (previous) {
    const set: Record<string, any> = { is_current: false, updated_by_id: actor.id };
    if (previous.result === "pending" || previous.result === "passed") set.result = "superseded";
    await patch(db, wireVerifications, previous, set as never);
  }
  const { received_at, ...rest } = data;
  const w = await insert(db, wireVerifications, {
    ...rest, received_at: received_at ?? new Date(), closing_id: c.id, is_current: true, result: "pending",
    created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "closing.wire_instructions_recorded", entity_type: ENTITY, entity_id: c.id,
    summary: `${data.bank_name} ····${data.account_number.slice(-4)}`,
    changes: { wire_id: w.id, instruction_source: data.instruction_source, superseded: previous ? previous.id : null },
    ip_address: actor.ip_address,
  });
  if (previous) {
    const { raiseAlert } = await tasksService();
    await raiseAlert(db, {
      title: "Wire instructions changed", severity: "high", owner_id: c.coordinator_id,
      reason: "New wire instructions replaced a previous set. Changed instructions are a common fraud " +
        "pattern: verify by independent callback before funding.",
      related_type: "closing", related_id: c.id, related_label: "Closing wire", rule_key: "closing.wire_changed",
      idempotency_key: `closing-wire-changed:${w.id}`,
    });
  }
  await db.commit();
  return w;
}

export async function recordCallback(
  db: Db,
  w: WireVerification,
  data: CallbackIn,
  actor: CurrentUser,
): Promise<WireVerification> {
  const c = await get(db, w.closing_id);
  requireOpen(c);
  if (!w.is_current) throw new HttpError(409, "These instructions were superseded; verify the current set");
  if (w.result !== "pending") {
    throw new HttpError(409, `Callback already recorded (${w.result}). Record new instructions to verify again.`);
  }
  const srcA = normSource(data.callback_phone_source);
  const srcB = normSource(w.instruction_source);
  if (!srcA || srcA === srcB || srcB.includes(srcA) || srcA.includes(srcB)) {
    throw new HttpError(422, "The callback number must come from a source independent of the wire instructions");
  }
  if (w.instruction_contact_phone && digits(data.callback_phone) === digits(w.instruction_contact_phone)) {
    throw new HttpError(422, "The callback number must not be the phone number provided with the wire instructions");
  }
  await patch(db, wireVerifications, w, {
    callback_phone: data.callback_phone, callback_phone_source: data.callback_phone_source,
    callback_contact_name: data.callback_contact_name, result: data.result, result_notes: data.result_notes,
    verified_by_id: actor.id, verified_by_name: actor.full_name, verified_at: data.verified_at ?? new Date(),
    updated_by_id: actor.id,
  });
  await audit.record(db, {
    actor, action: `closing.wire_callback_${data.result}`, entity_type: ENTITY, entity_id: c.id,
    summary: `Callback to ${data.callback_contact_name} (${data.callback_phone_source})`,
    changes: { wire_id: w.id, result: data.result, callback_phone_source: data.callback_phone_source },
    ip_address: actor.ip_address,
  });
  if (data.result === "failed") {
    const { raiseAlert } = await tasksService();
    await raiseAlert(db, {
      title: "Wire verification failed — do not send funds", severity: "critical", owner_id: c.coordinator_id,
      reason: data.result_notes || "Independent callback did not confirm the wire instructions",
      related_type: "closing", related_id: c.id, related_label: "Closing wire", rule_key: "closing.wire_failed",
      idempotency_key: `closing-wire-failed:${w.id}`,
    });
  }
  await db.commit();
  return w;
}

// ----------------------------------------------------------------------------- sources & uses

export function capitalStructure(sources: Array<{ kind: string; amount: number }>, purchase_price: number | null | undefined) {
  const byKind: Record<string, number> = {};
  for (const s of sources) byKind[s.kind] = (byKind[s.kind] ?? 0) + Number(s.amount);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const debt = sum(Object.entries(byKind).filter(([k]) => DEBT_KINDS.includes(k)).map(([, v]) => v));
  const equity = byKind.equity ?? 0;
  const total = sum(Object.values(byKind));
  return {
    equity: r2(equity), debt: r2(debt), total: r2(total), by_kind: byKind,
    ltv_pct: purchase_price ? r2((debt / purchase_price) * 100) : null,
    equity_pct: total ? r2((equity / total) * 100) : null,
  };
}

export async function setSourcesUses(db: Db, c: Closing, data: SourcesUsesIn, actor: CurrentUser): Promise<Closing> {
  requireOpen(c);
  const sources = data.sources.map((s) => ({ label: s.label, kind: s.kind, amount: s.amount }));
  const uses = data.uses.map((u) => ({ label: u.label, kind: u.kind, amount: u.amount, capitalized: u.capitalized }));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pp = sum(uses.filter((u) => u.kind === "purchase_price").map((u) => u.amount));
  const values: Record<string, any> = {
    sources, uses,
    total_sources: r2(sum(sources.map((s) => s.amount))),
    total_uses: r2(sum(uses.map((u) => u.amount))),
    basis: r2(sum(uses.filter((u) => u.capitalized).map((u) => u.amount))),
    purchase_price: pp ? pp : c.purchase_price,
  };
  values.capital_structure = capitalStructure(sources, values.purchase_price);
  const changes = audit.diff(c, values);
  if (!Object.keys(changes).length) return c;
  await patch(db, closings, c, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "closing.sources_uses_updated", entity_type: ENTITY, entity_id: c.id,
    summary: `Sources $${fmt0(values.total_sources)} / uses $${fmt0(values.total_uses)}`, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

// ----------------------------------------------------------------------------- readiness

const blocker = (key: string, label: string, detail: string | null = null): Blocker => ({ key, label, detail });

export async function blockers(db: Db, c: Closing): Promise<Blocker[]> {
  const out: Blocker[] = [];
  if (c.status !== "open") return [blocker("status", `Closing is ${c.status}`)];
  const t = closingChecklistItems;
  const openBlocking = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.closing_id, c.id), isNull(t.deleted_at), eq(t.is_blocking, true), notInArray(t.status, SATISFIED_STATUSES),
      ),
    )
    .orderBy(asc(t.sort_order));
  for (const i of openBlocking) out.push(blocker(`item:${i.id}`, i.title, i.category.replaceAll("_", " ")));
  const w = await currentWire(db, c.id);
  if (w === null) out.push(blocker("wire", "Wire instructions not recorded"));
  else if (w.result !== "passed") out.push(blocker("wire", "Wire callback verification not passed", w.result));
  if (!c.purchase_price) out.push(blocker("price", "Purchase price not set"));
  if (!c.uses?.length || !c.sources?.length) {
    out.push(blocker("sources_uses", "Final sources and uses not entered"));
  } else if (Math.abs(Number(c.total_sources || 0) - Number(c.total_uses || 0)) > 0.5) {
    out.push(
      blocker(
        "sources_uses", "Sources and uses do not balance",
        `$${fmt0(Number(c.total_sources || 0))} vs $${fmt0(Number(c.total_uses || 0))}`,
      ),
    );
  }
  return out;
}

// ----------------------------------------------------------------------------- list / out

export interface ClosingFilters {
  q?: string;
  status?: string[];
  coordinator_id?: string[];
  manager_id?: string[];
  opportunity_id?: string;
  property_id?: string;
  asset_pending?: boolean;
  scheduled_from?: string;
  scheduled_to?: string;
}

/** WHERE clause over `closings JOIN opportunities LEFT JOIN properties`; see `fromJoined`. */
export function buildWhere(f: ClosingFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = closings;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [opportunities.title, properties.name, properties.address_line, properties.city]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    inFilter(t.coordinator_id, f.coordinator_id),
    inFilter(t.manager_id, f.manager_id),
    f.opportunity_id ? eq(t.opportunity_id, f.opportunity_id) : undefined,
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.asset_pending !== undefined ? eq(t.asset_pending, f.asset_pending) : undefined,
    f.scheduled_from ? sql`${t.scheduled_closing_on} >= ${f.scheduled_from}` : undefined,
    f.scheduled_to ? sql`${t.scheduled_closing_on} <= ${f.scheduled_to}` : undefined,
  );
}

/** Closing rows matching the filters, with the joins the search needs. */
export function selectClosings(db: Db, where: SQL | undefined) {
  return db
    .select({ c: closings })
    .from(closings)
    .innerJoin(opportunities, eq(opportunities.id, closings.opportunity_id))
    .leftJoin(properties, eq(properties.id, closings.property_id))
    .where(where);
}

export async function countClosings(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(closings)
    .innerJoin(opportunities, eq(opportunities.id, closings.opportunity_id))
    .leftJoin(properties, eq(properties.id, closings.property_id))
    .where(where);
  return r?.n ?? 0;
}

export async function statusFacets(db: Db, where: SQL | undefined): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: closings.status, n: sql<number>`count(*)::int` })
    .from(closings)
    .innerJoin(opportunities, eq(opportunities.id, closings.opportunity_id))
    .leftJoin(properties, eq(properties.id, closings.property_id))
    .where(where)
    .groupBy(closings.status);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const set = [...new Set(ids.filter((i): i is string => !!i))];
  if (!set.length) return {};
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, set));
  return Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
}

const LIST_ITEM = [
  "id", "opportunity_id", "property_id", "status", "scheduled_closing_on", "closed_on", "purchase_price", "basis",
  "coordinator_id", "manager_id", "asset_id", "asset_pending", "completed_at", "created_at", "updated_at",
] as const;

export async function toItems(db: Db, rows: Closing[]): Promise<Record<string, any>[]> {
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const oppIds = [...new Set(rows.map((c) => c.opportunity_id))];
  const propIds = [...new Set(rows.map((c) => c.property_id).filter((p): p is string => !!p))];
  const opps = new Map(
    (await db.select({ id: opportunities.id, title: opportunities.title }).from(opportunities).where(inArray(opportunities.id, oppIds)))
      .map((r) => [r.id, r.title] as [string, string]),
  );
  const props = propIds.length
    ? new Map(
        (
          await db
            .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
            .from(properties)
            .where(inArray(properties.id, propIds))
        ).map((r) => [r.id, r]),
      )
    : new Map<string, { name: string | null; address_line: string }>();
  const I = closingChecklistItems;
  const counts = new Map(
    (
      await db
        .select({
          closing_id: I.closing_id,
          total: sql<number>`count(*)::int`,
          done: sql<number>`coalesce(sum(case when ${inArray(I.status, SATISFIED_STATUSES)} then 1 else 0 end), 0)::int`,
          blocking_open: sql<number>`coalesce(sum(case when ${and(eq(I.is_blocking, true), notInArray(I.status, SATISFIED_STATUSES))} then 1 else 0 end), 0)::int`,
        })
        .from(I)
        .where(and(inArray(I.closing_id, ids), isNull(I.deleted_at)))
        .groupBy(I.closing_id)
    ).map((r) => [r.closing_id, r]),
  );
  const W = wireVerifications;
  const wires = new Map(
    (
      await db
        .select({ closing_id: W.closing_id, result: W.result })
        .from(W)
        .where(and(inArray(W.closing_id, ids), eq(W.is_current, true), isNull(W.deleted_at)))
    ).map((r) => [r.closing_id, r.result]),
  );
  const names = await userNames(db, [...rows.map((c) => c.coordinator_id), ...rows.map((c) => c.manager_id)]);
  return rows.map((c) => {
    const p = c.property_id ? props.get(c.property_id) : undefined;
    const k = counts.get(c.id);
    return {
      ...pick(c, LIST_ITEM),
      opportunity_title: opps.get(c.opportunity_id) ?? null,
      property_label: p ? p.name || p.address_line : null,
      coordinator_name: c.coordinator_id ? (names[c.coordinator_id] ?? null) : null,
      manager_name: c.manager_id ? (names[c.manager_id] ?? null) : null,
      blocking_open: k ? Number(k.blocking_open || 0) : 0,
      items_total: k ? Number(k.total) : 0,
      items_done: k ? Number(k.done || 0) : 0,
      wire_status: wires.get(c.id) ?? "missing",
    };
  });
}

const CLOSING_OUT_EXTRA = [
  "offer_id", "uw_model_id", "sources", "uses", "total_sources", "total_uses", "capital_structure", "hold_thesis",
  "business_plan", "target_hold_years", "notes", "completed_by_id", "asset_error", "audit_task_id", "audit_due_on",
  "audit_result", "audit_completed_at", "created_by_id",
] as const;

export async function toOut(db: Db, c: Closing): Promise<Record<string, any>> {
  const [item] = await toItems(db, [c]);
  const found = await blockers(db, c);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(closingSnapshots)
    .where(eq(closingSnapshots.closing_id, c.id));
  return {
    ...pick(c, CLOSING_OUT_EXTRA),
    ...item,
    blockers: found,
    can_complete: c.status === "open" && !found.length,
    has_snapshot: Boolean(n),
  };
}

// ----------------------------------------------------------------------------- completion

/** Every column of a row as JSON-safe values (optionally leaving some out). */
function rowJson(obj: Record<string, any>, exclude: string[] = []): Record<string, any> {
  return toJsonable(Object.fromEntries(Object.entries(obj).filter(([k]) => !exclude.includes(k))));
}

/** Python `json.dumps(sort_keys=True)` formatting so digests are stable and comparable. */
function stableStringify(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u0080-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(", ") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => `${stableStringify(k)}: ${stableStringify(v[k])}`).join(", ") + "}";
}

async function buildSnapshot(db: Db, c: Closing, opp: Record<string, any>, actor: CurrentUser): Promise<Record<string, any>> {
  const snap: Record<string, any> = { opportunity: rowJson(opp, ["closed_snapshot"]) };
  const p = c.property_id ? await dbGet(db, properties, c.property_id) : undefined;
  if (p) snap.property = rowJson(p, ["location"]);
  const uw = await uwModelRow(db, c.uw_model_id);
  snap.underwriting = uw
    ? toJsonable(
        Object.fromEntries(
          ["id", "name", "version", "template", "status", "approved_by_id", "approved_at", "assumptions", "outputs"].map(
            (k) => [k, uw[k] ?? null],
          ),
        ),
      )
    : null;
  snap.offer = null;
  if (c.offer_id) {
    try {
      const { offers, offerApprovals } = await import("../offers/schema");
      const o = await dbGet(db, offers as any, c.offer_id);
      if (o) {
        snap.offer = rowJson(o, ["loi_payload", "model_outputs"]);
        const approvals = await db
          .select()
          .from(offerApprovals as any)
          .where(eq((offerApprovals as any).offer_id, (o as any).id))
          .orderBy((offerApprovals as any).decided_at);
        snap.offer.approvals = approvals.map((a: any) => rowJson(a));
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }
  snap.closing = toJsonable(
    Object.fromEntries(
      [
        "id", "purchase_price", "sources", "uses", "total_sources", "total_uses", "basis", "capital_structure",
        "closed_on", "scheduled_closing_on", "hold_thesis", "business_plan", "target_hold_years", "manager_id",
        "coordinator_id", "uw_model_id", "offer_id",
      ].map((k) => [k, (c as Record<string, any>)[k]]),
    ),
  );
  const t = closingChecklistItems;
  snap.checklist = (await db.select().from(t).where(and(eq(t.closing_id, c.id), isNull(t.deleted_at)))).map((i) =>
    toJsonable(
      pick(i, [
        "id", "category", "title", "status", "is_blocking", "owner_id", "due_on", "document_id", "waived_reason",
        "completed_at", "completed_by_id",
      ]),
    ),
  );
  const w = await currentWire(db, c.id);
  snap.wire = w
    ? toJsonable({
        beneficiary_name: w.beneficiary_name, bank_name: w.bank_name, account_last4: w.account_number.slice(-4),
        amount: w.amount, instruction_source: w.instruction_source, callback_phone_source: w.callback_phone_source,
        callback_contact_name: w.callback_contact_name, verified_by_name: w.verified_by_name,
        verified_at: w.verified_at, result: w.result,
      })
    : null;
  snap.completed_by = { id: String(actor.id), name: actor.full_name };
  snap.completed_at = toJsonable(c.completed_at);
  return snap;
}

/** Opportunity → Asset. If the assets module is missing or fails, keep asset_pending for a later retry. */
async function createAsset(db: Db, c: Closing, actor: CurrentUser): Promise<void> {
  let createAssetFromClosing: (db: Db, o: Record<string, any>) => Promise<Record<string, any>>;
  let assetsTable: any;
  try {
    createAssetFromClosing = (await import("../assets/service")).createAssetFromClosing as never;
    assetsTable = (await import("../assets/schema")).assets;
  } catch {
    await patch(db, closings, c, { asset_pending: true, asset_error: "Assets module unavailable" });
    return;
  }
  let assetId: string;
  await db.execute(sql`SAVEPOINT closing_asset`);
  try {
    const asset = await createAssetFromClosing(db, {
      property_id: c.property_id, opportunity_id: c.opportunity_id, closing_id: c.id, acquired_on: c.closed_on,
      basis: c.basis, uw_model_id: c.uw_model_id, manager_id: c.manager_id, hold_thesis: c.hold_thesis, actor,
    });
    const set: Record<string, any> = {};
    for (const attr of ["business_plan", "target_hold_years"] as const) {
      const v = c[attr];
      if (v !== null && v !== undefined && attr in asset && (asset[attr] === null || asset[attr] === "")) set[attr] = v;
    }
    if (Object.keys(set).length) await patch(db, assetsTable, asset as never, set as never);
    assetId = asset.id;
    await db.execute(sql`RELEASE SAVEPOINT closing_asset`);
  } catch (e: any) {
    // The closing must still complete; conversion is retried.
    await db.execute(sql`ROLLBACK TO SAVEPOINT closing_asset`);
    await db.execute(sql`RELEASE SAVEPOINT closing_asset`);
    const fresh = await dbGet(db, closings, c.id);
    if (fresh) Object.assign(c, fresh);
    const name = e?.constructor?.name ?? "Error";
    await patch(db, closings, c, { asset_pending: true, asset_error: `${name}: ${e?.message ?? e}`.slice(0, 2000) });
    return;
  }
  await patch(db, closings, c, { asset_id: assetId, asset_pending: false, asset_error: null });
}

/** Open diligence items from the contracts module's `dd_items` table (read generically; optional). */
async function openDdItems(db: Db, c: Closing): Promise<Record<string, any>[]> {
  const cols = await tableColumns(db, "dd_items");
  if (!cols) return [];
  const id = sql.identifier;
  const conds: SQL[] = [];
  if (cols.has("opportunity_id")) conds.push(sql`${id("opportunity_id")} = ${c.opportunity_id}`);
  if (cols.has("property_id") && c.property_id) conds.push(sql`${id("property_id")} = ${c.property_id}`);
  const ccols = await tableColumns(db, "contracts");
  if (cols.has("contract_id") && ccols) {
    const sub: SQL[] = [];
    if (ccols.has("opportunity_id")) sub.push(sql`${id("opportunity_id")} = ${c.opportunity_id}`);
    if (ccols.has("property_id") && c.property_id) sub.push(sql`${id("property_id")} = ${c.property_id}`);
    if (sub.length) conds.push(sql`${id("contract_id")} in (select id from contracts where ${sql.join(sub, sql` or `)})`);
  }
  if (!conds.length) return [];
  const where: SQL[] = [sql`(${sql.join(conds, sql` or `)})`];
  if (cols.has("deleted_at")) where.push(sql`${id("deleted_at")} is null`);
  if (cols.has("status")) {
    where.push(sql`${id("status")} not in (${sql.join(CLOSED_DD_STATUSES.map((s) => sql`${s}`), sql`, `)})`);
  }
  const rows = await raw(db, sql`select * from dd_items where ${sql.join(where, sql` and `)} limit 500`);
  const first = (r: Record<string, any>, keys: string[]) => keys.map((k) => r[k]).find((v) => v) ?? null;
  return rows.map((r) => {
    // date columns serialize as YYYY-MM-DD, timestamp columns (due_at) as full ISO datetimes
    const dueDay = first(r, ["due_on", "due_date"]);
    const due = dueDay ? dateStr(dueDay) : (r.due_at ?? null);
    return toJsonable({
      id: r.id, title: first(r, ["title", "name", "label", "description"]) ?? "DD item", status: r.status ?? null,
      severity: r.severity ?? null, due_on: due,
      owner_id: r.owner_id ?? null, findings: r.findings ?? null, category: r.category ?? null,
    });
  });
}

async function leasesFor(db: Db, property_id: string | null): Promise<Record<string, any>[]> {
  const cols = await tableColumns(db, "leases");
  if (!cols || !property_id || !cols.has("property_id")) return [];
  const extra = cols.has("deleted_at") ? sql` and deleted_at is null` : sql``;
  return raw(db, sql`select * from leases where property_id = ${property_id}${extra} limit 1000`);
}

const handoffItem = (label: string, detail: string | null = null, document_id: any = null, st = "pending") =>
  toJsonable({ label, detail, document_id, status: st });

async function buildHandoff(db: Db, c: Closing, actor: CurrentUser): Promise<HandoffPackage> {
  const [existing] = await db.select().from(handoffPackages).where(eq(handoffPackages.closing_id, c.id)).limit(1);
  if (existing) return existing;
  const t = closingChecklistItems;
  const checklist = await db.select().from(t).where(and(eq(t.closing_id, c.id), isNull(t.deleted_at)));

  const fromChecklist = (...cats: string[]) =>
    checklist
      .filter((i) => cats.includes(i.category))
      .map((i) =>
        handoffItem(
          i.title, `Closing item: ${i.status.replaceAll("_", " ")}`, i.document_id,
          i.status === "done" ? "delivered" : i.status === "not_applicable" ? "not_applicable" : "pending",
        ),
      );

  const leases = await leasesFor(db, c.property_id);
  const leaseItems = leases.map((l) =>
    handoffItem(
      String(l.tenant_name || "Lease"),
      [
        String(l.status || ""),
        l.expiration_on ? `expires ${dateStr(l.expiration_on)}` : "",
        l.rentable_sf ? `${fmt0(Number(l.rentable_sf))} SF` : "",
      ].filter((x) => x).join(" · "),
      l.document_id ?? null,
    ),
  );
  const dd = await openDdItems(db, c);
  const orElse = (xs: any[], fallback: any[]) => (xs.length ? xs : fallback);
  const sections = {
    rent_roll: {
      items: [handoffItem("Rent roll as of closing date", leases.length ? `${leases.length} lease(s) on file` : "No leases on file")],
      notes: null,
    },
    leases: { items: orElse(leaseItems, [handoffItem("Executed leases, amendments and guaranties")]), notes: null },
    service_contracts: {
      items: orElse(fromChecklist("vendors"), [handoffItem("Assumed service contracts")]), notes: null,
    },
    warranties: { items: [handoffItem("Roof, HVAC and equipment warranties")], notes: null },
    keys_access: {
      items: [handoffItem("Keys, access cards and codes"), handoffItem("Alarm and security credentials")], notes: null,
    },
    utilities: { items: orElse(fromChecklist("utilities"), [handoffItem("Utility accounts transferred")]), notes: null },
    tax_insurance: {
      items: [...fromChecklist("insurance"), handoffItem("Property tax accounts and current bills")], notes: null,
    },
    open_dd_items: { items: dd.map((d) => handoffItem(d.title, d.findings || d.status)), notes: null },
  };
  return insert(db, handoffPackages, {
    closing_id: c.id, asset_id: c.asset_id, property_id: c.property_id, sections, open_dd_items: dd,
    carry_forward: toJsonable({
      capital_structure: c.capital_structure, hold_thesis: c.hold_thesis, business_plan: c.business_plan,
      target_hold_years: c.target_hold_years, uw_model_id: c.uw_model_id, manager_id: c.manager_id,
      purchase_price: c.purchase_price, basis: c.basis, closed_on: c.closed_on, offer_id: c.offer_id,
      opportunity_id: c.opportunity_id,
    }),
    generated_at: new Date(), recipient_id: c.manager_id, created_by_id: actor.id, updated_by_id: actor.id,
  } as never);
}

function dueDt(value: unknown, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    // Python fromisoformat: naive values are taken as UTC.
    const hasTime = /T\d{2}:\d{2}/.test(value);
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
    const d = new Date(hasTime && !hasZone ? `${value}Z` : value);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  return fallback;
}

/** Open DD items survive into operations as tasks linked to the asset. */
async function ddTasks(db: Db, c: Closing, pkg: HandoffPackage, actor: CurrentUser): Promise<number> {
  if (!c.asset_id) return 0;
  const { createTask } = await tasksService();
  const now = new Date();
  for (const d of pkg.open_dd_items ?? []) {
    const sev = String(d.severity ?? "").toLowerCase();
    const owner = d.owner_id;
    await createTask(db, {
      title: `Open DD item from acquisition: ${d.title}`,
      description: d.findings || "Carried forward from acquisition due diligence at closing.",
      assignee_id: owner ? owner : (c.manager_id || c.coordinator_id),
      due_at: dueDt(d.due_on, new Date(now.getTime() + 14 * 86_400_000)), task_type: "due_diligence",
      priority: ["high", "critical", "4", "5"].includes(sev) ? "high" : "normal",
      related_type: "asset", related_id: c.asset_id, related_label: d.title, source: "closing",
      idempotency_key: `closing-dd:${c.id}:${d.id}`, actor_id: actor.id,
    });
  }
  return (pkg.open_dd_items ?? []).length;
}

/** Moves the opportunity to closed through the pipeline's gated move (which commits). */
async function closeOpportunity(db: Db, c: Closing, opp: Record<string, any>, actor: CurrentUser): Promise<void> {
  if (["closed", "dead", "nurture"].includes(opp.stage)) {
    await db.commit();
    return;
  }
  const pipeline = await pipelineService();
  try {
    await pipeline.move(
      db, opp as never,
      { to_stage: "closed", fields: { closed_price: c.purchase_price, closed_on: c.closed_on, closing_date: c.closed_on } } as never,
      actor,
    );
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    await audit.record(db, {
      actor, action: "closing.pipeline_move_blocked", entity_type: ENTITY, entity_id: c.id,
      summary: "Could not move opportunity to closed", changes: { detail: toJsonable(e.detail) },
      ip_address: actor.ip_address,
    });
    await db.commit();
  }
}

export async function complete(db: Db, c: Closing, data: CompleteIn, actor: CurrentUser): Promise<Closing> {
  requireOpen(c);
  const found = await blockers(db, c);
  if (found.length) {
    throw new HttpError(422, {
      message: "Closing cannot complete: " + found.map((b) => b.label).join("; "),
      blockers: found,
    });
  }
  const opp = await opportunity(db, c.opportunity_id);
  const now = new Date();
  await patch(db, closings, c, {
    status: "completed", closed_on: data.closed_on, completed_at: now, completed_by_id: actor.id,
    updated_by_id: actor.id, capital_structure: capitalStructure(c.sources ?? [], c.purchase_price),
  });

  const snap = await buildSnapshot(db, c, opp, actor);
  const digest = createHash("sha256").update(stableStringify(snap), "utf8").digest("hex");
  await insert(db, closingSnapshots, {
    closing_id: c.id, created_at: now, created_by_id: actor.id, created_by_name: actor.full_name, sha256: digest,
    data: snap,
  });

  await createAsset(db, c, actor);
  const pkg = await buildHandoff(db, c, actor);
  await ddTasks(db, c, pkg, actor);

  const { createTask } = await tasksService();
  const label = opp.title;
  const auditDue = addDays(data.closed_on, 90);
  const task = await createTask(db, {
    title: `90-day post-close audit: ${label}`,
    description: "Compare actual operations with the acquisition underwriting and report variances back to acquisitions.",
    assignee_id: c.manager_id || c.coordinator_id || actor.id, due_at: at1700(auditDue), task_type: "review",
    priority: "normal", related_type: "closing", related_id: c.id, related_label: label, source: "closing",
    idempotency_key: `closing-audit:${c.id}`, actor_id: actor.id,
  });
  await patch(db, closings, c, { audit_task_id: task.id, audit_due_on: auditDue });

  await audit.record(db, {
    actor, action: "closing.completed", entity_type: ENTITY, entity_id: c.id,
    summary: label + (c.asset_pending ? " (asset conversion pending)" : ""),
    changes: { closed_on: data.closed_on, basis: c.basis, asset_id: c.asset_id, snapshot_sha256: digest, note: data.note },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "closing.completed", {
    closing_id: c.id, opportunity_id: c.opportunity_id, property_id: c.property_id, asset_id: c.asset_id, actor,
  });
  await closeOpportunity(db, c, opp, actor); // commits
  return c;
}

export async function retryAsset(db: Db, c: Closing, actor: CurrentUser): Promise<Closing> {
  if (c.status !== "completed" || !c.asset_pending) {
    throw new HttpError(409, "Asset conversion is not pending for this closing");
  }
  await createAsset(db, c, actor);
  if (c.asset_id) {
    const pkg = await buildHandoff(db, c, actor);
    await patch(db, handoffPackages, pkg, { asset_id: c.asset_id });
    await ddTasks(db, c, pkg, actor);
  }
  await audit.record(db, {
    actor, action: "closing.asset_conversion_retried", entity_type: ENTITY, entity_id: c.id,
    summary: c.asset_id ? "Asset created" : "Still pending", changes: { asset_id: c.asset_id, error: c.asset_error },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return c;
}

// ----------------------------------------------------------------------------- handoff

export async function updateHandoff(db: Db, pkg: HandoffPackage, data: HandoffUpdate, actor: CurrentUser): Promise<HandoffPackage> {
  if (pkg.acknowledged_at) throw new HttpError(409, "The handoff package was acknowledged by operations");
  const sections: Record<string, any> = { ...(pkg.sections ?? {}) };
  for (const [key, sec] of Object.entries(data.sections)) {
    if (!(key in HANDOFF_SECTIONS)) throw new HttpError(422, `Unknown handoff section '${key}'`);
    sections[key] = toJsonable(sec);
  }
  const values: Record<string, any> = { sections };
  if ("recipient_id" in data) values.recipient_id = data.recipient_id ?? null;
  const changes = audit.diff(pkg, values);
  if (!Object.keys(changes).length) return pkg;
  await patch(db, handoffPackages, pkg, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "closing.handoff_updated", entity_type: ENTITY, entity_id: pkg.closing_id,
    changes: { sections: Object.keys(data.sections) }, ip_address: actor.ip_address,
  });
  await db.commit();
  return pkg;
}

export async function acknowledgeHandoff(db: Db, pkg: HandoffPackage, actor: CurrentUser): Promise<HandoffPackage> {
  if (pkg.acknowledged_at) throw new HttpError(409, "Already acknowledged");
  await patch(db, handoffPackages, pkg, { acknowledged_at: new Date(), acknowledged_by_id: actor.id, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "closing.handoff_acknowledged", entity_type: ENTITY, entity_id: pkg.closing_id,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return pkg;
}

// ----------------------------------------------------------------------------- 90-day audit

function variance(key: string, label: string, assumed: unknown, actual: number | null, unit: AuditMetric["unit"] = "currency"): AuditMetric {
  const a = typeof assumed === "number" ? assumed : null;
  const m: AuditMetric = {
    key, label, assumed: a, actual: actual !== null ? Math.round(actual * 1e4) / 1e4 : null, variance: null,
    variance_pct: null, unit,
  };
  if (a !== null && actual !== null) {
    m.variance = Math.round((actual - a) * 1e4) / 1e4;
    m.variance_pct = a ? r2(((actual - a) / Math.abs(a)) * 100) : null;
  }
  return m;
}

export async function postCloseAudit(db: Db, c: Closing): Promise<PostCloseAuditOut> {
  const out: PostCloseAuditOut = {
    closing_id: c.id, asset_id: c.asset_id, closed_on: c.closed_on, due_on: c.audit_due_on, period_start: null,
    period_end: null, months_of_data: 0, metrics: [], notes: [], completed: c.audit_result ?? null,
  };
  if (c.status !== "completed" || !c.closed_on) {
    out.notes.push("Available after the closing is completed");
    return out;
  }
  const uw = await uwModelRow(db, c.uw_model_id);
  const outputs: Record<string, any> = uw?.outputs || {};
  if (!Object.keys(outputs).length) out.notes.push("Approved underwriting outputs are unavailable");

  const totals: Record<string, number> = {};
  let months = 0;
  const hasFinancials = await tableColumns(db, "asset_financials");
  if (!c.asset_id) {
    out.notes.push("Asset not yet created; no operating actuals");
  } else if (!hasFinancials) {
    out.notes.push("Asset financials are unavailable");
  } else {
    const start = `${c.closed_on.slice(0, 8)}01`;
    const rows = await raw<{ category: string; amt: string | null; n: number; first: string; last: string }>(
      db,
      sql`select category, sum(amount) as amt, count(distinct period)::int as n, min(period)::text as first, max(period)::text as last
          from asset_financials
          where asset_id = ${c.asset_id} and period >= ${start} and is_current is true and deleted_at is null
          group by category`,
    );
    const firsts: string[] = [];
    const lasts: string[] = [];
    for (const r of rows) {
      totals[String(r.category)] = Number(r.amt || 0);
      months = Math.max(months, Number(r.n || 0));
      firsts.push(r.first);
      lasts.push(r.last);
    }
    out.period_start = firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null;
    out.period_end = lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null;
    if (!rows.length) out.notes.push("No operating actuals posted since closing");
  }
  out.months_of_data = months;

  const annual = months ? 12 / months : null;
  const income = totals.income;
  const expense = Math.abs(totals.expense ?? 0);
  const debtService = Math.abs(totals.debt_service ?? 0);
  const noi = annual && income !== undefined ? (income - expense) * annual : null;
  const ds = annual && debtService ? debtService * annual : null;
  const price = c.purchase_price ? Number(c.purchase_price) : null;
  const equity = Number((c.capital_structure as Record<string, any>)?.equity || 0) || null;

  // Underwriting may store rates as fractions (0.065) or percents (6.5): compare in the same scale.
  const scaled = (assumed: unknown, fraction: number | null): number | null => {
    if (fraction === null) return null;
    return typeof assumed === "number" && assumed > 1 ? fraction * 100 : fraction;
  };

  out.metrics = [
    variance("purchase_price", "Purchase price", outputs.purchase_price, price),
    variance("noi", "NOI (annualized)", outputs.noi_year1, noi),
    variance(
      "going_in_cap", "Yield on purchase price", outputs.going_in_cap,
      scaled(outputs.going_in_cap, noi !== null && price ? noi / price : null), "percent",
    ),
    variance("dscr", "DSCR", outputs.dscr, noi !== null && ds ? noi / ds : null, "ratio"),
    variance(
      "cash_on_cash", "Cash-on-cash", outputs.cash_on_cash,
      scaled(outputs.cash_on_cash, noi !== null && equity ? (noi - (ds || 0)) / equity : null), "percent",
    ),
  ];
  if ("capex" in totals) out.metrics.push(variance("capex", "Capex to date", null, Math.abs(totals.capex)));
  return out;
}

export async function completeAudit(db: Db, c: Closing, data: AuditCompleteIn, actor: CurrentUser): Promise<Closing> {
  if (c.status !== "completed") throw new HttpError(409, "The post-close audit runs after closing");
  if (c.audit_completed_at) throw new HttpError(409, "The post-close audit is already recorded");
  const result = await postCloseAudit(db, c);
  const opp = await opportunity(db, c.opportunity_id);
  const now = new Date();
  const auditResult = toJsonable({
    metrics: result.metrics, months_of_data: result.months_of_data, period_start: result.period_start,
    period_end: result.period_end, notes: result.notes, findings: data.findings,
    lessons_for_acquisitions: data.lessons_for_acquisitions, completed_by: actor.full_name, completed_at: now,
  });
  await patch(db, closings, c, {
    audit_result: auditResult, audit_completed_at: now, audit_completed_by_id: actor.id, updated_by_id: actor.id,
  });
  const { createTask, complete: completeTask } = await tasksService();

  // Variance feedback returns to acquisitions (the opportunity owner who underwrote the deal).
  await createTask(db, {
    title: `Review 90-day variance feedback: ${opp.title}`, description: data.lessons_for_acquisitions || data.findings,
    assignee_id: opp.owner_id, due_at: new Date(now.getTime() + 7 * 86_400_000), task_type: "review",
    priority: "normal", related_type: "closing", related_id: c.id, related_label: opp.title, source: "closing",
    idempotency_key: `closing-audit-feedback:${c.id}`, actor_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "closing.post_close_audit_completed", entity_type: ENTITY, entity_id: c.id,
    summary: data.findings.slice(0, 300), changes: { metrics: auditResult.metrics }, ip_address: actor.ip_address,
  });
  await events.emit(db, "closing.audit_completed", {
    closing_id: c.id, opportunity_id: c.opportunity_id, uw_model_id: c.uw_model_id, asset_id: c.asset_id,
    variances: auditResult.metrics, actor,
  });
  const { tasks } = await import("../tasks/schema");
  const task = c.audit_task_id ? await dbGet(db, tasks as any, c.audit_task_id) : undefined;
  if (task && ["open", "in_progress"].includes((task as any).status)) {
    try {
      await completeTask(db, task as never, "Post-close audit recorded", actor); // commits
      return c;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  await db.commit();
  return c;
}

// ----------------------------------------------------------------------------- handlers support

export async function reassignUser(db: Db, user_id: string, reassign_to_id: string | null | undefined): Promise<void> {
  if (!reassign_to_id) return;
  await db
    .update(closings)
    .set({ coordinator_id: reassign_to_id })
    .where(and(eq(closings.coordinator_id, user_id), eq(closings.status, "open"), isNull(closings.deleted_at)));
  await db
    .update(closings)
    .set({ manager_id: reassign_to_id })
    .where(and(eq(closings.manager_id, user_id), eq(closings.status, "open"), isNull(closings.deleted_at)));
  const openClosings = db.select({ id: closings.id }).from(closings).where(eq(closings.status, "open"));
  await db
    .update(closingChecklistItems)
    .set({ owner_id: reassign_to_id })
    .where(
      and(
        eq(closingChecklistItems.owner_id, user_id),
        notInArray(closingChecklistItems.status, SATISFIED_STATUSES),
        inArray(closingChecklistItems.closing_id, openClosings),
      ),
    );
}
