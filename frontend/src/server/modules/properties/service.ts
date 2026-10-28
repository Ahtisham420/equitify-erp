import { and, arrayOverlaps, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import * as audit from "../../common/audit";
import { normalizeAddress } from "../../common/normalize";
import * as provenance from "../../common/provenance";
import { applySearch, inFilter, rangeFilter } from "../../common/query";
import type { CurrentUser } from "../../core/deps";
import * as events from "../../core/events";
import { HttpError } from "../../core/http";
import type { Db } from "../../db";
import { get, insert, patch } from "../../db/orm";
import { MATERIAL_FIELDS, properties, type Property } from "./schema";
import type { BulkIn, PropertyCreate, PropertyUpdate } from "./schemas";

export const ENTITY = "property";

const BASE_REQUIRED = ["address_line", "city", "state", "county", "latitude", "longitude", "year_built", "zoning"];
const TYPE_REQUIRED: Record<string, string[]> = {
  stnl: ["building_area_sf", "land_area_acres", "asking_price", "noi", "wale_years", "occupancy_pct"],
  multi_tenant_retail: ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "wale_years", "parking_spaces"],
  retail: ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "parking_spaces"],
  gas_convenience: ["building_area_sf", "land_area_acres", "traffic_count", "noi", "wale_years"],
  medical: ["building_area_sf", "occupancy_pct", "noi", "wale_years", "parking_spaces"],
  office: ["building_area_sf", "occupancy_pct", "noi", "parking_spaces", "construction_class"],
  industrial: ["building_area_sf", "land_area_acres", "occupancy_pct", "noi", "construction_class"],
  ground_lease: ["land_area_acres", "noi", "wale_years"],
  land: ["land_area_acres", "future_land_use", "flood_zone", "traffic_count", "corridor"],
};

const required = (p: Pick<Property, "property_type">) =>
  BASE_REQUIRED.concat(TYPE_REQUIRED[p.property_type] ?? ["building_area_sf", "land_area_acres"]);

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function missingFields(p: Property): string[] {
  return required(p).filter((f) => isEmpty((p as Record<string, any>)[f]));
}

export function completeness(p: Property): number {
  const req = required(p);
  return Math.round((1000 * (req.length - missingFields(p).length)) / req.length) / 10;
}

/** SQL expression for the geometry column value (or null when coordinates are missing). */
function locationValue(lat: number | null | undefined, lng: number | null | undefined) {
  return (lat !== null && lat !== undefined && lng !== null && lng !== undefined
    ? sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
    : null) as unknown as string | null;
}

export interface PropertyFilters {
  q?: string;
  status?: string[];
  property_type?: string[];
  state?: string[];
  county?: string;
  city?: string;
  tag?: string[];
  min_area?: number;
  max_area?: number;
  min_acres?: number;
  max_acres?: number;
  min_price?: number;
  max_price?: number;
  min_year?: number;
  max_year?: number;
  min_completeness?: number;
  near_lat?: number;
  near_lng?: number;
  radius_miles?: number;
  ids?: string[];
}

/** WHERE clause for the filters; `skip` leaves a facet's own filter out (for facet counts). */
export function buildWhere(f: PropertyFilters, skip: Set<string> = new Set()): SQL | undefined {
  const t = properties;
  return and(
    isNull(t.deleted_at),
    applySearch(f.q, [t.name, t.address_line, t.city, t.county, t.normalized_address, t.corridor]),
    skip.has("status") ? undefined : inFilter(t.status, f.status),
    skip.has("property_type") ? undefined : inFilter(t.property_type, f.property_type),
    skip.has("state") ? undefined : inFilter(t.state, f.state),
    inFilter(t.id, f.ids),
    f.county ? sql`${t.county} ilike ${`%${f.county}%`}` : undefined,
    f.city ? sql`${t.city} ilike ${`%${f.city}%`}` : undefined,
    f.tag?.length ? arrayOverlaps(t.tags, f.tag) : undefined,
    rangeFilter(t.building_area_sf, f.min_area, f.max_area),
    rangeFilter(t.land_area_acres, f.min_acres, f.max_acres),
    rangeFilter(t.asking_price, f.min_price, f.max_price),
    rangeFilter(t.year_built, f.min_year, f.max_year),
    rangeFilter(t.completeness_score, f.min_completeness, null),
    f.near_lat !== undefined && f.near_lng !== undefined && f.radius_miles
      ? sql`ST_DWithin(${t.location}::geography, ST_SetSRID(ST_MakePoint(${f.near_lng}, ${f.near_lat}), 4326)::geography, ${f.radius_miles * 1609.344})`
      : undefined,
  );
}

export async function getProperty(db: Db, id: string): Promise<Property> {
  const p = await get(db, properties, id);
  if (!p || p.deleted_at) throw new HttpError(404, "Property not found");
  return p;
}

/** Row without the opaque geometry column. */
export function plain(p: Property) {
  const { location: _location, ...rest } = p;
  return rest;
}

export async function toOut(db: Db, p: Property) {
  const obs = await provenance.currentObservations(db, ENTITY, p.id);
  return { ...plain(p), missing_fields: missingFields(p), provenance: obs };
}

export async function findDuplicates(db: Db, normalized: string, exclude?: string): Promise<Property[]> {
  return db
    .select()
    .from(properties)
    .where(
      and(
        isNull(properties.deleted_at),
        or(eq(properties.normalized_address, normalized), sql`${properties.alternate_addresses} @> ${JSON.stringify([normalized])}::jsonb`),
        exclude ? sql`${properties.id} <> ${exclude}` : undefined,
      ),
    )
    .limit(5);
}

export async function create(db: Db, data: PropertyCreate, actor: CurrentUser, force = false): Promise<Property> {
  const normalized = normalizeAddress(data.address_line, data.city, data.state, data.postal_code);
  const dupes = await findDuplicates(db, normalized);
  if (dupes.length && !force) {
    throw new HttpError(409, {
      message: "A property with this address already exists",
      duplicates: dupes.map((d) => ({ id: d.id, address_line: d.address_line, city: d.city, status: d.status })),
    });
  }

  const { provenance: prov, ...values } = data;
  const draft = {
    ...values,
    alternate_addresses: values.alternate_addresses.map((a) => normalizeAddress(a)),
    normalized_address: normalized,
    created_by_id: actor.id,
    updated_by_id: actor.id,
  };
  let p = await insert(db, properties, {
    ...draft,
    location: locationValue(data.latitude, data.longitude),
  } as never);
  p = await patch(db, properties, p, { completeness_score: completeness(p) });

  for (const field of MATERIAL_FIELDS) {
    const value = (p as Record<string, any>)[field];
    if (value !== null && value !== undefined) {
      await provenance.observe(db, { entity_type: ENTITY, entity_id: p.id, field, value, prov, actor_id: actor.id });
    }
  }

  await audit.record(db, {
    actor, action: "property.created", entity_type: ENTITY, entity_id: p.id, summary: p.name || p.address_line, ip_address: actor.ip_address,
  });
  await events.emit(db, "property.created", { property_id: p.id, actor });
  await db.commit();
  return p;
}

export async function update(db: Db, p: Property, data: PropertyUpdate, actor: CurrentUser): Promise<Property> {
  const { provenance: prov, ...rest } = data;
  const values: Record<string, any> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (Array.isArray(values.alternate_addresses)) {
    values.alternate_addresses = values.alternate_addresses.map((a: string) => normalizeAddress(a));
  }

  // `p` is mutated in memory by applyMaterial; persisted below with one UPDATE.
  const changes = await provenance.applyMaterial(db, p, {
    entity_type: ENTITY, data: values, material_fields: MATERIAL_FIELDS, prov, actor_id: actor.id,
  });
  if (!Object.keys(changes).length) return p;

  const set: Record<string, any> = Object.fromEntries(Object.keys(changes).map((k) => [k, (p as Record<string, any>)[k]]));
  if (["address_line", "city", "state", "postal_code"].some((k) => k in changes)) {
    p.normalized_address = normalizeAddress(p.address_line, p.city, p.state, p.postal_code);
    set.normalized_address = p.normalized_address;
  }
  if ("latitude" in changes || "longitude" in changes) set.location = locationValue(p.latitude, p.longitude);
  p.completeness_score = completeness(p);
  set.completeness_score = p.completeness_score;
  set.updated_by_id = actor.id;
  await patch(db, properties, p, set as never);

  await audit.record(db, {
    actor, action: "property.updated", entity_type: ENTITY, entity_id: p.id, changes, ip_address: actor.ip_address,
  });
  await events.emit(db, "property.updated", { property_id: p.id, changed: new Set(Object.keys(changes)), actor });
  await db.commit();
  return p;
}

/** Soft delete only — property records persist for history and reactivation. */
export async function archive(db: Db, p: Property, actor: CurrentUser): Promise<void> {
  await patch(db, properties, p, { deleted_at: new Date(), updated_by_id: actor.id });
  await audit.record(db, {
    actor, action: "property.archived", entity_type: ENTITY, entity_id: p.id, summary: p.name || p.address_line, ip_address: actor.ip_address,
  });
  await db.commit();
}

export async function bulkUpdate(db: Db, data: BulkIn, actor: CurrentUser): Promise<number> {
  const rows = await db
    .select()
    .from(properties)
    .where(and(inArray(properties.id, data.ids), isNull(properties.deleted_at)));
  for (const p of rows) {
    const changes: Record<string, any> = {};
    const set: Record<string, any> = {};
    if (data.status && p.status !== data.status) {
      changes.status = { from: p.status, to: data.status };
      set.status = data.status;
    }
    if (data.add_tags.length || data.remove_tags.length) {
      const tags = (p.tags ?? []).filter((t) => !data.remove_tags.includes(t));
      for (const t of data.add_tags) if (!tags.includes(t)) tags.push(t);
      if (JSON.stringify(tags) !== JSON.stringify(p.tags)) {
        changes.tags = { from: p.tags, to: tags };
        set.tags = tags;
      }
    }
    if (Object.keys(changes).length) {
      await patch(db, properties, p, { ...set, updated_by_id: actor.id });
      await audit.record(db, {
        actor, action: "property.bulk_updated", entity_type: ENTITY, entity_id: p.id, changes, ip_address: actor.ip_address,
      });
    }
  }
  await db.commit();
  return rows.length;
}

export async function verifyObservation(db: Db, obsId: string, state: "verified" | "rejected", actor: CurrentUser) {
  const obs = await provenance.setVerification(db, obsId, state, actor.id);
  if (!obs || obs.entity_type !== ENTITY) throw new HttpError(404, "Observation not found");
  await audit.record(db, {
    actor, action: `property.field_${state}`, entity_type: ENTITY, entity_id: obs.entity_id, summary: obs.field, ip_address: actor.ip_address,
  });
  await events.emit(db, "property.updated", { property_id: obs.entity_id, changed: new Set([obs.field]), actor });
  await db.commit();
  return obs;
}
