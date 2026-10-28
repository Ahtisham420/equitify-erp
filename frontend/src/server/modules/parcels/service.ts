import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { normalizeApn } from "../../common/normalize";
import * as provenance from "../../common/provenance";
import { countWhere, inFilter, rangeFilter } from "../../common/query";
import type { ListParams } from "../../core/router";
import type { CurrentUser } from "../../core/deps";
import { HttpError } from "../../core/http";
import { utcnow } from "../../core/security";
import type { Db } from "../../db";
import { get as ormGet, insert, patch, raw, remove } from "../../db/orm";
import { properties } from "../properties/schema";
import * as propertyService from "../properties/service";
import { territories } from "../territories/schema";
import * as geo from "./geo";
import {
  BUILDING_MATERIAL,
  PARCEL_MATERIAL,
  SPACE_MATERIAL,
  buildings,
  parcelVersions,
  parcels,
  propertyParcels,
  spaces,
  type Building,
  type Parcel,
  type PropertyParcel,
  type Space,
} from "./schema";
import type {
  BuildingIn,
  BuildingUpdate,
  BulkAssociateIn,
  ParcelCreate,
  ParcelUpdate,
  PropertyParcelIn,
  PropertyParcelUpdate,
  SpaceIn,
  SpaceUpdate,
} from "./schemas";

export const ENTITY = "parcel";
export const ADJACENCY_TOLERANCE_M = 1.0;

/** Parcel row without the (large, deferred) PostGIS columns; geometry is read through SQL when needed. */
export type ParcelRow = Omit<Parcel, "geometry" | "centroid">;
const { geometry: _geometry, centroid: _centroid, ...parcelCols } = getTableColumns(parcels);
export { parcelCols };

export interface OwnerRef {
  kind: string;
  id: string;
  name: string | null;
}
// Owners are keyed "kind|id" so they can live in a Set.
const ownerKey = (kind: string, id: string) => `${kind}|${id}`;
const splitKey = (k: string): [string, string] => {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)];
};

const round = (x: number, digits: number) => {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
};
const sumAcreage = (items: Array<{ acreage: number | null }>) => items.reduce((s, x) => s + (x.acreage ?? 0), 0);
const idList = (ids: string[]): SQL => sql.join(ids.map((i) => sql`${i}`), sql`, `);

async function upd(db: Db, row: ParcelRow, values: Record<string, any>): Promise<ParcelRow> {
  const [u] = await db.update(parcels).set(values as never).where(eq(parcels.id, row.id)).returning(parcelCols);
  if (u) Object.assign(row, u);
  return row;
}

// ----------------------------------------------------------------------------- filters

export interface ParcelFilters {
  q?: string;
  county?: string[];
  state?: string[];
  min_acres?: number;
  max_acres?: number;
  has_geometry?: boolean;
  property_id?: string;
  linked?: boolean;
  bbox?: string;
  near_lat?: number;
  near_lng?: number;
  radius_miles?: number;
  territory_id?: string;
  ids?: string[];
}

export function buildWhere(f: ParcelFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = parcels;
  const terms = f.q ? f.q.split(/\s+/).filter(Boolean) : [];
  return and(
    isNull(t.deleted_at),
    ...terms.map((term) => {
      const conds = [t.apn, t.county, t.legal_description, t.situs_address].map((c) => ilike(c, `%${term}%`));
      const norm = normalizeApn(term);
      if (norm) conds.push(ilike(t.apn_normalized, `%${norm}%`));
      return or(...conds);
    }),
    skip.has("county") ? undefined : inFilter(t.county, f.county),
    skip.has("state") ? undefined : inFilter(t.state, f.state),
    inFilter(t.id, f.ids),
    rangeFilter(t.acreage, f.min_acres, f.max_acres),
    f.has_geometry !== undefined ? eq(t.has_geometry, f.has_geometry) : undefined,
    f.property_id
      ? sql`${t.id} in (select ${propertyParcels.parcel_id} from ${propertyParcels} where ${propertyParcels.property_id} = ${f.property_id})`
      : undefined,
    f.linked !== undefined
      ? f.linked
        ? sql`${t.id} in (select ${propertyParcels.parcel_id} from ${propertyParcels})`
        : sql`${t.id} not in (select ${propertyParcels.parcel_id} from ${propertyParcels})`
      : undefined,
    f.bbox ? sql`ST_Intersects(${t.geometry}, ${geo.envelope(f.bbox)})` : undefined,
    f.near_lat !== undefined && f.near_lng !== undefined && f.radius_miles
      ? sql`ST_DWithin(${t.geometry}::geography, ${geo.point(f.near_lat, f.near_lng)}::geography, ${f.radius_miles * geo.M_PER_MILE})`
      : undefined,
    f.territory_id
      ? sql`ST_Intersects(${t.geometry}, (select ${territories.geometry} from ${territories} where ${territories.id} = ${f.territory_id}))`
      : undefined,
  );
}

const propertyCount = sql<number>`(select count(*)::int from ${propertyParcels} where ${propertyParcels.parcel_id} = ${parcels.id})`;

export interface ParcelListItem {
  id: string;
  county: string;
  state: string | null;
  apn: string;
  apn_normalized: string;
  situs_address: string | null;
  legal_description: string | null;
  acreage: number | null;
  has_geometry: boolean;
  centroid_lat: number | null;
  centroid_lng: number | null;
  source: string | null;
  observed_on: string | null;
  property_count: number;
  updated_at: Date;
}

export function listItem(p: ParcelRow, count: number | null | undefined): ParcelListItem {
  return {
    id: p.id,
    county: p.county,
    state: p.state,
    apn: p.apn,
    apn_normalized: p.apn_normalized,
    situs_address: p.situs_address,
    legal_description: p.legal_description,
    acreage: p.acreage,
    has_geometry: p.has_geometry,
    centroid_lat: p.centroid_lat,
    centroid_lng: p.centroid_lng,
    source: p.source,
    observed_on: p.observed_on,
    property_count: Number(count ?? 0),
    updated_at: p.updated_at,
  };
}

/** One page of list items (+ unpaginated total) for the filters. */
export async function listPage(db: Db, f: ParcelFilters, order: SQL[], p: ListParams): Promise<[ParcelListItem[], number]> {
  const where = buildWhere(f);
  const total = await countWhere(db, parcels, where);
  const rows = await db
    .select({ ...parcelCols, property_count: propertyCount })
    .from(parcels)
    .where(where)
    .orderBy(...order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size);
  return [rows.map((r) => listItem(r, r.property_count)), total];
}

async function listByIds(db: Db, ids: string[]): Promise<ParcelListItem[]> {
  const rows = await db
    .select({ ...parcelCols, property_count: propertyCount })
    .from(parcels)
    .where(buildWhere({ ids }))
    .orderBy(asc(parcels.apn));
  return rows.map((r) => listItem(r, r.property_count));
}

// ----------------------------------------------------------------------------- parcels

export async function getParcel(db: Db, parcelId: string): Promise<ParcelRow> {
  const [p] = await db.select(parcelCols).from(parcels).where(eq(parcels.id, parcelId)).limit(1);
  if (!p || p.deleted_at) throw new HttpError(404, "Parcel not found");
  return p;
}
export { getParcel as get };

export async function toOut(db: Db, p: ParcelRow) {
  const [g] = await raw<{ gj: string | null; area: number | null }>(
    db,
    sql`select ST_AsGeoJSON(geometry, 7) as gj, ST_Area(geometry::geography)::float8 as area from parcels where id = ${p.id}`,
  );
  const [c] = await db.select({ n: propertyCount }).from(parcels).where(eq(parcels.id, p.id));
  return {
    ...listItem(p, c?.n ?? 0),
    facts: p.facts ?? {},
    notes: p.notes,
    // Named `geojson` (not `geometry`) so the raw PostGIS column never reaches the client.
    geojson: geo.loads(g?.gj),
    geometry_acreage: g?.area ? round(Number(g.area) / geo.SQ_M_PER_ACRE, 4) : null,
    provenance: await provenance.currentObservations(db, ENTITY, p.id),
    created_at: p.created_at,
    created_by_id: p.created_by_id,
  };
}

export async function findDuplicates(db: Db, county: string, apnNormalized: string, exclude?: string): Promise<ParcelRow[]> {
  return db
    .select(parcelCols)
    .from(parcels)
    .where(
      and(
        isNull(parcels.deleted_at),
        sql`lower(trim(${parcels.county})) = ${county.trim().toLowerCase()}`,
        eq(parcels.apn_normalized, apnNormalized),
        exclude ? sql`${parcels.id} <> ${exclude}` : undefined,
      ),
    )
    .limit(5);
}

const duplicateError = (dupes: ParcelRow[]) =>
  new HttpError(409, {
    message: "A parcel with this county and APN already exists. Review before merging.",
    duplicates: dupes.map((d) => ({
      id: d.id, apn: d.apn, county: d.county, situs_address: d.situs_address, acreage: d.acreage,
    })),
  });

/** Parcel `source`/`observed_on` columns feed the field observations when no explicit provenance is given. */
function withProv(prov: provenance.ProvenanceIn, source: string | null | undefined, observedOn: string | null | undefined) {
  const upd: Partial<provenance.ProvenanceIn> = {};
  if (source && prov.source === "Manual entry") upd.source = source;
  if (observedOn && !prov.observed_on) upd.observed_on = observedOn;
  return Object.keys(upd).length ? { ...prov, ...upd } : prov;
}

/** Column values that set (or clear) the parcel geometry and its derived centroid fields. */
function geometryValues(g: geo.PolygonResult | null): Record<string, any> {
  return g
    ? {
        geometry: sql`ST_GeomFromText(${g.wkt}, 4326)`,
        centroid: geo.point(g.centroid_lat, g.centroid_lng),
        has_geometry: true,
        centroid_lat: round(g.centroid_lat, 7),
        centroid_lng: round(g.centroid_lng, 7),
      }
    : { geometry: null, centroid: null, has_geometry: false, centroid_lat: null, centroid_lng: null };
}

/** Version row with the parcel's current legal description + geometry (read in SQL; geometry stays in PostGIS). */
async function snapshot(db: Db, p: ParcelRow, changed: string[], actor: CurrentUser): Promise<void> {
  const [cur] = await raw<{ v: number }>(
    db,
    sql`select coalesce(max(version), 0)::int as v from parcel_versions where parcel_id = ${p.id}`,
  );
  await db.insert(parcelVersions).values({
    parcel_id: p.id,
    version: Number(cur?.v ?? 0) + 1,
    legal_description: p.legal_description,
    geometry: sql`(select geometry from parcels where id = ${p.id})` as never,
    acreage: p.acreage,
    changed_fields: changed,
    source: p.source,
    observed_on: p.observed_on,
    recorded_by_id: actor.id,
  });
}

export async function create(db: Db, data: ParcelCreate, actor: CurrentUser, { force = false } = {}): Promise<ParcelRow> {
  const apnNorm = normalizeApn(data.apn);
  if (!apnNorm) throw new HttpError(422, "APN must contain letters or digits");
  const dupes = await findDuplicates(db, data.county, apnNorm);
  if (dupes.length && !force) throw duplicateError(dupes);

  const shape = data.geometry ? await geo.polygonFromGeojson(db, data.geometry) : null;
  const { provenance: provIn, geometry: _g, ...values } = data;
  values.county = values.county.trim();
  const acreage = values.acreage ?? (shape ? round(shape.acres, 4) : undefined);
  const [p] = await db
    .insert(parcels)
    .values({
      ...values,
      acreage,
      apn_normalized: apnNorm,
      created_by_id: actor.id,
      updated_by_id: actor.id,
      ...geometryValues(shape),
    } as never)
    .returning(parcelCols);

  const prov = withProv(provIn, data.source, data.observed_on);
  for (const field of PARCEL_MATERIAL) {
    const value = (p as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: p.id, field, value, prov, actor_id: actor.id });
    }
  }
  await snapshot(db, p, ["created"], actor);
  await audit.record(db, {
    actor, action: "parcel.created", entity_type: ENTITY, entity_id: p.id, summary: `${p.county} APN ${p.apn}`,
    ip_address: actor.ip_address,
    changes: dupes.length ? { possible_duplicate_of: dupes.map((d) => d.id) } : null,
  });
  await db.commit();
  return p;
}

export async function update(db: Db, p: ParcelRow, data: ParcelUpdate, actor: CurrentUser): Promise<ParcelRow> {
  const { provenance: provIn, geometry: geomIn, clear_geometry, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (values.county) values.county = values.county.trim();
  let newNorm = p.apn_normalized;
  if ("apn" in values || "county" in values) {
    newNorm = normalizeApn("apn" in values ? values.apn : p.apn) || "";
    if (!newNorm) throw new HttpError(422, "APN must contain letters or digits");
    const dupes = await findDuplicates(db, values.county ?? p.county, newNorm, p.id);
    if (dupes.length) throw duplicateError(dupes);
  }

  const shape = geomIn ? await geo.polygonFromGeojson(db, geomIn) : null;
  const hadGeometry = p.has_geometry;
  const prov = withProv(
    provIn,
    "source" in values ? values.source : p.source,
    "observed_on" in values ? values.observed_on : p.observed_on,
  );
  // `p` is mutated in memory by applyMaterial; persisted below with one UPDATE.
  const changes = await provenance.applyMaterial(db, p, {
    entity_type: ENTITY, data: values, material_fields: PARCEL_MATERIAL, prov, actor_id: actor.id,
  });
  p.apn_normalized = newNorm;
  let geometryChanged = false;
  if (shape) {
    geometryChanged = true;
    changes.geometry = { from: hadGeometry ? "polygon" : null, to: `polygon (${shape.acres.toFixed(4)} ac)` };
  } else if (clear_geometry && hadGeometry) {
    geometryChanged = true;
    changes.geometry = { from: "polygon", to: null };
  }
  if (!Object.keys(changes).length) return p;

  const set: Record<string, any> = {};
  for (const k of Object.keys(changes)) if (k !== "geometry") set[k] = (p as Record<string, any>)[k];
  set.apn_normalized = newNorm;
  if (geometryChanged) Object.assign(set, geometryValues(shape));
  set.updated_by_id = actor.id;
  await upd(db, p, set);

  if (geometryChanged || "legal_description" in changes) {
    await snapshot(db, p, Object.keys(changes).filter((k) => ["geometry", "legal_description", "acreage"].includes(k)), actor);
  }
  await audit.record(db, {
    actor, action: "parcel.updated", entity_type: ENTITY, entity_id: p.id, changes, ip_address: actor.ip_address,
  });
  await db.commit();
  return p;
}

export async function archive(db: Db, p: ParcelRow, actor: CurrentUser): Promise<void> {
  await upd(db, p, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "parcel.archived", entity_type: ENTITY, entity_id: p.id, summary: `${p.county} APN ${p.apn}`,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

/** Human-approved merge of a reviewed duplicate: links and buildings move to `target`, `source` is archived. */
export async function merge(db: Db, source: ParcelRow, target: ParcelRow, actor: CurrentUser): Promise<ParcelRow> {
  if (source.id === target.id) throw new HttpError(422, "Cannot merge a parcel into itself");
  const existing = new Set(
    (await db.select({ id: propertyParcels.property_id }).from(propertyParcels).where(eq(propertyParcels.parcel_id, target.id))).map(
      (r) => r.id,
    ),
  );
  let moved = 0;
  const links = await db.select().from(propertyParcels).where(eq(propertyParcels.parcel_id, source.id));
  for (const link of links) {
    if (existing.has(link.property_id)) {
      await remove(db, propertyParcels, link);
    } else {
      await patch(db, propertyParcels, link, { parcel_id: target.id, updated_by_id: actor.id });
      moved += 1;
    }
  }
  await db.update(buildings).set({ parcel_id: target.id }).where(eq(buildings.parcel_id, source.id));
  await upd(db, source, {
    deleted_at: utcnow(),
    updated_by_id: actor.id,
    facts: { ...(source.facts ?? {}), merged_into: target.id },
  });
  await audit.record(db, {
    actor, action: "parcel.merged", entity_type: ENTITY, entity_id: source.id,
    summary: `Merged into ${target.county} APN ${target.apn}`, changes: { into: target.id, links_moved: moved },
    ip_address: actor.ip_address,
  });
  await audit.record(db, {
    actor, action: "parcel.merge_received", entity_type: ENTITY, entity_id: target.id,
    summary: `Absorbed ${source.county} APN ${source.apn}`, changes: { from: source.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return target;
}

export async function versions(db: Db, parcelId: string) {
  const { geometry: _vg, ...cols } = getTableColumns(parcelVersions);
  const rows = await db
    .select({ ...cols, gj: sql<string | null>`ST_AsGeoJSON(${parcelVersions.geometry}, 7)` })
    .from(parcelVersions)
    .where(eq(parcelVersions.parcel_id, parcelId))
    .orderBy(desc(parcelVersions.version));
  return rows.map((v) => ({
    id: v.id,
    version: v.version,
    legal_description: v.legal_description,
    acreage: v.acreage,
    changed_fields: v.changed_fields,
    source: v.source,
    observed_on: v.observed_on,
    recorded_at: v.recorded_at,
    recorded_by_id: v.recorded_by_id,
    geojson: geo.loads(v.gj),
  }));
}

// ----------------------------------------------------------------------------- GeoJSON

export async function feature(db: Db, p: ParcelRow) {
  const [r] = await db
    .select({ gj: sql<string | null>`ST_AsGeoJSON(${parcels.geometry}, 7)` })
    .from(parcels)
    .where(eq(parcels.id, p.id));
  return {
    type: "Feature",
    id: p.id,
    geometry: geo.loads(r?.gj),
    properties: { id: p.id, apn: p.apn, county: p.county, acreage: p.acreage, situs_address: p.situs_address },
  };
}

export async function featureCollection(db: Db, f: ParcelFilters, limit: number) {
  const rows = await db
    .select({
      id: parcels.id, apn: parcels.apn, county: parcels.county, acreage: parcels.acreage,
      situs_address: parcels.situs_address, gj: sql<string | null>`ST_AsGeoJSON(${parcels.geometry}, 6)`,
    })
    .from(parcels)
    .where(and(buildWhere(f), eq(parcels.has_geometry, true)))
    .limit(limit);
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      id: r.id,
      geometry: geo.loads(r.gj),
      properties: { id: r.id, apn: r.apn, county: r.county, acreage: r.acreage, situs_address: r.situs_address },
    })),
    truncated: rows.length >= limit,
  };
}

// ----------------------------------------------------------------------------- ownership (read-only, optional module)

async function columnExists(db: Db, table: string, column?: string): Promise<boolean> {
  const rows = column
    ? await raw(
        db,
        sql`select 1 from information_schema.columns where table_schema = current_schema() and table_name = ${table} and column_name = ${column} limit 1`,
      )
    : await raw(
        db,
        sql`select 1 from information_schema.tables where table_schema = current_schema() and table_name = ${table} limit 1`,
      );
  return rows.length > 0;
}

/** Current owners per parcel via property_parcels -> ownership_interests. Returns [map, ownership_available]. */
export async function ownersForParcels(db: Db, parcelIds: string[]): Promise<[Map<string, Set<string>>, boolean]> {
  if (!(await columnExists(db, "ownership_interests"))) return [new Map(), false];
  if (!parcelIds.length) return [new Map(), true];
  const hasDeleted = await columnExists(db, "ownership_interests", "deleted_at");
  const rows = await raw<{ parcel_id: string; owner_kind: string; owner_person_id: string | null; owner_organization_id: string | null }>(
    db,
    sql`select pp.parcel_id, oi.owner_kind, oi.owner_person_id, oi.owner_organization_id
        from property_parcels pp
        join ownership_interests oi on oi.property_id = pp.property_id
        where pp.parcel_id in (${idList(parcelIds)})
          and (oi.effective_to is null or oi.effective_to >= current_date)
          ${hasDeleted ? sql`and oi.deleted_at is null` : sql``}`,
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const ownerId = r.owner_kind === "person" ? r.owner_person_id : r.owner_organization_id;
    if (ownerId) {
      const set = out.get(r.parcel_id) ?? new Set<string>();
      set.add(ownerKey(r.owner_kind, ownerId));
      out.set(r.parcel_id, set);
    }
  }
  return [out, true];
}

export async function ownerRefs(db: Db, keys: Set<string>): Promise<OwnerRef[]> {
  const names = new Map<string, string | null>();
  for (const [kind, table, col] of [["person", "people", "full_name"], ["organization", "organizations", "name"]] as const) {
    const ids = [...keys].map(splitKey).filter(([k]) => k === kind).map(([, i]) => i);
    if (ids.length && (await columnExists(db, table, col))) {
      const rows = await raw<{ id: string; name: string | null }>(
        db,
        sql`select id, ${sql.identifier(col)} as name from ${sql.identifier(table)} where id in (${idList(ids)})`,
      );
      for (const r of rows) names.set(ownerKey(kind, r.id), r.name);
    }
  }
  return [...keys]
    .map(splitKey)
    .map(([kind, id]): OwnerRef => ({ kind, id, name: names.get(ownerKey(kind, id)) ?? null }))
    .sort((a, b) => (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase()));
}

// ----------------------------------------------------------------------------- adjacency & assemblage

const toleranceDeg = (meters: number) => meters / geo.M_PER_DEGREE;

export interface AdjacentParcel {
  id: string;
  county: string;
  apn: string;
  situs_address: string | null;
  acreage: number | null;
  distance_m: number;
  touches: boolean;
  shared_owners: OwnerRef[];
}

export async function adjacent(db: Db, p: ParcelRow, user: CurrentUser, toleranceM = ADJACENCY_TOLERANCE_M) {
  if (!p.has_geometry) return { items: [] as AdjacentParcel[], owners: [] as OwnerRef[], owners_hidden: false };
  const rows = await raw<{
    id: string; county: string; apn: string; situs_address: string | null; acreage: number | null;
    distance_m: number | null; touches: boolean | null;
  }>(
    db,
    sql`select o.id, o.county, o.apn, o.situs_address, o.acreage::float8 as acreage,
               ST_Distance(o.geometry::geography, me.geometry::geography) as distance_m,
               ST_Touches(o.geometry, me.geometry) as touches
        from parcels o
        join parcels me on me.id = ${p.id}
        where o.id <> ${p.id} and o.deleted_at is null and o.has_geometry is true
          and ST_DWithin(o.geometry, me.geometry, ${toleranceDeg(toleranceM)})
        order by distance_m
        limit 200`,
  );
  const items: AdjacentParcel[] = rows.map((r) => ({
    id: r.id,
    county: r.county,
    apn: r.apn,
    situs_address: r.situs_address,
    acreage: r.acreage === null ? null : Number(r.acreage),
    distance_m: round(Number(r.distance_m ?? 0), 2),
    touches: Boolean(r.touches),
    shared_owners: [],
  }));
  if (!user.can("ownership", "view")) return { items, owners: [] as OwnerRef[], owners_hidden: true };

  const [owners] = await ownersForParcels(db, [p.id, ...items.map((i) => i.id)]);
  const mine = owners.get(p.id) ?? new Set<string>();
  const shared = (id: string) => [...(owners.get(id) ?? [])].filter((k) => mine.has(k));
  const allKeys = new Set(mine);
  for (const i of items) for (const k of shared(i.id)) allKeys.add(k);
  const refs = new Map((await ownerRefs(db, allKeys)).map((r) => [ownerKey(r.kind, r.id), r]));
  for (const i of items) i.shared_owners = shared(i.id).filter((k) => refs.has(k)).map((k) => refs.get(k)!);
  return { items, owners: [...mine].filter((k) => refs.has(k)).map((k) => refs.get(k)!), owners_hidden: false };
}

async function neighbors(db: Db, ids: Set<string>, toleranceM: number): Promise<Set<string>> {
  const rows = await raw<{ id: string }>(
    db,
    sql`select distinct b.id
        from parcels a
        join parcels b on b.id <> a.id and ST_DWithin(b.geometry, a.geometry, ${toleranceDeg(toleranceM)})
        where a.id in (${idList([...ids])}) and b.deleted_at is null and b.has_geometry is true`,
  );
  return new Set(rows.map((r) => r.id));
}

/** Contiguous parcels sharing a current owner with `p` (breadth-first over the adjacency graph, per owner). */
export async function assemblage(db: Db, p: ParcelRow, user: CurrentUser, toleranceM = ADJACENCY_TOLERANCE_M, maxParcels = 200) {
  if (!user.can("ownership", "view")) {
    return { owners: [] as OwnerRef[], groups: [], owners_hidden: true, ownership_available: true };
  }
  const [owners, available] = await ownersForParcels(db, [p.id]);
  const mine = owners.get(p.id) ?? new Set<string>();
  if (!available || !mine.size) {
    return { owners: [] as OwnerRef[], groups: [], owners_hidden: false, ownership_available: available };
  }

  const refs = new Map((await ownerRefs(db, mine)).map((r) => [ownerKey(r.kind, r.id), r]));
  const groups: Array<{ owner: OwnerRef; parcels: ParcelListItem[]; total_acreage: number }> = [];
  for (const owner of mine) {
    let group = new Set([p.id]);
    let frontier = new Set([p.id]);
    while (frontier.size && p.has_geometry && group.size < maxParcels) {
      const candidates = [...(await neighbors(db, frontier, toleranceM))].filter((c) => !group.has(c));
      if (!candidates.length) break;
      const [candOwners] = await ownersForParcels(db, candidates);
      frontier = new Set(candidates.filter((c) => candOwners.get(c)?.has(owner)));
      group = new Set([...group, ...frontier]);
    }
    if (group.size > 1) {
      const items = await listByIds(db, [...group]);
      const [kind, id] = splitKey(owner);
      groups.push({
        owner: refs.get(owner) ?? { kind, id, name: null },
        parcels: items,
        total_acreage: round(sumAcreage(items), 4),
      });
    }
  }
  return { owners: [...refs.values()], groups, owners_hidden: false, ownership_available: true };
}

export async function isContiguous(db: Db, ids: string[], toleranceM = ADJACENCY_TOLERANCE_M): Promise<boolean | null> {
  if (ids.length < 2) return null;
  const [r] = await raw<{ n: number | null }>(
    db,
    sql`select ST_NumGeometries(ST_Multi(ST_Union(ST_Buffer(geometry, ${toleranceDeg(toleranceM / 2)}))))::int as n
        from parcels where id in (${idList(ids)}) and has_geometry is true`,
  );
  return r?.n !== null && r?.n !== undefined ? r.n === 1 : null;
}

// ----------------------------------------------------------------------------- property <-> parcel links

export async function parcelProperties(db: Db, parcelId: string) {
  const rows = await db
    .select({ link: propertyParcels, pr: properties })
    .from(propertyParcels)
    .innerJoin(properties, eq(properties.id, propertyParcels.property_id))
    .where(and(eq(propertyParcels.parcel_id, parcelId), isNull(properties.deleted_at)))
    .orderBy(asc(propertyParcels.created_at));
  return rows.map(({ link, pr }) => ({
    link_id: link.id,
    relationship: link.relationship,
    property_id: pr.id,
    name: pr.name,
    address_line: pr.address_line,
    city: pr.city,
    state: pr.state,
    status: pr.status,
    property_type: pr.property_type,
  }));
}

export async function propertyParcelsFor(db: Db, propertyId: string) {
  const rows = await db
    .select({
      ...parcelCols,
      property_count: propertyCount,
      link_id: propertyParcels.id,
      link_relationship: propertyParcels.relationship,
      link_notes: propertyParcels.notes,
    })
    .from(parcels)
    .innerJoin(propertyParcels, eq(propertyParcels.parcel_id, parcels.id))
    .where(and(buildWhere({}), eq(propertyParcels.property_id, propertyId)))
    .orderBy(asc(propertyParcels.created_at));
  return rows.map((r) => ({
    link_id: r.link_id,
    relationship: r.link_relationship,
    notes: r.link_notes,
    parcel: listItem(r, r.property_count),
  }));
}

export async function getLink(db: Db, propertyId: string, linkId: string): Promise<PropertyParcel> {
  const link = await ormGet(db, propertyParcels, linkId);
  if (!link || link.property_id !== propertyId) throw new HttpError(404, "Parcel link not found");
  return link;
}

async function auditLink(db: Db, actor: CurrentUser, verb: string, propertyId: string, parcel: ParcelRow, rel: string) {
  const summary = `${parcel.county} APN ${parcel.apn} (${rel})`;
  await audit.record(db, {
    actor, action: `parcel.${verb}`, entity_type: ENTITY, entity_id: parcel.id, summary,
    changes: { property_id: propertyId, relationship: rel }, ip_address: actor.ip_address,
  });
  await audit.record(db, {
    actor, action: `property.parcel_${verb}`, entity_type: "property", entity_id: propertyId, summary,
    changes: { parcel_id: parcel.id, relationship: rel }, ip_address: actor.ip_address,
  });
}

export async function linkParcel(db: Db, propertyId: string, data: PropertyParcelIn, actor: CurrentUser): Promise<PropertyParcel> {
  const parcel = await getParcel(db, data.parcel_id);
  const [exists] = await db
    .select({ id: propertyParcels.id })
    .from(propertyParcels)
    .where(and(eq(propertyParcels.property_id, propertyId), eq(propertyParcels.parcel_id, parcel.id)));
  if (exists) throw new HttpError(409, "Parcel is already linked to this property");
  const link = await insert(db, propertyParcels, {
    property_id: propertyId, parcel_id: parcel.id, relationship: data.relationship, notes: data.notes,
    created_by_id: actor.id, updated_by_id: actor.id,
  });
  await auditLink(db, actor, "linked", propertyId, parcel, data.relationship);
  await db.commit();
  return link;
}

export async function updateLink(db: Db, link: PropertyParcel, data: PropertyParcelUpdate, actor: CurrentUser): Promise<PropertyParcel> {
  const values: Record<string, any> = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const changes = audit.diff(link, values);
  if (!Object.keys(changes).length) return link;
  await patch(db, propertyParcels, link, { ...values, updated_by_id: actor.id } as never);
  const [parcel] = await db.select(parcelCols).from(parcels).where(eq(parcels.id, link.parcel_id!));
  await audit.record(db, {
    actor, action: "property.parcel_link_updated", entity_type: "property", entity_id: link.property_id, changes,
    summary: parcel ? `${parcel.county} APN ${parcel.apn}` : null, ip_address: actor.ip_address,
  });
  await db.commit();
  return link;
}

export async function unlink(db: Db, link: PropertyParcel, actor: CurrentUser): Promise<void> {
  const [parcel] = await db.select(parcelCols).from(parcels).where(eq(parcels.id, link.parcel_id!));
  if (parcel) await auditLink(db, actor, "unlinked", link.property_id!, parcel, link.relationship);
  await remove(db, propertyParcels, link);
  await db.commit();
}

export interface BulkPreviewParcel {
  id: string;
  apn: string;
  county: string;
  acreage: number | null;
  has_geometry: boolean;
  already_linked: boolean;
  relationship: string;
  linked_elsewhere: string[];
}

/** Preview (default) or apply: link many parcels to an existing property or a new one. */
export async function bulkAssociate(db: Db, data: BulkAssociateIn, actor: CurrentUser) {
  const requested = data.parcel_ids.map((i) => i.toLowerCase());
  const foundRows = await db
    .select(parcelCols)
    .from(parcels)
    .where(and(inArray(parcels.id, requested), isNull(parcels.deleted_at)));
  const found = new Map(foundRows.map((p) => [p.id, p]));
  const parcelList = [...new Set(requested)].filter((i) => found.has(i)).map((i) => found.get(i)!);
  const missing = requested.filter((i) => !found.has(i));
  if (!parcelList.length) throw new HttpError(422, "None of the selected parcels exist");

  let propertyId: string | null = data.property_id ? data.property_id.toLowerCase() : null;
  if (propertyId) {
    await propertyService.getProperty(db, propertyId);
  } else if (!data.new_property && !data.preview) {
    throw new HttpError(422, "Choose a property or provide a new property");
  }

  const ids = parcelList.map((p) => p.id);
  const links = await db
    .select({ parcel_id: propertyParcels.parcel_id, property_id: propertyParcels.property_id })
    .from(propertyParcels)
    .where(inArray(propertyParcels.parcel_id, ids));
  const already = new Set(links.filter((l) => l.property_id === propertyId).map((l) => l.parcel_id));
  const elsewhere = new Map<string, string[]>();
  for (const l of links) {
    if (l.property_id !== propertyId) elsewhere.set(l.parcel_id!, [...(elsewhere.get(l.parcel_id!) ?? []), l.property_id!]);
  }
  let hasPrimary = false;
  if (propertyId) {
    const [r] = await db
      .select({ id: propertyParcels.id })
      .from(propertyParcels)
      .where(and(eq(propertyParcels.property_id, propertyId), eq(propertyParcels.relationship, "primary")))
      .limit(1);
    hasPrimary = Boolean(r);
  }

  const preview: BulkPreviewParcel[] = parcelList.map((p) => {
    let rel: string;
    if (data.relationship) {
      rel = data.relationship;
    } else if (!hasPrimary && !already.has(p.id)) {
      rel = "primary";
      hasPrimary = true;
    } else {
      rel = "assemblage";
    }
    return {
      id: p.id, apn: p.apn, county: p.county, acreage: p.acreage, has_geometry: p.has_geometry,
      already_linked: already.has(p.id), relationship: rel, linked_elsewhere: elsewhere.get(p.id) ?? [],
    };
  });
  const out = {
    preview: data.preview,
    property_id: propertyId,
    parcels: preview,
    missing_ids: missing,
    total_acreage: round(sumAcreage(parcelList), 4),
    contiguous: await isContiguous(db, parcelList.filter((p) => p.has_geometry).map((p) => p.id)),
    linked: 0,
  };
  if (data.preview) return out;

  if (!propertyId && data.new_property) {
    const prop = await propertyService.create(db, data.new_property, actor); // commits the property on its own
    propertyId = prop.id;
    out.property_id = propertyId;
  }
  let linked = 0;
  for (const item of preview) {
    if (item.already_linked) continue;
    await insert(db, propertyParcels, {
      property_id: propertyId!, parcel_id: item.id, relationship: item.relationship,
      created_by_id: actor.id, updated_by_id: actor.id,
    });
    await auditLink(db, actor, "linked", propertyId!, found.get(item.id)!, item.relationship);
    linked += 1;
  }
  await db.commit();
  out.linked = linked;
  return out;
}

// ----------------------------------------------------------------------------- buildings

async function checkParcelOnProperty(db: Db, propertyId: string, parcelId: string | null | undefined) {
  if (!parcelId) return;
  const [r] = await db
    .select({ id: propertyParcels.id })
    .from(propertyParcels)
    .where(and(eq(propertyParcels.property_id, propertyId), eq(propertyParcels.parcel_id, parcelId)));
  if (!r) throw new HttpError(422, "Parcel is not linked to this property");
}

export function buildingOut(b: Building, spaceCount = 0) {
  return {
    id: b.id,
    property_id: b.property_id,
    parcel_id: b.parcel_id,
    name: b.name,
    building_area_sf: b.building_area_sf,
    year_built: b.year_built,
    floors: b.floors,
    construction_class: b.construction_class,
    use_type: b.use_type,
    notes: b.notes,
    space_count: spaceCount,
    updated_at: b.updated_at,
  };
}

export async function listBuildings(db: Db, propertyId: string) {
  const counts = new Map(
    (
      await db
        .select({ b: spaces.building_id, n: sql<number>`count(${spaces.id})::int` })
        .from(spaces)
        .where(and(eq(spaces.property_id, propertyId), isNull(spaces.deleted_at), sql`${spaces.building_id} is not null`))
        .groupBy(spaces.building_id)
    ).map((r) => [r.b, r.n]),
  );
  const rows = await db
    .select()
    .from(buildings)
    .where(and(eq(buildings.property_id, propertyId), isNull(buildings.deleted_at)))
    .orderBy(asc(buildings.name));
  return rows.map((b) => buildingOut(b, counts.get(b.id) ?? 0));
}

export async function getBuilding(db: Db, propertyId: string, buildingId: string): Promise<Building> {
  const b = await ormGet(db, buildings, buildingId);
  if (!b || b.deleted_at || b.property_id !== propertyId) throw new HttpError(404, "Building not found");
  return b;
}

export async function createBuilding(db: Db, propertyId: string, data: BuildingIn, actor: CurrentUser): Promise<Building> {
  await checkParcelOnProperty(db, propertyId, data.parcel_id);
  const { provenance: prov, ...values } = data;
  const b = await insert(db, buildings, { ...values, property_id: propertyId, created_by_id: actor.id, updated_by_id: actor.id });
  for (const field of BUILDING_MATERIAL) {
    const value = (b as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: "building", entity_id: b.id, field, value, prov, actor_id: actor.id });
    }
  }
  await audit.record(db, {
    actor, action: "property.building_added", entity_type: "property", entity_id: propertyId, summary: b.name,
    changes: { building_id: b.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return b;
}

export async function updateBuilding(db: Db, b: Building, data: BuildingUpdate, actor: CurrentUser): Promise<Building> {
  const { provenance: prov, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if ("parcel_id" in values) await checkParcelOnProperty(db, b.property_id!, values.parcel_id);
  const changes = await provenance.applyMaterial(db, b, {
    entity_type: "building", data: values, material_fields: BUILDING_MATERIAL, prov, actor_id: actor.id,
  });
  if (Object.keys(changes).length) {
    const set = Object.fromEntries(Object.keys(changes).map((k) => [k, (b as Record<string, any>)[k]]));
    await patch(db, buildings, b, { ...set, updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: "property.building_updated", entity_type: "property", entity_id: b.property_id, summary: b.name,
      changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return b;
}

export async function archiveBuilding(db: Db, b: Building, actor: CurrentUser): Promise<void> {
  await patch(db, buildings, b, { deleted_at: utcnow(), updated_by_id: actor.id });
  await db.update(spaces).set({ building_id: null }).where(eq(spaces.building_id, b.id));
  await audit.record(db, {
    actor, action: "property.building_removed", entity_type: "property", entity_id: b.property_id, summary: b.name,
    ip_address: actor.ip_address,
  });
  await db.commit();
}

// ----------------------------------------------------------------------------- spaces / suites

export function spaceOut(s: Space) {
  return {
    id: s.id,
    property_id: s.property_id,
    building_id: s.building_id,
    suite: s.suite,
    area_sf: s.area_sf,
    floor: s.floor,
    location_note: s.location_note,
    use_type: s.use_type,
    occupancy_status: s.occupancy_status,
    tenant_name: s.tenant_name,
    tenant_organization_id: s.tenant_organization_id,
    lease_id: s.lease_id,
    notes: s.notes,
    updated_at: s.updated_at,
  };
}

export async function listSpaces(
  db: Db,
  propertyId: string,
  { q, building_id, occupancy_status }: { q?: string; building_id?: string; occupancy_status?: string[] } = {},
): Promise<Space[]> {
  return db
    .select()
    .from(spaces)
    .where(
      and(
        eq(spaces.property_id, propertyId),
        isNull(spaces.deleted_at),
        q ? or(ilike(spaces.suite, `%${q}%`), ilike(spaces.tenant_name, `%${q}%`)) : undefined,
        building_id ? eq(spaces.building_id, building_id) : undefined,
        inFilter(spaces.occupancy_status, occupancy_status),
      ),
    )
    .orderBy(asc(spaces.suite));
}

export async function getSpace(db: Db, propertyId: string, spaceId: string): Promise<Space> {
  const s = await ormGet(db, spaces, spaceId);
  if (!s || s.deleted_at || s.property_id !== propertyId) throw new HttpError(404, "Space not found");
  return s;
}

async function checkBuilding(db: Db, propertyId: string, buildingId: string | null | undefined) {
  if (buildingId) await getBuilding(db, propertyId, buildingId);
}

export async function createSpace(db: Db, propertyId: string, data: SpaceIn, actor: CurrentUser): Promise<Space> {
  await checkBuilding(db, propertyId, data.building_id);
  const { provenance: prov, ...values } = data;
  const s = await insert(db, spaces, { ...values, property_id: propertyId, created_by_id: actor.id, updated_by_id: actor.id });
  for (const field of SPACE_MATERIAL) {
    const value = (s as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: "space", entity_id: s.id, field, value, prov, actor_id: actor.id });
    }
  }
  await audit.record(db, {
    actor, action: "property.space_added", entity_type: "property", entity_id: propertyId, summary: `Suite ${s.suite}`,
    changes: { space_id: s.id }, ip_address: actor.ip_address,
  });
  await db.commit();
  return s;
}

export async function updateSpace(db: Db, s: Space, data: SpaceUpdate, actor: CurrentUser): Promise<Space> {
  const { provenance: prov, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (values.building_id) await checkBuilding(db, s.property_id!, values.building_id);
  const changes = await provenance.applyMaterial(db, s, {
    entity_type: "space", data: values, material_fields: SPACE_MATERIAL, prov, actor_id: actor.id,
  });
  if (Object.keys(changes).length) {
    const set = Object.fromEntries(Object.keys(changes).map((k) => [k, (s as Record<string, any>)[k]]));
    await patch(db, spaces, s, { ...set, updated_by_id: actor.id } as never);
    await audit.record(db, {
      actor, action: "property.space_updated", entity_type: "property", entity_id: s.property_id,
      summary: `Suite ${s.suite}`, changes, ip_address: actor.ip_address,
    });
    await db.commit();
  }
  return s;
}

export async function archiveSpace(db: Db, s: Space, actor: CurrentUser): Promise<void> {
  await patch(db, spaces, s, { deleted_at: utcnow(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "property.space_removed", entity_type: "property", entity_id: s.property_id,
    summary: `Suite ${s.suite}`, ip_address: actor.ip_address,
  });
  await db.commit();
}
