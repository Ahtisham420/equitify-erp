import { z } from "zod";

import { provenanceIn } from "../../common/provenance";

const status = z.enum(["tracked", "pursued", "rejected", "owned", "managed", "listed", "sold"]);

const base = {
  name: z.string().max(200).nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  postal_code: z.string().nullish(),
  county: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  property_type: z.string(),
  property_subtype: z.string().nullish(),
  building_area_sf: z.number().min(0).nullish(),
  land_area_acres: z.number().min(0).nullish(),
  year_built: z.number().int().min(1700).max(2100).nullish(),
  year_renovated: z.number().int().min(1700).max(2100).nullish(),
  parking_spaces: z.number().int().min(0).nullish(),
  construction_class: z.string().nullish(),
  asking_price: z.number().min(0).nullish(),
  last_sale_price: z.number().min(0).nullish(),
  last_sale_date: z.string().date().nullish(),
  occupancy_pct: z.number().min(0).max(100).nullish(),
  wale_years: z.number().min(0).nullish(),
  noi: z.number().nullish(),
  zoning: z.string().nullish(),
  future_land_use: z.string().nullish(),
  flood_zone: z.string().nullish(),
  traffic_count: z.number().int().min(0).nullish(),
  corridor: z.string().nullish(),
  notes: z.string().nullish(),
};

export const propertyCreate = z.object({
  ...base,
  property_type: base.property_type.default("other"),
  address_line: z.string().min(1).max(255),
  alternate_addresses: z.array(z.string()).default([]),
  status: status.default("tracked"),
  tags: z.array(z.string()).default([]),
  provenance: provenanceIn.default({}),
});
export type PropertyCreate = z.infer<typeof propertyCreate>;

/** Partial update. Unknown keys are rejected (pydantic `extra="forbid"`); only provided keys are applied. */
export const propertyUpdate = z
  .object({
    ...base,
    property_type: base.property_type.nullish(),
    address_line: z.string().min(1).max(255).nullish(),
    alternate_addresses: z.array(z.string()).nullish(),
    status: status.nullish(),
    tags: z.array(z.string()).nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type PropertyUpdate = z.infer<typeof propertyUpdate>;

export const verifyIn = z.object({ state: z.enum(["verified", "rejected"]) });

export const bulkIn = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: status.nullish(),
  add_tags: z.array(z.string()).default([]),
  remove_tags: z.array(z.string()).default([]),
});
export type BulkIn = z.infer<typeof bulkIn>;
