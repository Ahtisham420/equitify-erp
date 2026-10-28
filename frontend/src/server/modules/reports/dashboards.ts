/**
 * Dashboard definitions (spec 34) and the builders that turn KPI definitions into tiles, charts and tables.
 *
 * Every number produced here carries an href to /reports/kpi/<key> with the exact filters (plus the bucket,
 * group or user it represents), which lists the constituent records.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../../db";
import { utcnow } from "../../core/security";
import {
  asDate, available, bucketEnd, bucketLabel, bucketStart, buckets, Ctx, evaluate, Filters, fromAs, granularity,
  grouped, inList, licenseRestrictions, load, maxDate, minDate, newAlias, NONE, queryString, records, safe,
  addDays, col as qcol, type Fn, type Kpi,
} from "./engine";
import { REGISTRY } from "./kpis";
import {
  mkRow, type Column, type DashboardOut, type Point, type Row, type SeriesMeta, type SeriesOut, type TableOut, type Tile,
} from "./schemas";

export interface SeriesDef {
  key: string;
  label: string;
  kind: "time" | "breakdown";
  kpis: string[];
  by: string | null; // user|source|stage|property_type|state|<facet>
  chart: string;
  limit: number;
  order: "value" | "key";
  description: string | null;
}

export interface TableDef {
  key: string;
  kind: "records" | "team" | "sources";
  kpi: string | null;
  label: string | null;
  limit: number;
}

export interface Dashboard {
  key: string;
  label: string;
  description: string;
  tiles: string[];
  series: SeriesDef[];
  tables: TableDef[];
  default_me: boolean;
}

export const TEAM_COLUMNS: Record<string, string> = {
  "outreach.interactions": "Interactions", "outreach.meaningful": "Meaningful", "tasks.completed": "Tasks done",
  "tasks.overdue": "Tasks overdue", "pipeline.stage_moves": "Stage moves", "offers.sent": "Offers sent",
  "closings.completed": "Closings",
};
export const SOURCE_KPIS: Record<string, string> = {
  leads: "sourcing.properties_added", opportunities: "sourcing.opportunities_created", offers: "offers.sent",
  closings: "closings.completed", volume: "closings.volume", conversion: "pipeline.conversion",
};

/** Every KPI key a dashboard depends on. */
export function kpiKeys(d: Dashboard): Set<string> {
  const keys = new Set(d.tiles);
  for (const s of d.series) s.kpis.forEach((k) => keys.add(k));
  for (const t of d.tables) {
    if (t.kpi) keys.add(t.kpi);
    if (t.kind === "team") Object.keys(TEAM_COLUMNS).forEach((k) => keys.add(k));
    if (t.kind === "sources") Object.values(SOURCE_KPIS).forEach((k) => keys.add(k));
  }
  return keys;
}

const series = (
  key: string, label: string, kind: "time" | "breakdown", kpis: string[],
  o: { by?: string; chart?: string; limit?: number; order?: "value" | "key"; description?: string } = {},
): SeriesDef => ({
  key, label, kind, kpis, by: o.by ?? null, chart: o.chart ?? "bar", limit: o.limit ?? 12, order: o.order ?? "value",
  description: o.description ?? null,
});

const table = (o: { key: string; kind: TableDef["kind"]; kpi?: string; label?: string; limit?: number }): TableDef => ({
  key: o.key, kind: o.kind, kpi: o.kpi ?? null, label: o.label ?? null, limit: o.limit ?? 10,
});

const _r = (key: string, kpi: string, limit = 10, label?: string): TableDef =>
  table({ key, kind: "records", kpi, limit, label });

const dash = (
  key: string, label: string, description: string, tiles: string[],
  o: { series?: SeriesDef[]; tables?: TableDef[]; default_me?: boolean } = {},
): Dashboard => ({
  key, label, description, tiles, series: o.series ?? [], tables: o.tables ?? [], default_me: o.default_me ?? false,
});

export const DASHBOARDS: Record<string, Dashboard> = Object.fromEntries([
  dash(
    "executive", "Executive command center",
    "Firm-wide view across acquisitions, portfolio, operations and brokerage.",
    ["pipeline.active", "pipeline.stalled", "offers.sent", "contracts.dates_due_14", "closings.completed",
      "closings.volume", "portfolio.value", "debt.maturing_12m_balance", "receivables.delinquent",
      "operations.wo_overdue", "brokerage.weighted_gci", "tasks.alerts_open_high"],
    {
      series: [
        series("opps_closings", "Opportunities created and closings", "time",
          ["sourcing.opportunities_created", "closings.completed"], { chart: "line" }),
        series("pipeline_stage", "Active pipeline by stage", "breakdown", ["pipeline.active"], { by: "stage" }),
      ],
      tables: [_r("dates", "contracts.dates_due_14", 8), _r("watchlist", "portfolio.watchlist_open", 8)],
    },
  ),
  dash(
    "acquisitions", "Acquisitions",
    "Sourcing through closing: volume, velocity, conversion and what is stuck.",
    ["sourcing.opportunities_created", "pipeline.active", "pipeline.stalled", "pipeline.no_next_action",
      "pipeline.avg_days_in_stage", "pipeline.stage_moves", "offers.sent", "offers.acceptance_rate",
      "offers.awaiting_response", "contracts.executed", "closings.scheduled_30", "closings.completed",
      "pipeline.conversion", "pipeline.dead", "reactivation.pending", "reactivation.conversion_rate"],
    {
      series: [
        series("stage", "Active pipeline by stage", "breakdown", ["pipeline.active"], { by: "stage" }),
        series("created_dead", "Opportunities created vs. marked dead", "time",
          ["sourcing.opportunities_created", "pipeline.dead"], { chart: "line" }),
        series("dead_reason", "Dead opportunities by reason", "breakdown", ["pipeline.dead"], { by: "dead_reason" }),
        series("by_source", "Opportunities created by source", "breakdown",
          ["sourcing.opportunities_created"], { by: "source" }),
      ],
      tables: [_r("stalled", "pipeline.stalled"), _r("closing_soon", "closings.scheduled_30")],
    },
  ),
  dash(
    "queue", "Daily queue",
    "What needs attention today. Defaults to your own work; change the user filter to view others.",
    ["tasks.overdue", "tasks.due_today", "queue.next_actions_due", "outreach.follow_ups_due",
      "outreach.open_loops", "offers.awaiting_response", "contracts.dates_due_14", "tasks.alerts_open_high",
      "reactivation.pending"],
    {
      default_me: true,
      series: [series("done", "Tasks completed", "time", ["tasks.completed"])],
      tables: [_r("overdue", "tasks.overdue"), _r("today", "tasks.due_today"),
        _r("next_actions", "queue.next_actions_due"), _r("follow_ups", "outreach.follow_ups_due"),
        _r("dates", "contracts.dates_due_14")],
    },
  ),
  dash(
    "signals", "Signals",
    "Motivation and market signals: what is new, what is stacking, what is about to expire.",
    ["sourcing.signals_new", "signals.active", "signals.high_severity", "sourcing.stacked_signal_properties",
      "sourcing.high_score_properties", "signals.expiring_30"],
    {
      series: [
        series("new", "New signals", "time", ["sourcing.signals_new"]),
        series("category", "Active signals by category", "breakdown", ["signals.active"], { by: "category" }),
        series("severity", "Active signals by severity", "breakdown", ["signals.active"], { by: "severity", order: "key" }),
      ],
      tables: [_r("high", "signals.high_severity"), _r("stacked", "sourcing.stacked_signal_properties")],
    },
  ),
  dash(
    "portfolio", "Portfolio",
    "Owned assets: value, exposure, collections and watchlist.",
    ["portfolio.active_assets", "portfolio.value", "portfolio.basis", "portfolio.acquired",
      "portfolio.watchlist_open", "receivables.delinquent", "receivables.collected", "leases.expiring_12m",
      "debt.total_balance", "debt.maturing_12m"],
    {
      series: [
        series("value_type", "Portfolio value by property type", "breakdown", ["portfolio.value"], { by: "property_type" }),
        series("value_state", "Portfolio value by state", "breakdown", ["portfolio.value"], { by: "state" }),
        series("aging", "Delinquent balance by aging", "breakdown", ["receivables.delinquent"], { by: "aging", order: "key" }),
        series("collected", "Rent collected", "time", ["receivables.collected"]),
      ],
      tables: [_r("watchlist", "portfolio.watchlist_open"), _r("delinquent", "receivables.delinquent")],
    },
  ),
  dash(
    "leases", "Lease expiration & rollover",
    "Rent at risk by expiration year, upcoming expirations and option notice deadlines.",
    ["leases.active", "leases.expiring_12m", "leases.rent_expiring_12m", "leases.option_notices_90",
      "leases.holdover", "leases.unverified"],
    {
      series: [
        series("rollover", "Rent rolling by expiration year", "breakdown", ["leases.rent_by_expiration"],
          { by: "exp_year", order: "key" }),
        series("lease_type", "Active leases by type", "breakdown", ["leases.active"], { by: "lease_type" }),
      ],
      tables: [_r("expiring", "leases.expiring_12m"), _r("options", "leases.option_notices_90")],
    },
  ),
  dash(
    "debt", "Debt maturity, covenants & rate",
    "Maturity wall, covenant state and interest-rate exposure.",
    ["debt.total_balance", "debt.weighted_rate", "debt.floating_balance", "debt.maturing_12m",
      "debt.maturing_12m_balance", "debt.covenant_breach", "debt.covenant_watch", "debt.caps_expiring_180",
      "debt.floating_uncapped", "debt.reports_overdue"],
    {
      series: [
        series("maturity", "Debt by maturity year", "breakdown", ["debt.balance_by_maturity"],
          { by: "maturity_year", order: "key" }),
        series("rate_type", "Debt by rate type", "breakdown", ["debt.total_balance"], { by: "rate_type" }),
        series("lender", "Debt by lender", "breakdown", ["debt.total_balance"], { by: "lender", limit: 10 }),
      ],
      tables: [_r("maturing", "debt.maturing_12m"), _r("breach", "debt.covenant_breach"),
        _r("caps", "debt.caps_expiring_180")],
    },
  ),
  dash(
    "operations", "Operations",
    "Work orders, preventive maintenance, vendors, insurance, capital projects and tax.",
    ["operations.wo_open", "operations.wo_overdue", "operations.wo_completed", "operations.wo_avg_days",
      "operations.pm_due_14", "operations.findings_open", "operations.vendor_credentials",
      "operations.insurance_expiring_60", "operations.coi_deficient", "operations.capex_active",
      "operations.capex_budget", "operations.capex_over_budget", "operations.tax_due_30"],
    {
      series: [
        series("completed", "Work orders completed", "time", ["operations.wo_completed"]),
        series("priority", "Open work orders by priority", "breakdown", ["operations.wo_open"], { by: "priority" }),
        series("category", "Open work orders by category", "breakdown", ["operations.wo_open"], { by: "category" }),
      ],
      tables: [_r("overdue", "operations.wo_overdue"), _r("credentials", "operations.vendor_credentials"),
        _r("insurance", "operations.insurance_expiring_60")],
    },
  ),
  dash(
    "brokerage", "Brokerage",
    "Listings, inquiries, showings, deal pipeline and commission production.",
    ["brokerage.active_listings", "brokerage.listings_expiring_30", "brokerage.inquiries",
      "brokerage.showings", "brokerage.active_deals", "brokerage.pipeline_gci", "brokerage.weighted_gci",
      "brokerage.deals_closed", "commissions.earned_count", "commissions.earned", "commissions.receivable"],
    {
      series: [
        series("activity", "Inquiries and showings", "time", ["brokerage.inquiries", "brokerage.showings"],
          { chart: "line" }),
        series("inq_source", "Inquiries by source", "breakdown", ["brokerage.inquiries"], { by: "source" }),
        series("deal_stage", "Active deals by stage", "breakdown", ["brokerage.active_deals"], { by: "stage" }),
      ],
      tables: [_r("expiring", "brokerage.listings_expiring_30"), _r("deals", "brokerage.active_deals")],
    },
  ),
  dash(
    "data", "Data quality",
    "Completeness, verification backlog, import exceptions and license renewals.",
    ["data.avg_completeness", "data.low_completeness", "data.missing_location",
      "data.unverified_observations", "data.ai_unverified", "data.import_invalid", "data.import_duplicates",
      "data.sources_renewing", "sourcing.properties_added"],
    {
      series: [
        series("band", "Properties by completeness band", "breakdown", ["data.properties_total"],
          { by: "band", order: "key" }),
        series("unverified_field", "Unverified facts by field", "breakdown", ["data.unverified_observations"],
          { by: "field" }),
        series("added", "Properties added", "time", ["sourcing.properties_added"]),
      ],
      tables: [_r("low", "data.low_completeness"), _r("invalid", "data.import_invalid")],
    },
  ),
  dash(
    "sources", "Source performance",
    "Leads, opportunities, offers and closings by source, with conversion and cost per closed deal.",
    ["sourcing.properties_added", "sourcing.opportunities_created", "offers.sent", "closings.completed",
      "pipeline.conversion", "data.sources_active"],
    {
      series: [
        series("opps", "Opportunities by source", "breakdown", ["sourcing.opportunities_created"], { by: "source" }),
        series("closings", "Closings by source", "breakdown", ["closings.completed"], { by: "source" }),
      ],
      tables: [table({ key: "sources", kind: "sources", label: "Source performance" })],
    },
  ),
  dash(
    "team", "Team performance",
    "Activity and output per person: interactions, tasks, stage moves, offers and closings.",
    Object.keys(TEAM_COLUMNS),
    {
      series: [
        series("activity", "Interactions and meaningful conversations", "time",
          ["outreach.interactions", "outreach.meaningful"], { chart: "line" }),
        series("by_user", "Interactions by user", "breakdown", ["outreach.interactions"], { by: "user" }),
      ],
      tables: [table({ key: "team", kind: "team", label: "Team performance" })],
    },
  ),
  dash(
    "compliance", "Compliance",
    "Send-time blocks, opt-outs, DNC exposure and suppression.",
    ["compliance.sends", "compliance.blocked", "compliance.opt_outs", "compliance.consent_revoked",
      "compliance.dnc_listed", "compliance.scrub_expired", "compliance.suppressed"],
    {
      series: [
        series("sends", "Outbound attempts and blocks", "time", ["compliance.sends", "compliance.blocked"],
          { chart: "line" }),
        series("blocked_channel", "Blocked sends by channel", "breakdown", ["compliance.blocked"], { by: "channel" }),
      ],
      tables: [_r("blocked", "compliance.blocked")],
    },
  ),
].map((d) => [d.key, d]));

// ============================================================================ helpers

export function kpiHref(key: string, f: Filters, opts: { facets?: Record<string, string>; [override: string]: any } = {}): string {
  return `/reports/kpi/${key}${queryString(f.params(opts))}`;
}

export function kpisFor(keys: string[], c: Ctx): Kpi[] {
  const out: Kpi[] = [];
  for (const key of keys) {
    const k = REGISTRY[key];
    if (k !== undefined && available(k, c.user)) out.push(k);
  }
  return out;
}

export const dashboardVisible = (d: Dashboard, c: Ctx): boolean => kpisFor([...kpiKeys(d)].sort(), c).length > 0;

export function effectiveCtx(d: Dashboard, c: Ctx): Ctx {
  if (d.default_me && !c.f.user.length && !c.f.team) return c.with_filters(c.f.replace({ user: ["me"] }));
  return c;
}

async function userNames(db: Db, ids: any[]): Promise<Record<string, string>> {
  const U = load("auth.models:User");
  const valid = ids.filter((i) => i !== null && i !== undefined);
  if (!valid.length) return {};
  const rows = await db.select({ id: U.id, name: U.full_name }).from(U).where(inArray(U.id, valid.map(String)));
  return Object.fromEntries(rows.map((r: any) => [String(r.id), r.name]));
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// ============================================================================ tiles

export async function tile(db: Db, k: Kpi, c: Ctx): Promise<Tile | null> {
  const res = await safe(db, (s) => evaluate(s, k, c));
  if (res === null) return null;
  const [value, ignored] = res;
  let delta: number | null = null;
  const prev = c.previous();
  if (prev !== null && !k.point_in_time && value !== null) {
    const p = await safe(db, (s) => evaluate(s, k, prev));
    if (p !== null && p[0] !== null) delta = round2(value - p[0]);
  }
  return {
    key: k.key, label: k.label, value, unit: k.unit, delta, better: k.better, href: kpiHref(k.key, c.f),
    module_href: k.module_href, definition: k.definition, point_in_time: k.point_in_time, ignored_filters: ignored,
  };
}

// ============================================================================ series

function groupFn(k: Kpi, by: string): Fn | null {
  if (["user", "source", "stage"].includes(by)) {
    const fn = k.dims[by];
    return fn ? (M: any) => fn(M) : null;
  }
  if (by === "property_type" || by === "state") {
    const pfn = k.dims.property;
    if (!pfn) return null;
    return (M: any) => {
      const P = load("properties.models:Property");
      if (P === null || !P[by]) throw new TypeError("missing properties column");
      const a = newAlias();
      return sql`(select ${qcol(a, by)} from ${fromAs(P, a)} where ${qcol(a, "id")} = ${pfn(M)})`;
    };
  }
  return k.facets[by] ?? null;
}

function drill(k: Kpi, f: Filters, by: string, value: any): string {
  const v = value === null || value === undefined ? NONE : String(value);
  if (["user", "source", "stage", "property_type", "state"].includes(by)) return kpiHref(k.key, f, { [by]: [v] });
  return kpiHref(k.key, f, { facets: { [by]: v } });
}

export async function timeSeries(db: Db, s: SeriesDef, c: Ctx): Promise<SeriesOut | null> {
  const ks = kpisFor(s.kpis, c).filter((k) => "date" in k.dims);
  if (!ks.length) return null;
  const [start0, end0] = c.period;
  const end = end0 ?? c.today;
  const start = start0 ?? addDays(end, -364);
  const gran = granularity(start, end);
  const cc = c.with_filters(c.f.replace({ date_from: start, date_to: end, days: null }));
  const starts = buckets(start, end, gran);
  const values: Record<string, Record<string, number | null>> = {};
  const hrefs: Record<string, Record<string, string>> = {};
  for (const b of starts) {
    values[b] = {};
    hrefs[b] = {};
  }
  const metas: SeriesMeta[] = [];
  for (const k of ks) {
    const group = (M: any) => sql`date_trunc(${gran}::text, ${k.dims.date(M)})`;
    const rows = await safe(db, (d) => grouped(d, k, cc, group));
    if (rows === null) continue;
    const got = new Map<string, number | null>();
    for (const [g, v] of rows) {
      const gd = asDate(g);
      if (gd) got.set(bucketStart(gd, gran), v);
    }
    const zero = k.agg === "count" || k.agg === "sum" ? 0.0 : null;
    for (const b of starts) {
      values[b][k.key] = got.has(b) ? got.get(b)! : zero;
      hrefs[b][k.key] = kpiHref(k.key, c.f, { date_from: maxDate(b, start), date_to: minDate(bucketEnd(b, gran), end) });
    }
    metas.push({ key: k.key, label: k.label, href: kpiHref(k.key, cc.f) });
  }
  if (!metas.length) return null;
  const points: Point[] = starts.map((b) => ({
    key: b, label: bucketLabel(b, gran), values: values[b], hrefs: hrefs[b],
  }));
  return {
    key: s.key, label: s.label, description: s.description ?? `Per ${gran}`, kind: "time", chart: s.chart,
    unit: ks[0].unit, series: metas, points,
  };
}

export async function breakdown(db: Db, s: SeriesDef, c: Ctx): Promise<SeriesOut | null> {
  const ks = kpisFor(s.kpis, c);
  const data = new Map<string, { values: Record<string, number | null>; hrefs: Record<string, string> }>();
  const rawVals: Record<string, any> = {};
  const metas: SeriesMeta[] = [];
  for (const k of ks) {
    const fn = groupFn(k, s.by ?? "");
    if (fn === null) continue;
    const rows = await safe(db, (d) => grouped(d, k, c, fn));
    if (rows === null) continue;
    for (const [g, v] of rows) {
      const key = g === null || g === undefined ? NONE : String(g);
      rawVals[key] = g;
      if (!data.has(key)) data.set(key, { values: {}, hrefs: {} });
      data.get(key)!.values[k.key] = v;
      data.get(key)!.hrefs[k.key] = drill(k, c.f, s.by ?? "", g);
    }
    metas.push({ key: k.key, label: k.label, href: kpiHref(k.key, c.f) });
  }
  if (!metas.length) return null;
  const first = metas[0].key;
  let keys = [...data.keys()];
  if (s.order === "key") keys.sort();
  else keys.sort((a, b) => -(data.get(a)!.values[first] || 0) - -(data.get(b)!.values[first] || 0));
  keys = keys.slice(0, s.limit);
  const names = s.by === "user" ? await userNames(db, keys.map((x) => rawVals[x]).filter((v) => v !== null && v !== undefined)) : {};
  const points: Point[] = keys.map((x) => ({
    key: x, label: x === NONE ? "Not set" : names[x] ?? x, values: data.get(x)!.values, hrefs: data.get(x)!.hrefs,
  }));
  const unit = ks.find((k) => k.key === first)!.unit;
  return {
    key: s.key, label: s.label, description: s.description, kind: "breakdown", chart: "bar", unit,
    series: metas, points,
  };
}

// ============================================================================ tables

export async function recordsTable(db: Db, t: TableDef, c: Ctx, restricted: Record<string, string>): Promise<TableOut | null> {
  const ks = kpisFor([t.kpi ?? ""], c);
  if (!ks.length) return null;
  const k = ks[0];
  const res = await safe(db, (d) => records(d, k, c, { page: 1, page_size: t.limit, restricted }));
  if (res === null) return null;
  const [cols, items, total] = res;
  return {
    key: t.key, label: t.label ?? k.label, description: k.definition,
    columns: cols.map((col) => ({ key: col.key, label: col.label, kind: col.kind })),
    rows: items.map((i) => mkRow(i)), total, href: kpiHref(k.key, c.f),
  };
}

export async function teamTable(db: Db, t: TableDef, c: Ctx): Promise<TableOut | null> {
  const ks = kpisFor(Object.keys(TEAM_COLUMNS), c).filter((k) => "user" in k.dims);
  if (!ks.length) return null;
  const U = load("auth.models:User");
  const ids = c.user_ids.filter((i) => i !== NONE);
  const users: Array<{ id: string; name: string }> = await db
    .select({ id: U.id, name: U.full_name })
    .from(U)
    .where(and(
      isNull(U.deleted_at), eq(U.status, "active"), eq(U.is_service, false),
      c.f.user.length ? inList(U.id, ids) : undefined,
      c.f.team ? eq(U.team_id, c.f.team) : undefined,
    ))
    .orderBy(U.full_name);
  const per: Record<string, Record<string, number | null>> = {};
  for (const k of ks) {
    const rows = await safe(db, (d) => grouped(d, k, c, (M: any) => k.dims.user(M)));
    per[k.key] = {};
    for (const [g, v] of rows ?? []) if (g !== null && g !== undefined) per[k.key][String(g)] = v;
  }
  const outRows: Row[] = [];
  for (const { id: uid, name } of users) {
    const cells: Record<string, number | null> = {};
    const hrefs: Record<string, string> = {};
    for (const k of ks) {
      cells[k.key] = String(uid) in per[k.key] ? per[k.key][String(uid)] : 0.0;
      hrefs[k.key] = kpiHref(k.key, c.f, { user: [String(uid)] });
    }
    outRows.push(mkRow({ id: String(uid), title: name, href: kpiHref(ks[0].key, c.f, { user: [String(uid)] }), cells, hrefs }));
  }
  const total = (r: Row) => Object.values(r.cells).reduce((a: number, v: any) => a + (v || 0), 0);
  outRows.sort((a, b) => -total(a) - -total(b));
  return {
    key: t.key, label: t.label ?? "Team performance", description: "Per user, filtered period",
    columns: ks.map((k) => ({ key: k.key, label: TEAM_COLUMNS[k.key], kind: "number" })),
    rows: outRows, total: outRows.length, href: null,
  };
}

export async function sourcesTable(db: Db, t: TableDef, c: Ctx, restricted: Record<string, string>): Promise<TableOut | null> {
  const ks = new Map<string, Kpi>();
  for (const [colName, key] of Object.entries(SOURCE_KPIS)) {
    const k = REGISTRY[key];
    if (k !== undefined && available(k, c.user) && "source" in k.dims) ks.set(colName, k);
  }
  if (!ks.size) return null;
  const display = new Map<string, string>(); // lower -> display
  const vals = new Map<string, Record<string, number | null>>();
  for (const [colName, k] of ks) {
    const rows = await safe(db, (d) => grouped(d, k, c, (M: any) => k.dims.source(M)));
    for (const [g, v] of rows ?? []) {
      const name = g === null || g === undefined || !String(g).trim() ? NONE : String(g).trim();
      const low = name.toLowerCase();
      if (!display.has(low)) display.set(low, name);
      if (!vals.has(low)) vals.set(low, {});
      const cur = vals.get(low)!;
      cur[colName] = colName !== "conversion" ? (cur[colName] || 0) + (v || 0) : v;
    }
  }
  const costs = new Map<string, [number, string]>();
  const DS = load("imports.models:DataSource");
  if (DS !== null && c.user.can("imports", "view")) {
    const rows: any[] =
      (await safe(db, (d) => d.select({ provider: DS.provider, cost: DS.cost }).from(DS).where(isNull(DS.deleted_at)))) ?? [];
    for (const { provider, cost } of rows) {
      if (cost !== null && cost !== undefined) costs.set(provider.trim().toLowerCase(), [Number(cost), provider]);
    }
  }
  const rowsOut: Row[] = [];
  for (const [low, name] of display) {
    const v = vals.get(low)!;
    const cost = costs.get(low);
    const closings = v.closings || 0;
    const cells: Record<string, any> = {};
    for (const colName of ks.keys()) cells[colName] = colName in v ? v[colName] : colName !== "conversion" ? 0.0 : null;
    const hrefs: Record<string, string> = {};
    for (const [colName, k] of ks) hrefs[colName] = kpiHref(k.key, c.f, { source: [name] });
    if (cost) {
      cells.cost = cost[0];
      hrefs.cost = kpiHref("data.sources_active", new Filters(), { source: [cost[1]] });
      if (closings) {
        cells.cost_per_closed = round2(cost[0] / closings);
        hrefs.cost_per_closed = hrefs.closings || hrefs.cost;
      }
    }
    const reason = restricted[low];
    rowsOut.push(mkRow({
      id: name, title: name === NONE ? "Not recorded" : name, href: hrefs.opportunities || Object.values(hrefs)[0],
      cells, hrefs, restricted: reason !== undefined, restriction_reason: reason ?? null,
    }));
  }
  const rank = (r: Row) => r.cells.opportunities || r.cells.leads || 0;
  rowsOut.sort((a, b) => -rank(a) - -rank(b));
  const labels: Record<string, [string, string]> = {
    leads: ["Leads (properties)", "number"], opportunities: ["Opportunities", "number"],
    offers: ["Offers sent", "number"], closings: ["Closings", "number"],
    volume: ["Closed volume", "currency"], conversion: ["Conversion %", "percent"],
  };
  const columns: Column[] = [...ks.keys()].map((colName) => ({ key: colName, label: labels[colName][0], kind: labels[colName][1] }));
  if (costs.size) {
    columns.push({ key: "cost", label: "Source cost", kind: "currency" });
    columns.push({ key: "cost_per_closed", label: "Cost per closed deal", kind: "currency" });
  }
  return {
    key: t.key, label: t.label ?? "Source performance",
    description: "Opportunity source, or the data source a property was imported from",
    columns, rows: rowsOut, total: rowsOut.length, href: null,
  };
}

// ============================================================================ build + CSV

export async function build(db: Db, d: Dashboard, c0: Ctx): Promise<DashboardOut> {
  const c = effectiveCtx(d, c0);
  const tiles: Tile[] = [];
  for (const k of kpisFor(d.tiles, c)) {
    const t = await tile(db, k, c);
    if (t !== null) tiles.push(t);
  }
  const seriesOut: SeriesOut[] = [];
  for (const s of d.series) {
    const out = s.kind === "time" ? await timeSeries(db, s, c) : await breakdown(db, s, c);
    if (out !== null && out.points.length) seriesOut.push(out);
  }
  const restricted = d.tables.length ? await licenseRestrictions(db) : {};
  const tables: TableOut[] = [];
  for (const t of d.tables) {
    const out =
      t.kind === "team" ? await teamTable(db, t, c)
        : t.kind === "sources" ? await sourcesTable(db, t, c, restricted)
          : await recordsTable(db, t, c, restricted);
    if (out !== null) tables.push(out);
  }
  return {
    key: d.key, label: d.label, description: d.description, generated_at: utcnow(), default_me: d.default_me,
    filters: c.f.toDict(), tiles, series: seriesOut, tables,
  };
}

/** Python `datetime.isoformat()` for an aware UTC datetime. */
export const pyIso = (d: Date): string => d.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

/** `_fmt` + csv.writer cell conversion. */
function fmt(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return String(JSON.stringify(v));
  return String(v);
}

/** csv.writer with the default dialect (QUOTE_MINIMAL, \r\n). */
function csvLine(cells: any[]): string {
  return cells
    .map((v) => {
      const s = fmt(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",") + "\r\n";
}

/** CSV of a built dashboard. Rows from license-restricted sources are withheld with the reason. */
export function dashboardCsv(out: DashboardOut): [string, number, number] {
  let buf = "";
  let rows = 0;
  let withheld = 0;
  const w = (cells: any[]) => (buf += csvLine(cells));
  w(["Dashboard", out.label]);
  w(["Generated", pyIso(out.generated_at)]);
  const qs = queryString(Object.entries(out.filters).flatMap(([k, vs]) => vs.map((v) => [k, v] as [string, string])));
  w(["Filters", qs.replace(/^\?/, "") || "none"]);
  buf += "\r\n";
  w(["Metric", "Value", "Unit", "Change vs previous period", "Definition"]);
  for (const t of out.tiles) {
    w([t.label, t.value, t.unit, t.delta, t.definition]);
    rows += 1;
  }
  for (const s of out.series) {
    buf += "\r\n";
    w([s.label]);
    w(["Group", ...s.series.map((m) => m.label)]);
    for (const p of s.points) {
      w([p.label, ...s.series.map((m) => p.values[m.key])]);
      rows += 1;
    }
  }
  for (const t of out.tables) {
    buf += "\r\n";
    w([t.label]);
    w(["Record", ...t.columns.map((cl) => cl.label)]);
    const reasons = new Set<string>();
    for (const r of t.rows) {
      if (r.restricted) {
        withheld += 1;
        reasons.add(r.restriction_reason || "Restricted source");
        continue;
      }
      w([r.title, ...t.columns.map((cl) => r.cells[cl.key])]);
      rows += 1;
    }
    if (reasons.size) w([`Withheld rows: ${[...reasons].sort().join("; ")}`]);
  }
  return [buf, rows, withheld];
}

export function recordsCsv(label: string, columns: Column[], items: Row[]): [string, number, number] {
  let buf = "";
  const w = (cells: any[]) => (buf += csvLine(cells));
  w(["id", label, ...columns.map((cl) => cl.label), "source"]);
  let rows = 0;
  let withheld = 0;
  const reasons = new Set<string>();
  for (const r of items) {
    if (r.restricted) {
      withheld += 1;
      reasons.add(r.restriction_reason || "Restricted source");
      continue;
    }
    w([r.id, r.title, ...columns.map((cl) => r.cells[cl.key]), r.source || ""]);
    rows += 1;
  }
  if (reasons.size) {
    buf += "\r\n";
    w([`${withheld} rows withheld: ${[...reasons].sort().join("; ")}`]);
  }
  return [buf, rows, withheld];
}
