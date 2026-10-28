/**
 * PostGIS helpers shared by parcels and territories. PostGIS is authoritative for geometry:
 * GeoJSON input is parsed, repaired and measured in the database, never in JavaScript.
 */
import { sql, type SQL } from "drizzle-orm";

import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { raw } from "../../db/orm";

export const SQ_M_PER_ACRE = 4046.8564224;
export const M_PER_MILE = 1609.344;
export const M_PER_FT = 0.3048;
export const M_PER_DEGREE = 111_320.0;

const invalid = (msg: string) => new HttpError(422, msg);

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Accept a GeoJSON geometry, Feature or FeatureCollection and return a single geometry object. */
function flatten(rawGeom: unknown, allowed: Set<string>): Record<string, any> {
  if (!isObj(rawGeom)) throw invalid("Geometry must be a GeoJSON object");
  const kind = rawGeom.type;
  if (kind === "Feature") return flatten(rawGeom.geometry, allowed);
  if (kind === "FeatureCollection") {
    const features: unknown[] = Array.isArray(rawGeom.features) ? rawGeom.features : [];
    const geoms = features.filter(isObj).map((f) => flatten(f.geometry, allowed));
    if (!geoms.length) throw invalid("FeatureCollection has no geometries");
    return geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
  }
  if (allowed.has(kind) || kind === "GeometryCollection") return rawGeom;
  throw invalid(`Expected GeoJSON ${[...allowed].sort().join(" / ")}, got ${kind || "unknown"}`);
}

const fromGeojson = (geom: Record<string, any>): SQL =>
  sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}::text), 4326)`;

export interface PolygonResult {
  wkt: string;
  centroid_lat: number;
  centroid_lng: number;
  acres: number;
}

/** Run a statement inside a savepoint so a PostGIS parse error doesn't abort the request's transaction. */
async function nested<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`SAVEPOINT geo_nested`);
  try {
    const r = await fn();
    await db.execute(sql`RELEASE SAVEPOINT geo_nested`);
    return r;
  } catch (err) {
    await db.execute(sql`ROLLBACK TO SAVEPOINT geo_nested`);
    await db.execute(sql`RELEASE SAVEPOINT geo_nested`);
    throw err;
  }
}

export async function polygonFromGeojson(db: Db, rawGeom: unknown): Promise<PolygonResult> {
  const geom = flatten(rawGeom, new Set(["Polygon", "MultiPolygon"]));
  let row: Record<string, any>;
  try {
    [row] = await nested(db, () =>
      raw(
        db,
        sql`select ST_AsText(s.g) as wkt, ST_IsEmpty(s.g) as empty, ST_Y(ST_Centroid(s.g)) as lat,
                   ST_X(ST_Centroid(s.g)) as lng, ST_Area(s.g::geography) as area
            from (select ST_Multi(ST_CollectionExtract(ST_MakeValid(${fromGeojson(geom)}), 3)) as g) s`,
      ),
    );
  } catch {
    throw invalid("Invalid GeoJSON geometry");
  }
  if (!row || row.empty || !row.wkt) throw invalid("Geometry must contain at least one polygon");
  return {
    wkt: row.wkt,
    centroid_lat: Number(row.lat),
    centroid_lng: Number(row.lng),
    acres: Number(row.area ?? 0) / SQ_M_PER_ACRE,
  };
}

/** Returns [WKT LINESTRING, length in feet]. */
export async function lineFromGeojson(db: Db, rawGeom: unknown): Promise<[string, number]> {
  const geom = flatten(rawGeom, new Set(["LineString", "MultiLineString"]));
  let row: Record<string, any>;
  try {
    [row] = await nested(db, () =>
      raw(
        db,
        sql`select ST_AsText(s.g) as wkt, GeometryType(s.g) as gtype, ST_Length(s.g::geography) as len
            from (select ST_LineMerge(ST_Multi(ST_CollectionExtract(${fromGeojson(geom)}, 2))) as g) s`,
      ),
    );
  } catch {
    throw invalid("Invalid GeoJSON geometry");
  }
  if (!row || row.gtype !== "LINESTRING") throw invalid("Corridor geometry must be one connected line");
  return [row.wkt, Number(row.len ?? 0) / M_PER_FT];
}

/** SQL expression for a WGS84 point. */
export const point = (lat: number, lng: number): SQL => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;

/** `minLng,minLat,maxLng,maxLat` -> PostGIS envelope. */
export function envelope(bbox: string): SQL {
  const parts = bbox.split(",");
  const nums = parts.map((v) => (v.trim() === "" ? NaN : Number(v)));
  if (parts.length !== 4 || nums.some((n) => Number.isNaN(n))) throw invalid("bbox must be minLng,minLat,maxLng,maxLat");
  const [minx, miny, maxx, maxy] = nums;
  return sql`ST_MakeEnvelope(${minx}::float8, ${miny}::float8, ${maxx}::float8, ${maxy}::float8, 4326)`;
}

export const loads = (value: string | null | undefined): Record<string, any> | null => (value ? JSON.parse(value) : null);
