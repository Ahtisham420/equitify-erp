import { and, asc, eq, getTableColumns, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import * as audit from "../../common/audit";
import { applySearch, countWhere, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import type { ListParams } from "../../core/router";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { raw } from "../../db/orm";
import { users } from "../auth/schema";
import { propertyParcels } from "../parcels/schema";
import * as geo from "../parcels/geo";
import { properties } from "../properties/schema";
import { buildWhere as propertyBuildWhere, type PropertyFilters } from "../properties/service";
import { savedViews } from "../search/schema";
import {
  corridors,
  growthRecords,
  nodes,
  tradeAreas,
  trafficCounts,
  territories,
  territoryMembers,
  type Territory,
} from "./schema";
import type { MembersIn, TerritoryIn, TerritoryUpdate } from "./schemas";

export const GEO_FIELDS = new Set(["latitude", "longitude", "county", "city", "state", "location"]);
export const DEFAULT_CORRIDOR_BUFFER_FT = 500.0;

type Plain = Record<string, any>;
/** Territory row without the (large, deferred) geometry column. */
export type TerritoryRow = Omit<Territory, "geometry">;

const round = (x: number, digits: number) => {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
};
const fmt = (n: number, digits: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const defined = (o: Plain): Plain => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All columns except the deferred PostGIS ones (geometry / location): they are only read through SQL. */
export function plainCols(table: PgTable): Plain {
  const { geometry: _g, location: _l, ...rest } = getTableColumns(table) as Plain;
  return rest;
}

// ============================================================================= shared CRUD helpers

export async function getObj(db: Db, table: PgTable, objId: string, label: string): Promise<Plain> {
  const [obj] = await db
    .select(plainCols(table))
    .from(table)
    .where(eq((table as any).id, objId))
    .limit(1);
  if (!obj || obj.deleted_at) throw new HttpError(404, `${label} not found`);
  return obj;
}

async function saveRow(db: Db, table: PgTable, obj: Plain, values: Plain): Promise<Plain> {
  const [u] = await db.update(table).set(values as never).where(eq((table as any).id, obj.id)).returning(plainCols(table));
  if (u) Object.assign(obj, u);
  return obj;
}

interface GeomChange {
  set: Plain;
  change: { from: string | null; to: string | null };
}

async function applyLine(db: Db, rawGeom: unknown, clear: boolean, hasGeometry: boolean): Promise<GeomChange | null> {
  if (rawGeom && Object.keys(rawGeom as object).length) {
    const [wkt, lengthFt] = await geo.lineFromGeojson(db, rawGeom);
    return {
      set: { geometry: sql`ST_GeomFromText(${wkt}, 4326)`, has_geometry: true, length_ft: round(lengthFt, 2) },
      change: { from: null, to: `line (${fmt(lengthFt, 0)} ft)` },
    };
  }
  if (clear && hasGeometry) {
    return { set: { geometry: null, has_geometry: false, length_ft: null }, change: { from: "line", to: null } };
  }
  return null;
}

async function applyPolygon(db: Db, rawGeom: unknown): Promise<GeomChange | null> {
  if (!rawGeom || !Object.keys(rawGeom as object).length) return null;
  const shape = await geo.polygonFromGeojson(db, rawGeom);
  return {
    set: { geometry: sql`ST_GeomFromText(${shape.wkt}, 4326)`, has_geometry: true },
    change: { from: null, to: `polygon (${fmt(shape.acres, 1)} ac)` },
  };
}

const pointValue = (lat: unknown, lng: unknown) =>
  lat !== null && lat !== undefined && lng !== null && lng !== undefined ? geo.point(lat as number, lng as number) : null;

export async function createRecord(
  db: Db,
  table: PgTable,
  values: Plain,
  actor: CurrentUser,
  entity: string,
  { geometry, kind, summary }: { geometry?: unknown; kind?: "line" | "polygon"; summary?: string } = {},
): Promise<Plain> {
  const row: Plain = { ...defined(values), created_by_id: actor.id, updated_by_id: actor.id };
  if ("location" in table) row.location = pointValue(row.latitude, row.longitude);
  if (kind === "line") Object.assign(row, (await applyLine(db, geometry, false, false))?.set ?? {});
  else if (kind === "polygon") Object.assign(row, (await applyPolygon(db, geometry))?.set ?? {});
  const [obj] = await db.insert(table).values(row as never).returning(plainCols(table));
  await audit.record(db, {
    actor, action: `${entity}.created`, entity_type: entity, entity_id: obj.id, summary: summary ?? obj.name ?? null,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return obj;
}

export async function updateRecord(
  db: Db,
  table: PgTable,
  obj: Plain,
  values: Plain,
  actor: CurrentUser,
  entity: string,
  { geometry, clear_geometry = false, kind }: { geometry?: unknown; clear_geometry?: boolean; kind?: "line" | "polygon" } = {},
): Promise<Plain> {
  const changes = audit.diff(obj, values);
  const set: Plain = { ...values };
  // `values` is applied in memory too, so later reads in this request see the new state.
  Object.assign(obj, values);
  if ("location" in table && ("latitude" in changes || "longitude" in changes)) {
    set.location = pointValue(obj.latitude, obj.longitude);
  }
  let geomChange: GeomChange | null = null;
  if (kind === "line") geomChange = await applyLine(db, geometry, clear_geometry, Boolean(obj.has_geometry));
  else if (kind === "polygon") geomChange = await applyPolygon(db, geometry);
  if (geomChange) {
    Object.assign(set, geomChange.set);
    changes.geometry = geomChange.change;
  }
  if (!Object.keys(changes).length) return obj;
  set.updated_by_id = actor.id;
  await saveRow(db, table, obj, set);
  await audit.record(db, {
    actor, action: `${entity}.updated`, entity_type: entity, entity_id: obj.id, changes, summary: obj.name ?? null,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return obj;
}

export async function archiveRecord(db: Db, table: PgTable, obj: Plain, actor: CurrentUser, entity: string): Promise<void> {
  await saveRow(db, table, obj, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: `${entity}.archived`, entity_type: entity, entity_id: obj.id, summary: obj.name ?? null,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function geojsonOf(db: Db, table: PgTable, objId: string): Promise<Plain | null> {
  const t = table as any;
  const [r] = await db
    .select({ g: sql<string | null>`ST_AsGeoJSON(${t.geometry}, 7)` })
    .from(table)
    .where(eq(t.id, objId));
  return geo.loads(r?.g);
}

const offset = (p: ListParams) => (p.page - 1) * p.page_size;

// ============================================================================= corridors

export interface CorridorFilters {
  q?: string;
  road_class?: string[];
  county?: string;
  city?: string;
  has_geometry?: boolean;
}

export function corridorWhere(f: CorridorFilters): SQL | undefined {
  const c = corridors;
  return and(
    isNull(c.deleted_at),
    applySearch(f.q, [c.name, c.road_name, c.city, c.county]),
    inFilter(c.road_class, f.road_class),
    f.county ? ilike(c.county, `%${f.county}%`) : undefined,
    f.city ? ilike(c.city, `%${f.city}%`) : undefined,
    f.has_geometry !== undefined ? eq(c.has_geometry, f.has_geometry) : undefined,
  );
}

const corridorExtras = {
  node_count: sql<number>`(select count(*)::int from ${nodes} where ${nodes.corridor_id} = ${corridors.id} and ${nodes.deleted_at} is null)`,
  latest_count: sql<number | null>`(select ${trafficCounts.count} from ${trafficCounts} where ${trafficCounts.corridor_id} = ${corridors.id} and ${trafficCounts.deleted_at} is null order by ${trafficCounts.count_year} desc limit 1)`,
  latest_count_year: sql<number | null>`(select ${trafficCounts.count_year} from ${trafficCounts} where ${trafficCounts.corridor_id} = ${corridors.id} and ${trafficCounts.deleted_at} is null order by ${trafficCounts.count_year} desc limit 1)`,
};

const corridorRow = (c: Plain) => ({
  id: c.id,
  name: c.name,
  road_name: c.road_name,
  road_class: c.road_class,
  side_of_road: c.side_of_road,
  travel_direction: c.travel_direction,
  frontage_length_ft: c.frontage_length_ft,
  city: c.city,
  county: c.county,
  state: c.state,
  has_geometry: c.has_geometry,
  length_ft: c.length_ft,
  source: c.source,
  observed_on: c.observed_on,
  notes: c.notes,
  node_count: Number(c.node_count ?? 0),
  latest_count: c.latest_count ?? null,
  latest_count_year: c.latest_count_year ?? null,
  geojson: null as Plain | null,
  updated_at: c.updated_at,
});

export async function listCorridors(db: Db, f: CorridorFilters, order: SQL[], p: ListParams) {
  const where = corridorWhere(f);
  const total = await countWhere(db, corridors, where);
  const rows = await db
    .select({ ...plainCols(corridors), ...corridorExtras })
    .from(corridors)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset(offset(p));
  return { items: rows.map(corridorRow), total };
}

export async function corridorOut(db: Db, c: Plain) {
  const [row] = await db
    .select({ ...plainCols(corridors), ...corridorExtras })
    .from(corridors)
    .where(eq(corridors.id, c.id));
  const out = corridorRow(row);
  out.geojson = await geojsonOf(db, corridors, c.id);
  return out;
}

export async function corridorsGeojson(db: Db, f: CorridorFilters, limit: number) {
  const rows = await db
    .select({
      id: corridors.id, name: corridors.name, road_class: corridors.road_class,
      g: sql<string | null>`ST_AsGeoJSON(${corridors.geometry}, 6)`,
    })
    .from(corridors)
    .where(and(corridorWhere(f), eq(corridors.has_geometry, true)))
    .limit(limit);
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature", id: r.id, geometry: geo.loads(r.g), properties: { id: r.id, name: r.name, road_class: r.road_class },
    })),
  };
}

// ============================================================================= nodes

export interface NodeFilters {
  q?: string;
  corridor_id?: string;
  county?: string;
  city?: string;
  signalized?: boolean;
}

export function nodeWhere(f: NodeFilters): SQL | undefined {
  const n = nodes;
  return and(
    isNull(n.deleted_at),
    applySearch(f.q, [n.name, n.cross_street, n.city, n.county]),
    f.corridor_id ? eq(n.corridor_id, f.corridor_id) : undefined,
    f.county ? ilike(n.county, `%${f.county}%`) : undefined,
    f.city ? ilike(n.city, `%${f.city}%`) : undefined,
    f.signalized !== undefined ? eq(n.signalized, f.signalized) : undefined,
  );
}

const nodeOut = (n: Plain) => ({
  id: n.id,
  name: n.name,
  corridor_id: n.corridor_id,
  corridor_name: n.corridor_name ?? null,
  cross_street: n.cross_street,
  city: n.city,
  county: n.county,
  state: n.state,
  latitude: n.latitude,
  longitude: n.longitude,
  approach_traffic: n.approach_traffic,
  signalized: n.signalized,
  turn_restrictions: n.turn_restrictions,
  quadrants: n.quadrants,
  nearby_development: n.nearby_development,
  source: n.source,
  observed_on: n.observed_on,
  notes: n.notes,
  updated_at: n.updated_at,
});

const nodeSelect = (db: Db) =>
  db
    .select({ ...plainCols(nodes), corridor_name: corridors.name })
    .from(nodes)
    .leftJoin(corridors, eq(corridors.id, nodes.corridor_id));

export async function listNodes(db: Db, f: NodeFilters, order: SQL[], p: ListParams) {
  const where = nodeWhere(f);
  const total = await countWhere(db, nodes, where);
  const rows = await nodeSelect(db).where(where).orderBy(...order).limit(p.page_size).offset(offset(p));
  return { items: rows.map(nodeOut), total };
}

export async function nodeDetail(db: Db, nodeId: string) {
  const [row] = await nodeSelect(db).where(and(nodeWhere({}), eq(nodes.id, nodeId)));
  if (!row) throw new HttpError(404, "Node not found");
  return nodeOut(row);
}

// ============================================================================= traffic counts

export interface TrafficFilters {
  q?: string;
  corridor_id?: string;
  node_id?: string;
  min_year?: number;
  max_year?: number;
  min_count?: number;
  max_count?: number;
  source?: string;
}

export function trafficWhere(f: TrafficFilters): SQL | undefined {
  const t = trafficCounts;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.segment, t.approach, t.source]),
    f.corridor_id ? eq(t.corridor_id, f.corridor_id) : undefined,
    f.node_id ? eq(t.node_id, f.node_id) : undefined,
    f.source ? ilike(t.source, `%${f.source}%`) : undefined,
    rangeFilter(t.count_year, f.min_year, f.max_year),
    rangeFilter(t.count, f.min_count, f.max_count),
  );
}

function trafficSelect(db: Db) {
  const t = trafficCounts;
  const lagged = db
    .select({
      tid: t.id,
      prev: sql<number | null>`lag(${t.count}) over (partition by ${t.corridor_id}, ${t.node_id}, ${t.segment}, ${t.approach} order by ${t.count_year})`.as("prev"),
    })
    .from(t)
    .where(isNull(t.deleted_at))
    .as("lagged");
  return db
    .select({ ...plainCols(t), prev: lagged.prev, corridor_name: corridors.name, node_name: nodes.name })
    .from(t)
    .innerJoin(lagged, eq(lagged.tid, t.id))
    .leftJoin(corridors, eq(corridors.id, t.corridor_id))
    .leftJoin(nodes, eq(nodes.id, t.node_id));
}

const trafficRow = (r: Plain) => ({
  id: r.id,
  corridor_id: r.corridor_id,
  corridor_name: r.corridor_name ?? null,
  node_id: r.node_id,
  node_name: r.node_name ?? null,
  segment: r.segment,
  approach: r.approach,
  count: r.count,
  count_year: r.count_year,
  count_type: r.count_type,
  latitude: r.latitude,
  longitude: r.longitude,
  source: r.source,
  observed_on: r.observed_on,
  notes: r.notes,
  // vs previous count year for the same segment/approach
  change_pct: r.prev ? round(((r.count - r.prev) / r.prev) * 100, 1) : null,
  updated_at: r.updated_at,
});

export async function listTraffic(db: Db, f: TrafficFilters, order: SQL[], p: ListParams) {
  const where = trafficWhere(f);
  const total = await countWhere(db, trafficCounts, where);
  const rows = await trafficSelect(db).where(where).orderBy(...order).limit(p.page_size).offset(offset(p));
  return { items: rows.map(trafficRow), total };
}

export async function trafficDetail(db: Db, tid: string) {
  const [row] = await trafficSelect(db).where(and(trafficWhere({}), eq(trafficCounts.id, tid)));
  if (!row) throw new HttpError(404, "Traffic count not found");
  return trafficRow(row);
}

export async function trafficTrend(
  db: Db,
  { corridor_id, node_id, segment, approach }: { corridor_id?: string; node_id?: string; segment?: string; approach?: string },
) {
  if (!(corridor_id || node_id || segment)) throw new HttpError(422, "Provide corridor_id, node_id or segment");
  const t = trafficCounts;
  return db
    .select({ count_year: t.count_year, count: t.count, source: t.source, segment: t.segment, approach: t.approach })
    .from(t)
    .where(
      and(
        isNull(t.deleted_at),
        corridor_id ? eq(t.corridor_id, corridor_id) : undefined,
        node_id ? eq(t.node_id, node_id) : undefined,
        segment ? eq(t.segment, segment) : undefined,
        approach ? eq(t.approach, approach) : undefined,
      ),
    )
    .orderBy(asc(t.count_year), asc(t.observed_on));
}

// ============================================================================= trade areas

export function tradeAreaWhere(nodeId?: string, propertyId?: string, minutes?: number[], q?: string): SQL | undefined {
  const t = tradeAreas;
  return and(
    isNull(t.deleted_at),
    applySearch(q, [t.name, t.source, nodes.name, properties.address_line]),
    nodeId ? eq(t.node_id, nodeId) : undefined,
    propertyId ? eq(t.property_id, propertyId) : undefined,
    inFilter(t.minutes, minutes),
  );
}

function tradeSelect(db: Db) {
  return db
    .select({
      ...plainCols(tradeAreas),
      node_name: nodes.name,
      property_label: sql<string | null>`coalesce(${properties.name}, ${properties.address_line})`,
    })
    .from(tradeAreas)
    .leftJoin(nodes, eq(nodes.id, tradeAreas.node_id))
    .leftJoin(properties, eq(properties.id, tradeAreas.property_id));
}

const tradeOut = (t: Plain) => ({
  id: t.id,
  name: t.name,
  node_id: t.node_id,
  node_name: t.node_name ?? null,
  property_id: t.property_id,
  property_label: t.property_label ?? null,
  minutes: t.minutes,
  has_geometry: t.has_geometry,
  demographics: t.demographics,
  competitors: t.competitors,
  anchors: t.anchors,
  source: t.source,
  observed_on: t.observed_on,
  notes: t.notes,
  geojson: null as Plain | null,
  updated_at: t.updated_at,
});

export async function listTradeAreas(
  db: Db,
  { node_id, property_id, minutes, q }: { node_id?: string; property_id?: string; minutes?: number[]; q?: string },
  order: SQL[],
  p: ListParams,
) {
  const where = tradeAreaWhere(node_id, property_id, minutes, q);
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tradeAreas)
    .leftJoin(nodes, eq(nodes.id, tradeAreas.node_id))
    .leftJoin(properties, eq(properties.id, tradeAreas.property_id))
    .where(where);
  const rows = await tradeSelect(db).where(where).orderBy(...order).limit(p.page_size).offset(offset(p));
  return { items: rows.map(tradeOut), total: c?.n ?? 0 };
}

export async function tradeDetail(db: Db, tid: string) {
  const [row] = await tradeSelect(db).where(and(tradeAreaWhere(), eq(tradeAreas.id, tid)));
  if (!row) throw new HttpError(404, "Trade area not found");
  const out = tradeOut(row);
  out.geojson = await geojsonOf(db, tradeAreas, tid);
  return out;
}

// ============================================================================= growth context

export interface GrowthFilters {
  q?: string;
  kind?: string[];
  county?: string;
  city?: string;
  from_date?: string;
  to_date?: string;
  near_lat?: number;
  near_lng?: number;
  property_id?: string;
  node_id?: string;
  radius_miles?: number;
}

export async function resolveCenter(
  db: Db,
  { lat, lng, property_id, node_id }: { lat?: number | null; lng?: number | null; property_id?: string | null; node_id?: string | null },
): Promise<[number, number] | null> {
  if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) return [lat, lng];
  let row: { lat: number | null; lng: number | null } | undefined;
  if (property_id) {
    [row] = await db
      .select({ lat: properties.latitude, lng: properties.longitude })
      .from(properties)
      .where(eq(properties.id, property_id));
  } else if (node_id) {
    [row] = await db.select({ lat: nodes.latitude, lng: nodes.longitude }).from(nodes).where(eq(nodes.id, node_id));
  } else {
    return null;
  }
  if (!row || row.lat === null || row.lng === null) throw new HttpError(422, "The selected center has no coordinates");
  return [Number(row.lat), Number(row.lng)];
}

/** WHERE clause + distance expression (miles from the center, or NULL without a center) for growth records. */
export async function growthParts(db: Db, f: GrowthFilters, skip: Set<string> = new Set()) {
  const g = growthRecords;
  const center = await resolveCenter(db, { lat: f.near_lat, lng: f.near_lng, property_id: f.property_id, node_id: f.node_id });
  const dist = center
    ? sql<number | null>`ST_Distance(${g.location}::geography, ${geo.point(...center)}::geography) / ${geo.M_PER_MILE}::float8`
    : sql<number | null>`null::float8`;
  const where = and(
    isNull(g.deleted_at),
    applySearch(f.q, [g.name, g.description, g.source, g.city]),
    skip.has("kind") ? undefined : inFilter(g.kind, f.kind),
    f.county ? ilike(g.county, `%${f.county}%`) : undefined,
    f.city ? ilike(g.city, `%${f.city}%`) : undefined,
    rangeFilter(g.event_date, f.from_date, f.to_date),
    center && f.radius_miles
      ? sql`ST_DWithin(${g.location}::geography, ${geo.point(...center)}::geography, ${f.radius_miles * geo.M_PER_MILE})`
      : undefined,
  );
  return { where, dist };
}

export const growthOut = (g: Plain, distance: number | null | undefined) => ({
  id: g.id,
  kind: g.kind,
  name: g.name,
  description: g.description,
  status: g.status,
  units: g.units,
  value: g.value,
  event_date: g.event_date,
  city: g.city,
  county: g.county,
  state: g.state,
  latitude: g.latitude,
  longitude: g.longitude,
  source: g.source,
  observed_on: g.observed_on,
  distance_miles: distance !== null && distance !== undefined ? round(Number(distance), 2) : null,
  updated_at: g.updated_at,
});

export async function listGrowth(db: Db, f: GrowthFilters, order: (distance: SQL) => SQL[], p: ListParams) {
  const { where, dist } = await growthParts(db, f);
  const total = await countWhere(db, growthRecords, where);
  const rows = await db
    .select({ ...plainCols(growthRecords), distance_miles: dist.as("distance_miles") })
    .from(growthRecords)
    .where(where)
    .orderBy(...order(sql.raw("distance_miles")))
    .limit(p.page_size)
    .offset(offset(p));
  return { items: rows.map((r) => growthOut(r, r.distance_miles)), total };
}

// ============================================================================= territories: visibility

const roleKey = (user: CurrentUser): string | null => (user.user as Plain).role?.key ?? null;

export function visibleClause(user: CurrentUser): SQL {
  if (user.is_admin) return sql`true`;
  const t = territories;
  const role = roleKey(user);
  return or(
    eq(t.visibility, "company"),
    eq(t.owner_id, user.id),
    role ? and(eq(t.visibility, "role"), sql`${role} = any(${t.allowed_roles})`) : undefined,
  ) as SQL;
}

export const canEdit = (t: TerritoryRow, user: CurrentUser) =>
  user.is_admin || t.owner_id === user.id || user.can("territories", "approve");

export async function getVisible(db: Db, territoryId: string, user: CurrentUser): Promise<TerritoryRow> {
  const { geometry: _g, ...cols } = getTableColumns(territories);
  const [t] = await db
    .select(cols)
    .from(territories)
    .where(and(eq(territories.id, territoryId), isNull(territories.deleted_at), visibleClause(user)))
    .limit(1);
  if (!t) throw new HttpError(404, "Territory not found");
  return t;
}

export function requireEdit(t: TerritoryRow, user: CurrentUser): void {
  if (!canEdit(t, user)) throw new HttpError(403, "Only the territory owner or an approver can change it");
}

export interface TerritoryFilters {
  q?: string;
  rule_type?: string[];
  visibility?: string[];
  parent_id?: string;
  top_level?: boolean;
  mine?: boolean;
}

export function territoryWhere(f: TerritoryFilters, user: CurrentUser, skip: Set<string> = new Set()): SQL | undefined {
  const t = territories;
  return and(
    isNull(t.deleted_at),
    visibleClause(user),
    applySearch(f.q, [t.name, t.description]),
    skip.has("rule_type") ? undefined : inFilter(t.rule_type, f.rule_type),
    skip.has("visibility") ? undefined : inFilter(t.visibility, f.visibility),
    f.parent_id ? eq(t.parent_id, f.parent_id) : undefined,
    f.top_level ? isNull(t.parent_id) : undefined,
    f.mine ? eq(t.owner_id, user.id) : undefined,
  );
}

export const territoryItem = (t: TerritoryRow) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  rule_type: t.rule_type,
  rule: t.rule,
  has_geometry: t.has_geometry,
  parent_id: t.parent_id,
  visibility: t.visibility,
  allowed_roles: t.allowed_roles,
  owner_id: t.owner_id,
  assignee_id: t.assignee_id,
  member_count: t.member_count,
  last_computed_at: t.last_computed_at,
  updated_at: t.updated_at,
});

const territoryCols = (() => {
  const { geometry: _g, ...cols } = getTableColumns(territories);
  return cols;
})();

/** Visible territories matching the filters (rows without geometry), ordered and limited. */
export async function listTerritories(
  db: Db,
  f: TerritoryFilters,
  user: CurrentUser,
  order: SQL[],
  p?: ListParams,
): Promise<{ items: ReturnType<typeof territoryItem>[]; total: number }> {
  const where = territoryWhere(f, user);
  const total = await countWhere(db, territories, where);
  let q = db.select(territoryCols).from(territories).where(where).orderBy(...order).$dynamic();
  if (p) q = q.limit(p.page_size).offset(offset(p));
  else q = q.limit(500);
  return { items: (await q).map(territoryItem), total };
}

export async function territoryOut(db: Db, t: TerritoryRow, user: CurrentUser) {
  const ids = [t.owner_id, t.assignee_id].filter((i): i is string => Boolean(i));
  const names = new Map<string, string>();
  if (ids.length) {
    for (const r of await db.select({ id: users.id, name: users.full_name }).from(users).where(inArray(users.id, ids))) {
      names.set(r.id, r.name);
    }
  }
  let parentName: string | null = null;
  if (t.parent_id) {
    const [r] = await db.select({ name: territories.name }).from(territories).where(eq(territories.id, t.parent_id));
    parentName = r?.name ?? null;
  }
  const children = await db
    .select(territoryCols)
    .from(territories)
    .where(territoryWhere({ parent_id: t.id }, user))
    .orderBy(asc(territories.name));
  return {
    ...territoryItem(t),
    parent_name: parentName,
    owner_name: t.owner_id ? names.get(t.owner_id) ?? null : null,
    assignee_name: t.assignee_id ? names.get(t.assignee_id) ?? null : null,
    children: children.map(territoryItem),
    geojson: await geojsonOf(db, territories, t.id),
    can_edit: canEdit(t, user),
    created_at: t.created_at,
  };
}

// ============================================================================= territories: rules

function num(rule: Plain, key: string, { lo, hi, default: dflt }: { lo: number; hi: number; default?: number }): number {
  const raw = key in rule ? rule[key] : dflt;
  let value = NaN;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "boolean") value = Number(raw);
  else if (typeof raw === "string" && raw.trim() !== "") value = Number(raw);
  if (Number.isNaN(value)) throw new HttpError(422, `Rule field '${key}' must be a number`);
  if (!(lo <= value && value <= hi)) throw new HttpError(422, `Rule field '${key}' must be between ${lo} and ${hi}`);
  return value;
}

function uuidOf(rule: Plain, key: string): string | null {
  const raw = rule[key];
  if (!raw) return null;
  const s = String(raw).trim().replace(/^\{|\}$/g, "").toLowerCase();
  const m = /^[0-9a-f]{32}$/.test(s) ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` : s;
  if (!UUID_RE.test(m)) throw new HttpError(422, `Rule field '${key}' must be an id`);
  return m;
}

/** Validate the configurable membership rule and keep only the keys that rule type uses. */
export async function normalizeRule(db: Db, ruleType: string | null | undefined, rule: Plain): Promise<Plain> {
  if (ruleType === "explicit" || ruleType === "boundary") return {};
  if (ruleType === "radius") {
    const out: Plain = { radius_miles: num(rule, "radius_miles", { lo: 0.01, hi: 200 }) };
    const nodeId = uuidOf(rule, "node_id");
    const propertyId = uuidOf(rule, "property_id");
    if (nodeId) {
      await getObj(db, nodes, nodeId, "Node");
      out.node_id = nodeId;
    } else if (propertyId) {
      out.property_id = propertyId;
    } else {
      out.lat = num(rule, "lat", { lo: -90, hi: 90 });
      out.lng = num(rule, "lng", { lo: -180, hi: 180 });
    }
    await resolveCenter(db, { lat: out.lat, lng: out.lng, property_id: propertyId, node_id: nodeId });
    return out;
  }
  if (ruleType === "corridor") {
    const corridorId = uuidOf(rule, "corridor_id");
    if (!corridorId) throw new HttpError(422, "Choose a corridor");
    const c = await getObj(db, corridors, corridorId, "Corridor");
    if (!c.has_geometry) throw new HttpError(422, "The corridor has no line geometry yet");
    return {
      corridor_id: corridorId,
      buffer_ft: num(rule, "buffer_ft", { lo: 1, hi: 26_400, default: DEFAULT_CORRIDOR_BUFFER_FT }),
    };
  }
  if (ruleType === "county" || ruleType === "city") {
    let values: unknown = rule.values || [];
    if (typeof values === "string") values = values.split(",");
    const list = (Array.isArray(values) ? values : [])
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (!list.length) throw new HttpError(422, `Add at least one ${ruleType}`);
    const out: Plain = { values: list };
    if (rule.state) out.state = String(rule.state).trim();
    return out;
  }
  if (ruleType === "saved_query") {
    const viewId = uuidOf(rule, "saved_view_id");
    const [view] = viewId ? await db.select().from(savedViews).where(eq(savedViews.id, viewId)) : [];
    if (!view || view.deleted_at || view.module !== "properties") throw new HttpError(422, "Choose a saved property view");
    return { saved_view_id: view.id, saved_view_name: view.name };
  }
  throw new HttpError(422, "Unknown rule type");
}

type FilterKind = "str" | "list" | "uuids" | "float" | "int";
const PROPERTY_FILTER_KINDS: Record<keyof PropertyFilters, FilterKind> = {
  q: "str", status: "list", property_type: "list", state: "list", county: "str", city: "str", tag: "list",
  min_area: "float", max_area: "float", min_acres: "float", max_acres: "float", min_price: "float", max_price: "float",
  min_year: "int", max_year: "int", min_completeness: "float", near_lat: "float", near_lng: "float", radius_miles: "float",
  ids: "uuids",
};

function pyFloat(v: unknown): number {
  const s = String(v).trim();
  const n = Number(s);
  if (s === "" || Number.isNaN(n)) throw new Error("not a number");
  return n;
}

/** Saved view params are URL strings; coerce them to PropertyFilters field types (bad values are skipped). */
function filtersFromParams(params: Plain): PropertyFilters {
  const out: Plain = {};
  for (const [name, kind] of Object.entries(PROPERTY_FILTER_KINDS)) {
    const rawValue = params[name];
    if (rawValue === null || rawValue === undefined || rawValue === "" || (Array.isArray(rawValue) && !rawValue.length)) continue;
    const values: unknown[] = Array.isArray(rawValue) ? rawValue : [rawValue];
    try {
      if (kind === "uuids") {
        out[name] = values.map((v) => {
          const s = String(v);
          if (!UUID_RE.test(s)) throw new Error("bad uuid");
          return s.toLowerCase();
        });
      } else if (kind === "list") out[name] = values.map((v) => String(v));
      else if (kind === "float") out[name] = pyFloat(values[0]);
      else if (kind === "int") out[name] = Math.trunc(pyFloat(values[0]));
      else out[name] = String(values[0]);
    } catch {
      continue;
    }
  }
  return out as PropertyFilters;
}

/** SQL condition on `properties` matching the territory rule; null for explicit (manual-only) territories. */
async function ruleCondition(db: Db, t: TerritoryRow): Promise<SQL | null> {
  const rule = t.rule ?? {};
  const p = properties;
  const live = isNull(p.deleted_at);
  const loc = sql`${p.location}::geography`;
  const none = and(live, sql`false`) as SQL;
  switch (t.rule_type) {
    case "explicit":
      return null;
    case "boundary": {
      if (!t.has_geometry) return none;
      return and(
        live,
        sql`${p.location} is not null`,
        sql`ST_Contains((select ${territories.geometry} from ${territories} where ${territories.id} = ${t.id}), ${p.location})`,
      ) as SQL;
    }
    case "radius": {
      let center: [number, number] | null;
      try {
        center = await resolveCenter(db, {
          lat: rule.lat, lng: rule.lng, property_id: uuidOf(rule, "property_id"), node_id: uuidOf(rule, "node_id"),
        });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        center = null;
      }
      if (!center) return none;
      const meters = Number(rule.radius_miles || 0) * geo.M_PER_MILE;
      return and(live, sql`ST_DWithin(${loc}, ${geo.point(...center)}::geography, ${meters})`) as SQL;
    }
    case "corridor": {
      const cid = uuidOf(rule, "corridor_id");
      if (!cid) return none;
      const meters = Number(rule.buffer_ft || DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT;
      return and(
        live,
        sql`ST_DWithin(${loc}, (select ${corridors.geometry} from ${corridors} where ${corridors.id} = ${cid})::geography, ${meters})`,
      ) as SQL;
    }
    case "county":
    case "city": {
      const col = t.rule_type === "county" ? p.county : p.city;
      const values = ((rule.values as string[] | undefined) ?? []).map((v) => v.toLowerCase());
      if (!values.length) return none;
      return and(
        live,
        sql`lower(trim(${col})) in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`,
        rule.state ? sql`lower(${p.state}) = ${String(rule.state).toLowerCase()}` : undefined,
      ) as SQL;
    }
    case "saved_query": {
      const viewId = rule.saved_view_id ? uuidOf(rule, "saved_view_id") : null;
      const [view] = viewId ? await db.select().from(savedViews).where(eq(savedViews.id, viewId)) : [];
      if (!view || view.deleted_at) return none;
      return propertyBuildWhere(filtersFromParams(view.params ?? {})) ?? live;
    }
    default:
      return none;
  }
}

/** Radius / corridor rules store their computed buffer so the territory can be drawn and used as a spatial filter. */
async function displayGeometryValues(db: Db, t: TerritoryRow): Promise<Plain> {
  const rule = t.rule ?? {};
  if (t.rule_type === "radius") {
    let center: [number, number] | null;
    try {
      center = await resolveCenter(db, {
        lat: rule.lat, lng: rule.lng, property_id: uuidOf(rule, "property_id"), node_id: uuidOf(rule, "node_id"),
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      center = null;
    }
    if (center) {
      const meters = Number(rule.radius_miles || 0) * geo.M_PER_MILE;
      return {
        geometry: sql`ST_SetSRID(ST_Buffer(${geo.point(...center)}::geography, ${meters}::float8)::geometry, 4326)`,
        has_geometry: true,
      };
    }
    return {};
  }
  if (t.rule_type === "corridor") {
    const cid = uuidOf(rule, "corridor_id");
    const meters = Number(rule.buffer_ft || DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT;
    const line = cid ? sql`(select ${corridors.geometry} from ${corridors} where ${corridors.id} = ${cid})` : sql`null`;
    return { geometry: sql`ST_SetSRID(ST_Buffer(${line}::geography, ${meters}::float8)::geometry, 4326)`, has_geometry: true };
  }
  if (t.rule_type !== "boundary") return { geometry: null, has_geometry: false };
  return {};
}

async function saveTerritory(db: Db, t: TerritoryRow, values: Plain): Promise<TerritoryRow> {
  const [u] = await db.update(territories).set(values as never).where(eq(territories.id, t.id)).returning(territoryCols);
  if (u) Object.assign(t, u);
  return t;
}

async function memberCount(db: Db, territoryId: string): Promise<number> {
  return countWhere(db, territoryMembers, eq(territoryMembers.territory_id, territoryId));
}

/** Re-evaluate rule membership. Manual members are always kept. Does not commit. */
export async function recompute(db: Db, t: TerritoryRow): Promise<{ added: number; removed: number; total: number }> {
  const display = await displayGeometryValues(db, t);
  if (Object.keys(display).length) await saveTerritory(db, t, display);
  const cond = await ruleCondition(db, t);
  let added = 0;
  let removed = 0;
  if (cond) {
    const del: any = await db.execute(
      sql`delete from territory_members where territory_id = ${t.id} and source = 'rule'
          and property_id not in (select ${properties.id} from ${properties} where ${cond})`,
    );
    removed = Math.max(Number(del.count ?? 0), 0);
    const ins: any = await db.execute(
      sql`insert into territory_members (id, territory_id, property_id, source, added_at)
          select gen_random_uuid(), ${t.id}::uuid, ${properties.id}, 'rule', now() from ${properties} where ${cond}
          on conflict (territory_id, property_id) do nothing`,
    );
    added = Math.max(Number(ins.count ?? 0), 0);
  }
  const total = await memberCount(db, t.id);
  await saveTerritory(db, t, { member_count: total, last_computed_at: utcnow() });
  return { added, removed, total };
}

async function checkParent(db: Db, tId: string | null, parentId: string | null | undefined, user: CurrentUser): Promise<void> {
  if (!parentId) return;
  await getVisible(db, parentId, user);
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === tId) throw new HttpError(422, "A territory cannot be nested inside itself");
    seen.add(cursor);
    const [r]: { p: string | null }[] = await db
      .select({ p: territories.parent_id })
      .from(territories)
      .where(eq(territories.id, cursor));
    cursor = r?.p ?? null;
  }
}

function checkOwnerChange(ownerId: string | null | undefined, user: CurrentUser): void {
  if (ownerId && ownerId !== user.id && !(user.is_admin || user.can("territories", "approve"))) {
    throw new HttpError(403, "Only approvers can assign a territory to another owner");
  }
}

export async function createTerritory(db: Db, data: TerritoryIn, actor: CurrentUser): Promise<TerritoryRow> {
  checkOwnerChange(data.owner_id, actor);
  await checkParent(db, null, data.parent_id, actor);
  if (data.rule_type === "boundary" && !data.geometry) {
    throw new HttpError(422, "Boundary territories need a polygon (GeoJSON)");
  }
  const rule = await normalizeRule(db, data.rule_type, data.rule);
  const { rule: _r, geometry, owner_id, ...rest } = data;
  const row: Plain = {
    ...defined(rest), rule, owner_id: owner_id || actor.id, created_by_id: actor.id, updated_by_id: actor.id,
  };
  if (data.rule_type === "boundary") Object.assign(row, (await applyPolygon(db, geometry))?.set ?? {});
  const [t] = await db.insert(territories).values(row as never).returning(territoryCols);
  const result = await recompute(db, t);
  await audit.record(db, {
    actor, action: "territory.created", entity_type: "territory", entity_id: t.id, summary: t.name,
    changes: { rule_type: t.rule_type, rule, members: result.total }, ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function updateTerritory(db: Db, t: TerritoryRow, data: TerritoryUpdate, actor: CurrentUser): Promise<TerritoryRow> {
  const { geometry, ...rest } = data;
  const values: Plain = defined(rest);
  if ("owner_id" in values) {
    if (values.owner_id === null) delete values.owner_id;
    else checkOwnerChange(values.owner_id, actor);
  }
  if ("parent_id" in values) await checkParent(db, t.id, values.parent_id, actor);
  const ruleType: string | null = "rule_type" in values ? values.rule_type : t.rule_type;
  if ("rule_type" in values || "rule" in values) {
    values.rule = await normalizeRule(db, ruleType, ("rule" in values ? values.rule : t.rule) || {});
  }
  const changes: Plain = audit.diff(t, values);
  const set: Plain = { ...values };
  let hasGeometry = t.has_geometry;
  if (geometry && ruleType === "boundary") {
    const g = await applyPolygon(db, geometry);
    if (g) {
      Object.assign(set, g.set);
      changes.geometry = g.change;
      hasGeometry = true;
    }
  }
  if (ruleType === "boundary" && !hasGeometry) {
    throw new HttpError(422, "Boundary territories need a polygon (GeoJSON)");
  }
  if (!Object.keys(changes).length) return t;
  set.updated_by_id = actor.id;
  await saveTerritory(db, t, set);
  if (["rule_type", "rule", "geometry"].some((k) => k in changes)) {
    const result = await recompute(db, t);
    changes.members = { added: result.added, removed: result.removed };
  }
  await audit.record(db, {
    actor, action: "territory.updated", entity_type: "territory", entity_id: t.id, summary: t.name, changes,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return t;
}

export async function archiveTerritory(db: Db, t: TerritoryRow, actor: CurrentUser): Promise<void> {
  await db.update(territories).set({ parent_id: t.parent_id }).where(eq(territories.parent_id, t.id));
  await saveTerritory(db, t, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "territory.archived", entity_type: "territory", entity_id: t.id, summary: t.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function recomputeAndCommit(db: Db, t: TerritoryRow, actor: CurrentUser) {
  const result = await recompute(db, t);
  await audit.record(db, {
    actor, action: "territory.recomputed", entity_type: "territory", entity_id: t.id,
    summary: `${result.total} members (+${result.added} / -${result.removed})`, changes: result,
    ip_address: actor.ip_address,
  });
  await db.commit();
  return result;
}

// ============================================================================= territories: members

export function membersWhere(territoryId: string, q?: string, source?: string[]): SQL | undefined {
  return and(
    eq(territoryMembers.territory_id, territoryId),
    isNull(properties.deleted_at),
    applySearch(q, [properties.name, properties.address_line, properties.city, properties.county]),
    inFilter(territoryMembers.source, source),
  );
}

export async function listMembers(
  db: Db,
  territoryId: string,
  { q, source }: { q?: string; source?: string[] },
  order: SQL[],
  p: ListParams,
) {
  const where = membersWhere(territoryId, q, source);
  const [c] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(territoryMembers)
    .innerJoin(properties, eq(properties.id, territoryMembers.property_id))
    .where(where);
  const items = await db
    .select({
      property_id: territoryMembers.property_id,
      source: territoryMembers.source,
      added_at: territoryMembers.added_at,
      name: properties.name,
      address_line: properties.address_line,
      city: properties.city,
      state: properties.state,
      county: properties.county,
      property_type: properties.property_type,
      status: properties.status,
    })
    .from(territoryMembers)
    .innerJoin(properties, eq(properties.id, territoryMembers.property_id))
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset(offset(p));
  return { items, total: c?.n ?? 0 };
}

/** Manual assignment (also used by bulk parcel/property selection). Manual members survive rule recomputes. */
export async function addMembers(db: Db, t: TerritoryRow, data: MembersIn, actor: CurrentUser): Promise<number> {
  const ids = new Set(data.property_ids.map((i) => i.toLowerCase()));
  if (data.parcel_ids.length) {
    const rows = await db
      .select({ id: propertyParcels.property_id })
      .from(propertyParcels)
      .where(inArray(propertyParcels.parcel_id, data.parcel_ids.map((i) => i.toLowerCase())));
    for (const r of rows) if (r.id) ids.add(r.id);
  }
  if (!ids.size) throw new HttpError(422, "No properties to add (parcels may not be linked to properties yet)");
  const valid = (
    await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(inArray(properties.id, [...ids]), isNull(properties.deleted_at)))
  ).map((r) => r.id);
  if (valid.length) {
    await db
      .insert(territoryMembers)
      .values(
        valid.map((pid) => ({
          territory_id: t.id, property_id: pid, source: "manual", added_at: utcnow(), added_by_id: actor.id,
        })),
      )
      .onConflictDoUpdate({
        target: [territoryMembers.territory_id, territoryMembers.property_id],
        set: { source: "manual", added_by_id: actor.id },
      });
  }
  await saveTerritory(db, t, { member_count: await memberCount(db, t.id), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "territory.members_added", entity_type: "territory", entity_id: t.id,
    summary: `${valid.length} properties assigned manually`, changes: { property_ids: valid },
    ip_address: actor.ip_address,
  });
  await db.commit();
  return valid.length;
}

export async function removeMember(db: Db, t: TerritoryRow, propertyId: string, actor: CurrentUser): Promise<void> {
  const deleted = await db
    .delete(territoryMembers)
    .where(and(eq(territoryMembers.territory_id, t.id), eq(territoryMembers.property_id, propertyId)))
    .returning({ id: territoryMembers.id });
  if (!deleted.length) throw new HttpError(404, "Property is not a member of this territory");
  await saveTerritory(db, t, { member_count: await memberCount(db, t.id) });
  await audit.record(db, {
    actor, action: "territory.member_removed", entity_type: "territory", entity_id: t.id,
    changes: { property_id: propertyId }, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function overlaps(db: Db, t: TerritoryRow, user: CurrentUser) {
  const mine = sql`select ${territoryMembers.property_id} from ${territoryMembers} where ${territoryMembers.territory_id} = ${t.id}`;
  // Aliased subquery of this territory's members: the join below reuses territory_members, so keep it raw.
  const rows = await raw<{ id: string; name: string; rule_type: string; shared: number }>(
    db,
    sql`select ${territories.id} as id, ${territories.name} as name, ${territories.rule_type} as rule_type,
               count(${territoryMembers.id})::int as shared
        from ${territories}
        join ${territoryMembers} on ${territoryMembers.territory_id} = ${territories.id}
        where ${territories.id} <> ${t.id} and ${territories.deleted_at} is null and ${visibleClause(user)}
          and ${territoryMembers.property_id} in (${mine})
        group by ${territories.id}, ${territories.name}, ${territories.rule_type}
        order by count(${territoryMembers.id}) desc`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, rule_type: r.rule_type, shared: Number(r.shared) }));
}

export async function forProperty(db: Db, propertyId: string, user: CurrentUser) {
  const rows = await db
    .select(territoryCols)
    .from(territories)
    .innerJoin(territoryMembers, eq(territoryMembers.territory_id, territories.id))
    .where(and(eq(territoryMembers.property_id, propertyId), isNull(territories.deleted_at), visibleClause(user)))
    .orderBy(asc(territories.name));
  return rows.map((r) => territoryItem(r as unknown as TerritoryRow));
}

// ============================================================================= event-driven membership

/** Re-evaluate rule-based territories for one property (runs inside the caller's transaction; no commit). */
export async function evaluateProperty(db: Db, propertyId: string, changed?: Set<string> | null): Promise<void> {
  const geoChanged = changed ? [...changed].some((f) => GEO_FIELDS.has(f)) : true;
  const list = await db
    .select(territoryCols)
    .from(territories)
    .where(
      and(
        isNull(territories.deleted_at),
        ne(territories.rule_type, "explicit"),
        changed && !geoChanged ? eq(territories.rule_type, "saved_query") : undefined,
      ),
    );
  for (const t of list) {
    const cond = await ruleCondition(db, t);
    if (cond === null) continue;
    const [hit] = await db
      .select({ id: properties.id })
      .from(properties)
      .where(and(cond, eq(properties.id, propertyId)))
      .limit(1);
    const matches = Boolean(hit);
    const [cur] = await db
      .select({ source: territoryMembers.source })
      .from(territoryMembers)
      .where(and(eq(territoryMembers.territory_id, t.id), eq(territoryMembers.property_id, propertyId)));
    const current = cur?.source ?? null;
    if (matches && current === null) {
      await db
        .insert(territoryMembers)
        .values({ territory_id: t.id, property_id: propertyId, source: "rule", added_at: utcnow() })
        .onConflictDoNothing({ target: [territoryMembers.territory_id, territoryMembers.property_id] });
      await saveTerritory(db, t, { member_count: (t.member_count || 0) + 1 });
    } else if (!matches && current === "rule") {
      await db
        .delete(territoryMembers)
        .where(and(eq(territoryMembers.territory_id, t.id), eq(territoryMembers.property_id, propertyId)));
      await saveTerritory(db, t, { member_count: Math.max((t.member_count || 1) - 1, 0) });
    }
  }
}

export async function reassignOwner(db: Db, userId: string, reassignToId: string | null | undefined): Promise<void> {
  if (!reassignToId) return;
  await db.update(territories).set({ owner_id: reassignToId }).where(eq(territories.owner_id, userId));
  await db.update(territories).set({ assignee_id: reassignToId }).where(eq(territories.assignee_id, userId));
}

// ============================================================================= geography-driven property search

export interface GeoPropertyFilters {
  q?: string;
  corridor_id?: string;
  buffer_ft?: number;
  node_id?: string;
  radius_miles?: number;
  min_traffic?: number;
  traffic_radius_miles?: number;
  growth_kind?: string[];
  growth_radius_miles?: number;
  territory_id?: string;
}

/** Properties by corridor buffer, node radius, traffic and growth conditions, with distance in miles. */
export async function geoProperties(db: Db, f: GeoPropertyFilters, sort: string | undefined, p: ListParams) {
  const pr = properties;
  const loc = sql`${pr.location}::geography`;
  let dist: SQL = sql`null::float8`;
  const where: Array<SQL | undefined> = [isNull(pr.deleted_at)];
  if (f.corridor_id) {
    const c = await getObj(db, corridors, f.corridor_id, "Corridor");
    if (!c.has_geometry) throw new HttpError(422, "The corridor has no line geometry yet");
    const line = sql`(select ${corridors.geometry} from ${corridors} where ${corridors.id} = ${c.id})::geography`;
    where.push(sql`ST_DWithin(${loc}, ${line}, ${(f.buffer_ft || DEFAULT_CORRIDOR_BUFFER_FT) * geo.M_PER_FT})`);
    dist = sql`ST_Distance(${loc}, ${line}) / ${geo.M_PER_MILE}::float8`;
  }
  if (f.node_id) {
    const center = (await resolveCenter(db, { node_id: f.node_id }))!;
    const pt = sql`${geo.point(...center)}::geography`;
    where.push(sql`ST_DWithin(${loc}, ${pt}, ${(f.radius_miles || 1) * geo.M_PER_MILE})`);
    dist = sql`ST_Distance(${loc}, ${pt}) / ${geo.M_PER_MILE}::float8`;
  }
  if (f.min_traffic) {
    const tc = trafficCounts;
    where.push(
      or(
        sql`${pr.traffic_count} >= ${f.min_traffic}`,
        sql`exists (select 1 from ${tc} where ${tc.deleted_at} is null and ${tc.count} >= ${f.min_traffic}
              and ${tc.location} is not null
              and ST_DWithin(${tc.location}::geography, ${loc}, ${(f.traffic_radius_miles || 0.25) * geo.M_PER_MILE}))`,
      ),
    );
  }
  if (f.growth_kind?.length) {
    const g = growthRecords;
    where.push(
      sql`exists (select 1 from ${g} where ${g.deleted_at} is null
            and ${g.kind} in (${sql.join(f.growth_kind.map((k) => sql`${k}`), sql`, `)})
            and ST_DWithin(${g.location}::geography, ${loc}, ${(f.growth_radius_miles || 1) * geo.M_PER_MILE}))`,
    );
  }
  if (f.territory_id) {
    where.push(
      sql`${pr.id} in (select ${territoryMembers.property_id} from ${territoryMembers} where ${territoryMembers.territory_id} = ${f.territory_id})`,
    );
  }
  where.push(applySearch(f.q, [pr.name, pr.address_line, pr.city, pr.county]));
  const cond = and(...where);

  const isDesc = Boolean(sort?.startsWith("-"));
  const order =
    sort && sort.replace(/^-+/, "") === "distance_miles"
      ? sql`distance_miles ${isDesc ? sql`desc` : sql`asc`} nulls last`
      : sql`distance_miles asc nulls last`;

  const total = await countWhere(db, pr, cond);
  const rows = await db
    .select({
      id: pr.id, name: pr.name, address_line: pr.address_line, city: pr.city, state: pr.state,
      property_type: pr.property_type, status: pr.status, traffic_count: pr.traffic_count,
      distance_miles: dist.as("distance_miles"),
    })
    .from(pr)
    .where(cond)
    .orderBy(order)
    .limit(p.page_size)
    .offset(offset(p));
  return {
    items: rows.map((r) => ({
      ...r,
      distance_miles: r.distance_miles !== null && r.distance_miles !== undefined ? round(Number(r.distance_miles), 2) : null,
    })),
    total,
  };
}

