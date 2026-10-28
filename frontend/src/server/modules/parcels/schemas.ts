import { z } from "zod";

import { provenanceIn } from "../../common/provenance";
import { propertyCreate } from "../properties/schemas";

const relationship = z.enum(["primary", "assemblage", "excess_land", "outparcel", "other"]);
const occupancy = z.enum(["vacant", "occupied", "pending", "owner_occupied", "unavailable"]);
const uuid = z.string().uuid();
const geojson = z.record(z.any());

// ----------------------------------------------------------------------------- parcels

const parcelBase = {
  county: z.string().min(1).max(120),
  state: z.string().max(40).nullish(),
  apn: z.string().min(1).max(80),
  situs_address: z.string().max(255).nullish(),
  legal_description: z.string().nullish(),
  acreage: z.number().min(0).nullish(),
  facts: z.record(z.any()).default({}),
  source: z.string().max(200).nullish(),
  observed_on: z.string().date().nullish(),
  notes: z.string().nullish(),
};

export const parcelCreate = z.object({
  ...parcelBase,
  /** GeoJSON Polygon/MultiPolygon, Feature or FeatureCollection */
  geometry: geojson.nullish(),
  provenance: provenanceIn.default({}),
});
export type ParcelCreate = z.infer<typeof parcelCreate>;

/** Partial update. Unknown keys are rejected (pydantic `extra="forbid"`); only provided keys are applied. */
export const parcelUpdate = z
  .object({
    county: z.string().min(1).max(120).nullish(),
    state: z.string().nullish(),
    apn: z.string().min(1).max(80).nullish(),
    situs_address: z.string().nullish(),
    legal_description: z.string().nullish(),
    acreage: z.number().min(0).nullish(),
    facts: z.record(z.any()).nullish(),
    source: z.string().nullish(),
    observed_on: z.string().date().nullish(),
    notes: z.string().nullish(),
    geometry: geojson.nullish(),
    clear_geometry: z.boolean().default(false),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type ParcelUpdate = z.infer<typeof parcelUpdate>;

export const parcelMergeIn = z.object({ into_id: uuid });
export type ParcelMergeIn = z.infer<typeof parcelMergeIn>;

export const bulkAssociateIn = z.object({
  parcel_ids: z.array(uuid).min(1).max(500),
  property_id: uuid.nullish(),
  new_property: propertyCreate.nullish(),
  relationship: relationship.nullish(), // null = first parcel primary, rest assemblage
  preview: z.boolean().default(true),
});
export type BulkAssociateIn = z.infer<typeof bulkAssociateIn>;

// ----------------------------------------------------------------------------- property links

export const propertyParcelIn = z.object({
  parcel_id: uuid,
  relationship: relationship.default("primary"),
  notes: z.string().nullish(),
});
export type PropertyParcelIn = z.infer<typeof propertyParcelIn>;

export const propertyParcelUpdate = z.object({
  relationship: relationship.nullish(),
  notes: z.string().nullish(),
});
export type PropertyParcelUpdate = z.infer<typeof propertyParcelUpdate>;

// ----------------------------------------------------------------------------- buildings / spaces

export const buildingIn = z.object({
  name: z.string().min(1).max(160),
  parcel_id: uuid.nullish(),
  building_area_sf: z.number().min(0).nullish(),
  year_built: z.number().int().min(1700).max(2100).nullish(),
  floors: z.number().int().min(0).max(300).nullish(),
  construction_class: z.string().max(20).nullish(),
  use_type: z.string().max(60).nullish(),
  notes: z.string().nullish(),
  provenance: provenanceIn.default({}),
});
export type BuildingIn = z.infer<typeof buildingIn>;

export const buildingUpdate = z
  .object({
    name: z.string().min(1).max(160).nullish(),
    parcel_id: uuid.nullish(),
    building_area_sf: z.number().min(0).nullish(),
    year_built: z.number().int().min(1700).max(2100).nullish(),
    floors: z.number().int().min(0).max(300).nullish(),
    construction_class: z.string().nullish(),
    use_type: z.string().nullish(),
    notes: z.string().nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type BuildingUpdate = z.infer<typeof buildingUpdate>;

export const spaceIn = z.object({
  suite: z.string().min(1).max(60),
  building_id: uuid.nullish(),
  area_sf: z.number().min(0).nullish(),
  floor: z.string().max(20).nullish(),
  location_note: z.string().max(200).nullish(),
  use_type: z.string().max(60).nullish(),
  occupancy_status: occupancy.default("vacant"),
  tenant_name: z.string().max(200).nullish(),
  tenant_organization_id: uuid.nullish(),
  lease_id: uuid.nullish(),
  notes: z.string().nullish(),
  provenance: provenanceIn.default({}),
});
export type SpaceIn = z.infer<typeof spaceIn>;

export const spaceUpdate = z
  .object({
    suite: z.string().min(1).max(60).nullish(),
    building_id: uuid.nullish(),
    area_sf: z.number().min(0).nullish(),
    floor: z.string().nullish(),
    location_note: z.string().nullish(),
    use_type: z.string().nullish(),
    occupancy_status: occupancy.nullish(),
    tenant_name: z.string().nullish(),
    tenant_organization_id: uuid.nullish(),
    lease_id: uuid.nullish(),
    notes: z.string().nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type SpaceUpdate = z.infer<typeof spaceUpdate>;
