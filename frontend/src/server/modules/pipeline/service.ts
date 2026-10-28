/**
 * Acquisition pipeline (spec module 11).
 *
 * Every stage has explicit entry requirements, declared once in STAGE_GATES. Moving with unmet
 * requirements is an audited override that needs `pipeline:approve` and a reason. Dead opportunities are
 * retained (never deleted) with a structured reason and a reactivation rule.
 */
import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";

import type { PgColumn } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import * as events from "../../core/events";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import { buyboxEvaluations } from "../buybox/schema";
import { evaluateProperty } from "../buybox/service";
import { organizations, people } from "../contacts/schema";
import { interactions } from "../outreach/schema";
import { properties } from "../properties/schema";
import { missingFields } from "../properties/service";
import { createTask } from "../tasks/service";
import {
  ACTIVE_STAGES,
  DEAD_REASONS,
  DEFAULT_STALL_DAYS,
  REACTIVATION_TYPES,
  STAGES,
  opportunities,
  opportunityEvents,
  pipelineStageSettings,
  type Opportunity,
} from "./schema";
import type { MoveIn, OpportunityCreate, OpportunityUpdate, Requirement } from "./schemas";

export const ENTITY = "opportunity";

/** Python `x in (None, "", [], {})` */
const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v as object).length === 0);

const label = (s: string) => s.replace(/_/g, " ");
const round = (x: number, places: number) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};
const DAY_MS = 86_400_000;

// Reactivation trigger catalogue (spec module 30). `required` keys must all be present, `any_of` needs one.
export const REACTIVATION_SPEC: Record<string, { label: string; params: any[]; required: string[]; any_of: string[] }> = {
  time: {
    label: "Revisit after time",
    params: [
      { key: "after_days", label: "After days", type: "number" },
      { key: "on_date", label: "On date", type: "date" },
    ],
    required: [], any_of: ["after_days", "on_date"],
  },
  debt: {
    label: "Debt event",
    params: [
      { key: "event", label: "Debt event", type: "select",
        options: ["maturity", "rate_reset", "lockout_end", "defeasance_window", "lien_or_default"] },
      { key: "date", label: "Expected date", type: "date" },
    ],
    required: ["event"], any_of: [],
  },
  price: {
    label: "Price or listing change",
    params: [
      { key: "target_price", label: "Target price", type: "number" },
      { key: "drop_pct", label: "Price drop %", type: "number" },
      { key: "on_listing", label: "When listed for sale", type: "boolean" },
    ],
    required: [], any_of: ["target_price", "drop_pct", "on_listing"],
  },
  ownership: {
    label: "Ownership or entity change",
    params: [
      { key: "event", label: "Change", type: "select",
        options: ["any_change", "sale", "entity_change", "estate_or_succession"] },
    ],
    required: ["event"], any_of: [],
  },
  lease: {
    label: "Lease or tenant event",
    params: [
      { key: "event", label: "Lease event", type: "select",
        options: ["expiration", "renewal", "vacancy", "tenant_change"] },
      { key: "date", label: "Expected date", type: "date" },
    ],
    required: ["event"], any_of: [],
  },
  market: {
    label: "Market / rate / comp move",
    params: [
      { key: "metric", label: "Metric", type: "select", options: ["cap_rate", "interest_rate", "comp_price_psf"] },
      { key: "direction", label: "Direction", type: "select", options: ["above", "below"] },
      { key: "threshold", label: "Threshold", type: "number" },
    ],
    required: ["metric", "direction", "threshold"], any_of: [],
  },
  development: {
    label: "Development / infrastructure",
    params: [{ key: "description", label: "What to watch", type: "text" }],
    required: ["description"], any_of: [],
  },
  relationship: {
    label: "Relationship / warm path",
    params: [{ key: "description", label: "Relationship to watch", type: "text" }],
    required: ["description"], any_of: [],
  },
  manual: {
    label: "Manual field / threshold",
    params: [
      { key: "description", label: "Condition", type: "text" },
      { key: "review_on", label: "Review on", type: "date" },
    ],
    required: ["description"], any_of: [],
  },
};

export function ruleProblems(rule: any): string[] {
  if (!rule || typeof rule !== "object" || Array.isArray(rule) || !rule.type) return ["Choose a reactivation trigger type"];
  const spec = REACTIVATION_SPEC[rule.type];
  if (!(REACTIVATION_TYPES as readonly string[]).includes(rule.type) || !spec) {
    return [`Unknown reactivation type '${rule.type}'`];
  }
  const params = rule.params || {};
  if (typeof params !== "object" || Array.isArray(params)) return ["Reactivation parameters must be an object"];
  const labels: Record<string, string> = Object.fromEntries(spec.params.map((p) => [p.key, p.label]));
  const problems = spec.required.filter((k) => isEmpty(params[k])).map((k) => `${labels[k] ?? k} is required`);
  if (spec.any_of.length && spec.any_of.every((k) => isEmpty(params[k]) || params[k] === false)) {
    problems.push("Provide one of: " + spec.any_of.map((k) => (labels[k] ?? k).toLowerCase()).join(", "));
  }
  return problems;
}

/** `audit.diff`, ignoring JSON objects that differ only in key order (jsonb does not preserve it). */
function diff(obj: Record<string, any>, data: Record<string, any>) {
  const canon = (v: any): any =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
  const changes = audit.diff(obj, data);
  for (const [k, c] of Object.entries(changes)) {
    if (JSON.stringify(canon(c.from)) === JSON.stringify(canon(c.to))) delete changes[k];
  }
  return changes;
}

// ----------------------------------------------------------------------------- stage gates

function req(
  key: string,
  label: string,
  met: unknown,
  o: { fields?: string[]; detail?: string | null; blocking?: boolean } = {},
): Requirement {
  return { key, label, met: Boolean(met), fields: o.fields ?? [], detail: o.detail ?? null, blocking: o.blocking ?? true };
}

const isSet = (o: Opportunity, field: string) => !isEmpty((o as Record<string, any>)[field]);

type GateCheck = (db: Db, o: Opportunity) => Promise<Requirement[]>;

async function gateSourced(db: Db, o: Opportunity): Promise<Requirement[]> {
  const reqs = [req("property", "Linked to a property", o.property_id !== null, { fields: ["property_id"] })];
  let met = false;
  let detail = "Property not yet evaluated against any active buy box";
  if (o.property_id) {
    const rows = await db
      .select({ result: buyboxEvaluations.result })
      .from(buyboxEvaluations)
      .where(and(eq(buyboxEvaluations.property_id, o.property_id), eq(buyboxEvaluations.is_current, true)));
    if (rows.length) {
      met = true;
      detail = [...new Set(rows.map((r) => label(r.result)))].sort().join(", ");
    }
  }
  reqs.push(req("buybox", "Current buy box evaluation", met, { detail }));
  if (o.property_id) {
    const p = await ormGet(db, properties, o.property_id);
    if (p) {
      const missing = missingFields(p);
      reqs.push(
        req("completeness", "Property data completeness checked", !missing.length, {
          blocking: false,
          detail: `${Math.round(p.completeness_score)}% complete` + (missing.length ? `; missing ${missing.join(", ")}` : ""),
        }),
      );
    }
  }
  return reqs;
}

const gateScreening: GateCheck = async (_db, o) => [
  req("owner_contact", "Owner or contact identified", Boolean(o.primary_person_id || o.primary_organization_id), {
    fields: ["primary_person_id", "primary_organization_id"],
  }),
];

const gateResearch: GateCheck = async (db, o) => {
  let named = [...(o.research_missing_fields ?? [])];
  let detail = named.join(", ") || null;
  if (!named.length && o.stage !== "research") {
    // Moving into research fills these from the property's Insufficient Data evaluations.
    named = await defaultResearchFields(db, o);
    detail = named.length ? `From buy box evaluation: ${named.join(", ")}` : null;
  }
  return [req("missing_fields", "Named missing fields to resolve", named.length > 0, { fields: ["research_missing_fields"], detail })];
};

const gateUnderwriting: GateCheck = async (_db, o) => [
  req("estimated_value", "Estimated value", isSet(o, "estimated_value"), { fields: ["estimated_value"] }),
  req("cap_rate", "Cap rate", isSet(o, "cap_rate"), { fields: ["cap_rate"] }),
  req("underwriting_notes", "Underwriting summary notes", isSet(o, "underwriting_notes"), { fields: ["underwriting_notes"] }),
];

const gateContact: GateCheck = async (db, o) => {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(eq(interactions.opportunity_id, o.id), sql`${interactions.disposition} is not null`));
  return [
    req("interaction", "Logged outreach attempt with a disposition", n > 0, {
      detail: n
        ? `${n} logged interaction${n !== 1 ? "s" : ""} with disposition`
        : "Log a call, email or meeting on this opportunity first",
    }),
  ];
};

const gateNegotiation: GateCheck = async (_db, o) => [
  req("price_expectation", "Owner price expectation", isSet(o, "price_expectation"), { fields: ["price_expectation"] }),
  req("next_action", "Dated next action", isSet(o, "next_action") && isSet(o, "next_action_at"), {
    fields: ["next_action", "next_action_at"],
  }),
];

const gateOffer: GateCheck = async (_db, o) => [
  req("offer_price", "Offer price", isSet(o, "offer_price"), { fields: ["offer_price"] }),
  req("offer_sent_at", "Offer sent date", isSet(o, "offer_sent_at"), { fields: ["offer_sent_at"] }),
  req("response_due_at", "Response due date", isSet(o, "response_due_at"), { fields: ["response_due_at"] }),
];

const gateUnderContract: GateCheck = async (_db, o) => [
  req("contract_executed_on", "Contract executed date", isSet(o, "contract_executed_on"), { fields: ["contract_executed_on"] }),
];

const gateDueDiligence: GateCheck = async (_db, o) => [
  req("dd_deadline", "Due diligence deadline", isSet(o, "dd_deadline"), { fields: ["dd_deadline"] }),
];

const gateClosing: GateCheck = async (_db, o) => [
  req("closing_date", "Closing date scheduled", isSet(o, "closing_date"), { fields: ["closing_date"] }),
];

const gateClosed: GateCheck = async (_db, o) => [
  req("closed_price", "Closed price", isSet(o, "closed_price"), { fields: ["closed_price"] }),
  req("closed_on", "Closed on date", isSet(o, "closed_on"), { fields: ["closed_on"] }),
];

const gateDead: GateCheck = async (_db, o) => {
  const reqs = [
    req("dead_reason", "Structured dead reason", (DEAD_REASONS as readonly string[]).includes(o.dead_reason ?? ""), {
      fields: ["dead_reason"],
    }),
  ];
  if (o.dead_reason === "price_gap") reqs.push(req("price_gap", "Price gap amount", isSet(o, "price_gap"), { fields: ["price_gap"] }));
  const problems = ruleProblems(o.reactivation_rule);
  reqs.push(req("reactivation_rule", "Reactivation rule", !problems.length, {
    fields: ["reactivation_rule"], detail: problems.join("; ") || null,
  }));
  return reqs;
};

const gateNurture: GateCheck = async (_db, o) => [
  req("next_touch_on", "Next touch date", isSet(o, "next_touch_on"), { fields: ["next_touch_on"] }),
];

export const STAGE_GATES: Record<string, GateCheck> = {
  sourced: gateSourced,
  screening: gateScreening,
  research: gateResearch,
  underwriting: gateUnderwriting,
  contact: gateContact,
  negotiation: gateNegotiation,
  offer: gateOffer,
  under_contract: gateUnderContract,
  due_diligence: gateDueDiligence,
  closing: gateClosing,
  closed: gateClosed,
  dead: gateDead,
  nurture: gateNurture,
};

export const checkGate = (db: Db, o: Opportunity, stage: string) => STAGE_GATES[stage](db, o);

export const unmetOf = (reqs: Requirement[]) => reqs.filter((r) => r.blocking && !r.met);

export function nextStage(stage: string): string | null {
  const i = ACTIVE_STAGES.indexOf(stage);
  if (i >= 0) return i + 1 < ACTIVE_STAGES.length ? ACTIVE_STAGES[i + 1] : "closed";
  return null;
}

/** Returns true when this is an (authorised) override; throws when blocked. */
function enforce(unmet: Requirement[], overrideReason: string | null | undefined, actor: CurrentUser, stage: string): boolean {
  if (!unmet.length) return false;
  const detail = { unmet };
  if (!(overrideReason && overrideReason.trim())) {
    throw new HttpError(422, {
      message: `Requirements for ${label(stage)} are not met: ` + unmet.map((r) => r.label.toLowerCase()).join(", "),
      ...detail,
    });
  }
  if (!actor.can("pipeline", "approve")) {
    throw new HttpError(403, { message: "Overriding stage requirements requires pipeline approval permission", ...detail });
  }
  return true;
}

// ----------------------------------------------------------------------------- helpers

export function valueOf(o: Record<string, any>): number | null {
  for (const f of ["closed_price", "offer_price", "price_expectation", "estimated_value"]) {
    const v = o[f];
    if (v !== null && v !== undefined) return Number(v);
  }
  return null;
}

export const valueExpr = () =>
  sql<number | null>`coalesce(${opportunities.closed_price}, ${opportunities.offer_price}, ${opportunities.price_expectation}, ${opportunities.estimated_value})`;

function snapshot(o: Record<string, any>): Record<string, any> {
  const fields = [
    "title", "property_id", "owner_id", "stage", "priority", "primary_person_id", "primary_organization_id",
    "next_action", "next_action_at", "price_expectation", "estimated_value", "cap_rate", "offer_price",
    "offer_sent_at", "response_due_at", "contract_executed_on", "dd_deadline", "closing_date", "closed_price",
    "closed_on", "dead_reason", "price_gap", "reactivation_rule", "next_touch_on", "research_missing_fields",
  ];
  return toJsonable(Object.fromEntries(fields.map((f) => [f, o[f] ?? null])));
}

export async function getThresholds(db: Db): Promise<Record<string, number>> {
  const rows = new Map((await db.select().from(pipelineStageSettings)).map((r) => [r.stage, r.stall_days]));
  return Object.fromEntries(STAGES.map((s) => [s, rows.get(s) ?? DEFAULT_STALL_DAYS]));
}

export function stalledCondition(thresholds: Record<string, number>): SQL | undefined {
  const now = Date.now();
  return or(
    ...ACTIVE_STAGES.map((s) =>
      and(
        eq(opportunities.stage, s),
        lt(opportunities.stage_entered_at, new Date(now - (thresholds[s] ?? DEFAULT_STALL_DAYS) * DAY_MS)),
      ),
    ),
  );
}

export async function userNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const set = [...new Set([...ids].filter((x): x is string => !!x))];
  if (!set.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, set));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function toItems(db: Db, rows: Opportunity[], thresholds: Record<string, number>) {
  if (!rows.length) return [];
  const propIds = [...new Set(rows.map((o) => o.property_id).filter((x): x is string => !!x))];
  const props = new Map(
    propIds.length
      ? (
          await db
            .select({ id: properties.id, name: properties.name, address_line: properties.address_line, city: properties.city, state: properties.state })
            .from(properties)
            .where(inArray(properties.id, propIds))
        ).map((r) => [r.id, r])
      : [],
  );
  const names = await userNames(db, rows.map((o) => o.owner_id));
  const now = Date.now();
  return rows.map((o) => {
    const p = o.property_id ? props.get(o.property_id) : undefined;
    const age = round((now - o.stage_entered_at.getTime()) / DAY_MS, 1);
    return {
      id: o.id,
      title: o.title,
      property_id: o.property_id,
      property_label: p ? p.name || p.address_line : null,
      property_city: p ? p.city : null,
      property_state: p ? p.state : null,
      owner_id: o.owner_id,
      owner_name: o.owner_id ? (names.get(o.owner_id) ?? null) : null,
      stage: o.stage,
      stage_entered_at: o.stage_entered_at,
      stage_age_days: age,
      stalled: ACTIVE_STAGES.includes(o.stage) && age > (thresholds[o.stage] ?? DEFAULT_STALL_DAYS),
      priority: o.priority,
      source: o.source,
      next_action: o.next_action,
      next_action_at: o.next_action_at,
      value: valueOf(o),
      price_expectation: o.price_expectation,
      offer_price: o.offer_price,
      dead_reason: o.dead_reason,
      next_touch_on: o.next_touch_on,
      tags: o.tags,
      created_at: o.created_at,
      updated_at: o.updated_at,
    };
  });
}

export async function toOut(db: Db, o: Opportunity) {
  const item = (await toItems(db, [o], await getThresholds(db)))[0];
  let primary_person_label: string | null = null;
  let primary_organization_label: string | null = null;
  if (o.primary_person_id) {
    const [r] = await db.select({ n: people.full_name }).from(people).where(eq(people.id, o.primary_person_id));
    primary_person_label = r?.n ?? null;
  }
  if (o.primary_organization_id) {
    const [r] = await db.select({ n: organizations.name }).from(organizations).where(eq(organizations.id, o.primary_organization_id));
    primary_organization_label = r?.n ?? null;
  }
  return {
    ...item,
    primary_person_id: o.primary_person_id,
    primary_person_label,
    primary_organization_id: o.primary_organization_id,
    primary_organization_label,
    research_missing_fields: o.research_missing_fields,
    research_notes: o.research_notes,
    estimated_value: o.estimated_value,
    cap_rate: o.cap_rate,
    underwriting_notes: o.underwriting_notes,
    offer_sent_at: o.offer_sent_at,
    response_due_at: o.response_due_at,
    contract_executed_on: o.contract_executed_on,
    dd_deadline: o.dd_deadline,
    closing_date: o.closing_date,
    closed_price: o.closed_price,
    closed_on: o.closed_on,
    closed_snapshot: o.closed_snapshot,
    dead_notes: o.dead_notes,
    price_gap: o.price_gap,
    reactivation_rule: o.reactivation_rule,
    dead_at: o.dead_at,
    nurture_cadence_days: o.nurture_cadence_days,
    notes: o.notes,
    created_by_id: o.created_by_id,
  };
}

export async function get(db: Db, opportunity_id: string): Promise<Opportunity> {
  const o = await ormGet(db, opportunities, opportunity_id);
  if (!o || o.deleted_at) throw new HttpError(404, "Opportunity not found");
  return o;
}

// ----------------------------------------------------------------------------- queries

export interface OpportunityFilters {
  q?: string;
  stage?: string[];
  owner_id?: string[];
  priority?: string[];
  source?: string[];
  dead_reason?: string[];
  property_id?: string;
  stalled?: boolean;
  overdue?: boolean;
  min_value?: number;
  max_value?: number;
}

/** WHERE clause; every query using it must LEFT JOIN properties (the search spans property columns). */
export function buildWhere(f: OpportunityFilters, thresholds: Record<string, number>, skip: Set<string> = new Set()) {
  const o = opportunities;
  const p = properties;
  return and(
    isNull(o.deleted_at),
    applySearch(f.q, [o.title, o.source, o.next_action, p.name, p.address_line, p.city, p.county]),
    skip.has("stage") ? undefined : inFilter(o.stage, f.stage),
    skip.has("owner_id") ? undefined : inFilter(o.owner_id, f.owner_id),
    skip.has("priority") ? undefined : inFilter(o.priority, f.priority),
    skip.has("source") ? undefined : inFilter(o.source, f.source),
    skip.has("dead_reason") ? undefined : inFilter(o.dead_reason, f.dead_reason),
    f.property_id ? eq(o.property_id, f.property_id) : undefined,
    f.stalled ? stalledCondition(thresholds) : undefined,
    f.overdue ? and(lt(o.next_action_at, utcnow()), notInArray(o.stage, ["closed", "dead"])) : undefined,
    rangeFilter(valueExpr(), f.min_value, f.max_value),
  );
}

const fromJoined = (db: Db) =>
  db.select({ o: opportunities }).from(opportunities).leftJoin(properties, eq(properties.id, opportunities.property_id));

export async function listPage(db: Db, where: SQL | undefined, order: SQL[], page: number, pageSize: number) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunities)
    .leftJoin(properties, eq(properties.id, opportunities.property_id))
    .where(where);
  const rows = await fromJoined(db).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
  return { items: rows.map((r) => r.o), total: Number(n) };
}

/** Counts per distinct value of `column` within the filtered rows. */
export async function facet(db: Db, where: SQL | undefined, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(opportunities)
    .leftJoin(properties, eq(properties.id, opportunities.property_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function board(
  db: Db,
  f: OpportunityFilters,
  thresholds: Record<string, number>,
  stages: string[],
  perStage: number,
) {
  const base = buildWhere(f, thresholds, new Set(["stage"]));
  const aggRows = await db
    .select({ stage: opportunities.stage, n: sql<number>`count(*)::int`, v: sql<string | null>`sum(${valueExpr()})` })
    .from(opportunities)
    .leftJoin(properties, eq(properties.id, opportunities.property_id))
    .where(base)
    .groupBy(opportunities.stage);
  const agg = new Map(aggRows.map((r) => [r.stage, [Number(r.n), Number(r.v ?? 0)] as const]));
  const cols = [];
  for (const s of stages) {
    const rows = await fromJoined(db)
      .where(and(base, eq(opportunities.stage, s)))
      .orderBy(sql`${opportunities.next_action_at} asc nulls last`, asc(opportunities.stage_entered_at))
      .limit(perStage);
    const [count, value] = agg.get(s) ?? [0, 0];
    cols.push({
      stage: s,
      count,
      value,
      stall_days: thresholds[s] ?? DEFAULT_STALL_DAYS,
      items: await toItems(db, rows.map((r) => r.o), thresholds),
    });
  }
  return cols;
}

export async function metrics(db: Db, thresholds: Record<string, number>, owner_id?: string[]) {
  const o = opportunities;
  const live = and(isNull(o.deleted_at), owner_id?.length ? inArray(o.owner_id, owner_id) : undefined);

  const perStageRows = await db
    .select({
      stage: o.stage,
      n: sql<number>`count(*)::int`,
      v: sql<string | null>`sum(${valueExpr()})`,
      a: sql<string | null>`avg(extract(epoch from now() - ${o.stage_entered_at}) / 86400)`,
    })
    .from(o)
    .where(live)
    .groupBy(o.stage);
  const perStage = new Map(
    perStageRows.map((r) => [r.stage, { n: Number(r.n), v: Number(r.v ?? 0), a: r.a === null ? null : Number(r.a) }]),
  );
  const stalledRows = await db
    .select({ stage: o.stage, n: sql<number>`count(*)::int` })
    .from(o)
    .where(and(live, stalledCondition(thresholds)))
    .groupBy(o.stage);
  const stalledCounts = new Map(stalledRows.map((r) => [r.stage, Number(r.n)]));
  const stages = STAGES.map((s) => {
    const m = perStage.get(s);
    return {
      stage: s,
      count: m?.n ?? 0,
      value: m?.v ?? 0,
      avg_age_days: m && m.a !== null ? round(m.a, 1) : null,
      stalled: stalledCounts.get(s) ?? 0,
      stall_days: thresholds[s] ?? DEFAULT_STALL_DAYS,
    };
  });

  // Velocity: time spent in each stage = gap between entering it and the next movement.
  const ownerSql = owner_id?.length
    ? sql`and o.owner_id in (${sql.join(owner_id.map((i) => sql`${i}::uuid`), sql`, `)})`
    : sql``;
  const velRows = await raw<{ from_stage: string; avg_days: string | null; n: number }>(
    db,
    sql`select ev.from_stage, avg(extract(epoch from (ev.at - ev.prev_at)) / 86400) as avg_days, count(*)::int as n
        from (
          select e.from_stage, e.at, lag(e.at) over (partition by e.opportunity_id order by e.at) as prev_at
          from opportunity_events e join opportunities o on o.id = e.opportunity_id
          where o.deleted_at is null ${ownerSql}
        ) ev
        where ev.prev_at is not null and ev.from_stage is not null
        group by ev.from_stage`,
  );
  const vel = new Map(velRows.map((r) => [r.from_stage, { a: r.avg_days === null ? null : Number(r.avg_days), n: Number(r.n) }]));
  const velocity = ACTIVE_STAGES.map((s) => {
    const v = vel.get(s);
    return { stage: s, avg_days: v && v.a !== null ? round(v.a, 1) : null, samples: v?.n ?? 0 };
  });

  const reached = new Map<string, Set<string>>();
  for (const r of await db
    .selectDistinct({ oid: opportunityEvents.opportunity_id, st: opportunityEvents.to_stage })
    .from(opportunityEvents)
    .innerJoin(o, eq(o.id, opportunityEvents.opportunity_id))
    .where(live)) {
    if (!reached.has(r.oid)) reached.set(r.oid, new Set());
    reached.get(r.oid)!.add(r.st);
  }
  const progression = [...ACTIVE_STAGES, "closed"];
  const conversion = progression.slice(0, -1).map((s, i) => {
    const later = progression.slice(i + 1);
    const entered = [...reached.values()].filter((r) => r.has(s));
    const converted = entered.filter((r) => later.some((l) => r.has(l))).length;
    return {
      stage: s,
      next_stage: progression[i + 1],
      entered: entered.length,
      converted,
      rate: entered.length ? round(converted / entered.length, 4) : null,
    };
  });

  const stalledList = await db
    .select()
    .from(o)
    .where(and(live, stalledCondition(thresholds)))
    .orderBy(asc(o.stage_entered_at))
    .limit(50);
  const active = stages.filter((m) => ACTIVE_STAGES.includes(m.stage));
  const by = Object.fromEntries(stages.map((m) => [m.stage, m]));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const totals = {
    active_count: sum(active.map((m) => m.count)),
    active_value: sum(active.map((m) => m.value)),
    stalled_count: sum(active.map((m) => m.stalled)),
    closed_count: by.closed.count,
    closed_value: by.closed.value,
    dead_count: by.dead.count,
    nurture_count: by.nurture.count,
  };
  return { stages, velocity, conversion, stalled: await toItems(db, stalledList, thresholds), totals };
}

export async function saveThresholds(db: Db, values: Record<string, number>, actor: CurrentUser) {
  const before = await getThresholds(db);
  for (const [stage, days] of Object.entries(values)) {
    if (!ACTIVE_STAGES.includes(stage)) throw new HttpError(422, `Unknown or non-active stage '${stage}'`);
    if (!(days >= 1 && days <= 365)) throw new HttpError(422, "Stall threshold must be 1–365 days");
    const [row] = await db.select().from(pipelineStageSettings).where(eq(pipelineStageSettings.stage, stage));
    if (row) {
      await db
        .update(pipelineStageSettings)
        .set({ stall_days: days, updated_by_id: actor.id })
        .where(eq(pipelineStageSettings.stage, stage));
    } else {
      await db.insert(pipelineStageSettings).values({ stage, stall_days: days, updated_by_id: actor.id });
    }
  }
  const changes = Object.fromEntries(
    Object.entries(values)
      .filter(([s, d]) => before[s] !== d)
      .map(([s, d]) => [s, { from: before[s], to: d }]),
  );
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "pipeline.stall_thresholds_updated", entity_type: "pipeline", changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return getThresholds(db);
}

// ----------------------------------------------------------------------------- mutations

async function defaultResearchFields(db: Db, o: Pick<Opportunity, "property_id">): Promise<string[]> {
  if (!o.property_id) return [];
  const fields = new Set<string>();
  const rows = await db
    .select({ mf: buyboxEvaluations.missing_fields })
    .from(buyboxEvaluations)
    .where(
      and(
        eq(buyboxEvaluations.property_id, o.property_id),
        eq(buyboxEvaluations.is_current, true),
        eq(buyboxEvaluations.result, "insufficient_data"),
      ),
    );
  for (const r of rows) for (const f of r.mf ?? []) fields.add(f);
  return [...fields].sort();
}

/** Closed opportunity -> property becomes an owned asset. */
async function convertProperty(db: Db, o: Opportunity, actor: CurrentUser): Promise<void> {
  if (!o.property_id) return;
  const p = await ormGet(db, properties, o.property_id);
  if (!p || p.status === "owned") return;
  const old = p.status;
  await patch(db, properties, p, { status: "owned", updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "property.converted_to_asset", entity_type: "property", entity_id: p.id,
    summary: `Closed via opportunity “${o.title}”`,
    changes: { status: { from: old, to: "owned" }, opportunity_id: String(o.id) },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "property.updated", { property_id: p.id, changed: new Set(["status"]), actor });
}

async function closedSnapshot(db: Db, o: Opportunity, actor: CurrentUser) {
  const snap: Record<string, any> = { opportunity: snapshot(o), closed_by: actor.full_name, closed_recorded_at: utcnow() };
  const p = o.property_id ? await ormGet(db, properties, o.property_id) : undefined;
  if (p) {
    snap.property = Object.fromEntries(
      ["id", "name", "address_line", "city", "state", "county", "property_type", "building_area_sf", "land_area_acres",
        "asking_price", "noi", "occupancy_pct"].map((k) => [k, (p as Record<string, any>)[k]]),
    );
  }
  return toJsonable(snap);
}

async function followUpIfNeeded(db: Db, o: Opportunity, stage: string, actor: CurrentUser): Promise<void> {
  if (!["contact", "negotiation"].includes(stage) || o.next_action_at) return;
  const now = utcnow();
  await createTask(db, {
    title: `Set a dated next action: ${o.title}`,
    description: `Opportunity entered ${label(stage)} without a scheduled next action.`,
    assignee_id: o.owner_id,
    due_at: new Date(now.getTime() + DAY_MS),
    task_type: "follow_up",
    priority: "high",
    related_type: "opportunity",
    related_id: o.id,
    related_label: o.title,
    source: "pipeline",
    idempotency_key: `pipeline-next-action:${o.id}:${stage}:${Math.floor(now.getTime() / 1000)}`,
    actor_id: actor.id,
  });
}

export async function create(db: Db, data: OpportunityCreate, actor: CurrentUser, { force = false } = {}): Promise<Opportunity> {
  const p = await ormGet(db, properties, data.property_id);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  const existing = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.property_id, p.id), isNull(opportunities.deleted_at), sql`${opportunities.stage} <> 'closed'`));
  if (existing.length && !force) {
    throw new HttpError(409, {
      message: "This property already has an opportunity. Reactivate or continue it instead.",
      existing: existing.map((o) => ({ id: String(o.id), title: o.title, stage: o.stage })),
    });
  }

  // Sourced requires a current buy box evaluation: run one now if the property has none yet.
  const [{ n: hasEval }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(buyboxEvaluations)
    .where(and(eq(buyboxEvaluations.property_id, p.id), eq(buyboxEvaluations.is_current, true)));
  if (!hasEval) await evaluateProperty(db, p.id, { trigger: "opportunity_created", actor_id: actor.id });

  const now = utcnow();
  const { override_reason, title, ...rest } = data;
  const values = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const o = await insert(db, opportunities, {
    ...values,
    title: (title ?? "").trim() || p.name || p.address_line,
    stage: "sourced",
    stage_entered_at: now,
    owner_id: rest.owner_id || actor.id,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  } as never);

  const unmet = unmetOf(await checkGate(db, o, "sourced"));
  const override = enforce(unmet, override_reason, actor, "sourced");
  await insert(db, opportunityEvents, {
    opportunity_id: o.id, from_stage: null, to_stage: "sourced", actor_id: actor.id, actor_name: actor.full_name,
    at: now, override, reason: override ? (override_reason ?? null) : null, unmet, snapshot: snapshot(o),
  } as never);
  await audit.record(db, {
    actor, action: "opportunity.created", entity_type: ENTITY, entity_id: o.id,
    summary: o.title + (override ? " (gate override)" : ""),
    changes: override ? { override_reason } : null,
    ip_address: actor.ip_address,
  });
  await events.emit(db, "opportunity.created", { opportunity_id: o.id, actor });
  await db.commit();
  return o;
}

export async function update(db: Db, o: Opportunity, data: OpportunityUpdate, actor: CurrentUser): Promise<Opportunity> {
  if (o.stage === "closed") throw new HttpError(409, "Closed opportunities are an immutable transaction record");
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if ("title" in values && !values.title) delete values.title;
  const changes = diff(o, values);
  if (!Object.keys(changes).length) return o;
  const before = new Set((await checkGate(db, o, o.stage)).filter((r) => r.blocking && r.met).map((r) => r.key));
  const next = { ...o, ...values } as Opportunity;
  const broken = (await checkGate(db, next, o.stage)).filter((r) => r.blocking && !r.met && before.has(r.key));
  if (broken.length) {
    throw new HttpError(422, {
      message: "This change would remove data required for the current stage: " + broken.map((r) => r.label.toLowerCase()).join(", "),
      unmet: broken,
    });
  }
  await patch(db, opportunities, o, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "opportunity.updated", entity_type: ENTITY, entity_id: o.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return o;
}

export async function move(db: Db, o: Opportunity, data: MoveIn, actor: CurrentUser): Promise<Opportunity> {
  const to = data.to_stage;
  const frm = o.stage;
  if (frm === "closed") throw new HttpError(409, "Closed opportunities cannot change stage");
  if (to === frm) throw new HttpError(400, `Opportunity is already in ${label(to)}`);

  const values: Record<string, any> = Object.fromEntries(Object.entries(data.fields).filter(([, v]) => v !== undefined));
  if ("title" in values && !values.title) delete values.title;
  const fieldChanges = diff(o, values);
  const next = { ...o, ...values } as Opportunity;
  if (to === "research" && !next.research_missing_fields?.length) {
    next.research_missing_fields = await defaultResearchFields(db, next);
    values.research_missing_fields = next.research_missing_fields;
  }

  const unmet = unmetOf(await checkGate(db, next, to));
  const override = enforce(unmet, data.override_reason, actor, to);

  const now = utcnow();
  const set: Record<string, any> = { ...values, stage: to, stage_entered_at: now, updated_by_id: actor.id };
  Object.assign(next, { stage: to, stage_entered_at: now });
  if (to === "dead") set.dead_at = now;
  if (to === "closed") set.closed_snapshot = await closedSnapshot(db, next, actor);
  let reason = override && data.override_reason ? data.override_reason.trim() : null;
  if (!reason && to === "dead") {
    reason = (next.dead_reason ?? "").replace(/_/g, " ") + (next.dead_notes ? `: ${next.dead_notes}` : "");
  }
  await patch(db, opportunities, o, set as never);
  await insert(db, opportunityEvents, {
    opportunity_id: o.id, from_stage: frm, to_stage: to, actor_id: actor.id, actor_name: actor.full_name, at: now,
    override, reason, unmet, snapshot: snapshot(o),
  } as never);
  const changes: Record<string, any> = { stage: { from: frm, to }, ...fieldChanges };
  if (override) changes.override = { reason, unmet: unmet.map((r) => r.label) };
  await audit.record(db, {
    actor, action: "opportunity.stage_changed", entity_type: ENTITY, entity_id: o.id,
    summary: `${label(frm)} → ${label(to)}` + (override ? " (override)" : ""), changes, ip_address: actor.ip_address,
  });

  if (to === "closed") await convertProperty(db, o, actor);
  await followUpIfNeeded(db, o, to, actor);
  await events.emit(db, "opportunity.stage_changed", { opportunity_id: o.id, from_stage: frm, to_stage: to, actor });
  if (to === "dead") await events.emit(db, "opportunity.dead", { opportunity_id: o.id, actor });
  await db.commit();
  return o;
}

export async function archive(db: Db, o: Opportunity, actor: CurrentUser): Promise<void> {
  if (o.stage === "dead") throw new HttpError(409, "Dead opportunities are retained for reactivation and cannot be deleted");
  if (o.stage === "closed") throw new HttpError(409, "Closed opportunities are an immutable transaction record");
  await patch(db, opportunities, o, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "opportunity.deleted", entity_type: ENTITY, entity_id: o.id, summary: o.title,
    ip_address: actor.ip_address,
  });
  await db.commit();
}
