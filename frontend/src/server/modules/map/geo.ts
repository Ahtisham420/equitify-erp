/**
 * PostGIS helpers for the map workspace (port of parcels/geo.py). PostGIS is authoritative for geometry:
 * GeoJSON input is parsed, repaired and measured in the database, never in JS.
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

/** Accept a GeoJSON geometry, Feature or FeatureCollection and return a single geometry object. */
function flatten(rawIn: any, allowed: Set<string>): any {
  if (rawIn === null || typeof rawIn !== "object" || Array.isArray(rawIn)) {
    throw invalid("Geometry must be a GeoJSON object");
  }
  const kind = rawIn.type;
  if (kind === "Feature") return flatten(rawIn.geometry, allowed);
  if (kind === "FeatureCollection") {
    const feats: any[] = Array.isArray(rawIn.features) ? rawIn.features : [];
    const geoms = feats
      .filter((f) => f !== null && typeof f === "object" && !Array.isArray(f))
      .map((f) => flatten(f.geometry, allowed));
    if (!geoms.length) throw invalid("FeatureCollection has no geometries");
    return geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
  }
  if (allowed.has(kind) || kind === "GeometryCollection") return rawIn;
  throw invalid(`Expected GeoJSON ${[...allowed].sort().join(" / ")}, got ${kind || "unknown"}`);
}

const fromGeojson = (geom: unknown): SQL =>
  sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}::text), 4326)`;

let savepointSeq = 0;
/** SQLAlchemy `begin_nested()`: a failing statement rolls back to the savepoint instead of aborting the transaction. */
export async function nested<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const name = `eqf_sp_${++savepointSeq}`;
  await db.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    const result = await fn();
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return result;
  } catch (err) {
    await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    throw err;
  }
}

export interface PolygonResult {
  wkt: string;
  centroid_lat: number;
  centroid_lng: number;
  acres: number;
}

export async function polygonFromGeojson(db: Db, rawIn: unknown): Promise<PolygonResult> {
  const geom = flatten(rawIn, new Set(["Polygon", "MultiPolygon"]));
  let row: any;
  try {
    [row] = await nested(db, () =>
      raw<any>(
        db,
        sql`select ST_AsText(sub.g) as wkt, ST_IsEmpty(sub.g) as empty, ST_Y(ST_Centroid(sub.g)) as lat,
                   ST_X(ST_Centroid(sub.g)) as lng, ST_Area(sub.g::geography) as area
            from (select ST_Multi(ST_CollectionExtract(ST_MakeValid(${fromGeojson(geom)}), 3)) as g) sub`,
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
    acres: Number(row.area || 0) / SQ_M_PER_ACRE,
  };
}

export const point = (lat: number, lng: number): SQL => sql`ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)`;

/** `minLng,minLat,maxLng,maxLat` -> PostGIS envelope. */
export function envelope(bbox: string): SQL {
  const parts = bbox.split(",");
  const nums = parts.map((v) => (v.trim() === "" ? NaN : Number(v)));
  if (parts.length !== 4 || nums.some((n) => Number.isNaN(n))) {
    throw invalid("bbox must be minLng,minLat,maxLng,maxLat");
  }
  const [minx, miny, maxx, maxy] = nums;
  return sql`ST_MakeEnvelope(${minx}::float8, ${miny}::float8, ${maxx}::float8, ${maxy}::float8, 4326)`;
}

export const loads = (value: string | null | undefined): any => (value ? JSON.parse(value) : null);
