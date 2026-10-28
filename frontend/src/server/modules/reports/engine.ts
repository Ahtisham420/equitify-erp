/**
 * Metric engine (spec 34): common filters, evaluation context, the KPI definition type and the SQL that
 * evaluates a KPI.
 *
 * One KPI definition drives its tile value, chart breakdowns, drill-through records and exports, so a metric
 * means the same thing everywhere it appears. Every source module is optional: a KPI whose module is not
 * installed, whose table is missing or whose permission the user lacks is simply unavailable.
 *
 * KPI definitions receive `M`, the Drizzle table of their source model (columns are keyed by DB column name),
 * and build SQL fragments with the small helpers below instead of SQLAlchemy expressions.
 */
import { eq, getTableName, isNull, sql, type SQL } from "drizzle-orm";

import { toJsonable } from "../../common/audit";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { raw } from "../../db/orm";

export const NONE = "__none__"; // filter / facet value meaning "not set"
export const UNITS = ["count", "currency", "percent", "days", "number"];
export const FAMILIES = [
  "sourcing", "outreach", "pipeline", "offers", "contracts", "closings", "portfolio", "operations",
  "brokerage", "data", "reactivation",
];
export const DATE_PRESETS = [7, 30, 90, 365];

// ============================================================================ lazy module resolution

/** Source modules, imported lazily so that a module that is not installed only disables its own KPIs. */
const LOADERS: Record<string, () => Promise<any>> = {
  "properties.models": () => import("../properties/schema"),
  "pipeline.models": () => import("../pipeline/schema"),
  "signals.models": () => import("../signals/schema"),
  "scoring.models": () => import("../scoring/schema"),
  "outreach.models": () => import("../outreach/schema"),
  "tasks.models": () => import("../tasks/schema"),
  "offers.models": () => import("../offers/schema"),
  "contracts.models": () => import("../contracts/schema"),
  "closing.models": () => import("../closing/schema"),
  "assets.models": () => import("../assets/schema"),
  "leases.models": () => import("../leases/schema"),
  "receivables.models": () => import("../receivables/schema"),
  "debt.models": () => import("../debt/schema"),
  "maintenance.models": () => import("../maintenance/schema"),
  "operations.models": () => import("../operations/schema"),
  "brokerage.models": () => import("../brokerage/schema"),
  "commissions.models": () => import("../commissions/schema"),
  "imports.models": () => import("../imports/schema"),
  "reactivation.models": () => import("../reactivation/schema"),
  "compliance.models": () => import("../compliance/schema"),
  "territories.models": () => import("../territories/schema"),
  "territories.service": () => import("../territories/service"),
  "auth.models": () => import("../auth/schema"),
  "app.common.provenance": () => import("../../common/schema"),
};

/** Python `module:Name` -> TS export name, where the rule (table name -> lowerCamelCase / camelCase function) applies. */
const EXPORT_NAMES: Record<string, string> = {
  "properties.models:Property": "properties",
  "pipeline.models:Opportunity": "opportunities",
  "pipeline.models:PipelineStageSetting": "pipelineStageSettings",
  "pipeline.models:OpportunityEvent": "opportunityEvents",
  "signals.models:Signal": "signals",
  "scoring.models:OpportunityScore": "opportunityScores",
  "outreach.models:Interaction": "interactions",
  "tasks.models:Task": "tasks",
  "tasks.models:Alert": "alerts",
  "offers.models:Offer": "offers",
  "contracts.models:Contract": "contracts",
  "contracts.models:CriticalDate": "criticalDates",
  "contracts.models:DDItem": "ddItems",
  "contracts.models:RiskItem": "riskItems",
  "closing.models:Closing": "closings",
  "closing.models:WireVerification": "wireVerifications",
  "assets.models:Asset": "assets",
  "assets.models:WatchlistEntry": "watchlistEntries",
  "leases.models:Lease": "leases",
  "leases.models:LeaseOption": "leaseOptions",
  "receivables.models:Charge": "charges",
  "receivables.models:Payment": "payments",
  "debt.models:Loan": "loans",
  "debt.models:LenderReportingObligation": "lenderReportingObligations",
  "maintenance.models:WorkOrder": "workOrders",
  "maintenance.models:PMSchedule": "pmSchedules",
  "maintenance.models:InspectionFinding": "inspectionFindings",
  "maintenance.models:Inspection": "inspections",
  "operations.models:Vendor": "vendors",
  "operations.models:VendorCredential": "vendorCredentials",
  "operations.models:InsurancePolicy": "insurancePolicies",
  "operations.models:InsuranceCertificate": "insuranceCertificates",
  "operations.models:CapitalProject": "capitalProjects",
  "operations.models:TaxPayment": "taxPayments",
  "brokerage.models:Listing": "listings",
  "brokerage.models:Inquiry": "inquiries",
  "brokerage.models:Showing": "showings",
  "brokerage.models:BrokerageDeal": "brokerageDeals",
  "commissions.models:Commission": "commissions",
  "commissions.models:CommissionSplit": "commissionSplits",
  "imports.models:ImportRow": "importRows",
  "imports.models:ImportJob": "importJobs",
  "imports.models:DataSource": "dataSources",
  "reactivation.models:ReactivationItem": "reactivationItems",
  "reactivation.models:ReactivationTrigger": "reactivationTriggers",
  "compliance.models:OutboundMessage": "outboundMessages",
  "compliance.models:ConsentEvent": "consentEvents",
  "compliance.models:ComplianceRecord": "complianceRecords",
  "compliance.models:ProviderRestriction": "providerRestrictions",
  "territories.models:Territory": "territories",
  "territories.models:TerritoryMember": "territoryMembers",
  "territories.service:visible_clause": "visibleClause",
  "auth.models:User": "users",
  "auth.models:Team": "teams",
  "app.common.provenance:FieldObservation": "fieldObservations",
};

const g = globalThis as unknown as { __eqfReportMods?: Map<string, any>; __eqfReportTried?: Map<string, number> };
const mods = (g.__eqfReportMods ??= new Map<string, any>());
const tried = (g.__eqfReportTried ??= new Map<string, number>());
const RETRY_MS = 30_000;

/** Import every source module that is not loaded yet (failures are retried at most every 30s). Call before `load`. */
export async function preload(): Promise<void> {
  const now = Date.now();
  await Promise.all(
    Object.entries(LOADERS).map(async ([name, loader]) => {
      if (mods.has(name) || now - (tried.get(name) ?? -Infinity) < RETRY_MS) return;
      tried.set(name, now);
      try {
        mods.set(name, await loader());
      } catch {
        /* module not installed */
      }
    }),
  );
}

/** Resolve `module.path:Name` (after `preload()`); `null` when the module or the name does not exist. */
export function load(ref: string): any {
  const [mod, name] = ref.split(":");
  const m = mods.get(mod);
  if (!m) return null;
  return m[EXPORT_NAMES[ref] ?? name] ?? null;
}

// ============================================================================ dates (ISO "YYYY-MM-DD" strings, UTC)

const DAY_MS = 86_400_000;
const isoToMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const msToIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => msToIso(isoToMs(d) + n * DAY_MS);
export const diffDays = (a: string, b: string) => Math.round((isoToMs(a) - isoToMs(b)) / DAY_MS);
export const maxDate = (a: string, b: string) => (a >= b ? a : b);
export const minDate = (a: string, b: string) => (a <= b ? a : b);

/** `date.fromisoformat`: strict YYYY-MM-DD, real calendar date. */
function parseIsoDate(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || msToIso(isoToMs(v)) !== v) throw new Error("date");
  return v;
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** `uuid.UUID(value)`: canonical lowercase hyphenated form, or throws. */
function parseUuid(v: string): string {
  if (!UUID_RE.test(v)) throw new Error("uuid");
  const h = v.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ============================================================================ filters

const LIST_KEYS = ["user", "property_type", "state", "county", "source", "stage"] as const;

/** Filters shared by every dashboard and KPI (date, user/team, property type, geography, territory,
 *  source, stage) plus KPI-specific facets (`f_<name>`) used for drill-through from breakdowns. */
export class Filters {
  date_from: string | null = null;
  date_to: string | null = null;
  days: number | null = null;
  user: string[] = [];
  team: string | null = null;
  property_type: string[] = [];
  state: string[] = [];
  county: string[] = [];
  territory: string | null = null;
  source: string[] = [];
  stage: string[] = [];
  facets: Record<string, string> = {};

  static LIST_KEYS = LIST_KEYS;

  static parse(items: Iterable<[string, string]>): Filters {
    const multi = new Map<string, string[]>();
    for (const [key, raw0] of items) {
      const value = (raw0 ?? "").trim();
      if (value) {
        const list = multi.get(key) ?? [];
        list.push(value.slice(0, 200));
        multi.set(key, list);
      }
    }
    const one = (key: string): string | null => {
      const values = multi.get(key);
      return values && values.length ? values[values.length - 1] : null;
    };

    const out = new Filters();
    try {
      const daysRaw = one("days");
      let days: number | null = null;
      if (daysRaw && daysRaw !== "all") {
        if (!/^[+-]?\d+$/.test(daysRaw)) throw new Error("days");
        days = Number(daysRaw);
        if (!(days >= 1 && days <= 3650)) throw new Error("days");
      }
      const df = one("date_from");
      const dt = one("date_to");
      const team = one("team");
      const territory = one("territory");
      out.date_from = df ? parseIsoDate(df) : null;
      out.date_to = dt ? parseIsoDate(dt) : null;
      out.days = days;
      out.team = team ? parseUuid(team) : null;
      out.territory = territory ? parseUuid(territory) : null;
    } catch {
      throw new HttpError(422, "Invalid report filter value");
    }
    for (const key of LIST_KEYS) out[key] = (multi.get(key) ?? []).slice(0, 50);
    for (const [k, v] of multi) {
      if (k.startsWith("f_") && k.length > 2) out.facets[k.slice(2)] = v[v.length - 1];
    }
    if (out.date_from && out.date_to && out.date_from > out.date_to) {
      throw new HttpError(422, "date_from must be on or before date_to");
    }
    return out;
  }

  static fromDict(data: Record<string, any> | null | undefined): Filters {
    const items: [string, string][] = [];
    for (const [key, value] of Object.entries(data ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v !== null && v !== undefined) items.push([key, String(v)]);
      }
    }
    return Filters.parse(items);
  }

  /** `dataclasses.replace`: a copy with some fields changed. */
  replace(patch: Partial<Omit<Filters, "replace" | "params" | "toDict" | "period">>): Filters {
    const out = new Filters();
    Object.assign(out, structuredClone({ ...this }), patch);
    return out;
  }

  /** Query-string items for hrefs. Other option keys replace a filter (e.g. `user: [id]`); `facets` are added. */
  params(opts: { facets?: Record<string, string>; [override: string]: any } = {}): [string, string][] {
    const { facets, ...override } = opts;
    const values: Record<string, any> = {};
    for (const k of ["date_from", "date_to", "days", "team", "territory", ...LIST_KEYS]) values[k] = (this as any)[k];
    Object.assign(values, override);
    const out: [string, string][] = [];
    if (values.date_from || values.date_to) {
      for (const key of ["date_from", "date_to"]) if (values[key]) out.push([key, String(values[key])]);
    } else {
      // Explicit "all" so drill pages (whose UI defaults to 30 days) keep the same window.
      out.push(["days", values.days ? String(values.days) : "all"]);
    }
    for (const key of ["team", "territory"]) if (values[key]) out.push([key, String(values[key])]);
    for (const key of LIST_KEYS) for (const v of values[key] ?? []) out.push([key, String(v)]);
    for (const [name, value] of Object.entries({ ...this.facets, ...(facets ?? {}) })) out.push([`f_${name}`, value]);
    return out;
  }

  toDict(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, value] of this.params()) (out[key] ??= []).push(value);
    return out;
  }

  period(today: string): [string | null, string | null] {
    if (this.date_from || this.date_to) return [this.date_from, this.date_to];
    if (this.days) return [addDays(today, -(this.days - 1)), today];
    return [null, null];
  }
}

/** Python `urlencode` (quote_plus) of the items, prefixed with `?` when not empty. */
export function queryString(items: [string, string][]): string {
  const enc = (s: string) =>
    encodeURIComponent(s)
      .replace(/%20/g, "+")
      .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  const qs = items.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  return qs ? `?${qs}` : "";
}

// ============================================================================ context

export class Ctx {
  constructor(
    public user: CurrentUser,
    public f: Filters,
    public now: Date = new Date(),
  ) {}

  get today(): string {
    return this.now.toISOString().slice(0, 10);
  }

  /** Start of tomorrow (UTC): `< eod` means "due today or earlier". */
  get eod(): Date {
    return new Date(`${addDays(this.today, 1)}T00:00:00Z`);
  }

  get period(): [string | null, string | null] {
    return this.f.period(this.today);
  }

  get user_ids(): string[] {
    const out: string[] = [];
    for (const value of this.f.user) {
      if (value === "me") out.push(this.user.id);
      else if (value === NONE) out.push(NONE);
      else {
        try {
          out.push(parseUuid(value));
        } catch {
          continue;
        }
      }
    }
    return out;
  }

  with_filters(f: Filters): Ctx {
    return new Ctx(this.user, f, this.now);
  }

  /** The equal-length period immediately before the current one (for deltas). */
  previous(): Ctx | null {
    const [start, end0] = this.period;
    if (!start) return null;
    const end = end0 ?? this.today;
    const length = diffDays(end, start) + 1;
    return this.with_filters(
      this.f.replace({ date_from: addDays(start, -length), date_to: addDays(start, -1), days: null }),
    );
  }
}

// ============================================================================ SQL helpers

export type Fn = (...args: any[]) => any;

/** Text literal (cast so Postgres can type it in any position). */
export const lit = (s: string): SQL => sql`${s}::text`;
export const NULL_SQL: SQL = sql`null`;
export const isTrue = (e: any): SQL => sql`${e} is true`;
export const isFalse = (e: any): SQL => sql`${e} is false`;
export const asVarchar = (e: any): SQL => sql`${e}::varchar`;
export const concat = (...parts: any[]): SQL => sql`concat(${sql.join(parts, sql`, `)})`;
export const coalesce = (...parts: any[]): SQL => sql`coalesce(${sql.join(parts, sql`, `)})`;
export const caseWhen = (whens: Array<[any, any]>, otherwise: any): SQL =>
  sql`case ${sql.join(whens.map(([w, t]) => sql`when ${w} then ${t}`), sql` `)} else ${otherwise} end`;
export const descOf = (e: any): SQL => sql`${e} desc`;
export const descNullsLast = (e: any): SQL => sql`${e} desc nulls last`;
export const nullsLast = (e: any): SQL => sql`${e} asc nulls last`;
export const nullsFirst = (e: any): SQL => sql`${e} asc nulls first`;

/** `col IN (values)`; an empty list is false (SQLAlchemy `in_([])`). */
export const inList = (col: any, values: any[]): SQL =>
  values.length ? sql`${col} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})` : sql`false`;
export const notInList = (col: any, values: any[]): SQL =>
  values.length ? sql`${col} not in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})` : sql`true`;

export const nowLit = (c: Ctx): SQL => sql`${c.now.toISOString()}::timestamptz`;

let aliasN = 0;
export const newAlias = () => `r${++aliasN % 1_000_000}`;
/** `"table" "alias"` for a FROM clause, and `"alias"."col"` for a column of an aliased table. */
export const fromAs = (t: any, alias: string): SQL => sql`${sql.identifier(getTableName(t))} ${sql.identifier(alias)}`;
export const col = (alias: string, name: string): SQL => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

const isDateTimeExpr = (e: any): boolean => e?.__dt === true || /timestamp/i.test(e?.columnType ?? "");
export const markDateTime = <T extends object>(e: T): T => {
  (e as any).__dt = true;
  return e;
};

function whereSql(conds: any[]): SQL {
  const cs = conds.filter((x) => x !== undefined && x !== null);
  return cs.length ? sql` where ${sql.join(cs.map((x) => sql`(${x})`), sql` and `)}` : sql``;
}

// ============================================================================ KPI definition

export interface Col {
  key: string;
  label: string;
  expr: Fn; // (M, c) -> SQL expression
  kind: string; // text|date|datetime|currency|number|percent|status|bool|days
}
export const Col = (key: string, label: string, expr: Fn, kind = "text"): Col => ({ key, label, expr, kind });

export interface KpiInit {
  key: string;
  label: string;
  family: string;
  module: string; // permission module the records belong to
  model: string; // "module.models:Class"
  definition: string;
  title: Fn; // (M, c) -> record title expression
  href: Fn; // (M, c) -> record link expression
  where?: Fn; // (M, c) -> list of conditions
  unit?: string;
  agg?: string; // count | sum | avg | rate | wavg
  measure?: Fn | null; // (M, c) -> expr (sum/avg value, rate hit condition, wavg value)
  weight?: Fn | null; // (M, c) -> expr for wavg
  measure_label?: string | null;
  weight_label?: string | null;
  hit_label?: string | null;
  dims?: Record<string, Fn>; // date|user|property|source|stage -> (M) -> expr
  facets?: Record<string, Fn>; // name -> (M, c) -> expr
  cols?: Col[];
  sort?: Fn | null; // (M, c) -> list of order-by expressions
  module_href?: string | null;
  requires?: Array<[string, string]>;
  scope?: Fn | null; // (M, c) -> list of record-permission conditions
  better?: string | null; // "up" | "down" for delta tone
}

/** One metric definition reused everywhere: tile, chart, drill-through records, export and snapshot. */
export class Kpi {
  key!: string;
  label!: string;
  family!: string;
  module!: string;
  model!: string;
  definition!: string;
  title!: Fn;
  href!: Fn;
  where: Fn = () => [];
  unit = "count";
  agg = "count";
  measure: Fn | null = null;
  weight: Fn | null = null;
  measure_label: string | null = null;
  weight_label: string | null = null;
  hit_label: string | null = null;
  dims: Record<string, Fn> = {};
  facets: Record<string, Fn> = {};
  cols: Col[] = [];
  sort: Fn | null = null;
  module_href: string | null = null;
  requires: Array<[string, string]> = [];
  scope: Fn | null = null;
  better: string | null = null;

  constructor(init: KpiInit) {
    // undefined options keep the defaults
    for (const [key, value] of Object.entries(init)) if (value !== undefined) (this as any)[key] = value;
  }

  get point_in_time(): boolean {
    return !("date" in this.dims);
  }
}

export function available(k: Kpi, user: CurrentUser): boolean {
  if (!user.can(k.module, "view") || !k.requires.every(([m, a]) => user.can(m, a))) return false;
  return load(k.model) !== null;
}

const dim = (k: Kpi, name: string, M: any): any => {
  const fn = k.dims[name];
  return fn ? fn(M) : null;
};

/** `col IN (values)` where `NONE` stands for "is null". */
function inNone(column: any, values: string[]): SQL {
  const vals = values.filter((v) => v !== NONE);
  const conds: SQL[] = [];
  if (vals.length) conds.push(inList(column, vals));
  if (values.includes(NONE)) conds.push(isNull(column));
  return conds.length ? sql`(${sql.join(conds, sql` or `)})` : sql`false`;
}

export function dateConds(column: any, start: string | null, end: string | null): SQL[] {
  const dt = isDateTimeExpr(column);
  const out: SQL[] = [];
  if (start) out.push(dt ? sql`${column} >= ${`${start}T00:00:00Z`}::timestamptz` : sql`${column} >= ${start}::date`);
  if (end) {
    const nxt = addDays(end, 1);
    out.push(dt ? sql`${column} < ${`${nxt}T00:00:00Z`}::timestamptz` : sql`${column} < ${nxt}::date`);
  }
  return out;
}

export function propertySubquery(f: Filters): SQL {
  const P = load("properties.models:Property");
  const conds: any[] = [isNull(P.deleted_at)];
  if (f.property_type.length) conds.push(inNone(P.property_type, f.property_type));
  if (f.state.length) conds.push(inNone(sql`upper(${P.state})`, f.state.map((s) => (s === NONE ? s : s.toUpperCase()))));
  if (f.county.length) conds.push(inNone(sql`lower(${P.county})`, f.county.map((s) => (s === NONE ? s : s.toLowerCase()))));
  if (f.territory) {
    const TM = load("territories.models:TerritoryMember");
    if (TM !== null) {
      conds.push(sql`${P.id} in (select ${TM.property_id} from ${TM} where ${eq(TM.territory_id, f.territory)})`);
    }
  }
  // Standalone: the inner `properties` shadows any outer one (KPIs over Property itself).
  return sql`(select ${P.id} from ${P}${whereSql(conds)})`;
}

/** Data source (provider) a property was imported from: used for source attribution and licensing. */
export function propertySource(column: any): SQL | null {
  const R = load("imports.models:ImportRow");
  const J = load("imports.models:ImportJob");
  const S = load("imports.models:DataSource");
  if (R === null || J === null || S === null) return null;
  const [r, j, s] = [newAlias(), newAlias(), newAlias()];
  return sql`(select ${col(s, "provider")} from ${fromAs(R, r)} join ${fromAs(J, j)} on ${col(j, "id")} = ${col(r, "job_id")} join ${fromAs(S, s)} on ${col(s, "id")} = ${col(j, "data_source_id")} where ${col(r, "created_entity_id")} = ${column} order by ${col(j, "created_at")} limit 1)`;
}

/** All WHERE conditions for a KPI under the context's filters. Returns [conditions, ignored filters]. */
export function conditions(k: Kpi, M: any, c: Ctx, facets?: Record<string, string>): [any[], string[]] {
  const conds: any[] = [...(k.where(M, c) ?? [])];
  if ("deleted_at" in M) conds.push(isNull(M.deleted_at));
  if (k.scope) conds.push(...(k.scope(M, c) ?? []));
  const ignored: string[] = [];
  const f = c.f;
  const [start, end] = c.period;
  if (start || end) {
    const column = dim(k, "date", M);
    if (column === null || column === undefined) ignored.push("date");
    else conds.push(...dateConds(column, start, end));
  }
  if (f.user.length || f.team) {
    const column = dim(k, "user", M);
    if (column === null || column === undefined) ignored.push("user");
    else {
      if (f.user.length) conds.push(inNone(column, c.user_ids));
      if (f.team) {
        const U = load("auth.models:User");
        conds.push(sql`${column} in (select ${U.id} from ${U} where ${eq(U.team_id, f.team)})`);
      }
    }
  }
  if (f.property_type.length || f.state.length || f.county.length || f.territory) {
    const column = dim(k, "property", M);
    if (column === null || column === undefined) ignored.push("geography");
    else conds.push(sql`${column} in ${propertySubquery(f)}`);
  }
  for (const name of ["source", "stage"] as const) {
    const values = f[name];
    if (values.length) {
      const column = dim(k, name, M);
      if (column === null || column === undefined) ignored.push(name);
      else conds.push(inNone(column, values));
    }
  }
  for (const [name, value] of Object.entries(facets ?? {})) {
    const fn = k.facets[name];
    if (!fn) {
      ignored.push(`f_${name}`);
      continue;
    }
    const expr = fn(M, c);
    conds.push(value === NONE ? isNull(expr) : sql`${expr}::varchar = ${value}`);
  }
  return [conds, ignored];
}

// ============================================================================ evaluation

function aggCols(k: Kpi, M: any, c: Ctx): SQL[] {
  if (k.agg === "count") return [sql`count(*)`];
  const m = k.measure!(M, c);
  if (k.agg === "sum") return [sql`coalesce(sum(${m}), 0)`];
  if (k.agg === "avg") return [sql`avg(${m})`];
  if (k.agg === "rate") return [sql`count(*)`, sql`count(*) filter (where ${m})`];
  if (k.agg === "wavg") {
    const w = k.weight!(M, c);
    return [sql`sum(${m} * ${w})`, sql`sum(${w}) filter (where ${m} is not null)`];
  }
  throw new Error(`Unknown aggregation ${k.agg}`);
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function aggValue(k: Kpi, vals: any[]): number | null {
  if (k.agg === "rate") {
    const [total, hit] = [Number(vals[0]), Number(vals[1])];
    return total ? round((hit * 100.0) / total, 1) : null;
  }
  if (k.agg === "wavg") {
    const [n, d] = [num(vals[0]), num(vals[1])];
    return n !== null && d ? round(n / d, 3) : null;
  }
  const v = num(vals[0]);
  if (v === null) return null;
  return k.agg === "avg" ? round(v, 2) : v;
}

const aliasList = (exprs: SQL[], prefix: string): SQL =>
  sql.join(exprs.map((e, i) => sql`${e} as ${sql.raw(`${prefix}${i}`)}`), sql`, `);

export async function evaluate(
  db: Db,
  k: Kpi,
  c: Ctx,
  { facets }: { facets?: Record<string, string> } = {},
): Promise<[number | null, string[]]> {
  const M = load(k.model);
  const [conds, ignored] = conditions(k, M, c, facets);
  const cols = aggCols(k, M, c);
  const [row] = await raw(db, sql`select ${aliasList(cols, "a")} from ${M}${whereSql(conds)}`);
  return [aggValue(k, cols.map((_, i) => row[`a${i}`])), ignored];
}

/** KPI value per group. `group(M, c)` returns the grouping expression (null = not groupable). */
export async function grouped(
  db: Db,
  k: Kpi,
  c: Ctx,
  group: Fn,
  { facets }: { facets?: Record<string, string> } = {},
): Promise<Array<[any, number | null]> | null> {
  const M = load(k.model);
  const gexpr = group(M, c);
  if (gexpr === null || gexpr === undefined) return null;
  const [conds] = conditions(k, M, c, facets);
  const cols = aggCols(k, M, c);
  const rows = await raw(
    db,
    sql`select ${gexpr} as g, ${aliasList(cols, "a")} from ${M}${whereSql(conds)} group by 1`,
  );
  return rows.map((r) => [r.g ?? null, aggValue(k, cols.map((_, i) => r[`a${i}`]))] as [any, number | null]);
}

const UNIT_KIND: Record<string, string> = {
  count: "number", currency: "currency", percent: "percent", days: "days", number: "number",
};

export function recordColumns(k: Kpi): Col[] {
  const cols = [...k.cols];
  if (["sum", "avg", "wavg"].includes(k.agg) && k.measure) {
    cols.push(Col("_measure", k.measure_label ?? k.label, k.measure, UNIT_KIND[k.unit] ?? "number"));
  }
  if (k.agg === "wavg" && k.weight) cols.push(Col("_weight", k.weight_label ?? "Weight", k.weight, "currency"));
  if (k.agg === "rate" && k.measure) cols.push(Col("_hit", k.hit_label ?? "Counted", k.measure, "bool"));
  return cols;
}

export function licenseSource(k: Kpi, M: any): any {
  const src = dim(k, "source", M);
  if (src !== null && src !== undefined) return src;
  const prop = dim(k, "property", M);
  return prop !== null && prop !== undefined ? propertySource(prop) : null;
}

/** Postgres timestamptz text ("2024-05-01 10:00:00+00") -> ISO string. */
function pgTimestamp(s: string): string {
  const d = new Date(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Raw driver values (numeric/bigint/timestamps arrive as strings) -> the JSON the old API produced. */
function cellValue(v: any, kind: string): any {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    if (["currency", "number", "percent", "days"].includes(kind) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return Number(v);
    if (kind === "datetime") return pgTimestamp(v);
    return v;
  }
  if (typeof v === "bigint") return Number(v);
  return toJsonable(v);
}

export interface RecordItem {
  id: string;
  title: string;
  href: string | null;
  cells: Record<string, any>;
  source: string | null;
  restricted: boolean;
  restriction_reason: string | null;
}

/** The exact records that make up the KPI value (for rate KPIs: the denominator, with a hit flag). */
export async function records(
  db: Db,
  k: Kpi,
  c: Ctx,
  o: {
    page?: number;
    page_size?: number;
    facets?: Record<string, string>;
    restricted?: Record<string, string>;
  } = {},
): Promise<[Col[], RecordItem[], number, string[]]> {
  const { page = 1, page_size = 25, facets, restricted } = o;
  const M = load(k.model);
  const [conds, ignored] = conditions(k, M, c, facets);
  const cols = recordColumns(k);
  const sel: SQL[] = [sql`${M.id} as id`, sql`${k.title(M, c)} as title`, sql`${k.href(M, c)} as href`];
  cols.forEach((cl, i) => sel.push(sql`${cl.expr(M, c)} as ${sql.raw(`c${i}`)}`));
  const lic = licenseSource(k, M);
  if (lic !== null && lic !== undefined) sel.push(sql`${lic} as lic`);
  const [{ n }] = await raw(db, sql`select count(*) as n from ${M}${whereSql(conds)}`);
  const total = Number(n) || 0;
  const order: any[] = k.sort ? [...k.sort(M, c)] : "created_at" in M ? [descOf(M.created_at)] : [];
  order.push(M.id);
  const rows = await raw(
    db,
    sql`select ${sql.join(sel, sql`, `)} from ${M}${whereSql(conds)} order by ${sql.join(order, sql`, `)} offset ${(page - 1) * page_size} limit ${page_size}`,
  );
  const items: RecordItem[] = rows.map((m) => {
    const src = lic !== null && lic !== undefined ? m.lic : null;
    const reason = src ? (restricted ?? {})[String(src).trim().toLowerCase()] : undefined;
    const cells: Record<string, any> = {};
    cols.forEach((cl, i) => (cells[cl.key] = cellValue(m[`c${i}`], cl.kind)));
    return {
      id: String(m.id),
      title: m.title || "—",
      href: m.href ?? null,
      cells,
      source: src ?? null,
      restricted: reason !== undefined,
      restriction_reason: reason ?? null,
    };
  });
  return [cols, items, total, ignored];
}

/** lower(provider) -> reason, for sources whose data may not be redistributed/exported. */
export async function licenseRestrictions(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const S = load("imports.models:DataSource");
  const PR = load("compliance.models:ProviderRestriction");

  if (S !== null) {
    const rows: any[] =
      (await safe(db, async (d) =>
        d.select({ provider: S.provider }).from(S).where(sql`${isNull(S.deleted_at)} and ${S.redistribution_allowed} is false`),
      )) ?? [];
    for (const { provider } of rows) {
      out[provider.trim().toLowerCase()] = `License for ${provider} does not allow redistribution`;
    }
  }
  if (PR !== null) {
    const rows: any[] =
      (await safe(db, async (d) =>
        d
          .select({ provider: PR.provider, restriction: PR.restriction })
          .from(PR)
          .where(sql`${isNull(PR.deleted_at)} and ${PR.is_active} is true and ${PR.block_export} is true`),
      )) ?? [];
    for (const { provider, restriction } of rows) {
      const key = provider.trim().toLowerCase();
      out[key] ??= `Provider restriction (${restriction}) blocks export of ${provider} data`;
    }
  }
  return out;
}

let savepointN = 0;

/** Run one read block inside a savepoint; a missing table/column omits the block (null) instead of failing. */
export async function safe<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T | null> {
  const name = `rpt_sp_${++savepointN % 1_000_000}`;
  await db.execute(sql.raw(`savepoint ${name}`));
  try {
    const result = await fn(db);
    await db.execute(sql.raw(`release savepoint ${name}`));
    return result;
  } catch (err) {
    await db.execute(sql.raw(`rollback to savepoint ${name}`));
    if (err instanceof HttpError) throw err;
    console.warn("[reports] report block omitted:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================================ time buckets

export const granularity = (start: string, end: string): "day" | "week" | "month" => {
  const days = diffDays(end, start) + 1;
  return days <= 31 ? "day" : days <= 183 ? "week" : "month";
};

export function bucketStart(d: string, gran: string): string {
  if (gran === "week") {
    const weekday = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    return addDays(d, -weekday);
  }
  if (gran === "month") return `${d.slice(0, 7)}-01`;
  return d;
}

export function bucketEnd(s: string, gran: string): string {
  if (gran === "week") return addDays(s, 6);
  if (gran === "month") {
    const [y, m] = [Number(s.slice(0, 4)), Number(s.slice(5, 7))];
    return msToIso(Date.UTC(y, m, 1) - DAY_MS);
  }
  return s;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function bucketLabel(s: string, gran: string): string {
  const mon = MONTHS[Number(s.slice(5, 7)) - 1];
  return gran === "month" ? `${mon} ${s.slice(0, 4)}` : `${mon} ${s.slice(8, 10)}`;
}

export function buckets(start: string, end: string, gran: string): string[] {
  const out: string[] = [];
  let cur = bucketStart(start, gran);
  while (cur <= end) {
    out.push(cur);
    cur = addDays(bucketEnd(cur, gran), 1);
  }
  return out;
}

export function asDate(value: any): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}
