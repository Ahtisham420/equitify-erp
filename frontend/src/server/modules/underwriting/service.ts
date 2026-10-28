/**
 * Underwriting & financial modeling (spec module 12).
 *
 * Versioned, source-linked models. Drafts are edited in place; editing any submitted/approved/rejected/superseded
 * version creates a new draft version (prior versions are never changed). Approval checks the approver's
 * underwriting limit against the purchase price and locks the approved version; earlier approved versions of the same
 * model become `superseded`. Calculations live in `engine.ts` (pure functions).
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySearch, inFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as getRow, insert, patch, raw } from "../../db/orm";
import { users } from "../auth/schema";
import * as compsService from "../comps/service";
import { opportunities } from "../pipeline/schema";
import { properties } from "../properties/schema";
import { spaces } from "../parcels/schema";
import * as engine from "./engine";
import { asList, isoDate, pyRound, pySum, toPyDate, today, truthy, type Obj, type PyDate } from "./pyutil";
import { uwModelEvents, uwModels, type UwModel } from "./schema";
import type { AssumptionsIn, DecisionIn, ModelCreate, ModelUpdate, ScenariosIn, SimulateIn } from "./schemas";
import { leaseRow, seed, sv, TEMPLATES } from "./templates";

export const ENTITY = "uw_model";
const EDITABLE = new Set(["draft"]);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --------------------------------------------------------------------------- lookups

export async function get(db: Db, model_id: string): Promise<UwModel> {
  const m = await getRow(db, uwModels, model_id);
  if (!m || m.deleted_at) throw new HttpError(404, "Underwriting model not found");
  return m;
}

/** Public contract: the approved (locked) model version, or 422 when the version is not approved. */
export async function getApproved(db: Db, model_id: string): Promise<UwModel> {
  const m = await get(db, model_id);
  if (m.status !== "approved") throw new HttpError(422, "Underwriting model version is not approved");
  return m;
}

async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((i): i is string => !!i))];
  if (!uniq.length) return new Map();
  const rows = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

async function propertyLabels(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((i): i is string => !!i))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select({ id: properties.id, name: properties.name, address_line: properties.address_line })
    .from(properties)
    .where(inArray(properties.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name || r.address_line]));
}

async function opportunityLabel(db: Db, opp_id: string | null): Promise<string | null> {
  if (!opp_id) return null;
  const [r] = await db.select({ title: opportunities.title }).from(opportunities).where(eq(opportunities.id, opp_id)).limit(1);
  return r?.title ?? null;
}

// Optional tables owned by sibling modules are read lazily (like SQLAlchemy `Base.metadata.tables.get(name)`).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const [r] = await raw<{ ok: boolean }>(db, sql`select to_regclass(${`public.${name}`}::text) is not null as ok`);
  return !!r?.ok;
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const rows = await raw(
    db,
    sql`select 1 from information_schema.columns where table_name = ${table} and column_name = ${column} limit 1`,
  );
  return rows.length > 0;
}

/** `date` values from raw queries (string or Date depending on the driver) -> "YYYY-MM-DD". */
const rawDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
};
const rawNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// --------------------------------------------------------------------------- list

export interface ModelFilters {
  q?: string;
  status?: string[];
  template?: string[];
  property_id?: string;
  opportunity_id?: string;
  root_id?: string;
  latest_only?: boolean;
  locked?: boolean;
}

/** WHERE clause for the filters; `skip` leaves a facet's own filter out (for facet counts). */
export function buildWhere(f: ModelFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = uwModels;
  const latest_only = f.latest_only ?? true;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("template") ? undefined : inFilter(t.template, f.template),
    f.property_id ? eq(t.property_id, f.property_id) : undefined,
    f.opportunity_id ? eq(t.opportunity_id, f.opportunity_id) : undefined,
    f.root_id ? eq(t.root_id, f.root_id) : undefined,
    latest_only && !f.root_id ? eq(t.is_latest, true) : undefined,
    f.locked !== undefined && f.locked !== null ? eq(t.is_locked, f.locked) : undefined,
  );
}

export async function toItems(db: Db, rows: UwModel[]) {
  const labels = await propertyLabels(db, rows.map((r) => r.property_id));
  return rows.map((r) => {
    const o = r.outputs || {};
    return {
      id: r.id,
      root_id: r.root_id,
      name: r.name,
      template: r.template,
      version: r.version,
      status: r.status,
      is_locked: r.is_locked,
      is_latest: r.is_latest,
      property_id: r.property_id,
      opportunity_id: r.opportunity_id,
      property_label: r.property_id ? labels.get(r.property_id) ?? null : null,
      purchase_price: o.purchase_price ?? null,
      irr: o.irr ?? null,
      going_in_cap: o.going_in_cap ?? null,
      equity_multiple: o.equity_multiple ?? null,
      unsourced_count: (r.unsourced || []).length,
      approved_at: r.approved_at,
      updated_at: r.updated_at,
      created_at: r.created_at,
    };
  });
}

export async function toOut(db: Db, m: UwModel, actor?: CurrentUser | null) {
  const names = await userNames(db, [m.submitted_by_id, m.approved_by_id, m.created_by_id]);
  const property_label = m.property_id ? (await propertyLabels(db, [m.property_id])).get(m.property_id) ?? null : null;
  return {
    id: m.id,
    root_id: m.root_id,
    parent_id: m.parent_id,
    name: m.name,
    template: m.template,
    version: m.version,
    status: m.status,
    is_locked: m.is_locked,
    is_latest: m.is_latest,
    change_note: m.change_note,
    property_id: m.property_id,
    opportunity_id: m.opportunity_id,
    comp_set_id: m.comp_set_id,
    property_label,
    opportunity_label: await opportunityLabel(db, m.opportunity_id),
    assumptions: m.assumptions,
    scenarios: m.scenarios,
    outputs: m.outputs,
    annual: m.annual,
    warnings: m.warnings,
    unsourced: m.unsourced,
    simulation: m.simulation ?? null,
    calculated_at: m.calculated_at,
    submitted_by_id: m.submitted_by_id,
    submitted_by_name: m.submitted_by_id ? names.get(m.submitted_by_id) ?? null : null,
    submitted_at: m.submitted_at,
    approved_by_id: m.approved_by_id,
    approved_by_name: m.approved_by_id ? names.get(m.approved_by_id) ?? null : null,
    approved_at: m.approved_at,
    rejected_by_id: m.rejected_by_id,
    rejected_at: m.rejected_at,
    decision_note: m.decision_note,
    created_by_id: m.created_by_id,
    created_by_name: m.created_by_id ? names.get(m.created_by_id) ?? null : null,
    created_at: m.created_at,
    updated_at: m.updated_at,
    can_approve_amount: actor
      ? actor.can("underwriting", "approve") && actor.canApprove("underwriting", (m.outputs || {}).purchase_price)
      : false,
  };
}

// --------------------------------------------------------------------------- calculation

function calculate(assumptions: Obj, scenarios: Obj[]): [Obj, Obj[]] {
  try {
    const result = engine.run(assumptions);
    const scen_out: Obj[] = [];
    for (const s of scenarios) {
      const outputs = !truthy(s.overrides) ? result.outputs : engine.run(engine.applyOverrides(assumptions, s.overrides)).outputs;
      scen_out.push({
        ...s,
        outputs: Object.fromEntries(Object.entries(outputs).filter(([, v]) => !Array.isArray(v))),
      });
    }
    return [result, scen_out];
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, `Calculation failed: ${errMsg(e)}`);
  }
}

/** Re-run the engine for the base case and every scenario; updates `m` in memory and returns the column values to persist. */
export function recalc(m: UwModel) {
  const a = m.assumptions || {};
  const [result, scenarios] = calculate(a, [...(m.scenarios || [])]);
  const values = {
    outputs: result.outputs as Obj,
    annual: result.annual as Obj[],
    warnings: result.warnings as string[],
    scenarios,
    unsourced: engine.unsourced(a) as Obj[],
    calculated_at: utcnow(),
  };
  Object.assign(m, values);
  return values;
}

async function addEvent(
  db: Db,
  m: UwModel,
  action: string,
  actor: CurrentUser | null | undefined,
  note: string | null = null,
  details: Obj = {},
): Promise<void> {
  await db.insert(uwModelEvents).values({
    model_id: m.id,
    root_id: m.root_id,
    action,
    actor_id: actor?.id ?? null,
    actor_name: actor?.full_name ?? null,
    note,
    details: audit.toJsonable(details),
  });
}

// --------------------------------------------------------------------------- seeding

/** Seed lease rows from the leases module when installed (lazy, via table metadata), else from spaces. */
async function tenantRows(db: Db, template: string, property_id: string | null | undefined, mode: string, start: PyDate): Promise<Obj[]> {
  const rows: Obj[] = [];
  if (template === "land") return rows;
  const startIso = isoDate(start);
  if (property_id && (mode === "auto" || mode === "leases")) {
    if (await tableExists(db, "leases")) {
      const softDeleted = (await hasColumn(db, "leases", "deleted_at")) ? sql` and deleted_at is null` : sql``;
      const leaseRows = await raw(
        db,
        sql`select * from leases where property_id = ${property_id} and status in ('active', 'draft')${softDeleted}`,
      );
      const stepsExist = await tableExists(db, "rent_steps");
      for (const lease of leaseRows) {
        let steps: Obj[] = [];
        if (stepsExist) {
          steps = (await raw(db, sql`select * from rent_steps where lease_id = ${lease.id} order by start_on`)).map((s) => ({
            ...s,
            start_on: rawDate(s.start_on),
            annual_rent: rawNum(s.annual_rent),
          }));
        }
        let current: Obj | null = null;
        for (const s of steps) if (s.start_on && s.start_on <= startIso) current = s;
        current = current || (steps.length ? steps[0] : null);
        const verified = lease.verified ? " (verified)" : "";
        rows.push(
          leaseRow(template, {
            tenant: lease.tenant_name ?? null,
            space_id: lease.space_id ? String(lease.space_id) : null,
            lease_id: String(lease.id),
            area_sf: lease.rentable_sf !== null && lease.rentable_sf !== undefined ? Number(lease.rentable_sf) : null,
            base_rent_annual: current && current.annual_rent !== null && current.annual_rent !== undefined ? Number(current.annual_rent) : null,
            rent_source: current ? `Lease abstract${verified}` : null,
            commencement_on: rawDate(lease.commencement_on),
            expiration_on: rawDate(lease.expiration_on),
            rent_steps: steps
              .filter((s) => s.start_on && s.start_on > startIso && s.annual_rent !== null && s.annual_rent !== undefined)
              .map((s) => ({ start_on: s.start_on, annual_rent: Number(s.annual_rent) })),
            source: "lease",
          }),
        );
      }
      if (rows.length || mode === "leases") return rows;
    }
  }
  if (property_id && (mode === "auto" || mode === "spaces")) {
    const list = await db
      .select()
      .from(spaces)
      .where(and(eq(spaces.property_id, property_id), isNull(spaces.deleted_at)))
      .orderBy(spaces.suite);
    for (const s of list) {
      rows.push(
        leaseRow(template, {
          tenant: s.tenant_name, suite: s.suite, space_id: String(s.id), area_sf: s.area_sf,
          vacant: s.occupancy_status === "vacant", source: "space",
        }),
      );
    }
  }
  if (!rows.length && mode !== "none") rows.push(leaseRow(template, { source: "manual" }));
  return rows;
}

/** Seed exit cap (sale comp set on cap-rate basis) or market rent (lease comp set) with comp evidence. */
async function applyCompSet(db: Db, a: Obj, comp_set_id: string): Promise<void> {
  const summary = await compsService.compSetSummary(db, comp_set_id);
  if (!summary || summary.metric_point === null || summary.metric_point === undefined) return;
  const evidence = {
    comp_set_id,
    comp_ids: summary.comp_ids,
    comp_id: summary.comp_ids.length ? summary.comp_ids[0] : null,
  };
  const source = `Comp set: ${summary.name}`;
  if (summary.kind === "sale" && summary.value_basis === "cap_rate" && "exit" in a) {
    a.exit.exit_cap = sv(pyRound(summary.metric_point, 3), source, evidence);
  } else if (summary.kind === "lease") {
    for (const lease of asList(a.leases)) {
      if (!engine.hasVal(lease.market_rent_psf)) lease.market_rent_psf = sv(pyRound(summary.metric_point, 2), source, evidence);
    }
  }
}

// --------------------------------------------------------------------------- create / edit / versions

export async function create(db: Db, data: ModelCreate, actor: CurrentUser): Promise<UwModel> {
  let prop: typeof properties.$inferSelect | undefined;
  if (data.property_id) {
    prop = await getRow(db, properties, data.property_id);
    if (!prop || prop.deleted_at) throw new HttpError(404, "Property not found");
  }
  const start = (data.analysis_start ? toPyDate(data.analysis_start) : null) ?? today();
  const assumptions = seed(data.template, {
    start,
    purchase_price: prop ? prop.asking_price : null,
    price_source: prop && prop.asking_price ? "Property record: asking price" : null,
    total_area_sf: prop ? prop.building_area_sf : null,
    area_source: prop && prop.building_area_sf ? "Property record" : null,
    gross_acres: prop ? prop.land_area_acres : null,
    acres_source: prop && prop.land_area_acres ? "Property record" : null,
  });
  const scenarios = assumptions.scenarios_seed ?? [];
  delete assumptions.scenarios_seed;
  if (TEMPLATES[data.template].model_type === "income") {
    assumptions.leases = await tenantRows(db, data.template, data.property_id, data.seed_tenants, start);
  }
  if (data.comp_set_id) await applyCompSet(db, assumptions, data.comp_set_id);

  const m = await insert(db, uwModels, {
    name: data.name,
    template: data.template,
    property_id: data.property_id ?? null,
    opportunity_id: data.opportunity_id ?? null,
    comp_set_id: data.comp_set_id ?? null,
    version: 1,
    is_latest: true,
    status: "draft",
    is_locked: false,
    assumptions,
    scenarios: structuredClone(scenarios),
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  m.root_id = m.id;
  await patch(db, uwModels, m, { root_id: m.id, ...recalc(m) });
  await addEvent(db, m, "created", actor, null, { template: data.template });
  await audit.record(db, {
    actor, action: "uw_model.created", entity_type: ENTITY, entity_id: m.id,
    summary: `${m.name} v1 (${TEMPLATES[data.template].label})`, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

async function nextVersion(db: Db, root_id: string): Promise<number> {
  const [r] = await db.select({ v: sql<number | null>`max(${uwModels.version})` }).from(uwModels).where(eq(uwModels.root_id, root_id));
  return Number(r?.v ?? 0) + 1;
}

/** Copy a version into a new draft version; the source version is left untouched. */
export async function newVersion(
  db: Db,
  src: UwModel,
  actor: CurrentUser,
  o: { note: string | null | undefined; assumptions?: Obj | null; scenarios?: Obj[] | null; commit?: boolean },
): Promise<UwModel> {
  const { note, assumptions, scenarios } = o;
  const commit = o.commit ?? true;
  const root = src.root_id || src.id;
  const version = await nextVersion(db, root);
  await db.update(uwModels).set({ is_latest: false }).where(eq(uwModels.root_id, root));
  const m = await insert(db, uwModels, {
    root_id: root,
    parent_id: src.id,
    property_id: src.property_id,
    opportunity_id: src.opportunity_id,
    comp_set_id: src.comp_set_id,
    version,
    is_latest: true,
    name: src.name,
    template: src.template,
    status: "draft",
    is_locked: false,
    change_note: note ?? null,
    assumptions: structuredClone(assumptions ?? src.assumptions),
    scenarios: structuredClone(scenarios ?? src.scenarios),
    created_by_id: actor.id,
    updated_by_id: actor.id,
  });
  await patch(db, uwModels, m, recalc(m));
  await addEvent(db, m, "versioned", actor, note ?? null, { from_version: src.version, from_id: src.id });
  await audit.record(db, {
    actor, action: "uw_model.versioned", entity_type: ENTITY, entity_id: m.id,
    summary: `${m.name} v${version} from v${src.version}`, changes: { note }, ip_address: actor.ip_address,
  });
  if (commit) await db.commit();
  return m;
}

function normalize(m: UwModel, a: Obj): Obj {
  const out = structuredClone(a);
  out.template = m.template;
  out.model_type = TEMPLATES[m.template]?.model_type ?? "income";
  return out;
}

export async function saveAssumptions(db: Db, m: UwModel, data: AssumptionsIn, actor: CurrentUser): Promise<UwModel> {
  const assumptions = normalize(m, data.assumptions);
  if (!EDITABLE.has(m.status)) {
    return newVersion(db, m, actor, { note: data.change_note || `Edited from v${m.version}`, assumptions });
  }
  const changes = engine.diffAssumptions(m.assumptions || {}, assumptions);
  if (!changes.length) return m;
  m.assumptions = assumptions;
  const set: Obj = { assumptions, updated_by_id: actor.id };
  if (data.change_note) set.change_note = data.change_note;
  Object.assign(m, set);
  Object.assign(set, recalc(m));
  await patch(db, uwModels, m, set as never);
  await audit.record(db, {
    actor, action: "uw_model.assumptions_updated", entity_type: ENTITY, entity_id: m.id,
    changes: { assumptions: changes.slice(0, 200) }, summary: `${changes.length} assumption changes`, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

function cleanScenarios(data: ScenariosIn): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<string>();
  for (const s of data.scenarios) {
    let key = (s.key || s.name).trim().toLowerCase().replace(/ /g, "_").slice(0, 60) || randomUUID().replace(/-/g, "").slice(0, 8);
    while (seen.has(key)) key = `${key}_${randomUUID().replace(/-/g, "").slice(0, 4)}`;
    seen.add(key);
    out.push({ key, name: s.name, kind: s.kind, overrides: s.kind !== "base" ? s.overrides : {} });
  }
  if (!out.some((s) => s.kind === "base")) out.unshift({ key: "base", name: "Base", kind: "base", overrides: {} });
  return out;
}

export async function saveScenarios(db: Db, m: UwModel, data: ScenariosIn, actor: CurrentUser): Promise<UwModel> {
  const scenarios = cleanScenarios(data);
  if (!EDITABLE.has(m.status)) {
    return newVersion(db, m, actor, { note: data.change_note || `Scenarios edited from v${m.version}`, scenarios });
  }
  const before = (m.scenarios || []).map((s) => Object.fromEntries(["key", "name", "kind", "overrides"].map((k) => [k, s[k] ?? null])));
  m.scenarios = scenarios;
  const set: Obj = { scenarios, updated_by_id: actor.id };
  Object.assign(m, set);
  Object.assign(set, recalc(m));
  await patch(db, uwModels, m, set as never);
  await audit.record(db, {
    actor, action: "uw_model.scenarios_updated", entity_type: ENTITY, entity_id: m.id,
    changes: { scenarios: { from: before, to: scenarios } }, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

export async function updateMeta(db: Db, m: UwModel, data: ModelUpdate, actor: CurrentUser): Promise<UwModel> {
  if (m.is_locked) throw new HttpError(409, "Approved versions are locked");
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const changes = audit.diff(m, values);
  if (!Object.keys(changes).length) return m;
  await patch(db, uwModels, m, { ...values, updated_by_id: actor.id } as never);
  await audit.record(db, {
    actor, action: "uw_model.updated", entity_type: ENTITY, entity_id: m.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

export async function recalculate(db: Db, m: UwModel, actor: CurrentUser): Promise<UwModel> {
  if (!EDITABLE.has(m.status)) throw new HttpError(409, "Only draft versions are recalculated; create a new version");
  await patch(db, uwModels, m, { ...recalc(m), updated_by_id: actor.id });
  await db.commit();
  return m;
}

export async function archive(db: Db, m: UwModel, actor: CurrentUser): Promise<void> {
  if (m.status !== "draft") throw new HttpError(409, "Only draft versions can be deleted; others are retained as history");
  let wasLatest = false;
  if (m.is_latest && m.root_id) {
    wasLatest = true;
    const [prev] = await db
      .select()
      .from(uwModels)
      .where(and(eq(uwModels.root_id, m.root_id), ne(uwModels.id, m.id), isNull(uwModels.deleted_at)))
      .orderBy(desc(uwModels.version))
      .limit(1);
    if (prev) await patch(db, uwModels, prev, { is_latest: true });
  }
  await patch(db, uwModels, m, { deleted_at: utcnow(), updated_by_id: actor.id, ...(wasLatest ? { is_latest: false } : {}) });
  await audit.record(db, {
    actor, action: "uw_model.deleted", entity_type: ENTITY, entity_id: m.id, summary: `${m.name} v${m.version}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// --------------------------------------------------------------------------- approval workflow

export async function submit(db: Db, m: UwModel, data: DecisionIn, actor: CurrentUser): Promise<UwModel> {
  if (m.status !== "draft") throw new HttpError(409, `A ${m.status} version cannot be submitted`);
  const calc = recalc(m);
  if (!(m.outputs || {}).purchase_price) throw new HttpError(422, "Purchase price is required before submitting");
  await patch(db, uwModels, m, {
    ...calc, status: "submitted", submitted_by_id: actor.id, submitted_at: utcnow(), decision_note: null, updated_by_id: actor.id,
  });
  await addEvent(db, m, "submitted", actor, data.note ?? null, {
    unsourced: (m.unsourced || []).length, purchase_price: m.outputs.purchase_price,
  });
  await audit.record(db, {
    actor, action: "uw_model.submitted", entity_type: ENTITY, entity_id: m.id, summary: `${m.name} v${m.version}`,
    changes: { unsourced: m.unsourced }, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

export async function approve(db: Db, m: UwModel, data: DecisionIn, actor: CurrentUser): Promise<UwModel> {
  if (m.status !== "submitted") throw new HttpError(409, "Only submitted versions can be approved");
  const amount = (m.outputs || {}).purchase_price ?? null;
  if (!actor.canApprove("underwriting", amount)) {
    throw new HttpError(403, "Purchase price exceeds your underwriting approval limit");
  }
  if (m.unsourced && m.unsourced.length && !data.acknowledge_unsourced) {
    throw new HttpError(422, {
      message: `${m.unsourced.length} material assumptions are unsourced; acknowledge to approve`,
      unsourced: m.unsourced,
    });
  }
  const root = m.root_id || m.id;
  const superseded = await db
    .select()
    .from(uwModels)
    .where(and(eq(uwModels.root_id, root), eq(uwModels.status, "approved"), ne(uwModels.id, m.id)));
  for (const prev of superseded) {
    await patch(db, uwModels, prev, { status: "superseded" });
    await addEvent(db, prev, "superseded", actor, `Superseded by v${m.version}`);
  }
  await patch(db, uwModels, m, {
    status: "approved", is_locked: true, approved_by_id: actor.id, approved_at: utcnow(),
    decision_note: data.note ?? null, updated_by_id: actor.id,
  });
  await addEvent(db, m, "approved", actor, data.note ?? null, {
    purchase_price: amount, unsourced: (m.unsourced || []).length, acknowledged_unsourced: data.acknowledge_unsourced,
  });
  await audit.record(db, {
    actor, action: "uw_model.approved", entity_type: ENTITY, entity_id: m.id, summary: `${m.name} v${m.version}`,
    changes: { purchase_price: amount, note: data.note ?? null, superseded: superseded.map((p) => p.id) },
    ip_address: actor.ip_address,
  });
  await events.emit(db, "uw_model.approved", {
    model_id: m.id, property_id: m.property_id, opportunity_id: m.opportunity_id, actor,
  });
  await db.commit();
  return m;
}

export async function reject(db: Db, m: UwModel, data: DecisionIn, actor: CurrentUser): Promise<UwModel> {
  if (m.status !== "submitted") throw new HttpError(409, "Only submitted versions can be rejected");
  if (!(data.note || "").trim()) throw new HttpError(422, "A rejection reason is required");
  await patch(db, uwModels, m, {
    status: "rejected", rejected_by_id: actor.id, rejected_at: utcnow(), decision_note: data.note ?? null, updated_by_id: actor.id,
  });
  await addEvent(db, m, "rejected", actor, data.note ?? null);
  await audit.record(db, {
    actor, action: "uw_model.rejected", entity_type: ENTITY, entity_id: m.id, summary: `${m.name} v${m.version}`,
    changes: { note: data.note ?? null }, ip_address: actor.ip_address,
  });
  await db.commit();
  return m;
}

// --------------------------------------------------------------------------- versions / diff

export async function versions(db: Db, m: UwModel) {
  const rows = await db
    .select()
    .from(uwModels)
    .where(and(eq(uwModels.root_id, m.root_id || m.id), isNull(uwModels.deleted_at)))
    .orderBy(desc(uwModels.version));
  const names = await userNames(db, rows.map((r) => r.created_by_id));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    is_locked: r.is_locked,
    is_latest: r.is_latest,
    change_note: r.change_note,
    created_by_name: r.created_by_id ? names.get(r.created_by_id) ?? null : null,
    created_at: r.created_at,
    approved_at: r.approved_at,
    purchase_price: (r.outputs || {}).purchase_price ?? null,
    irr: (r.outputs || {}).irr ?? null,
  }));
}

const DIFF_OUTPUTS = [
  "purchase_price", "noi_year1", "going_in_cap", "stabilized_cap", "loan_amount", "dscr", "debt_yield",
  "cash_on_cash", "unlevered_irr", "irr", "equity_multiple", "exit_value", "peak_equity", "breakeven_occupancy", "profit",
];

export async function diff(db: Db, m: UwModel, other_id: string | null | undefined) {
  let other: UwModel;
  if (other_id) {
    other = await get(db, other_id);
    if ((other.root_id || other.id) !== (m.root_id || m.id)) throw new HttpError(422, "Versions belong to different models");
  } else if (m.parent_id) {
    other = await get(db, m.parent_id);
  } else {
    throw new HttpError(422, "No earlier version to compare against");
  }
  const outs: Obj[] = [];
  for (const k of DIFF_OUTPUTS) {
    const a = (other.outputs || {})[k] ?? null;
    const b = (m.outputs || {})[k] ?? null;
    if (a !== b) {
      outs.push({ key: k, from: a, to: b, delta: typeof a === "number" && typeof b === "number" ? b - a : null });
    }
  }
  return {
    base_id: other.id,
    other_id: m.id,
    base_version: other.version,
    other_version: m.version,
    assumptions: engine.diffAssumptions(other.assumptions || {}, m.assumptions || {}),
    outputs: outs,
  };
}

export async function eventsFor(db: Db, m: UwModel) {
  const rows = await db
    .select()
    .from(uwModelEvents)
    .where(eq(uwModelEvents.root_id, m.root_id || m.id))
    .orderBy(desc(uwModelEvents.at));
  return rows.map((e) => ({
    id: e.id, model_id: e.model_id, action: e.action, actor_name: e.actor_name, at: e.at, note: e.note, details: e.details,
  }));
}

// --------------------------------------------------------------------------- analysis

function scenarioAssumptions(m: UwModel, scenario_key: string | null | undefined): Obj {
  let a = m.assumptions || {};
  if (scenario_key) {
    const s = (m.scenarios || []).find((x) => x.key === scenario_key);
    if (!s) throw new HttpError(404, "Scenario not found");
    a = engine.applyOverrides(a, s.overrides);
  }
  return a;
}

export function sensitivity(m: UwModel, metric: string, scenario_key: string | null | undefined, steps: Record<string, number>) {
  const a = scenarioAssumptions(m, scenario_key);
  try {
    return engine.sensitivity(a, metric, steps);
  } catch (e) {
    throw new HttpError(422, `Sensitivity failed: ${errMsg(e)}`);
  }
}

export async function simulate(db: Db, m: UwModel, data: SimulateIn, actor: CurrentUser) {
  const a = scenarioAssumptions(m, data.scenario_key);
  let result: Obj;
  try {
    result = engine.simulate(
      a,
      data.ranges.map((r) => ({ path: r.path, label: r.label ?? null, min: r.min, max: r.max, mode: r.mode ?? null })),
      data.iterations,
      data.seed,
      ["irr", "equity_multiple", "exit_value", "noi_year1", "profit"],
      data.target_irr ?? null,
    );
  } catch (e) {
    throw new HttpError(422, `Simulation failed: ${errMsg(e)}`);
  }
  result.run_at = utcnow().toISOString();
  result.run_by = actor.full_name;
  result.stored = !m.is_locked && actor.can("underwriting", "edit");
  if (result.stored) await patch(db, uwModels, m, { simulation: result, updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "uw_model.simulated", entity_type: ENTITY, entity_id: m.id,
    summary: `${result.iterations} iterations, seed ${data.seed}`, ip_address: actor.ip_address,
  });
  await db.commit();
  return result;
}

/** Actual (asset_financials) vs approved underwriting by analysis year. Reads the assets module lazily. */
export async function variance(db: Db, m: UwModel) {
  if (!["approved", "superseded"].includes(m.status)) {
    const [approved] = await db
      .select()
      .from(uwModels)
      .where(and(eq(uwModels.root_id, m.root_id || m.id), eq(uwModels.status, "approved"), isNull(uwModels.deleted_at)))
      .limit(1);
    if (!approved) throw new HttpError(422, "Variance is measured against an approved version");
    m = approved;
  }
  const base = { model_id: m.id, version: m.version, available: false, rows: [] as Obj[], asset_id: null as string | null };
  if (!(await tableExists(db, "assets")) || !(await tableExists(db, "asset_financials"))) {
    return { ...base, reason: "Asset management is not available yet; actuals will appear after closing." };
  }
  const [byModel] = await raw(db, sql`select id from assets where uw_model_id = ${m.id} limit 1`);
  let asset_id: string | null = byModel?.id ?? null;
  if (!asset_id && m.property_id) {
    const [byProp] = await raw(db, sql`select id from assets where property_id = ${m.property_id} limit 1`);
    asset_id = byProp?.id ?? null;
  }
  if (!asset_id) return { ...base, reason: "No owned asset is linked to this model or its property." };

  const start = engine.parseDate(((m.assumptions || {}).acquisition || {}).analysis_start) ?? today();
  const first = { ...start, day: 1 };
  const rows = await raw(
    db,
    sql`select period, category, sum(amount) as total from asset_financials where asset_id = ${asset_id} group by period, category`,
  );
  const actual = new Map<number, Map<string, number>>();
  const months = new Map<number, Set<string>>();
  for (const r of rows) {
    const period = toPyDate(rawDate(r.period));
    if (!period) continue;
    const idx = engine.monthIndex(first, period);
    if (idx < 0) continue;
    const year = Math.floor(idx / 12) + 1;
    if (!actual.has(year)) actual.set(year, new Map());
    const bucket = actual.get(year)!;
    bucket.set(r.category, (bucket.get(r.category) ?? 0.0) + Number(r.total ?? 0));
    if (!months.has(year)) months.set(year, new Set());
    months.get(year)!.add(`${period.year}-${period.month}`);
  }

  const vr = (uw: number | null, act: number | null | undefined) => {
    const a = act ?? null;
    const d = uw !== null && a !== null ? a - uw : null;
    return { uw, actual: a, variance: d, variance_pct: d !== null && uw ? (d / Math.abs(uw)) * 100 : null };
  };

  const outRows: Obj[] = [];
  for (const row of m.annual || []) {
    const y = row.year;
    if (!actual.has(y)) continue;
    const nMonths = months.get(y)?.size ?? 0;
    const frac = nMonths / 12;
    const a = actual.get(y)!;
    const income = a.get("income") ?? 0.0;
    const expense = a.get("expense") ?? 0.0;
    const uw_income = "egr" in row ? row.egr : row.revenue ?? null;
    const uw_opex = "opex" in row ? row.opex : (row.development || 0) + (row.carry || 0);
    const uw_capex = pySum(["ti", "lc", "reserves", "capex"].map((k) => row[k] || 0));
    const scale = (v: number | null | undefined) => (v !== null && v !== undefined ? v * frac : null);
    outRows.push({
      year: y,
      months_actual: nMonths,
      income: vr(scale(uw_income), income),
      expense: vr(scale(uw_opex), expense),
      noi: vr(scale(row.noi), a.has("income") || a.has("expense") ? income - expense : null),
      capex: vr(scale(uw_capex), a.get("capex")),
      debt_service: vr(scale(row.debt_service), a.get("debt_service")),
    });
  }
  return {
    ...base,
    available: true,
    asset_id: String(asset_id),
    rows: outRows,
    reason: outRows.length ? null : "No actuals recorded yet for the modeled years.",
  };
}

