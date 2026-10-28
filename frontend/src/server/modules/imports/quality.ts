/** Data quality metrics over properties: completeness, verification backlog, staleness and duplicates. */
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { applySearch, inFilter, type Page } from "../../common/query";
import { fieldObservations } from "../../common/schema";
import type { CurrentUser } from "../../core/deps";
import type { ListParams } from "../../core/router";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { insert, patch } from "../../db/orm";
import { MATERIAL_FIELDS, properties } from "../properties/schema";
import { dataQualityThresholds } from "./schema";

// Days after which a current fact is considered stale. Admins can override per field.
export const DEFAULT_STALENESS: Record<string, number> = {
  asking_price: 90,
  occupancy_pct: 180,
  noi: 365,
  wale_years: 365,
  zoning: 365,
  future_land_use: 730,
  traffic_count: 730,
  flood_zone: 1825,
};

const BANDS: Record<string, string> = { low: "Below 50%", medium: "50–79%", high: "80% and above" };
const LIVE = isNull(properties.deleted_at);
const obs = fieldObservations;
export const OBS_SORTS: Record<string, PgColumn> = {
  recorded_at: obs.recorded_at, observed_on: obs.observed_on, field: obs.field, confidence: obs.confidence, source: obs.source,
};

const DAY_MS = 86_400_000;
const todayStr = () => new Date().toISOString().slice(0, 10);
const minusDays = (today: string, d: number) => new Date(Date.parse(today) - d * DAY_MS).toISOString().slice(0, 10);

export async function thresholds(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = { ...DEFAULT_STALENESS };
  const rows = await db.select().from(dataQualityThresholds).where(isNull(dataQualityThresholds.deleted_at));
  for (const t of rows) out[t.field] = t.days;
  return out;
}

export async function listThresholds(db: Db) {
  const current = await thresholds(db);
  return [...MATERIAL_FIELDS].sort().map((f) => ({
    field: f,
    days: current[f] ?? null,
    default_days: DEFAULT_STALENESS[f] ?? null,
    is_default: (current[f] ?? null) === (DEFAULT_STALENESS[f] ?? null),
  }));
}

export async function setThresholds(db: Db, values: Record<string, number | null>, actor: CurrentUser) {
  const existing = new Map((await db.select().from(dataQualityThresholds)).map((t) => [t.field, t]));
  const before = await thresholds(db);
  for (const [field, days] of Object.entries(values)) {
    if (!MATERIAL_FIELDS.has(field)) throw new HttpError(422, `'${field}' is not a sourced property field`);
    if (days !== null && !(days >= 1 && days <= 36_500)) throw new HttpError(422, "Thresholds must be between 1 and 36,500 days");
    const row = existing.get(field);
    if (days === null) {
      if (row && !row.deleted_at) await patch(db, dataQualityThresholds, row, { deleted_at: utcnow(), updated_by_id: actor.id });
      continue;
    }
    if (row) await patch(db, dataQualityThresholds, row, { days, deleted_at: null, updated_by_id: actor.id });
    else await insert(db, dataQualityThresholds, { field, days, created_by_id: actor.id, updated_by_id: actor.id });
  }
  const after = await thresholds(db);
  const changes: Record<string, any> = {};
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[f] !== after[f]) changes[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  if (Object.keys(changes).length) {
    await audit.record(db, {
      actor, action: "data_quality.thresholds_changed", entity_type: "data_quality", summary: "Staleness thresholds",
      changes, ip_address: actor.ip_address,
    });
  }
  await db.commit();
  return listThresholds(db);
}

/** observations x properties, current property facts on live properties */
function obsBase(): SQL {
  return and(eq(obs.entity_type, "property"), eq(obs.is_current, true), LIVE) as SQL;
}

function staleCondition(limits: Record<string, number>, today: string): SQL | undefined {
  return or(...Object.entries(limits).map(([f, d]) => and(eq(obs.field, f), lt(obs.observed_on, minusDays(today, d)))));
}

const round = (v: number, n: number) => {
  const f = 10 ** n;
  return Math.round(v * f) / f;
};

export async function summary(db: Db) {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(properties).where(LIVE);
  const [{ avg }] = await db.select({ avg: sql<string | null>`avg(${properties.completeness_score})` }).from(properties).where(LIVE);

  const band = sql<string>`case when ${properties.completeness_score} < 50 then 'low' when ${properties.completeness_score} < 80 then 'medium' else 'high' end`;
  const bands: Record<string, number> = Object.fromEntries(Object.keys(BANDS).map((k) => [k, 0]));
  for (const r of await db.select({ b: band, c: sql<number>`count(*)::int` }).from(properties).where(LIVE).groupBy(band)) {
    bands[r.b] = Number(r.c);
  }

  const byTypeRows = await db
    .select({ t: properties.property_type, c: sql<number>`count(*)::int`, a: sql<string | null>`avg(${properties.completeness_score})` })
    .from(properties)
    .where(LIVE)
    .groupBy(properties.property_type)
    .orderBy(desc(sql`count(*)`));
  const by_type = byTypeRows.map((r) => ({ property_type: r.t, count: Number(r.c), average: round(Number(r.a ?? 0), 1) }));

  const unverifiedWhere = and(obsBase(), eq(obs.verification, "unverified"));
  const [{ n: backlog }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(obs)
    .innerJoin(properties, eq(properties.id, obs.entity_id))
    .where(unverifiedWhere);
  const [{ n: ai }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(obs)
    .innerJoin(properties, eq(properties.id, obs.entity_id))
    .where(and(unverifiedWhere, eq(obs.ai_derived, true)));

  const limits = await thresholds(db);
  const today = todayStr();
  const staleRows = Object.keys(limits).length
    ? new Map(
        (
          await db
            .select({ f: obs.field, n: sql<number>`count(*)::int` })
            .from(obs)
            .innerJoin(properties, eq(properties.id, obs.entity_id))
            .where(and(obsBase(), staleCondition(limits, today)))
            .groupBy(obs.field)
        ).map((r) => [r.f, Number(r.n)]),
      )
    : new Map<string, number>();
  const stale_by_field = Object.entries(limits)
    .map(([field, d]) => ({ field, threshold_days: d, stale: staleRows.get(field) ?? 0 }))
    .sort((a, b) => b.stale - a.stale);

  const [dup] = (await db.execute(sql`
    select count(*)::int as g, coalesce(sum(n), 0)::int as p
    from (select count(*) as n from properties where deleted_at is null group by normalized_address having count(*) > 1) s
  `)) as unknown as Array<{ g: number; p: number }>;
  const dupGroups = Number(dup?.g ?? 0);
  const dupProps = Number(dup?.p ?? 0);

  return {
    total_properties: Number(total),
    average_completeness: round(Number(avg ?? 0), 1),
    completeness_bands: bands,
    completeness_by_type: by_type,
    verification_backlog: Number(backlog),
    ai_unverified: Number(ai),
    stale_total: stale_by_field.reduce((a, s) => a + s.stale, 0),
    stale_by_field,
    duplicate_groups: dupGroups,
    duplicate_properties: dupProps,
    duplicate_rate: total ? round((100 * dupProps) / Number(total), 2) : 0.0,
  };
}

type ObsRow = {
  o: typeof fieldObservations.$inferSelect; name: string | null; address: string; city: string | null; state: string | null;
};

function backlogItem(r: ObsRow) {
  const o = r.o;
  return {
    id: o.id,
    property_id: o.entity_id,
    property_title: r.name || r.address,
    property_location: [r.name ? r.address : null, r.city, r.state].filter(Boolean).join(", ") || null,
    field: o.field,
    value: o.value,
    source: o.source,
    observed_on: o.observed_on,
    confidence: o.confidence,
    ai_derived: o.ai_derived,
    recorded_at: o.recorded_at,
  };
}

const obsSelect = (db: Db) =>
  db
    .select({ o: obs, name: properties.name, address: properties.address_line, city: properties.city, state: properties.state })
    .from(obs)
    .innerJoin(properties, eq(properties.id, obs.entity_id));

const searchWhere = (q: string | undefined) => applySearch(q, [properties.name, properties.address_line, properties.city, obs.source]);

function backlogWhere(
  params: ListParams, field: string[] | undefined, source: string | undefined, aiDerived: boolean | undefined,
  skip: Set<string> = new Set(),
): SQL | undefined {
  return and(
    obsBase(),
    eq(obs.verification, "unverified"),
    searchWhere(params.q),
    skip.has("field") ? undefined : inFilter(obs.field, field),
    source ? ilike(obs.source, `%${source}%`) : undefined,
    aiDerived !== undefined && !skip.has("ai_derived") ? eq(obs.ai_derived, aiDerived) : undefined,
  );
}

function orderFor(sort: string | undefined, fallback: SQL): SQL[] {
  if (sort) {
    const col = OBS_SORTS[sort.replace(/^-+/, "")];
    if (col) return [sort.startsWith("-") ? sql`${col} desc nulls last` : sql`${col} asc nulls last`];
  }
  return [fallback];
}

async function countObs(db: Db, where: SQL | undefined): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(obs)
    .innerJoin(properties, eq(properties.id, obs.entity_id))
    .where(where);
  return Number(r?.n ?? 0);
}

export async function backlog(
  db: Db, params: ListParams, field: string[] | undefined, source: string | undefined, aiDerived: boolean | undefined,
): Promise<[ReturnType<typeof backlogItem>[], number]> {
  const where = backlogWhere(params, field, source, aiDerived);
  const total = await countObs(db, where);
  const rows = await obsSelect(db)
    .where(where)
    .orderBy(...orderFor(params.sort, sql`${obs.recorded_at} asc`))
    .limit(params.page_size)
    .offset((params.page - 1) * params.page_size);
  return [rows.map(backlogItem), total];
}

async function obsFacet(db: Db, where: SQL | undefined, column: PgColumn): Promise<Record<string, number>> {
  const rows = await db
    .select({ k: column, n: sql<number>`count(*)::int` })
    .from(obs)
    .innerJoin(properties, eq(properties.id, obs.entity_id))
    .where(where)
    .groupBy(column);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.k !== null && r.k !== undefined) out[String(r.k)] = Number(r.n);
  return out;
}

export async function backlogFacets(
  db: Db, params: ListParams, field: string[] | undefined, source: string | undefined, aiDerived: boolean | undefined,
) {
  const fields = await obsFacet(db, backlogWhere(params, field, source, aiDerived, new Set(["field"])), obs.field);
  const ai = await obsFacet(db, backlogWhere(params, field, source, aiDerived, new Set(["ai_derived"])), obs.ai_derived);
  return { field: fields, ai_derived: Object.fromEntries(Object.entries(ai).map(([k, v]) => [k.toLowerCase(), v])) };
}

export async function stale(db: Db, params: ListParams, field: string[] | undefined) {
  let limits = await thresholds(db);
  if (field?.length) limits = Object.fromEntries(Object.entries(limits).filter(([f]) => field.includes(f)));
  if (!Object.keys(limits).length) return [[], 0] as [any[], number];
  const today = todayStr();
  const where = and(obsBase(), staleCondition(limits, today), searchWhere(params.q));
  const total = await countObs(db, where);
  const rows = await obsSelect(db)
    .where(where)
    .orderBy(...orderFor(params.sort, sql`${obs.observed_on} asc`))
    .limit(params.page_size)
    .offset((params.page - 1) * params.page_size);
  const items = rows.map((r) => ({
    ...backlogItem(r),
    verification: r.o.verification,
    threshold_days: limits[r.o.field],
    age_days: r.o.observed_on ? Math.floor((Date.parse(today) - Date.parse(r.o.observed_on)) / DAY_MS) : 0,
  }));
  return [items, total] as [any[], number];
}

export async function duplicates(db: Db, params: ListParams): Promise<[any[], number]> {
  const terms = params.q ? params.q.split(/\s+/).filter(Boolean) : [];
  const where = and(LIVE, ...terms.map((t) => ilike(properties.normalized_address, `%${t}%`)));
  // two separate builders: `.as()` on a builder that is later given ORDER BY/LIMIT would leak those into the subquery
  const groups = () =>
    db
      .select({ addr: properties.normalized_address, n: sql<number>`count(*)::int`.as("n") })
      .from(properties)
      .where(where)
      .groupBy(properties.normalized_address)
      .having(sql`count(*) > 1`);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(groups().as("g"));
  const pageRows = await groups()
    .orderBy(desc(sql`count(*)`), asc(properties.normalized_address))
    .limit(params.page_size)
    .offset((params.page - 1) * params.page_size);
  const keys = pageRows.map((r) => r.addr);
  const members: Record<string, any[]> = Object.fromEntries(keys.map((k) => [k, []]));
  if (keys.length) {
    const ps = await db
      .select()
      .from(properties)
      .where(and(LIVE, inArray(properties.normalized_address, keys)))
      .orderBy(asc(properties.created_at));
    for (const p of ps) {
      members[p.normalized_address].push({
        id: p.id, name: p.name, address_line: p.address_line, city: p.city, state: p.state, status: p.status,
        completeness_score: p.completeness_score, created_at: p.created_at,
      });
    }
  }
  return [pageRows.map((r) => ({ normalized_address: r.addr, count: Number(r.n), properties: members[r.addr] })), Number(total)];
}

export type { Page };
