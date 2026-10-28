/**
 * Buy Box engine (spec module 8).
 *
 * Fit is a gate, not a score: each property/buy-box pair resolves to Pass, Pass With Exception, Fail or
 * Insufficient Data. Every evaluation stores the criteria version, a timestamp and per-criterion details;
 * earlier evaluations are kept with `is_current = false`.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, gte, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, insertMany, patch } from "../../db/orm";
import { users } from "../auth/schema";
import { properties, PROPERTY_STATUSES, PROPERTY_TYPES, type Property } from "../properties/schema";
import { tasks } from "../tasks/schema";
import { createTask } from "../tasks/service";
import {
  buyBoxes,
  buyboxCriteria,
  buyboxEvaluations,
  buyboxVersions,
  type BuyBox,
  type BuyboxCriterion,
  type BuyboxEvaluation,
} from "./schema";
import type { BuyBoxCreate, BuyBoxUpdate, CriterionIn } from "./schemas";

export const ENTITY = "buy_box";
const BATCH = 500;

/** Python `x in (None, "", [])` */
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

// ----------------------------------------------------------------------------- field catalogue

const NUM_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "is_set"];
export const OPS_BY_TYPE: Record<string, string[]> = {
  number: NUM_OPS,
  integer: NUM_OPS,
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_set"],
  string: ["eq", "neq", "in", "not_in", "contains", "is_set"],
  enum: ["eq", "neq", "in", "not_in", "is_set"],
  tags: ["contains", "not_in", "is_set"],
};

export const OP_TEXT: Record<string, string> = {
  eq: "=", neq: "≠", in: "one of", not_in: "not one of", gt: ">", gte: "≥", lt: "<", lte: "≤",
  between: "between", contains: "contains", is_set: "is set",
};

interface FieldMeta {
  label: string;
  type: string;
  unit?: string | null;
  options?: readonly string[];
  derived?: string[];
}

const s = (label: string): FieldMeta => ({ label, type: "string" });
const n = (label: string, unit: string | null = null): FieldMeta => ({ label, type: "number", unit });
const i = (label: string): FieldMeta => ({ label, type: "integer" });

const FIELDS: Record<string, FieldMeta> = {
  property_type: { label: "Property type", type: "enum", options: PROPERTY_TYPES },
  property_subtype: s("Subtype"),
  status: { label: "Property status", type: "enum", options: PROPERTY_STATUSES },
  state: s("State"),
  county: s("County"),
  city: s("City"),
  postal_code: s("Postal code"),
  corridor: s("Corridor"),
  building_area_sf: n("Building area", "SF"),
  land_area_acres: n("Land area", "ac"),
  year_built: i("Year built"),
  year_renovated: i("Year renovated"),
  parking_spaces: i("Parking spaces"),
  construction_class: s("Construction class"),
  asking_price: n("Asking price", "$"),
  last_sale_price: n("Last sale price", "$"),
  last_sale_date: { label: "Last sale date", type: "date" },
  occupancy_pct: n("Occupancy", "%"),
  wale_years: n("WALE", "yrs"),
  noi: n("NOI", "$"),
  cap_rate: { ...n("Cap rate (NOI / asking)", "%"), derived: ["noi", "asking_price"] },
  price_per_sf: { ...n("Asking price per SF", "$"), derived: ["asking_price", "building_area_sf"] },
  zoning: s("Zoning"),
  future_land_use: s("Future land use"),
  flood_zone: s("Flood zone"),
  traffic_count: i("Traffic count (VPD)"),
  tags: { label: "Tags", type: "tags" },
  completeness_score: n("Data completeness", "%"),
};

export function fieldMeta() {
  return Object.entries(FIELDS).map(([key, v]) => ({ key, ...v, operators: OPS_BY_TYPE[v.type] }));
}

export const dependsOn = (field: string): string[] => FIELDS[field]?.derived ?? [field];

const round = (x: number, places: number) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

export function fieldValue(p: any, field: string): any {
  if (field === "cap_rate") {
    const noi = p.noi;
    const price = p.asking_price;
    return noi !== null && noi !== undefined && price ? round((noi / price) * 100, 4) : null;
  }
  if (field === "price_per_sf") {
    const price = p.asking_price;
    const sf = p.building_area_sf;
    return price !== null && price !== undefined && sf ? round(price / sf, 2) : null;
  }
  return p[field] ?? null;
}

class ValueError extends Error {}

function toFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || Number.isNaN(Number(t))) throw new ValueError();
    return Number(t);
  }
  throw new ValueError();
}

function toIsoDate(v: unknown): string {
  const t = String(v).slice(0, 10);
  const d = new Date(`${t}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) {
    throw new ValueError();
  }
  return t;
}

function coerce(v: any, ftype: string): any {
  if (v === null || v === undefined) return null;
  if (ftype === "number" || ftype === "integer") return toFloat(v);
  if (ftype === "date") return toIsoDate(v);
  return String(v).trim().toLowerCase();
}

function check(op: string, actual: any, value: any, ftype: string): boolean {
  if (op === "is_set") return !isEmpty(actual) === Boolean(Array.isArray(value) ? value.length : value);
  if (ftype === "tags") {
    const have = new Set((actual ?? []).map((t: unknown) => String(t).trim().toLowerCase()));
    const wanted = (Array.isArray(value) ? value : [value]).map((x: unknown) => String(x).trim().toLowerCase());
    const hit = wanted.some((w: string) => have.has(w));
    return op === "contains" ? hit : !hit;
  }
  const a = coerce(actual, ftype);
  if (op === "in" || op === "not_in") {
    const inside = new Set((value as unknown[]).map((x) => coerce(x, ftype))).has(a);
    return op === "in" ? inside : !inside;
  }
  if (op === "between") {
    const x = coerce(value[0], ftype);
    const y = coerce(value[1], ftype);
    const [lo, hi] = x <= y ? [x, y] : [y, x];
    return lo <= a && a <= hi;
  }
  if (op === "contains") return String(a).includes(String(coerce(value, "string")));
  const b = coerce(value, ftype);
  switch (op) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
  }
  throw new ValueError();
}

export function validateCriterion(c: CriterionIn): void {
  const meta = FIELDS[c.field];
  if (!meta) throw new HttpError(422, `Unknown field '${c.field}'`);
  if (!OPS_BY_TYPE[meta.type].includes(c.operator)) {
    throw new HttpError(422, `Operator '${c.operator}' is not available for ${meta.label}`);
  }
  if (c.operator === "is_set" || meta.type === "tags") return;
  try {
    for (const v of Array.isArray(c.value) ? c.value : [c.value]) coerce(v, meta.type);
  } catch {
    throw new HttpError(422, `Invalid value for ${meta.label}`);
  }
}

/** Python `f"{v:,.2f}".rstrip("0").rstrip(".")` for floats; ints print plainly. */
function show(v: any, isFloat = false): string {
  if (isEmpty(v)) return "empty";
  if (Array.isArray(v)) return v.map((x) => show(x)).join(", ");
  if (typeof v === "number" && (isFloat || !Number.isInteger(v))) {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

// ----------------------------------------------------------------------------- engine

export interface EngineResult {
  result: string;
  missing_fields: string[];
  details: any[];
  preferred_misses: any[];
}

export function runEngine(p: any, criteria: BuyboxCriterion[]): EngineResult {
  const details: any[] = [];
  for (const c of [...criteria].sort((a, b) => a.position - b.position)) {
    const meta: FieldMeta = FIELDS[c.field] ?? { label: c.field, type: "string" };
    const label = meta.label;
    const actual = fieldValue(p, c.field);
    let missingDeps: string[] = [];
    let outcome: string;
    let explanation: string;
    const isNum = meta.type === "number";
    if (c.operator !== "is_set" && isEmpty(actual)) {
      outcome = "missing";
      const deps = dependsOn(c.field).filter((d) => isEmpty(p[d]));
      missingDeps = deps.length ? deps : [c.field];
      explanation = `${label} is missing` + (meta.derived ? ` (needs ${missingDeps.join(", ")})` : "");
    } else {
      let hit: boolean | null;
      try {
        hit = check(c.operator, actual, c.value, meta.type);
      } catch {
        hit = null;
      }
      const expected =
        c.operator !== "is_set"
          ? `${OP_TEXT[c.operator] ?? c.operator} ${show(c.value)}`
          : c.value
            ? "is set"
            : "is empty";
      if (hit === null) {
        outcome = "fail";
        explanation = `${label}: criterion value could not be compared`;
      } else if (c.requirement === "disqualifying") {
        outcome = hit ? "fail" : "pass";
        explanation = hit
          ? `Disqualified: ${label} ${expected} (actual ${show(actual, isNum)})`
          : `${label} ${show(actual, isNum)} — not ${expected}`;
      } else {
        outcome = hit ? "pass" : "fail";
        explanation = `${label} ${show(actual, isNum)} — expected ${expected}`;
      }
    }
    details.push({
      criterion_id: String(c.id),
      field: c.field,
      label,
      operator: c.operator,
      value: toJsonable(c.value),
      requirement: c.requirement,
      actual: toJsonable(actual),
      outcome,
      missing_fields: missingDeps,
      explanation,
    });
  }

  const gating = details.filter((d) => d.requirement !== "preferred");
  const missing = [...new Set(gating.filter((d) => d.outcome === "missing").flatMap((d) => d.missing_fields as string[]))].sort();
  let result: string;
  if (gating.some((d) => d.outcome === "fail")) result = "fail";
  else if (missing.length) result = "insufficient_data";
  else result = "pass";
  const preferred = details.filter((d) => d.requirement === "preferred" && d.outcome !== "pass");
  return { result, missing_fields: missing, details, preferred_misses: preferred };
}

/** Python `json.dumps(..., sort_keys=True)` formatting so signatures stay comparable across the port. */
function pyJson(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u0080-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (v instanceof Date) return pyJson(v.toISOString());
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  return "{" + Object.keys(v).sort().map((k) => `${pyJson(k)}: ${pyJson(v[k])}`).join(", ") + "}";
}

function signature(version: number, r: EngineResult): string {
  return createHash("sha256").update(pyJson({ v: version, r: r.result, d: r.details }), "utf8").digest("hex");
}

const propertyLabel = (p: { name: string | null; address_line: string }) => p.name || p.address_line;

const gatingFails = (details: any[]) =>
  new Set<string>(details.filter((d) => d.requirement !== "preferred" && d.outcome === "fail").map((d) => d.criterion_id));

const EXCEPTION_FIELDS = [
  "exception_status", "exception_requested_by_id", "exception_requested_at", "exception_request_reason",
  "exception_approver_id", "exception_decided_at", "exception_decision_reason",
] as const;

async function evaluateOne(
  db: Db,
  p: Property,
  box: BuyBox,
  criteria: BuyboxCriterion[],
  prev: BuyboxEvaluation | undefined,
  o: { trigger: string; actor_id: string | null; skip_unchanged: boolean },
): Promise<[BuyboxEvaluation, boolean]> {
  const r = runEngine(p, criteria);
  const sig = signature(box.version, r);
  if (prev && o.skip_unchanged && prev.signature === sig) return [prev, false];

  const values: Record<string, any> = {
    property_id: p.id, buy_box_id: box.id, buy_box_version: box.version, result: r.result, raw_result: r.result,
    missing_fields: r.missing_fields, details: r.details, preferred_misses: r.preferred_misses, signature: sig,
    evaluated_at: utcnow(), is_current: true, trigger: o.trigger, exception_status: "none",
    created_by_id: o.actor_id, updated_by_id: o.actor_id,
  };
  // An approved/pending exception survives re-evaluation only for the same version and no new failures.
  if (r.result === "fail" && prev && ["requested", "approved"].includes(prev.exception_status)
    && prev.buy_box_version === box.version) {
    const prevFails = gatingFails(prev.details);
    if ([...gatingFails(r.details)].every((f) => prevFails.has(f))) {
      for (const f of EXCEPTION_FIELDS) values[f] = prev[f];
      if (prev.exception_status === "approved") values.result = "pass_with_exception";
    }
  }
  if (prev) await patch(db, buyboxEvaluations, prev, { is_current: false });
  const ev = await insert(db, buyboxEvaluations, values as never);

  if (r.result === "insufficient_data") {
    const label = propertyLabel(p);
    await createTask(db, {
      title: `Research missing data for ${label}: ${r.missing_fields.join(", ")}`,
      description: `Buy box “${box.name}” (v${box.version}) cannot evaluate this property. ` +
        `Fields preventing evaluation: ${r.missing_fields.join(", ")}.`,
      assignee_id: box.owner_id,
      task_type: "research",
      related_type: "property",
      related_id: p.id,
      related_label: label,
      source: "buybox",
      idempotency_key: `buybox-research:${p.id}:${box.id}:${box.version}`,
      actor_id: o.actor_id,
    });
  }
  return [ev, true];
}

export async function loadCriteria(db: Db, boxIds: string[]): Promise<Map<string, BuyboxCriterion[]>> {
  const out = new Map<string, BuyboxCriterion[]>(boxIds.map((b) => [b, []]));
  if (!boxIds.length) return out;
  const rows = await db
    .select()
    .from(buyboxCriteria)
    .where(and(inArray(buyboxCriteria.buy_box_id, boxIds), isNull(buyboxCriteria.deleted_at)))
    .orderBy(asc(buyboxCriteria.position));
  for (const c of rows) out.get(c.buy_box_id)!.push(c);
  return out;
}

export async function activeBoxes(db: Db): Promise<BuyBox[]> {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(buyBoxes)
    .where(
      and(
        isNull(buyBoxes.deleted_at),
        eq(buyBoxes.is_active, true),
        or(isNull(buyBoxes.active_from), lte(buyBoxes.active_from, today)),
        or(isNull(buyBoxes.active_to), gte(buyBoxes.active_to, today)),
      ),
    );
}

export function referencedFields(criteria: BuyboxCriterion[]): Set<string> {
  return new Set(criteria.flatMap((c) => [c.field, ...dependsOn(c.field)]));
}

/** Evaluate one property against every applicable buy box. Does not commit (safe inside handlers). */
export async function evaluateProperty(
  db: Db,
  property_id: string,
  o: { trigger: string; actor_id?: string | null; changed?: Set<string> | null; skip_unchanged?: boolean },
): Promise<BuyboxEvaluation[]> {
  const { trigger, actor_id = null, changed = null, skip_unchanged = true } = o;
  const p = await ormGet(db, properties, property_id);
  if (!p || p.deleted_at) return [];
  const boxes = await activeBoxes(db);
  const crit = await loadCriteria(db, boxes.map((b) => b.id));
  const prevs = new Map<string, BuyboxEvaluation>();
  for (const e of await db
    .select()
    .from(buyboxEvaluations)
    .where(and(eq(buyboxEvaluations.property_id, p.id), eq(buyboxEvaluations.is_current, true)))) {
    prevs.set(e.buy_box_id, e);
  }
  const out: BuyboxEvaluation[] = [];
  for (const box of boxes) {
    if (changed !== null && prevs.has(box.id)) {
      const refs = referencedFields(crit.get(box.id)!);
      // completeness_score is recomputed on every property change, so any change can affect it.
      const touched = [...refs].some((f) => changed.has(f)) || (refs.has("completeness_score") && changed.size > 0);
      if (!touched) continue;
    }
    const [ev] = await evaluateOne(db, p, box, crit.get(box.id)!, prevs.get(box.id), { trigger, actor_id, skip_unchanged });
    out.push(ev);
  }
  return out;
}

/** Re-run one buy box across every live property in keyset-paginated batches. */
export async function evaluateAll(db: Db, box: BuyBox, actor: CurrentUser) {
  const crit = (await loadCriteria(db, [box.id])).get(box.id)!;
  const counts: Record<string, number> = {};
  let evaluated = 0;
  let changed = 0;
  let lastId: string | null = null;
  for (;;) {
    const props: Property[] = await db
      .select()
      .from(properties)
      .where(and(isNull(properties.deleted_at), lastId !== null ? gt(properties.id, lastId) : undefined))
      .orderBy(asc(properties.id))
      .limit(BATCH);
    if (!props.length) break;
    const prevs = new Map<string, BuyboxEvaluation>();
    for (const e of await db
      .select()
      .from(buyboxEvaluations)
      .where(
        and(
          eq(buyboxEvaluations.buy_box_id, box.id),
          eq(buyboxEvaluations.is_current, true),
          inArray(buyboxEvaluations.property_id, props.map((p) => p.id)),
        ),
      )) {
      prevs.set(e.property_id, e);
    }
    for (const p of props) {
      const [ev, did] = await evaluateOne(db, p, box, crit, prevs.get(p.id), {
        trigger: "evaluate_all", actor_id: actor.id, skip_unchanged: true,
      });
      evaluated += 1;
      changed += did ? 1 : 0;
      counts[ev.result] = (counts[ev.result] ?? 0) + 1;
    }
    await db.commit();
    lastId = props[props.length - 1].id;
  }

  await audit.record(db, {
    actor, action: "buy_box.evaluated_all", entity_type: ENTITY, entity_id: box.id,
    summary: `${evaluated} properties evaluated against v${box.version}`, changes: { by_result: counts },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return { evaluated, changed, unchanged: evaluated - changed, by_result: counts };
}

// ----------------------------------------------------------------------------- buy box CRUD

export interface BuyBoxFilters {
  q?: string;
  strategy?: string[];
  is_active?: boolean;
  owner_id?: string;
  result?: string[];
}

export function buildWhere(f: BuyBoxFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = buyBoxes;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.strategy, t.description]),
    skip.has("strategy") ? undefined : inFilter(t.strategy, f.strategy),
    skip.has("is_active") || f.is_active === undefined ? undefined : eq(t.is_active, f.is_active),
    f.owner_id ? eq(t.owner_id, f.owner_id) : undefined,
    f.result?.length && !skip.has("result")
      ? inArray(
          t.id,
          sql`(select ${buyboxEvaluations.buy_box_id} from ${buyboxEvaluations} where ${buyboxEvaluations.is_current} is true and ${inArray(buyboxEvaluations.result, f.result)})`,
        )
      : undefined,
  );
}

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter((x): x is string => !!x))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function resultCounts(db: Db, boxIds: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>(boxIds.map((b) => [b, {}]));
  if (!boxIds.length) return out;
  const rows = await db
    .select({ b: buyboxEvaluations.buy_box_id, r: buyboxEvaluations.result, n: sql<number>`count(*)::int` })
    .from(buyboxEvaluations)
    .where(and(inArray(buyboxEvaluations.buy_box_id, boxIds), eq(buyboxEvaluations.is_current, true)))
    .groupBy(buyboxEvaluations.buy_box_id, buyboxEvaluations.result);
  for (const r of rows) out.get(r.b)![r.r] = Number(r.n);
  return out;
}

export async function toItems(db: Db, boxes: BuyBox[]) {
  const ids = boxes.map((b) => b.id);
  const names = await userNames(db, boxes.map((b) => b.owner_id));
  const counts = await resultCounts(db, ids);
  const critCounts = new Map<string, number>();
  if (ids.length) {
    const rows = await db
      .select({ b: buyboxCriteria.buy_box_id, n: sql<number>`count(*)::int` })
      .from(buyboxCriteria)
      .where(and(inArray(buyboxCriteria.buy_box_id, ids), isNull(buyboxCriteria.deleted_at)))
      .groupBy(buyboxCriteria.buy_box_id);
    for (const r of rows) critCounts.set(r.b, Number(r.n));
  }
  return boxes.map((b) => ({
    id: b.id,
    name: b.name,
    strategy: b.strategy,
    owner_id: b.owner_id,
    owner_name: b.owner_id ? (names.get(b.owner_id) ?? null) : null,
    active_from: b.active_from,
    active_to: b.active_to,
    is_active: b.is_active,
    version: b.version,
    criteria_count: critCounts.get(b.id) ?? 0,
    result_counts: counts.get(b.id) ?? {},
    updated_at: b.updated_at,
  }));
}

export const criterionOut = (c: BuyboxCriterion) => ({
  field: c.field,
  operator: c.operator,
  value: c.value,
  requirement: c.requirement,
  note: c.note,
  id: c.id,
  position: c.position,
});

export async function toOut(db: Db, box: BuyBox) {
  const item = (await toItems(db, [box]))[0];
  const crit = (await loadCriteria(db, [box.id])).get(box.id)!;
  return { ...item, description: box.description, created_at: box.created_at, criteria: crit.map(criterionOut) };
}

export async function get(db: Db, box_id: string): Promise<BuyBox> {
  const box = await ormGet(db, buyBoxes, box_id);
  if (!box || box.deleted_at) throw new HttpError(404, "Buy box not found");
  return box;
}

const snapshot = (rows: Array<Pick<BuyboxCriterion, "id" | "field" | "operator" | "value" | "requirement" | "note" | "position">>) =>
  rows.map((c) => ({
    id: String(c.id), field: c.field, operator: c.operator, value: toJsonable(c.value),
    requirement: c.requirement, note: c.note, position: c.position,
  }));

function newRows(boxId: string, items: CriterionIn[], actor: CurrentUser) {
  return items.map((c, position) => {
    validateCriterion(c);
    return {
      id: randomUUID(), buy_box_id: boxId, field: c.field, operator: c.operator, value: c.value,
      requirement: c.requirement, note: c.note ?? null, position, created_by_id: actor.id, updated_by_id: actor.id,
    };
  });
}

export async function create(db: Db, data: BuyBoxCreate, actor: CurrentUser): Promise<BuyBox> {
  const { criteria, ...rest } = data;
  const box = await insert(db, buyBoxes, {
    ...rest,
    owner_id: rest.owner_id ?? actor.id,
    version: 1,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);
  const rows = await insertMany(db, buyboxCriteria, newRows(box.id, criteria, actor) as never);
  await insert(db, buyboxVersions, {
    buy_box_id: box.id, version: 1, criteria: snapshot(rows), change_note: "Created", created_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "buy_box.created", entity_type: ENTITY, entity_id: box.id, summary: box.name,
    changes: { criteria: snapshot(rows) }, ip_address: actor.ip_address,
  });
  await db.commit();
  return box;
}

export async function update(db: Db, box: BuyBox, data: BuyBoxUpdate, actor: CurrentUser): Promise<BuyBox> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if ("name" in values && !values.name) delete values.name;
  const changes = audit.diff(box, values);
  if (!Object.keys(changes).length) return box;
  const next = { ...box, ...values };
  if (next.active_from && next.active_to && next.active_to < next.active_from) {
    throw new HttpError(422, "active_to must be on or after active_from");
  }
  await patch(db, buyBoxes, box, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "buy_box.updated", entity_type: ENTITY, entity_id: box.id, summary: box.name, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return box;
}

/** Every criteria change creates a new version; the previous criteria remain in buybox_versions. */
export async function replaceCriteria(
  db: Db,
  box: BuyBox,
  items: CriterionIn[],
  actor: CurrentUser,
  note: string | null = null,
): Promise<BuyBox> {
  const current = (await loadCriteria(db, [box.id])).get(box.id)!;
  const rows = newRows(box.id, items, actor);
  const before = snapshot(current);
  const after = snapshot(rows);
  const strip = (snap: typeof before) => snap.map(({ id: _id, ...rest }) => rest);
  if (JSON.stringify(strip(before)) === JSON.stringify(strip(after))) return box;
  const now = utcnow();
  if (current.length) {
    await db
      .update(buyboxCriteria)
      .set({ deleted_at: now, updated_by_id: actor.id })
      .where(inArray(buyboxCriteria.id, current.map((c) => c.id)));
  }
  await insertMany(db, buyboxCriteria, rows as never);
  const oldVersion = box.version;
  await patch(db, buyBoxes, box, { version: oldVersion + 1, updated_by_id: actor.id });
  await insert(db, buyboxVersions, {
    buy_box_id: box.id, version: box.version, criteria: after, change_note: note, created_by_id: actor.id,
  } as never);
  await audit.record(db, {
    actor, action: "buy_box.criteria_changed", entity_type: ENTITY, entity_id: box.id,
    summary: `v${oldVersion} → v${box.version}` + (note ? `: ${note}` : ""),
    changes: { version: { from: oldVersion, to: box.version }, criteria: { from: strip(before), to: strip(after) } },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return box;
}

export async function currentInputs(db: Db, box: BuyBox): Promise<[CriterionIn[], BuyboxCriterion[]]> {
  const crit = (await loadCriteria(db, [box.id])).get(box.id)!;
  return [
    crit.map((c) => ({
      field: c.field,
      operator: c.operator as CriterionIn["operator"],
      value: c.value,
      requirement: c.requirement as CriterionIn["requirement"],
      note: c.note,
    })),
    crit,
  ];
}

export async function archive(db: Db, box: BuyBox, actor: CurrentUser): Promise<void> {
  await patch(db, buyBoxes, box, { deleted_at: utcnow(), is_active: false, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "buy_box.archived", entity_type: ENTITY, entity_id: box.id, summary: box.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// ----------------------------------------------------------------------------- evaluations

export async function evalOuts(db: Db, evals: BuyboxEvaluation[]) {
  if (!evals.length) return [];
  const props = new Map(
    (
      await db
        .select({ id: properties.id, name: properties.name, address_line: properties.address_line, city: properties.city, state: properties.state })
        .from(properties)
        .where(inArray(properties.id, [...new Set(evals.map((e) => e.property_id))]))
    ).map((r) => [r.id, r]),
  );
  const boxes = new Map(
    (
      await db
        .select({ id: buyBoxes.id, name: buyBoxes.name })
        .from(buyBoxes)
        .where(inArray(buyBoxes.id, [...new Set(evals.map((e) => e.buy_box_id))]))
    ).map((r) => [r.id, r.name]),
  );
  const names = await userNames(db, [...evals.map((e) => e.exception_requested_by_id), ...evals.map((e) => e.exception_approver_id)]);
  return evals.map((e) => {
    const p = props.get(e.property_id);
    return {
      id: e.id,
      property_id: e.property_id,
      property_label: p ? p.name || p.address_line : null,
      property_city: p ? p.city : null,
      property_state: p ? p.state : null,
      buy_box_id: e.buy_box_id,
      buy_box_name: boxes.get(e.buy_box_id) ?? null,
      buy_box_version: e.buy_box_version,
      result: e.result,
      raw_result: e.raw_result,
      missing_fields: e.missing_fields,
      details: e.details,
      preferred_misses: e.preferred_misses,
      evaluated_at: e.evaluated_at,
      is_current: e.is_current,
      trigger: e.trigger,
      exception_status: e.exception_status,
      exception_requested_by_id: e.exception_requested_by_id,
      exception_requested_by_name: e.exception_requested_by_id ? (names.get(e.exception_requested_by_id) ?? null) : null,
      exception_requested_at: e.exception_requested_at,
      exception_request_reason: e.exception_request_reason,
      exception_approver_id: e.exception_approver_id,
      exception_approver_name: e.exception_approver_id ? (names.get(e.exception_approver_id) ?? null) : null,
      exception_decided_at: e.exception_decided_at,
      exception_decision_reason: e.exception_decision_reason,
    };
  });
}

export function evaluationsWhere(
  box_id: string,
  o: { result?: string[]; exception_status?: string[]; current_only: boolean; q?: string },
): SQL | undefined {
  return and(
    eq(buyboxEvaluations.buy_box_id, box_id),
    isNull(properties.deleted_at),
    o.current_only ? eq(buyboxEvaluations.is_current, true) : undefined,
    inFilter(buyboxEvaluations.result, o.result),
    inFilter(buyboxEvaluations.exception_status, o.exception_status),
    applySearch(o.q, [properties.name, properties.address_line, properties.city, properties.county]),
  );
}

export async function getEvaluation(db: Db, eval_id: string): Promise<BuyboxEvaluation> {
  const ev = await ormGet(db, buyboxEvaluations, eval_id);
  if (!ev) throw new HttpError(404, "Evaluation not found");
  return ev;
}

/** Python `datetime.isoformat()` for a UTC datetime (task idempotency keys embed it). */
function pyIso(d: Date): string {
  const s = d.toISOString();
  const ms = s.slice(20, 23);
  return ms === "000" ? `${s.slice(0, 19)}+00:00` : `${s.slice(0, 19)}.${ms}000+00:00`;
}

export async function requestException(db: Db, ev: BuyboxEvaluation, reason: string, actor: CurrentUser) {
  if (!ev.is_current) throw new HttpError(409, "Only the current evaluation can receive an exception");
  if (ev.raw_result !== "fail") throw new HttpError(409, "Exceptions apply only to failed evaluations");
  if (["requested", "approved"].includes(ev.exception_status)) {
    throw new HttpError(409, `An exception is already ${ev.exception_status}`);
  }
  const box = await get(db, ev.buy_box_id);
  const p = await ormGet(db, properties, ev.property_id);
  const label = p ? propertyLabel(p) : String(ev.property_id);
  const requestedAt = utcnow();
  await patch(db, buyboxEvaluations, ev, {
    exception_status: "requested",
    exception_requested_by_id: actor.id,
    exception_requested_at: requestedAt,
    exception_request_reason: reason,
    exception_approver_id: null,
    exception_decided_at: null,
    exception_decision_reason: null,
    updated_by_id: actor.id,
  });
  await createTask(db, {
    title: `Approve buy box exception: ${label} (${box.name})`,
    description: `Requested by ${actor.full_name}: ${reason}`,
    assignee_id: box.owner_id,
    task_type: "approval",
    priority: "high",
    related_type: "property",
    related_id: ev.property_id,
    related_label: label,
    source: "buybox",
    idempotency_key: `buybox-exception:${ev.id}:${pyIso(requestedAt)}`,
    actor_id: actor.id,
  });
  await audit.record(db, {
    actor, action: "buybox.exception_requested", entity_type: "property", entity_id: ev.property_id,
    summary: `${box.name} v${ev.buy_box_version}: ${reason}`, changes: { evaluation_id: String(ev.id) },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return ev;
}

export async function decideException(db: Db, ev: BuyboxEvaluation, approve: boolean, reason: string, actor: CurrentUser) {
  if (ev.exception_status !== "requested") throw new HttpError(409, "There is no pending exception request");
  if (!ev.is_current) throw new HttpError(409, "This evaluation has been superseded");
  const box = await get(db, ev.buy_box_id);
  const requestedAt = ev.exception_requested_at;
  await patch(db, buyboxEvaluations, ev, {
    exception_status: approve ? "approved" : "rejected",
    exception_approver_id: actor.id,
    exception_decided_at: utcnow(),
    exception_decision_reason: reason,
    result: approve ? "pass_with_exception" : ev.raw_result,
    updated_by_id: actor.id,
  });

  if (requestedAt) {
    // Exact key first; rows written by the old Python service carry microsecond timestamps, so fall back to a
    // prefix match on the still-open task for this evaluation.
    const exact = `buybox-exception:${ev.id}:${pyIso(requestedAt)}`;
    let [task] = await db.select().from(tasks).where(eq(tasks.idempotency_key, exact)).limit(1);
    if (!task) {
      [task] = await db
        .select()
        .from(tasks)
        .where(and(sql`${tasks.idempotency_key} like ${`buybox-exception:${ev.id}:%`}`, sql`${tasks.status} not in ('done', 'cancelled')`))
        .orderBy(sql`${tasks.created_at} desc`)
        .limit(1);
    }
    if (task && !["done", "cancelled"].includes(task.status)) {
      await patch(db, tasks, task, {
        status: "done",
        completed_at: utcnow(),
        completed_by_id: actor.id,
        resolution_note: `${approve ? "Approved" : "Rejected"}: ${reason}`,
      } as never);
    }
  }

  const verb = approve ? "approved" : "rejected";
  await audit.record(db, {
    actor, action: `buybox.exception_${verb}`, entity_type: "property", entity_id: ev.property_id,
    summary: `${box.name} v${ev.buy_box_version}: ${reason}`,
    changes: { evaluation_id: String(ev.id), result: { from: ev.raw_result, to: ev.result } },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return ev;
}
