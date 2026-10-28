import { z } from "zod";

// Response (Out) shapes are built by plain mappers in service.ts / quality.ts; only request bodies are validated here.

const cadence = z.enum(["one_time", "daily", "weekly", "monthly", "quarterly", "annual", "ad_hoc"]);

// --- Data sources ---------------------------------------------------------------------------------

export const dataSourceIn = z.object({
  provider: z.string().min(1).max(200),
  description: z.string().nullish(),
  license_terms: z.string().nullish(),
  permitted_use: z.string().nullish(),
  redistribution_allowed: z.boolean().default(false),
  cadence: cadence.default("ad_hoc"),
  cost: z.number().min(0).nullish(),
  cost_notes: z.string().max(200).nullish(),
  contact_name: z.string().max(200).nullish(),
  contact_email: z.string().max(255).nullish(),
  contact_phone: z.string().max(40).nullish(),
  renewal_date: z.string().date().nullish(),
  is_active: z.boolean().default(true),
});
export type DataSourceIn = z.infer<typeof dataSourceIn>;

/** Partial update; unknown keys rejected (pydantic `extra="forbid"`). */
export const dataSourceUpdate = z
  .object({
    provider: z.string().min(1).max(200).nullish(),
    description: z.string().nullish(),
    license_terms: z.string().nullish(),
    permitted_use: z.string().nullish(),
    redistribution_allowed: z.boolean().nullish(),
    cadence: cadence.nullish(),
    cost: z.number().min(0).nullish(),
    cost_notes: z.string().max(200).nullish(),
    contact_name: z.string().max(200).nullish(),
    contact_email: z.string().max(255).nullish(),
    contact_phone: z.string().max(40).nullish(),
    renewal_date: z.string().date().nullish(),
    is_active: z.boolean().nullish(),
  })
  .strict();
export type DataSourceUpdate = z.infer<typeof dataSourceUpdate>;

// --- Import jobs ----------------------------------------------------------------------------------

export const mappingIn = z.object({ column_mapping: z.record(z.string(), z.string().nullable()) });
export type MappingIn = z.infer<typeof mappingIn>;

export const commitIn = z.object({ on_duplicate: z.enum(["skip", "update"]).default("skip") });
export type CommitIn = z.infer<typeof commitIn>;

// --- Data quality ---------------------------------------------------------------------------------

export const thresholdsIn = z.object({ thresholds: z.record(z.string(), z.number().int().nullable()) });
export type ThresholdsIn = z.infer<typeof thresholdsIn>;

export interface TargetField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  group: string;
}
