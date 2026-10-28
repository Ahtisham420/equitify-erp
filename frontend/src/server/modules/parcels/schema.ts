import { boolean, date, index, integer, jsonb, pgTable, text, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { geometry, numericFloat, pk, tz } from "../../db/columns";
import { entity, fk } from "../../db/entity";
import { users } from "../auth/schema";
import { properties } from "../properties/schema";

export const PARCEL_RELATIONSHIPS = ["primary", "assemblage", "excess_land", "outparcel", "other"] as const;
export const OCCUPANCY_STATES = ["vacant", "occupied", "pending", "owner_occupied", "unavailable"] as const;
export const SPACE_USE_TYPES = [
  "retail", "restaurant", "office", "medical", "industrial", "flex", "storage", "residential", "other",
] as const;

// Material facts that keep sourced history (field_observations).
export const PARCEL_MATERIAL = new Set(["apn", "legal_description", "acreage"]);
export const BUILDING_MATERIAL = new Set(["building_area_sf", "year_built", "floors"]);
export const SPACE_MATERIAL = new Set(["area_sf", "occupancy_status", "tenant_name"]);

export const parcels = pgTable(
  "parcels",
  {
    ...entity(),
    county: varchar("county", { length: 120 }).notNull(),
    state: varchar("state", { length: 40 }),
    apn: varchar("apn", { length: 80 }).notNull(), // as observed
    apn_normalized: varchar("apn_normalized", { length: 80 }).notNull(),
    situs_address: varchar("situs_address", { length: 255 }),
    legal_description: text("legal_description"),
    acreage: numericFloat("acreage", 12, 4),
    // Deferred in SQLAlchemy: never selected unless asked for (see service.ts `parcelCols`).
    geometry: geometry("geometry", "MULTIPOLYGON", 4326),
    centroid: geometry("centroid", "POINT", 4326),
    has_geometry: boolean("has_geometry").notNull().$defaultFn(() => false),
    centroid_lat: numericFloat("centroid_lat", 10, 7),
    centroid_lng: numericFloat("centroid_lng", 10, 7),
    facts: jsonb("facts").$type<Record<string, any>>().notNull().$defaultFn(() => ({})), // zoning, land use code, assessed value...
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_parcels_deleted_at").on(t.deleted_at),
    index("ix_parcels_county").on(t.county),
    index("ix_parcels_state").on(t.state),
    index("ix_parcels_apn_normalized").on(t.apn_normalized),
    index("ix_parcels_has_geometry").on(t.has_geometry),
    index("idx_parcels_geometry").using("gist", t.geometry),
    index("idx_parcels_centroid").using("gist", t.centroid),
  ],
);
export type Parcel = typeof parcels.$inferSelect;

/** Snapshot of legal description + geometry each time the source data changes. */
export const parcelVersions = pgTable(
  "parcel_versions",
  {
    id: pk(),
    parcel_id: fk("parcel_id", () => parcels.id, { notNull: true, onDelete: "cascade" }),
    version: integer("version").notNull(),
    legal_description: text("legal_description"),
    geometry: geometry("geometry", "MULTIPOLYGON", 4326),
    acreage: numericFloat("acreage", 12, 4),
    changed_fields: jsonb("changed_fields").$type<string[]>().notNull().$defaultFn(() => []),
    source: varchar("source", { length: 200 }),
    observed_on: date("observed_on", { mode: "string" }),
    recorded_at: tz("recorded_at").notNull().$defaultFn(() => new Date()),
    recorded_by_id: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("ix_parcel_versions_parcel_id").on(t.parcel_id)],
);
export type ParcelVersion = typeof parcelVersions.$inferSelect;

export const propertyParcels = pgTable(
  "property_parcels",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "cascade" }),
    parcel_id: fk("parcel_id", () => parcels.id, { notNull: true, onDelete: "cascade" }),
    relationship: varchar("relationship", { length: 30 }).notNull().$defaultFn(() => "primary"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_property_parcels_deleted_at").on(t.deleted_at),
    index("ix_property_parcels_property_id").on(t.property_id),
    index("ix_property_parcels_parcel_id").on(t.parcel_id),
    unique("uq_property_parcels_pair").on(t.property_id, t.parcel_id),
  ],
);
export type PropertyParcel = typeof propertyParcels.$inferSelect;

export const buildings = pgTable(
  "buildings",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "cascade" }),
    parcel_id: fk("parcel_id", () => parcels.id),
    name: varchar("name", { length: 160 }).notNull(),
    building_area_sf: numericFloat("building_area_sf", 14, 2),
    year_built: integer("year_built"),
    floors: integer("floors"),
    construction_class: varchar("construction_class", { length: 20 }),
    use_type: varchar("use_type", { length: 60 }),
    notes: text("notes"),
  },
  (t) => [
    index("ix_buildings_deleted_at").on(t.deleted_at),
    index("ix_buildings_property_id").on(t.property_id),
    index("ix_buildings_parcel_id").on(t.parcel_id),
  ],
);
export type Building = typeof buildings.$inferSelect;

export const spaces = pgTable(
  "spaces",
  {
    ...entity(),
    property_id: fk("property_id", () => properties.id, { notNull: true, onDelete: "cascade" }),
    building_id: fk("building_id", () => buildings.id),
    suite: varchar("suite", { length: 60 }).notNull(),
    area_sf: numericFloat("area_sf", 14, 2),
    floor: varchar("floor", { length: 20 }),
    location_note: varchar("location_note", { length: 200 }),
    use_type: varchar("use_type", { length: 60 }),
    occupancy_status: varchar("occupancy_status", { length: 20 }).notNull().$defaultFn(() => "vacant"),
    tenant_name: varchar("tenant_name", { length: 200 }),
    // Plain UUID references: organizations (contacts module) and leases (later release) are owned elsewhere.
    tenant_organization_id: uuid("tenant_organization_id"),
    lease_id: uuid("lease_id"),
    notes: text("notes"),
  },
  (t) => [
    index("ix_spaces_deleted_at").on(t.deleted_at),
    index("ix_spaces_property_id").on(t.property_id),
    index("ix_spaces_building_id").on(t.building_id),
    index("ix_spaces_occupancy_status").on(t.occupancy_status),
    index("ix_spaces_tenant_organization_id").on(t.tenant_organization_id),
    index("ix_spaces_lease_id").on(t.lease_id),
  ],
);
export type Space = typeof spaces.$inferSelect;
