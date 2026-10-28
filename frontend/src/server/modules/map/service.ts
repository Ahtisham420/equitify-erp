/**
 * Map workspace (spec module 7): layered GeoJSON over existing records, spatial filters, map selection with
 * previewed bulk actions, drawn territories, record cards and offline field observations.
 *
 * PostGIS is authoritative for geometry; every spatial predicate runs in the database. Other modules' tables are
 * read with plain SQL, and each layer is only returned when the user may view that module.
 */
import { and, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { toJsonable } from "../../common/audit";
import type { CurrentUser } from "../../core/deps";
import { HttpError, parse } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get, raw } from "../../db/orm";
import { users } from "../auth/schema";
import * as complianceService from "../compliance/service";
import * as documentsService from "../documents/service";
import * as outreach from "../outreach/service";
import * as parcels from "../parcels/service";
import { opportunityCreate } from "../pipeline/schemas";
import * as pipeline from "../pipeline/service";
import { properties } from "../properties/schema";
import * as signalsService from "../signals/service";
import { membersIn, territoryIn } from "../territories/schemas";
import * as territories from "../territories/service";
import * as geo from "./geo";
import { mapFieldObservations, OBSERVATION_CATEGORIES } from "./schema";
import type { MapFieldObservation } from "./schema";
import type {
  BulkExportIn, BulkOpportunitiesIn, BulkResult, BulkSequenceIn, BulkTarget, BulkTerritoryIn, ExportOut, ObservationIn,
  SaveTerritoryIn, SelectIn, SkipItem,
} from "./schemas";

type Id = string;

// layer key -> (permission module, label)
export const LAYERS: Record<string, [string, string]> = {
  properties: ["properties", "Properties"],
  parcels: ["parcels", "Parcels"],
  opportunities: ["pipeline", "Opportunities"],
  assets: ["assets", "Assets"],
  listings: ["brokerage", "Listings"],
  comps: ["comps", "Sale comps"],
  territories: ["territories", "Territories"],
  signals: ["signals", "Signals"],
  observations: ["map", "Field observations"],
};
export const LAYER_LIMIT = 1500;
export const SELECT_LIMIT = 2000;
const ADJACENCY_TOLERANCE_M = 1.0;
const NEAREST_PROPERTY_M = 75.0;
const DEFAULT_BUFFER_FT = 500.0;
const OPEN_EXCLUDED_STAGES = ["closed", "dead"];

// Third-party viewers are convenience links only (never a geometry source). Override with MAP_PARCEL_VIEWERS,
// a JSON list of {"label", "url_template"}; placeholders: {lat} {lng} {apn} {county} {state} {address}.
const DEFAULT_VIEWERS = [
  { label: "Google Maps", url_template: "https://www.google.com/maps/search/?api=1&query={lat},{lng}" },
  { label: "Street View", url_template: "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lng}" },
];

const unprocessable = (msg: string) => new HttpError(422, msg);

export function need(user: CurrentUser, module: string, action: string): void {
  if (!user.can(module, action)) throw new HttpError(403, `Missing permission ${module}:${action}`);
}

function detailText(detail: unknown): string {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, any>;
    return String(d.message || JSON.stringify(detail));
  }
  return String(detail);
}

const label = (name: string | null | undefined, address: string | null | undefined): string => name || address || "Untitled";
const idList = (ids: Iterable<string>) => sql.join([...ids].map((i) => sql`${i}`), sql`, `);
const col = (s: string) => sql.raw(s);
const isoTs = (v: unknown): any => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : v);
/** `col in (...)` for an optional multi-value filter. */
const inList = (column: string, values?: string[] | null): SQL | undefined =>
  values && values.length ? sql`${col(column)} in (${idList(values)})` : undefined;
const where = (conds: Array<SQL | undefined>): SQL => sql.join(conds.filter((c): c is SQL => !!c), sql` and `);
const pyNum = (v: unknown): string => (typeof v === "number" && Number.isInteger(v) ? v.toFixed(1) : String(v));

// ============================================================================= config

export function viewerTemplates(): Array<{ label: string; url_template: string }> {
  const rawEnv = process.env.MAP_PARCEL_VIEWERS;
  if (rawEnv) {
    try {
      const items = JSON.parse(rawEnv);
      const out = (items as any[])
        .filter((i) => i && typeof i === "object" && !Array.isArray(i) && i.label && String(i.url_template ?? "").startsWith("https://"))
        .map((i) => ({ label: String(i.label), url_template: String(i.url_template) }));
      if (out.length) return out;
    } catch {
      // fall through to the defaults
    }
  }
  return DEFAULT_VIEWERS;
}

/** Python `urllib.parse.quote(s, safe="")` */
const quote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function viewerLinks(values: Record<string, any>): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  for (const t of viewerTemplates()) {
    const names = new Set([...t.url_template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    if ([...names].some((n) => values[n] === null || values[n] === undefined || values[n] === "")) continue;
    const url = t.url_template.replace(/\{(\w+)\}/g, (_m, n) => quote(pyNum(values[n])));
    links.push({ label: t.label, url });
  }
  return links;
}

export function mapConfig(user: CurrentUser) {
  return {
    layers: Object.entries(LAYERS).map(([key, [mod, lbl]]) => ({ key, label: lbl, module: mod, allowed: user.can(mod, "view") })),
    viewers: viewerTemplates(),
    observation_categories: OBSERVATION_CATEGORIES,
  };
}

// ============================================================================= spatial filters

export interface MapFilters {
  bbox?: string;
  status?: string[];
  property_type?: string[];
  stage?: string[];
  signal_category?: string[];
  near_lat?: number;
  near_lng?: number;
  radius_miles?: number;
  polygon?: string;
  corridor_id?: string;
  buffer_ft?: number;
  adjacent_to?: string;
}

export interface Spatial {
  envelope?: SQL;
  polygon?: SQL;
  center?: SQL;
  radius_m: number;
  corridor?: SQL;
  buffer_m: number;
  adjacent?: Id[]; // parcel ids touching the target parcel
}

const hasRegion = (sp: Spatial) => sp.polygon !== undefined || sp.center !== undefined || sp.corridor !== undefined;

/** Validated (ST_MakeValid) drawn polygon as a SQL geometry expression. */
export async function polygonElement(db: Db, rawIn: unknown): Promise<SQL> {
  let value = rawIn;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw unprocessable("Polygon must be GeoJSON");
    }
  }
  const poly = await geo.polygonFromGeojson(db, value);
  return sql`ST_GeomFromText(${poly.wkt}, 4326)`;
}

/** Parcels that touch the target (ST_Touches, with a 1 m tolerance for digitising gaps). */
export async function adjacentParcelIds(db: Db, parcelId: Id): Promise<Id[]> {
  const rows = await raw<{ id: Id }>(
    db,
    sql`select p.id from parcels p join parcels me on me.id = ${parcelId}
        where p.id <> me.id and p.deleted_at is null and p.has_geometry is true
          and (ST_Touches(p.geometry, me.geometry)
               or ST_DWithin(p.geometry, me.geometry, ${ADJACENCY_TOLERANCE_M / geo.M_PER_DEGREE}::float8))
        limit 500`,
  );
  return rows.map((r) => r.id);
}

export async function resolveSpatial(db: Db, f: MapFilters): Promise<Spatial> {
  const sp: Spatial = { radius_m: 0.0, buffer_m: 0.0 };
  if (f.bbox) sp.envelope = geo.envelope(f.bbox);
  if (f.polygon) sp.polygon = await polygonElement(db, f.polygon);
  if (f.near_lat !== undefined && f.near_lng !== undefined && f.radius_miles) {
    sp.center = geo.point(f.near_lat, f.near_lng);
    sp.radius_m = f.radius_miles * geo.M_PER_MILE;
  }
  if (f.corridor_id) {
    const [c] = await raw<{ deleted_at: unknown; has_geometry: boolean }>(
      db,
      sql`select deleted_at, has_geometry from corridors where id = ${f.corridor_id}`,
    );
    if (!c || c.deleted_at) throw new HttpError(404, "Corridor not found");
    if (!c.has_geometry) throw unprocessable("This corridor has no line geometry yet");
    sp.corridor = sql`(select geometry from corridors where id = ${f.corridor_id})`;
    sp.buffer_m = (f.buffer_ft || DEFAULT_BUFFER_FT) * geo.M_PER_FT;
  }
  if (f.adjacent_to) sp.adjacent = await adjacentParcelIds(db, f.adjacent_to);
  return sp;
}

/**
 * Spatial predicates for one layer. `geom` is the geometry SQL tested everywhere; `inside` is the geometry tested
 * against a drawn polygon (points themselves; parcel centroids); `property_col` / `parcel_col` drive adjacency.
 */
export function conditions(
  sp: Spatial,
  geom: string,
  o: { inside?: string; property_col?: string; parcel_col?: string; envelope?: boolean } = {},
): SQL[] {
  const g = col(geom);
  const out: SQL[] = [];
  if ((o.envelope ?? true) && sp.envelope !== undefined) out.push(sql`ST_Intersects(${g}, ${sp.envelope})`);
  if (sp.polygon !== undefined) out.push(sql`ST_Contains(${sp.polygon}, ${col(o.inside ?? geom)})`);
  if (sp.center !== undefined) out.push(sql`ST_DWithin(${g}::geography, ${sp.center}::geography, ${sp.radius_m}::float8)`);
  if (sp.corridor !== undefined) {
    // Equivalent to ST_Intersects(geom, ST_Buffer(corridor::geography, m)) but index-friendly.
    out.push(sql`ST_DWithin(${g}::geography, ${sp.corridor}::geography, ${sp.buffer_m}::float8)`);
  }
  if (sp.adjacent !== undefined) {
    const ids = sp.adjacent;
    if (o.parcel_col !== undefined) {
      out.push(ids.length ? sql`${col(o.parcel_col)} in (${idList(ids)})` : sql`false`);
    } else if (o.property_col !== undefined) {
      out.push(
        ids.length
          ? sql`${col(o.property_col)} in (select property_id from property_parcels where parcel_id in (${idList(ids)}))`
          : sql`false`,
      );
    } else {
      out.push(sql`false`);
    }
  }
  return out;
}

// ============================================================================= layers

function pointFeature(fid: Id, lng: unknown, lat: unknown, props: Record<string, any>) {
  return {
    type: "Feature", id: String(fid),
    geometry: { type: "Point", coordinates: [Number(lng), Number(lat)] },
    properties: toJsonable({ id: fid, ...props }),
  };
}

function shapeFeature(fid: Id, gj: string | null, props: Record<string, any>) {
  return { type: "Feature", id: String(fid), geometry: geo.loads(gj), properties: toJsonable({ id: fid, ...props }) };
}

function collection(featuresIn: any[]) {
  const truncated = featuresIn.length > LAYER_LIMIT;
  const features = featuresIn.slice(0, LAYER_LIMIT);
  return { type: "FeatureCollection", features, truncated, count: features.length };
}

type LayerBuilder = (db: Db, f: MapFilters, sp: Spatial, user: CurrentUser) => Promise<ReturnType<typeof collection>>;

const propertiesLayer: LayerBuilder = async (db, f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select p.id, p.name, p.address_line, p.city, p.state, p.status, p.property_type, p.asking_price::float8 as asking_price,
               ST_X(p.location) as x, ST_Y(p.location) as y
        from properties p
        where ${where([
          sql`p.deleted_at is null and p.location is not null`,
          ...conditions(sp, "p.location", { property_col: "p.id" }),
          inList("p.status", f.status),
          inList("p.property_type", f.property_type),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "property", property_id: r.id, label: label(r.name, r.address_line), address: r.address_line,
        city: r.city, state: r.state, status: r.status, property_type: r.property_type, asking_price: r.asking_price,
      }),
    ),
  );
};

const parcelsLayer: LayerBuilder = async (db, _f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select pc.id, pc.apn, pc.county, pc.acreage::float8 as acreage, pc.situs_address,
               (select count(pp.id) from property_parcels pp where pp.parcel_id = pc.id)::int as n,
               ST_AsGeoJSON(pc.geometry, 6) as gj
        from parcels pc
        where ${where([
          sql`pc.deleted_at is null and pc.has_geometry is true`,
          ...conditions(sp, "pc.geometry", { inside: "pc.centroid", parcel_col: "pc.id" }),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      shapeFeature(r.id, r.gj, {
        kind: "parcel", parcel_id: r.id, label: `APN ${r.apn}`, apn: r.apn, county: r.county, acreage: r.acreage,
        address: r.situs_address, status: r.n ? "linked" : "unlinked",
      }),
    ),
  );
};

const opportunitiesLayer: LayerBuilder = async (db, f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select o.id, o.title, o.stage, o.priority, o.property_id, ST_X(p.location) as x, ST_Y(p.location) as y
        from opportunities o join properties p on p.id = o.property_id
        where ${where([
          sql`o.deleted_at is null and p.deleted_at is null and p.location is not null`,
          ...conditions(sp, "p.location", { property_col: "p.id" }),
          inList("o.stage", f.stage),
          inList("p.property_type", f.property_type),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "opportunity", property_id: r.property_id, label: r.title, status: r.stage, priority: r.priority,
      }),
    ),
  );
};

const assetsLayer: LayerBuilder = async (db, f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select a.id, a.status, a.current_value::float8 as current_value, a.property_id, p.name, p.address_line,
               ST_X(p.location) as x, ST_Y(p.location) as y
        from assets a join properties p on p.id = a.property_id
        where ${where([
          sql`a.deleted_at is null and p.deleted_at is null and p.location is not null`,
          ...conditions(sp, "p.location", { property_col: "p.id" }),
          inList("p.property_type", f.property_type),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "asset", property_id: r.property_id, label: label(r.name, r.address_line), status: r.status,
        current_value: r.current_value,
      }),
    ),
  );
};

const listingsLayer: LayerBuilder = async (db, f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select l.id, l.status, l.listing_type, l.asking_price::float8 as asking_price, l.property_id, l.headline,
               p.name, p.address_line, ST_X(p.location) as x, ST_Y(p.location) as y
        from listings l join properties p on p.id = l.property_id
        where ${where([
          sql`l.deleted_at is null and p.deleted_at is null and p.location is not null`,
          ...conditions(sp, "p.location", { property_col: "p.id" }),
          inList("p.property_type", f.property_type),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "listing", property_id: r.property_id, label: r.headline || label(r.name, r.address_line),
        status: r.status, listing_type: r.listing_type, asking_price: r.asking_price,
      }),
    ),
  );
};

const compsLayer: LayerBuilder = async (db, f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select c.id, c.name, c.address_line, c.verification_status, c.sale_price::float8 as sale_price,
               c.sale_date::text as sale_date, c.property_type, c.property_id, ST_X(c.location) as x, ST_Y(c.location) as y
        from sale_comps c
        where ${where([
          sql`c.deleted_at is null and c.location is not null`,
          ...conditions(sp, "c.location", { property_col: "c.property_id" }),
          inList("c.property_type", f.property_type),
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "comp", property_id: r.property_id, label: label(r.name, r.address_line), status: r.verification_status,
        sale_price: r.sale_price, sale_date: r.sale_date, property_type: r.property_type,
      }),
    ),
  );
};

/** Territory visibility for a user (mirrors territories.visible_clause). */
function territoryVisible(user: CurrentUser): SQL {
  if (user.is_admin) return sql`true`;
  const conds: SQL[] = [sql`t.visibility = 'company'`, sql`t.owner_id = ${user.id}`];
  const role = (user.user as any)?.role?.key;
  if (role) conds.push(sql`(t.visibility = 'role' and ${role} = any(t.allowed_roles))`);
  return sql`(${sql.join(conds, sql` or `)})`;
}

const territoriesLayer: LayerBuilder = async (db, _f, sp, user) => {
  const rows = await raw<any>(
    db,
    sql`select t.id, t.name, t.rule_type, t.visibility, t.member_count, ST_AsGeoJSON(t.geometry, 6) as gj
        from territories t
        where ${where([
          sql`t.deleted_at is null and t.has_geometry is true`,
          territoryVisible(user),
          sp.envelope !== undefined ? sql`ST_Intersects(t.geometry, ${sp.envelope})` : undefined,
        ])}
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      shapeFeature(r.id, r.gj, {
        kind: "territory", label: r.name, status: r.rule_type, visibility: r.visibility, member_count: r.member_count,
      }),
    ),
  );
};

const signalsLayer: LayerBuilder = async (db, f, sp, user) => {
  const rows = await raw<any>(
    db,
    sql`select s.id, s.category, s.signal_type, s.title, s.severity, s.observed_on::text as observed_on, s.property_id,
               ST_X(p.location) as x, ST_Y(p.location) as y
        from signals s join properties p on p.id = s.property_id
        where ${where([
          sql`s.deleted_at is null and s.status = 'active' and p.deleted_at is null and p.location is not null`,
          ...conditions(sp, "p.location", { property_col: "p.id" }),
          user.can("signals", "view_sensitive") ? undefined : sql`s.is_sensitive is false`,
          inList("s.category", f.signal_category),
          inList("p.property_type", f.property_type),
        ])}
        order by s.severity desc
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "signal", property_id: r.property_id, label: r.title || String(r.signal_type).replace(/_/g, " "),
        status: r.category, category: r.category, signal_type: r.signal_type, severity: r.severity,
        observed_on: r.observed_on,
      }),
    ),
  );
};

const observationsLayer: LayerBuilder = async (db, _f, sp) => {
  const rows = await raw<any>(
    db,
    sql`select m.id, m.category, m.note, m.observed_at, m.property_id, m.longitude as x, m.latitude as y
        from map_field_observations m
        where ${where([
          sql`m.deleted_at is null and m.location is not null`,
          ...conditions(sp, "m.location", { property_col: "m.property_id" }),
        ])}
        order by m.observed_at desc
        limit ${LAYER_LIMIT + 1}`,
  );
  return collection(
    rows.map((r) =>
      pointFeature(r.id, r.x, r.y, {
        kind: "observation", property_id: r.property_id, label: String(r.note || r.category).slice(0, 80),
        status: r.category, observed_at: isoTs(r.observed_at),
      }),
    ),
  );
};

const LAYER_BUILDERS: Record<string, LayerBuilder> = {
  properties: propertiesLayer, parcels: parcelsLayer, opportunities: opportunitiesLayer, assets: assetsLayer,
  listings: listingsLayer, comps: compsLayer, territories: territoriesLayer, signals: signalsLayer,
  observations: observationsLayer,
};

async function facetsFor(db: Db, f: MapFilters, sp: Spatial, user: CurrentUser): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const counts = async (rows: Array<{ k: unknown; n: number }>) => {
    const o: Record<string, number> = {};
    for (const r of rows) if (r.k !== null && r.k !== undefined) o[String(r.k)] = Number(r.n);
    return o;
  };
  if (user.can("properties", "view")) {
    const base = [
      sql`p.deleted_at is null and p.location is not null`,
      ...conditions(sp, "p.location", { property_col: "p.id" }),
    ];
    out.status = await counts(
      await raw(
        db,
        sql`select p.status as k, count(*)::int as n from properties p
            where ${where([...base, inList("p.property_type", f.property_type)])} group by p.status`,
      ),
    );
    out.property_type = await counts(
      await raw(
        db,
        sql`select p.property_type as k, count(*)::int as n from properties p
            where ${where([...base, inList("p.status", f.status)])} group by p.property_type`,
      ),
    );
  }
  if (user.can("pipeline", "view")) {
    out.stage = await counts(
      await raw(
        db,
        sql`select o.stage as k, count(*)::int as n from opportunities o join properties p on p.id = o.property_id
            where ${where([
              sql`o.deleted_at is null and p.deleted_at is null and p.location is not null`,
              ...conditions(sp, "p.location", { property_col: "p.id" }),
              inList("p.property_type", f.property_type),
            ])} group by o.stage`,
      ),
    );
  }
  return out;
}

export async function layers(db: Db, f: MapFilters, requested: string[], user: CurrentUser) {
  if (!f.bbox && !f.polygon && f.near_lat === undefined && !f.corridor_id && !f.adjacent_to) {
    throw unprocessable("Provide a bbox or a spatial filter");
  }
  const sp = await resolveSpatial(db, f);
  const out: Record<string, any> = {};
  const hidden: string[] = [];
  for (const key of requested) {
    if (!(key in LAYERS)) continue;
    const [module] = LAYERS[key];
    if (!user.can(module, "view")) {
      hidden.push(key);
      continue;
    }
    out[key] = await LAYER_BUILDERS[key](db, f, sp, user);
  }
  return { layers: out, hidden, facets: await facetsFor(db, f, sp, user) };
}

// ============================================================================= selection

async function parcelLinks(db: Db, parcelIds: Id[]): Promise<Map<Id, Id[]>> {
  const out = new Map<Id, Id[]>();
  if (!parcelIds.length) return out;
  const rows = await raw<{ parcel_id: Id; property_id: Id }>(
    db,
    sql`select parcel_id, property_id from property_parcels
        where parcel_id in (${idList(parcelIds)}) and deleted_at is null`,
  );
  for (const r of rows) {
    const list = out.get(r.parcel_id) ?? [];
    list.push(r.property_id);
    out.set(r.parcel_id, list);
  }
  return out;
}

async function openStages(db: Db, propertyIds: Id[]): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  if (!propertyIds.length) return out;
  const rows = await raw<{ property_id: Id; stage: string }>(
    db,
    sql`select property_id, stage from opportunities
        where property_id in (${idList(propertyIds)}) and deleted_at is null
          and stage not in (${idList(OPEN_EXCLUDED_STAGES)})`,
  );
  for (const r of rows) out.set(r.property_id, r.stage);
  return out;
}

export async function selectRecords(db: Db, data: SelectIn, user: CurrentUser) {
  const sp: Spatial = { radius_m: 0.0, buffer_m: 0.0 };
  if (data.polygon && Object.keys(data.polygon).length) sp.polygon = await polygonElement(db, data.polygon);
  if (data.circle) {
    sp.center = geo.point(data.circle.lat, data.circle.lng);
    sp.radius_m = data.circle.radius_m;
  }
  if (!hasRegion(sp) && !data.property_ids.length && !data.parcel_ids.length) {
    throw unprocessable("Draw a shape or pick records to select");
  }

  const propertyIds = new Set<Id>(data.property_ids);
  let truncated = false;
  if (hasRegion(sp)) {
    const found = await raw<{ id: Id }>(
      db,
      sql`select p.id from properties p
          where ${where([sql`p.deleted_at is null and p.location is not null`, ...conditions(sp, "p.location")])}
          limit ${SELECT_LIMIT + 1}`,
    );
    truncated = found.length > SELECT_LIMIT;
    for (const r of found.slice(0, SELECT_LIMIT)) propertyIds.add(r.id);
  }

  let parcelsOut: any[] = [];
  const parcelsHidden = !user.can("parcels", "view");
  if (!parcelsHidden) {
    const parcelIds = new Set<Id>(data.parcel_ids);
    if (hasRegion(sp)) {
      const found = await raw<{ id: Id }>(
        db,
        sql`select pc.id from parcels pc
            where ${where([
              sql`pc.deleted_at is null and pc.has_geometry is true`,
              ...conditions(sp, "pc.geometry", { inside: "pc.centroid" }),
            ])}
            limit ${SELECT_LIMIT + 1}`,
      );
      truncated = truncated || found.length > SELECT_LIMIT;
      for (const r of found.slice(0, SELECT_LIMIT)) parcelIds.add(r.id);
    }
    const links = await parcelLinks(db, [...parcelIds]);
    if (parcelIds.size) {
      const rows = await raw<any>(
        db,
        sql`select id, apn, county, acreage::float8 as acreage, situs_address from parcels
            where id in (${idList(parcelIds)}) and deleted_at is null order by apn`,
      );
      parcelsOut = rows.map((r) => ({
        id: r.id, apn: r.apn, county: r.county, acreage: r.acreage, situs_address: r.situs_address,
        property_ids: links.get(r.id) ?? [],
      }));
    }
    for (const ids of links.values()) for (const i of ids) propertyIds.add(i);
  }

  let props: any[] = [];
  if (propertyIds.size) {
    const rows = await raw<any>(
      db,
      sql`select id, name, address_line, city, state, status, property_type from properties
          where id in (${idList([...propertyIds].slice(0, SELECT_LIMIT * 2))}) and deleted_at is null
          order by address_line`,
    );
    const stages = user.can("pipeline", "view") ? await openStages(db, rows.map((r) => r.id)) : new Map<Id, string>();
    props = rows.map((r) => ({
      id: r.id, label: label(r.name, r.address_line), address_line: r.address_line, city: r.city, state: r.state,
      status: r.status, property_type: r.property_type, opportunity_stage: stages.get(r.id) ?? null,
    }));
  }
  return { properties: props, parcels: parcelsOut, truncated, parcels_hidden: parcelsHidden };
}

/** Properties in scope for a bulk action: explicit ids plus properties linked to the selected parcels. */
export async function resolveProperties(db: Db, target: BulkTarget, user: CurrentUser): Promise<Map<Id, string>> {
  const ids = new Set<Id>(target.property_ids);
  if (target.parcel_ids.length) {
    need(user, "parcels", "view");
    for (const linked of (await parcelLinks(db, target.parcel_ids)).values()) for (const i of linked) ids.add(i);
  }
  if (!ids.size) throw unprocessable("The selection has no properties (parcels may not be linked to properties yet)");
  const rows = await raw<{ id: Id; name: string | null; address_line: string }>(
    db,
    sql`select id, name, address_line from properties where id in (${idList(ids)}) and deleted_at is null
        order by address_line limit ${SELECT_LIMIT}`,
  );
  return new Map(rows.map((r) => [r.id, label(r.name, r.address_line)]));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const bulkResult = (o: Partial<BulkResult> & Pick<BulkResult, "action" | "applied" | "properties" | "eligible">): BulkResult => ({
  done: 0, skipped: [], warnings: [], blocked: false, details: {}, ...o,
});

// ============================================================================= bulk: opportunities

export async function bulkOpportunities(db: Db, data: BulkOpportunitiesIn, user: CurrentUser): Promise<BulkResult> {
  const props = await resolveProperties(db, data, user);
  const propIds = [...props.keys()];
  const existing = new Set(
    (
      await raw<{ property_id: Id }>(
        db,
        sql`select property_id from opportunities
            where property_id in (${idList(propIds)}) and deleted_at is null and stage <> 'closed'`,
      )
    ).map((r) => r.property_id),
  );
  const skipped: SkipItem[] = propIds
    .filter((i) => existing.has(i))
    .map((i) => ({ id: String(i), label: props.get(i)!, reason: "Already has an open opportunity" }));
  const eligible = propIds.filter((i) => !existing.has(i));
  const warnings: string[] = [];
  if (data.override_reason && !user.can("pipeline", "approve")) {
    warnings.push("Overriding stage requirements requires pipeline approval permission");
  }
  const result = bulkResult({
    action: "create_opportunities", applied: data.apply, properties: props.size, eligible: eligible.length, skipped,
    warnings, details: { gate: "Each opportunity must meet the sourced-stage requirements" },
  });
  if (!data.apply) return result;
  if (warnings.length) throw new HttpError(403, warnings[0]);

  const created: string[] = [];
  for (const pid of eligible) {
    const body = parse(opportunityCreate, {
      property_id: pid, owner_id: data.owner_id, priority: data.priority, source: data.source,
      override_reason: data.override_reason,
    });
    try {
      const o = await pipeline.create(db, body, user);
      created.push(String(o.id));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await db.rollback();
      result.skipped.push({ id: String(pid), label: props.get(pid)!, reason: detailText(e.detail) });
    }
  }
  result.done = created.length;
  await audit.record(db, {
    actor: user, action: "map.bulk_opportunities", entity_type: "map_selection",
    summary: `${created.length} opportunities created from map selection, ${result.skipped.length} skipped`,
    changes: { opportunity_ids: created, property_ids: propIds.map(String) }, ip_address: user.ip_address,
  });
  await db.commit();
  return result;
}

// ============================================================================= bulk: territory assignment

export async function bulkTerritory(db: Db, data: BulkTerritoryIn, user: CurrentUser): Promise<BulkResult> {
  const t = await territories.getVisible(db, data.territory_id, user);
  const props = await resolveProperties(db, data, user);
  const propIds = [...props.keys()];
  const already = new Set(
    (
      await raw<{ property_id: Id }>(
        db,
        sql`select property_id from territory_members
            where territory_id = ${t.id} and property_id in (${idList(propIds)})`,
      )
    ).map((r) => r.property_id),
  );
  const can = territories.canEdit(t, user);
  const result = bulkResult({
    action: "assign_territory", applied: data.apply, properties: props.size, eligible: props.size - already.size,
    skipped: propIds.filter((i) => already.has(i)).map((i) => ({ id: String(i), label: props.get(i)!, reason: "Already a member" })),
    blocked: !can, warnings: can ? [] : ["Only the territory owner or an approver can change it"],
    details: { territory_id: String(t.id), territory_name: t.name },
  });
  if (!data.apply) return result;
  territories.requireEdit(t, user);
  const fresh = propIds.filter((i) => !already.has(i));
  for (const chunk of chunks(fresh, 1000)) {
    result.done += await territories.addMembers(db, t, membersIn.parse({ property_ids: chunk }), user);
  }
  return result;
}

// ============================================================================= owners of selected properties

interface Interest {
  property_id: Id;
  owner_kind: string;
  owner_person_id: Id | null;
  owner_organization_id: Id | null;
  role: string;
  interest_pct: number | null;
  source: string;
}

export async function currentInterests(db: Db, propertyIds: Id[]): Promise<Interest[]> {
  if (!propertyIds.length) return [];
  return raw<Interest>(
    db,
    sql`select property_id, owner_kind, owner_person_id, owner_organization_id, role, interest_pct::float8 as interest_pct, source
        from ownership_interests
        where property_id in (${idList(propertyIds)}) and deleted_at is null and verification <> 'rejected'
          and (effective_to is null or effective_to >= current_date)`,
  );
}

async function peopleByIds(db: Db, ids: Iterable<Id>): Promise<Map<Id, Record<string, any>>> {
  const list = [...ids];
  if (!list.length) return new Map();
  const rows = await raw<any>(
    db,
    sql`select id, full_name, mailing_address, city, state, postal_code, source from people
        where id in (${idList(list)}) and deleted_at is null`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function orgsByIds(db: Db, ids: Iterable<Id>): Promise<Map<Id, Record<string, any>>> {
  const list = [...ids];
  if (!list.length) return new Map();
  const rows = await raw<any>(
    db,
    sql`select id, name, mailing_address, city, state, postal_code, source from organizations
        where id in (${idList(list)}) and deleted_at is null`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// ============================================================================= bulk: sequence enrollment

export async function bulkSequence(db: Db, data: BulkSequenceIn, user: CurrentUser): Promise<BulkResult> {
  const s = await outreach.getSequence(db, data.sequence_id);
  const props = await resolveProperties(db, data, user);
  const interests = await currentInterests(db, [...props.keys()]);
  const personIds = new Set<Id>(
    interests.filter((i) => i.owner_kind === "person" && i.owner_person_id).map((i) => i.owner_person_id!),
  );
  const orgIds = new Set<Id>(
    interests.filter((i) => i.owner_kind === "organization" && i.owner_organization_id).map((i) => i.owner_organization_id!),
  );
  if (orgIds.size) {
    const rows = await raw<{ person_id: Id }>(
      db,
      sql`select person_id from affiliations
          where organization_id in (${idList(orgIds)}) and is_current is true and deleted_at is null`,
    );
    for (const r of rows) personIds.add(r.person_id);
  }
  const people = await peopleByIds(db, personIds);
  const already = new Set<Id>();
  if (people.size) {
    const rows = await raw<{ person_id: Id }>(
      db,
      sql`select person_id from sequence_enrollments
          where sequence_id = ${s.id} and person_id in (${idList(people.keys())})
            and status in ('active', 'paused') and deleted_at is null`,
    );
    for (const r of rows) already.add(r.person_id);
  }

  const skipped: SkipItem[] = [];
  const eligible: Id[] = [];
  for (const [pid, p] of people) {
    if (already.has(pid)) {
      skipped.push({ id: String(pid), label: p.full_name, reason: "Already enrolled" });
      continue;
    }
    const reasons = await complianceService.personSuppressionReasons(db, pid);
    if (reasons.length) {
      skipped.push({ id: String(pid), label: p.full_name, reason: reasons.slice(0, 2).join("; ") });
      continue;
    }
    eligible.push(pid);
  }

  const owned = new Set(interests.map((i) => i.property_id));
  const warnings: string[] = [];
  if (s.status !== "active") warnings.push("Only active sequences accept enrollments");
  if (!(s.steps ?? []).length) warnings.push("The sequence has no steps yet");
  if (owned.size < props.size) warnings.push(`${props.size - owned.size} selected properties have no current owner on record`);
  const result = bulkResult({
    action: "enroll_sequence", applied: data.apply, properties: props.size, eligible: eligible.length, skipped, warnings,
    blocked: s.status !== "active" || !(s.steps ?? []).length,
    details: { sequence_id: String(s.id), sequence_name: s.name, people: people.size, organizations: orgIds.size },
  });
  if (!data.apply) return result;
  if (!eligible.length) throw unprocessable("No eligible people to enroll");
  const res: any = await outreach.enroll(db, s, eligible, data.owner_id, user);
  result.done = Math.trunc(Number(res.enrolled ?? 0));
  const names = new Map([...people].map(([k, v]) => [String(k), v.full_name]));
  for (const x of (res.skipped ?? []) as any[]) {
    result.skipped.push({ id: String(x.person_id), label: names.get(String(x.person_id)) ?? null, reason: String(x.reason) });
  }
  return result;
}

// ============================================================================= bulk: mailing export

const MAIL_COLUMNS = [
  "property", "property_address", "property_city", "property_state", "owner_kind", "owner_name", "owner_role",
  "mailing_address", "mailing_city", "mailing_state", "mailing_postal_code",
];

/** Python `csv.writer` (excel dialect): minimal quoting, CRLF line endings, None -> empty. */
function csvLine(fields: unknown[]): string {
  return (
    fields
      .map((v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(",") + "\r\n"
  );
}

export async function bulkExport(db: Db, data: BulkExportIn, user: CurrentUser): Promise<ExportOut> {
  const props = await resolveProperties(db, data, user);
  const propIds = [...props.keys()];
  const propRows = new Map(
    (
      await raw<any>(db, sql`select id, address_line, city, state from properties where id in (${idList(propIds)})`)
    ).map((r) => [r.id, r]),
  );
  const interests = await currentInterests(db, propIds);
  const people = await peopleByIds(db, interests.filter((i) => i.owner_person_id).map((i) => i.owner_person_id!));
  const orgs = await orgsByIds(db, interests.filter((i) => i.owner_organization_id).map((i) => i.owner_organization_id!));
  const masked = !user.can("contacts", "view_sensitive");

  const rows: unknown[][] = [];
  const skipped: SkipItem[] = [];
  const providers = new Set<string>();
  const seen = new Set<string>();
  const sorted = [...interests].sort((a, b) => {
    const ka = props.get(a.property_id) ?? "";
    const kb = props.get(b.property_id) ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const i of sorted) {
    const owner = i.owner_kind === "person" ? people.get(i.owner_person_id!) : orgs.get(i.owner_organization_id!);
    if (owner === undefined) continue;
    const key = `${i.property_id}|${i.owner_kind}|${owner.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = i.owner_kind === "person" ? owner.full_name : owner.name;
    if (i.owner_kind === "person") {
      const reasons = await complianceService.personSuppressionReasons(db, owner.id);
      if (reasons.length) {
        skipped.push({ id: String(owner.id), label: name, reason: "Opted out or suppressed" });
        continue;
      }
    }
    if (!(owner.mailing_address || owner.city)) {
      skipped.push({ id: String(owner.id), label: name, reason: "No mailing address on record" });
      continue;
    }
    for (const x of [i.source, owner.source]) if (x) providers.add(x);
    const pr = propRows.get(i.property_id);
    rows.push([
      props.get(i.property_id) ?? null, pr?.address_line ?? null, pr?.city ?? null, pr?.state ?? null, i.owner_kind, name,
      i.role, masked ? "Restricted" : owner.mailing_address, owner.city, owner.state, owner.postal_code,
    ]);
  }

  const [blocked, exportWarnings] = await complianceService.exportWarnings(db, { providers: [...providers].sort() });
  const warnings = [...exportWarnings];
  if (masked) warnings.push("Street addresses are restricted without contacts sensitive-data permission");
  const owned = new Set(interests.map((i) => i.property_id));
  const noOwner = propIds.filter((i) => !owned.has(i)).length;
  if (noOwner) warnings.push(`${noOwner} selected properties have no current owner on record`);
  const result: ExportOut = {
    ...bulkResult({
      action: "export_mailing", applied: data.apply, properties: props.size, eligible: rows.length, skipped, warnings,
      blocked,
    }),
    filename: null, csv: null, masked,
  };
  if (!data.apply) return result;
  if (blocked) {
    throw new HttpError(409, { message: "Export blocked by a data provider restriction", warnings });
  }
  const csv = csvLine(MAIL_COLUMNS) + rows.map(csvLine).join("");
  await audit.record(db, {
    actor: user, action: "map.mailing_exported", entity_type: "map_selection",
    summary: `${rows.length} mailing rows for ${props.size} properties`,
    changes: { property_ids: propIds.map(String), masked, warnings, skipped: skipped.length }, ip_address: user.ip_address,
  });
  await db.commit();
  result.done = rows.length;
  result.csv = csv;
  const d = utcnow();
  const p2 = (n: number) => String(n).padStart(2, "0");
  result.filename = `mailing-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}.csv`;
  return result;
}

// ============================================================================= drawn territories

export async function saveTerritory(db: Db, data: SaveTerritoryIn, user: CurrentUser) {
  let body;
  if (data.circle) {
    body = parse(territoryIn, {
      name: data.name, description: data.description, visibility: data.visibility, rule_type: "radius",
      rule: {
        lat: data.circle.lat, lng: data.circle.lng,
        radius_miles: Math.round(Math.max(data.circle.radius_m / geo.M_PER_MILE, 0.01) * 10_000) / 10_000,
      },
    });
  } else if (data.polygon && Object.keys(data.polygon).length) {
    body = parse(territoryIn, {
      name: data.name, description: data.description, visibility: data.visibility, rule_type: "boundary",
      geometry: data.polygon,
    });
  } else {
    throw unprocessable("Draw a polygon or circle to save as a territory");
  }
  return territories.createTerritory(db, body, user);
}

// ============================================================================= assemblage

export async function assemblage(db: Db, parcelId: Id, user: CurrentUser) {
  const p = await parcels.getParcel(db, parcelId);
  const out = await parcels.assemblage(db, p, user);
  const ids = new Set<Id>();
  for (const g of out.groups as any[]) for (const x of g.parcels) ids.add(x.id);
  let gj: string | null = null;
  if (ids.size) {
    const [row] = await raw<{ gj: string | null }>(
      db,
      sql`select ST_AsGeoJSON(ST_Union(geometry), 6) as gj from parcels
          where id in (${idList(ids)}) and has_geometry is true`,
    );
    gj = row?.gj ?? null;
  }
  return { result: toJsonable(out), geometry: geo.loads(gj) };
}

// ============================================================================= record cards

const CARD_SOURCES: Record<string, { module: string; table: string }> = {
  opportunity: { module: "pipeline", table: "opportunities" },
  asset: { module: "assets", table: "assets" },
  listing: { module: "brokerage", table: "listings" },
  signal: { module: "signals", table: "signals" },
};

async function propertyIdFor(db: Db, kind: string, recordId: Id, user: CurrentUser): Promise<Id> {
  const src = CARD_SOURCES[kind];
  if (src) need(user, src.module, "view");
  let obj: any = null;
  if (src) {
    const extra = kind === "signal" ? sql`, is_sensitive` : sql``;
    [obj] = await raw<any>(
      db,
      sql`select id, property_id, deleted_at${extra} from ${sql.raw(src.table)} where id = ${recordId}`,
    );
  }
  if (!obj || obj.deleted_at || !obj.property_id) throw new HttpError(404, "Record not found");
  if (kind === "signal" && obj.is_sensitive && !user.can("signals", "view_sensitive")) {
    throw new HttpError(404, "Record not found");
  }
  return obj.property_id;
}

async function owners(db: Db, propertyId: Id) {
  const interests = await currentInterests(db, [propertyId]);
  const people = await peopleByIds(db, interests.filter((i) => i.owner_person_id).map((i) => i.owner_person_id!));
  const orgs = await orgsByIds(db, interests.filter((i) => i.owner_organization_id).map((i) => i.owner_organization_id!));
  const out: any[] = [];
  for (const i of interests) {
    if (i.owner_kind === "person" && i.owner_person_id) {
      const p = people.get(i.owner_person_id);
      out.push({ kind: "person", id: i.owner_person_id, name: p ? p.full_name : null, role: i.role, interest_pct: i.interest_pct });
    } else if (i.owner_organization_id) {
      const o = orgs.get(i.owner_organization_id);
      out.push({ kind: "organization", id: i.owner_organization_id, name: o ? o.name : null, role: i.role, interest_pct: i.interest_pct });
    }
  }
  return out;
}

interface Card {
  kind: string;
  property: Record<string, any> | null;
  parcel: Record<string, any> | null;
  comp: Record<string, any> | null;
  observation: Record<string, any> | null;
  owners: any[] | null; // null = hidden (no ownership:view)
  opportunity: Record<string, any> | null;
  signals: any[] | null;
  motivation_index: number | null;
  parcels: Record<string, any>[];
  viewer_links: Array<{ label: string; url: string }>;
}

const newCard = (kind: string, o: Partial<Card> = {}): Card => ({
  kind, property: null, parcel: null, comp: null, observation: null, owners: null, opportunity: null, signals: null,
  motivation_index: null, parcels: [], viewer_links: [], ...o,
});

async function propertyCard(db: Db, propertyId: Id, user: CurrentUser, kind: string): Promise<Card> {
  need(user, "properties", "view");
  const p = await get(db, properties, propertyId);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  const card = newCard(kind, {
    property: toJsonable({
      id: p.id, label: label(p.name, p.address_line), address_line: p.address_line, city: p.city, state: p.state,
      county: p.county, status: p.status, property_type: p.property_type, building_area_sf: p.building_area_sf,
      land_area_acres: p.land_area_acres, asking_price: p.asking_price, year_built: p.year_built,
      occupancy_pct: p.occupancy_pct, latitude: p.latitude, longitude: p.longitude,
    }),
  });
  const apns: string[] = [];
  if (user.can("parcels", "view")) {
    const rows = await raw<any>(
      db,
      sql`select pc.id, pc.apn, pc.county, pc.acreage::float8 as acreage from parcels pc
          join property_parcels pp on pp.parcel_id = pc.id
          where pp.property_id = ${p.id} and pc.deleted_at is null`,
    );
    for (const r of rows) {
      card.parcels.push(toJsonable({ id: r.id, apn: r.apn, county: r.county, acreage: r.acreage }));
      apns.push(r.apn);
    }
  }
  if (user.can("ownership", "view")) card.owners = await owners(db, p.id);
  if (user.can("pipeline", "view")) {
    const [o] = await raw<any>(
      db,
      sql`select id, title, stage, priority, next_action, next_action_at, owner_id from opportunities
          where property_id = ${p.id} and deleted_at is null
          order by (stage in (${idList(OPEN_EXCLUDED_STAGES)})), updated_at desc limit 1`,
    );
    if (o) {
      card.opportunity = toJsonable({
        id: o.id, title: o.title, stage: o.stage, priority: o.priority, next_action: o.next_action,
        next_action_at: isoTs(o.next_action_at), owner_id: o.owner_id,
      });
    }
  }
  if (user.can("signals", "view")) {
    const sigs = await raw<any>(
      db,
      sql`select id, category, signal_type, title, severity, observed_on::text as observed_on from signals
          where property_id = ${p.id} and deleted_at is null and status = 'active'
            ${user.can("signals", "view_sensitive") ? sql`` : sql`and is_sensitive is false`}
          order by severity desc, observed_on desc limit 5`,
    );
    card.signals = sigs.map((s) => ({
      id: s.id, category: s.category, signal_type: s.signal_type, title: s.title, severity: s.severity,
      observed_on: s.observed_on,
    }));
    card.motivation_index = Math.round(Number(await signalsService.motivationIndex(db, p.id)) * 10) / 10;
  }
  card.viewer_links = viewerLinks({
    lat: p.latitude, lng: p.longitude, apn: apns.length ? apns[0] : null, county: p.county, state: p.state,
    address: p.address_line,
  });
  return card;
}

export async function card(db: Db, kind: string, recordId: Id, user: CurrentUser): Promise<Card> {
  if (kind === "property") return propertyCard(db, recordId, user, kind);
  if (kind in CARD_SOURCES) return propertyCard(db, await propertyIdFor(db, kind, recordId, user), user, kind);
  if (kind === "parcel") {
    need(user, "parcels", "view");
    const p = await parcels.getParcel(db, recordId);
    const links = await parcelLinks(db, [p.id]);
    const propIds = links.get(p.id) ?? [];
    const out = newCard(kind, {
      parcel: toJsonable({
        id: p.id, apn: p.apn, county: p.county, state: p.state, acreage: p.acreage, situs_address: p.situs_address,
        property_ids: propIds, source: p.source,
      }),
    });
    if (propIds.length && user.can("properties", "view")) {
      const propCard = await propertyCard(db, propIds[0], user, kind);
      propCard.parcel = out.parcel;
      return propCard;
    }
    out.viewer_links = viewerLinks({
      lat: p.centroid_lat, lng: p.centroid_lng, apn: p.apn, county: p.county, state: p.state, address: p.situs_address,
    });
    return out;
  }
  if (kind === "comp") {
    need(user, "comps", "view");
    const [c] = await raw<any>(
      db,
      sql`select id, name, address_line, city, state, property_type, sale_date::text as sale_date,
                 sale_price::float8 as sale_price, price_psf::float8 as price_psf, cap_rate::float8 as cap_rate,
                 verification_status, source, property_id, latitude::float8 as latitude, longitude::float8 as longitude,
                 deleted_at
          from sale_comps where id = ${recordId}`,
    );
    if (!c || c.deleted_at) throw new HttpError(404, "Comp not found");
    return newCard(kind, {
      comp: toJsonable({
        id: c.id, label: label(c.name, c.address_line), address_line: c.address_line, city: c.city, state: c.state,
        property_type: c.property_type, sale_date: c.sale_date, sale_price: c.sale_price, price_psf: c.price_psf,
        cap_rate: c.cap_rate, verification_status: c.verification_status, source: c.source, property_id: c.property_id,
      }),
      viewer_links: viewerLinks({ lat: c.latitude, lng: c.longitude, address: c.address_line }),
    });
  }
  if (kind === "observation") {
    const o = await getObservation(db, recordId);
    const out = newCard(kind, { observation: toJsonable((await observationOuts(db, [o]))[0]) });
    if (o.property_id && user.can("properties", "view")) {
      const propCard = await propertyCard(db, o.property_id, user, kind);
      propCard.observation = out.observation;
      return propCard;
    }
    return out;
  }
  throw unprocessable("Unknown record kind");
}

// ============================================================================= field observations

export async function getObservation(db: Db, obsId: Id): Promise<MapFieldObservation> {
  const o = await get(db, mapFieldObservations, obsId);
  if (!o || o.deleted_at) throw new HttpError(404, "Observation not found");
  return o;
}

async function nearestProperty(db: Db, lat: number, lng: number): Promise<Id | null> {
  const pt = geo.point(lat, lng);
  const [r] = await raw<{ id: Id }>(
    db,
    sql`select id from properties
        where deleted_at is null and location is not null
          and ST_DWithin(location::geography, ${pt}::geography, ${NEAREST_PROPERTY_M}::float8)
        order by ST_Distance(location::geography, ${pt}::geography) limit 1`,
  );
  return r ? r.id : null;
}

async function linkPhotos(db: Db, docIds: Id[], targets: Array<[string, Id]>, user: CurrentUser): Promise<void> {
  if (!docIds.length || !user.can("documents", "create")) return;
  for (const docId of docIds) {
    for (const [entityType, entityId] of targets) {
      try {
        await geo.nested(db, () => documentsService.link(db, docId, entityType, entityId, user));
      } catch (e) {
        if (e instanceof HttpError) continue;
        throw e;
      }
    }
  }
}

/** Idempotent on client_uuid: re-sending a queued observation returns the stored one (created=false). */
export async function createObservation(db: Db, data: ObservationIn, user: CurrentUser): Promise<[MapFieldObservation, boolean]> {
  const M = mapFieldObservations;
  const findExisting = async () => {
    const [row] = await db.select().from(M).where(eq(M.client_uuid, data.client_uuid)).limit(1);
    return row;
  };
  const existing = await findExisting();
  if (existing) return [existing, false];

  let propertyId: Id | null = data.property_id ?? null;
  if (propertyId) {
    const p = await get(db, properties, propertyId);
    if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  } else if (user.can("properties", "view")) {
    propertyId = await nearestProperty(db, data.lat, data.lng);
  }

  const note = (data.note ?? "").trim() || null;
  const [o] = await db
    .insert(M)
    .values({
      client_uuid: data.client_uuid, property_id: propertyId, latitude: data.lat, longitude: data.lng,
      location: geo.point(data.lat, data.lng) as unknown as string, accuracy_m: data.accuracy_m ?? null,
      observed_at: data.observed_at ?? utcnow(), category: data.category, note,
      photo_document_ids: data.photo_document_ids.map(String), created_by_id: user.id, updated_by_id: user.id,
    })
    .onConflictDoNothing({ target: M.client_uuid })
    .returning();
  if (!o) {
    // Lost a race with a concurrent re-send of the same queued observation.
    const again = await findExisting();
    if (again) return [again, false];
    throw new HttpError(500, "Internal Server Error");
  }
  const targets: Array<[string, Id]> = [["field_observation", o.id]];
  if (propertyId) targets.push(["property", propertyId]);
  await linkPhotos(db, data.photo_document_ids, targets, user);
  await audit.record(db, {
    actor: user,
    action: propertyId ? "property.field_observation" : "field_observation.created",
    entity_type: propertyId ? "property" : "field_observation",
    entity_id: propertyId || o.id,
    summary: `Field observation (${o.category.replace(/_/g, " ")})${o.note ? `: ${o.note.slice(0, 120)}` : ""}`,
    changes: {
      observation_id: o.id, lat: o.latitude, lng: o.longitude, accuracy_m: o.accuracy_m, photos: o.photo_document_ids.length,
    },
    ip_address: user.ip_address,
  });
  await db.commit();
  return [o, true];
}

export function observationWhere(o: {
  bbox?: string; property_id?: string; category?: string[]; mine: boolean; user: CurrentUser; q?: string;
}): SQL | undefined {
  const M = mapFieldObservations;
  return and(
    isNull(M.deleted_at),
    o.bbox ? sql`ST_Intersects(${M.location}, ${geo.envelope(o.bbox)})` : undefined,
    o.property_id ? eq(M.property_id, o.property_id) : undefined,
    o.mine ? eq(M.created_by_id, o.user.id) : undefined,
    o.q ? ilike(M.note, `%${o.q}%`) : undefined,
    o.category && o.category.length ? inArray(M.category, o.category) : undefined,
  );
}

export async function observationOuts(db: Db, rows: MapFieldObservation[]) {
  const propIds = [...new Set(rows.map((r) => r.property_id).filter((i): i is Id => !!i))];
  const userIds = [...new Set(rows.map((r) => r.created_by_id).filter((i): i is Id => !!i))];
  const labels = new Map<Id, string>();
  if (propIds.length) {
    const found = await raw<any>(db, sql`select id, name, address_line from properties where id in (${idList(propIds)})`);
    for (const r of found) labels.set(r.id, label(r.name, r.address_line));
  }
  const names = new Map<Id, string>();
  if (userIds.length) {
    const found = await db.select({ id: users.id, full_name: users.full_name }).from(users).where(inArray(users.id, userIds));
    for (const r of found) names.set(r.id, r.full_name);
  }
  return rows.map((r) => ({
    id: r.id, client_uuid: r.client_uuid, property_id: r.property_id,
    property_label: r.property_id ? (labels.get(r.property_id) ?? null) : null,
    latitude: r.latitude, longitude: r.longitude, accuracy_m: r.accuracy_m, observed_at: r.observed_at,
    category: r.category, note: r.note, photo_document_ids: (r.photo_document_ids ?? []).map(String),
    created_by_id: r.created_by_id,
    created_by_name: r.created_by_id ? (names.get(r.created_by_id) ?? null) : null,
    created_at: r.created_at,
  }));
}
