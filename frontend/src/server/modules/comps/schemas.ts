import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().date();

export const tenantCredit = z.enum(["investment_grade", "national", "regional", "local", "none"]);
export const verificationStatus = z.enum(["unverified", "verified", "disputed"]);
export const valuationMethod = z.enum(["direct_cap", "dcf", "sales_comparison", "land_residual", "appraisal", "bov"]);

export const verificationIn = z.object({
  status: verificationStatus.default("verified"),
  method: z.string().max(40).nullish(),
  notes: z.string().nullish(),
});
export type VerificationIn = z.infer<typeof verificationIn>;

// --------------------------------------------------------------------------- comps (shared)

const compCommon = {
  property_id: uuid.nullish(),
  name: z.string().max(200).nullish(),
  address_line: z.string().max(255).nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  county: z.string().nullish(),
  corridor: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  property_type: z.string().nullish(),
  tenant_name: z.string().nullish(),
  tenant_organization_id: uuid.nullish(),
  tenant_credit: tenantCredit.nullish(),
  building_area_sf: z.number().min(0).nullish(),
  land_area_acres: z.number().min(0).nullish(),
  year_built: z.number().int().min(1700).max(2100).nullish(),
  condition: z.string().nullish(),
  source: z.string().max(200).nullish(),
  document_id: uuid.nullish(),
  notes: z.string().nullish(),
};

const saleFields = {
  ...compCommon,
  sale_date: date.nullish(),
  sale_price: z.number().min(0).nullish(),
  price_psf: z.number().min(0).nullish(),
  price_per_acre: z.number().min(0).nullish(),
  cap_rate: z.number().min(0).max(100).nullish(),
  noi: z.number().nullish(),
  buyer_name: z.string().nullish(),
  buyer_organization_id: uuid.nullish(),
  seller_name: z.string().nullish(),
  seller_organization_id: uuid.nullish(),
  financing: z.string().nullish(),
  lease_term_remaining_years: z.number().min(0).nullish(),
  occupancy_pct: z.number().min(0).max(100).nullish(),
};

const leaseFields = {
  ...compCommon,
  space_id: uuid.nullish(),
  suite: z.string().nullish(),
  lease_type: z.string().nullish(),
  commencement_on: date.nullish(),
  term_months: z.number().int().min(0).max(1200).nullish(),
  area_sf: z.number().min(0).nullish(),
  base_rent_psf: z.number().min(0).nullish(),
  escalation_pct: z.number().nullish(),
  escalation_structure: z.string().nullish(),
  recovery_type: z.string().nullish(),
  recoveries_psf: z.number().min(0).nullish(),
  free_rent_months: z.number().min(0).nullish(),
  concessions: z.string().nullish(),
  ti_psf: z.number().min(0).nullish(),
  effective_rent_psf: z.number().nullish(),
};

export const saleCompCreate = z.object({
  ...saleFields,
  tags: z.array(z.string()).default([]),
  verification: verificationIn.nullish(),
});
export type SaleCompCreate = z.infer<typeof saleCompCreate>;

export const saleCompUpdate = z.object({ ...saleFields, tags: z.array(z.string()).nullish() }).strict();
export type SaleCompUpdate = z.infer<typeof saleCompUpdate>;

export const leaseCompCreate = z.object({
  ...leaseFields,
  tags: z.array(z.string()).default([]),
  verification: verificationIn.nullish(),
});
export type LeaseCompCreate = z.infer<typeof leaseCompCreate>;

export const leaseCompUpdate = z.object({ ...leaseFields, tags: z.array(z.string()).nullish() }).strict();
export type LeaseCompUpdate = z.infer<typeof leaseCompUpdate>;

// --------------------------------------------------------------------------- comp sets

export const compSetCreate = z.object({
  subject_property_id: uuid,
  name: z.string().min(1).max(200),
  kind: z.enum(["sale", "lease"]),
  purpose: z.enum(["valuation", "underwriting", "bov", "mark"]).nullable().default("valuation"),
  value_basis: z.string().nullish(),
  subject_quantity: z.number().nullish(),
  subject_quantity_source: z.string().nullish(),
  criteria: z.record(z.string(), z.any()).default({}),
  notes: z.string().nullish(),
  comp_ids: z.array(uuid).max(100).default([]),
});
export type CompSetCreate = z.infer<typeof compSetCreate>;

export const compSetUpdate = z
  .object({
    name: z.string().min(1).max(200).nullish(),
    purpose: z.enum(["valuation", "underwriting", "bov", "mark"]).nullish(),
    status: z.enum(["draft", "final"]).nullish(),
    value_basis: z.string().nullish(),
    subject_quantity: z.number().nullish(),
    subject_quantity_source: z.string().nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type CompSetUpdate = z.infer<typeof compSetUpdate>;

export const addItemsIn = z.object({ comp_ids: z.array(uuid).min(1).max(100) });
export type AddItemsIn = z.infer<typeof addItemsIn>;

export const itemUpdate = z
  .object({
    included: z.boolean().nullish(),
    exclusion_reason: z.string().max(2000).nullish(),
    adjustments: z.record(z.string(), z.number()).nullish(),
    adjustment_notes: z.record(z.string(), z.string()).nullish(),
    weight: z.number().min(0).max(100).nullish(),
  })
  .strict();
export type ItemUpdate = z.infer<typeof itemUpdate>;

export const gridRow = z.object({
  id: uuid,
  adjustments: z.record(z.string(), z.number()).default({}),
  adjustment_notes: z.record(z.string(), z.string()).default({}),
  weight: z.number().min(0).max(100).default(1.0),
});
export type GridRow = z.infer<typeof gridRow>;

export const gridIn = z.object({
  value_basis: z.string().nullish(),
  subject_quantity: z.number().nullish(),
  subject_quantity_source: z.string().nullish(),
  items: z.array(gridRow).max(200),
});
export type GridIn = z.infer<typeof gridIn>;

// --------------------------------------------------------------------------- valuations

export const sourcedValue = z.object({
  value: z.number().nullish(),
  source: z.string().max(300).nullish(),
  comp_ids: z.array(uuid).default([]),
  document_id: uuid.nullish(),
});
export type SourcedValue = z.infer<typeof sourcedValue>;

export const valuationCreate = z.object({
  property_id: uuid,
  method: valuationMethod,
  as_of: date,
  is_mark: z.boolean().default(false),
  analyst_id: uuid.nullish(),
  comp_set_id: uuid.nullish(),
  uw_model_id: uuid.nullish(),
  assumptions: z.record(z.string(), sourcedValue).default({}),
  value_low: z.number().min(0).nullish(),
  value_high: z.number().min(0).nullish(),
  value_point: z.number().min(0).nullish(),
  document_id: uuid.nullish(),
  third_party: z.string().max(200).nullish(),
  notes: z.string().nullish(),
});
export type ValuationCreate = z.infer<typeof valuationCreate>;

export const fromCompSetIn = z.object({
  as_of: date,
  is_mark: z.boolean().default(false),
  notes: z.string().nullish(),
});
export type FromCompSetIn = z.infer<typeof fromCompSetIn>;

export const valuationDocumentIn = z.object({
  property_id: uuid,
  document_id: uuid,
  kind: z.enum(["appraisal", "bov", "other"]).default("appraisal"),
  label: z.string().max(200).nullish(),
  prepared_by: z.string().max(200).nullish(),
  effective_date: date.nullish(),
  value_conclusion: z.number().min(0).nullish(),
  valuation_id: uuid.nullish(),
});
export type ValuationDocumentIn = z.infer<typeof valuationDocumentIn>;

// --------------------------------------------------------------------------- BOV

export const bovCreate = z.object({
  title: z.string().min(1).max(200),
  prepared_for: z.string().max(200).nullish(),
  narrative: z.string().nullish(),
  recommended_list_price: z.number().min(0).nullish(),
  valuation_id: uuid.nullish(),
});
export type BovCreate = z.infer<typeof bovCreate>;

export const bovUpdate = z
  .object({
    title: z.string().min(1).max(200).nullish(),
    prepared_for: z.string().nullish(),
    narrative: z.string().nullish(),
    recommended_list_price: z.number().min(0).nullish(),
    status: z.enum(["draft", "final", "delivered"]).nullish(),
    document_id: uuid.nullish(),
  })
  .strict();
export type BovUpdate = z.infer<typeof bovUpdate>;
