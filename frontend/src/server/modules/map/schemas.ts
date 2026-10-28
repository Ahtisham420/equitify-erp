import { z } from "zod";

import { OBSERVATION_CATEGORIES } from "./schema";

const uuid = () => z.string().uuid();
const ObservationCategory = z.enum(OBSERVATION_CATEGORIES);

// ----------------------------------------------------------------------------- selection

export const circle = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().gt(0).max(200_000),
});
export type Circle = z.infer<typeof circle>;

export const selectIn = z.object({
  polygon: z.record(z.any()).nullish(), // GeoJSON Polygon / Feature
  circle: circle.nullish(),
  property_ids: z.array(uuid()).max(2000).default([]),
  parcel_ids: z.array(uuid()).max(2000).default([]),
});
export type SelectIn = z.infer<typeof selectIn>;

// ----------------------------------------------------------------------------- bulk actions (preview -> apply)

const bulkTarget = {
  property_ids: z.array(uuid()).max(2000).default([]),
  parcel_ids: z.array(uuid()).max(2000).default([]),
  apply: z.boolean().default(false),
};
export interface BulkTarget {
  property_ids: string[];
  parcel_ids: string[];
  apply: boolean;
}

export const bulkOpportunitiesIn = z.object({
  ...bulkTarget,
  owner_id: uuid().nullish(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  source: z.string().max(80).default("map"),
  override_reason: z.string().max(2000).nullish(),
});
export type BulkOpportunitiesIn = z.infer<typeof bulkOpportunitiesIn>;

export const bulkTerritoryIn = z.object({ ...bulkTarget, territory_id: uuid() });
export type BulkTerritoryIn = z.infer<typeof bulkTerritoryIn>;

export const bulkSequenceIn = z.object({ ...bulkTarget, sequence_id: uuid(), owner_id: uuid().nullish() });
export type BulkSequenceIn = z.infer<typeof bulkSequenceIn>;

export const bulkExportIn = z.object({ ...bulkTarget });
export type BulkExportIn = z.infer<typeof bulkExportIn>;

export const saveTerritoryIn = z.object({
  name: z.string().min(1).max(160),
  description: z.string().nullish(),
  polygon: z.record(z.any()).nullish(),
  circle: circle.nullish(),
  visibility: z.enum(["private", "role", "company"]).default("private"),
});
export type SaveTerritoryIn = z.infer<typeof saveTerritoryIn>;

// ----------------------------------------------------------------------------- result shapes

export interface SkipItem {
  id: string;
  label: string | null;
  reason: string;
}

export interface BulkResult {
  action: string;
  applied: boolean;
  properties: number; // resolved properties in scope
  eligible: number; // would be (or were) acted on
  done: number;
  skipped: SkipItem[];
  warnings: string[];
  blocked: boolean;
  details: Record<string, any>;
}

export interface ExportOut extends BulkResult {
  filename: string | null;
  csv: string | null;
  masked: boolean;
}

// ----------------------------------------------------------------------------- field observations

export const observationIn = z.object({
  client_uuid: uuid(),
  property_id: uuid().nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).nullish(),
  observed_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Input should be a valid datetime")
    .transform((s) => new Date(s))
    .nullish(),
  category: ObservationCategory.default("general"),
  note: z.string().max(5000).nullish(),
  photo_document_ids: z.array(uuid()).max(20).default([]),
});
export type ObservationIn = z.infer<typeof observationIn>;
