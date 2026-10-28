import { z, type ZodDefault, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";

import { provenanceIn } from "../../common/provenance";

const uuid = () => z.string().uuid();
const date = () => z.string().date();

export const leaseStatus = z.enum(["draft", "active", "expired", "terminated"]);

/** Drop `.default()` from every field so that only keys the client sent survive (pydantic `exclude_unset`). */
export function unsetDefaults<S extends ZodObject<ZodRawShape>>(schema: S): ZodObject<ZodRawShape> {
  const shape: ZodRawShape = {};
  for (const [k, v] of Object.entries(schema.shape as ZodRawShape)) {
    shape[k] = v instanceof Object && (v as ZodTypeAny)._def.typeName === "ZodDefault"
      ? (v as ZodDefault<ZodTypeAny>).removeDefault().optional()
      : v;
  }
  return z.object(shape);
}

export const citationIn = z.object({
  document_id: uuid().nullish(),
  page: z.number().int().min(1).nullish(),
  clause_ref: z.string().max(80).nullish(),
  quoted_text: z.string().nullish(),
});
export type CitationIn = z.infer<typeof citationIn>;
const citationShape = citationIn.shape;

// --------------------------------------------------------------------------- lease

const leaseBaseShape = {
  property_id: uuid(),
  space_id: uuid().nullish(),
  asset_id: uuid().nullish(),
  document_id: uuid().nullish(),
  tenant_organization_id: uuid().nullish(),
  tenant_name: z.string().min(1).max(200),
  landlord_name: z.string().nullish(),
  premises_description: z.string().nullish(),
  status: leaseStatus.default("draft"),
  lease_type: z.string().default("nnn"),
  execution_on: date().nullish(),
  commencement_on: date().nullish(),
  rent_commencement_on: date().nullish(),
  expiration_on: date().nullish(),
  rentable_sf: z.number().min(0).nullish(),
  pro_rata_share: z.number().min(0).max(100).nullish(),
  base_rent_annual: z.number().min(0).nullish(),
  security_deposit: z.number().min(0).nullish(),
  late_fee_grace_days: z.number().int().min(0).max(90).nullish(),
  late_fee_pct: z.number().min(0).max(100).nullish(),
  late_fee_flat: z.number().min(0).nullish(),
  market_rent_psf: z.number().min(0).nullish(),
  renewal_probability: z.number().min(0).max(1).nullish(),
  downtime_months: z.number().int().min(0).max(60).nullish(),
  releasing_cost_psf: z.number().min(0).nullish(),
  citations: z.record(z.string(), citationIn).default({}),
  manager_id: uuid().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
};

export const leaseCreate = z.object({ ...leaseBaseShape, provenance: provenanceIn.default({}) });
export type LeaseCreate = z.infer<typeof leaseCreate>;

/** Partial update. Unknown keys are rejected (pydantic `extra="forbid"`); only provided keys are applied. */
export const leaseUpdate = z
  .object({
    space_id: leaseBaseShape.space_id,
    asset_id: leaseBaseShape.asset_id,
    document_id: leaseBaseShape.document_id,
    tenant_organization_id: leaseBaseShape.tenant_organization_id,
    tenant_name: z.string().min(1).max(200).nullish(),
    landlord_name: leaseBaseShape.landlord_name,
    premises_description: leaseBaseShape.premises_description,
    status: leaseStatus.nullish(),
    lease_type: z.string().nullish(),
    execution_on: leaseBaseShape.execution_on,
    commencement_on: leaseBaseShape.commencement_on,
    rent_commencement_on: leaseBaseShape.rent_commencement_on,
    expiration_on: leaseBaseShape.expiration_on,
    rentable_sf: leaseBaseShape.rentable_sf,
    pro_rata_share: leaseBaseShape.pro_rata_share,
    base_rent_annual: leaseBaseShape.base_rent_annual,
    security_deposit: leaseBaseShape.security_deposit,
    late_fee_grace_days: leaseBaseShape.late_fee_grace_days,
    late_fee_pct: leaseBaseShape.late_fee_pct,
    late_fee_flat: leaseBaseShape.late_fee_flat,
    market_rent_psf: leaseBaseShape.market_rent_psf,
    renewal_probability: leaseBaseShape.renewal_probability,
    downtime_months: leaseBaseShape.downtime_months,
    releasing_cost_psf: leaseBaseShape.releasing_cost_psf,
    citations: z.record(z.string(), citationIn).nullish(),
    manager_id: leaseBaseShape.manager_id,
    notes: leaseBaseShape.notes,
    tags: z.array(z.string()).nullish(),
    provenance: provenanceIn.default({}),
  })
  .strict();
export type LeaseUpdate = z.infer<typeof leaseUpdate>;

// --------------------------------------------------------------------------- rent schedule

export const rentStepIn = z.object({
  ...citationShape,
  start_on: date(),
  end_on: date(),
  annual_rent: z.number().min(0),
  rent_psf: z.number().nullish(),
  charge_type: z.string().default("base_rent"),
  amendment_id: uuid().nullish(),
  note: z.string().nullish(),
});
export type RentStepIn = z.infer<typeof rentStepIn>;

export const stepTableRow = z.object({
  start_on: date(),
  end_on: date().nullish(),
  annual_rent: z.number().min(0).nullish(),
  rent_psf: z.number().min(0).nullish(),
});
export type StepTableRow = z.infer<typeof stepTableRow>;

/** Escalation mechanics stored on the lease and used to build rent steps. */
export const escalationIn = z.object({
  method: z.enum(["flat", "fixed_pct", "fixed_amount", "cpi", "step_table"]).default("fixed_pct"),
  base_annual_rent: z.number().min(0).nullish(),
  base_rent_psf: z.number().min(0).nullish(),
  start_on: date().nullish(),
  end_on: date().nullish(),
  frequency_months: z.number().int().min(1).max(120).default(12),
  pct: z.number().min(-50).max(100).nullish(), // fixed_pct
  amount: z.number().nullish(), // fixed_amount: annual $ increase per period
  cpi_assumed_pct: z.number().min(-20).max(50).nullish(),
  cpi_floor_pct: z.number().min(-20).max(50).nullish(),
  cpi_cap_pct: z.number().min(-20).max(50).nullish(),
  free_rent_months: z.number().int().min(0).max(60).default(0),
  steps: z.array(stepTableRow).default([]),
  replace: z.boolean().default(true),
});
export type EscalationIn = z.infer<typeof escalationIn>;

// --------------------------------------------------------------------------- recoveries / options / clauses

const verifyShape = {
  ai_extracted: z.boolean().default(false),
  confidence: z.number().min(0).max(1).nullish(),
};

export const recoveryIn = z.object({
  ...citationShape,
  method: z.enum(["nnn", "modified_gross", "base_year", "expense_stop", "fixed_cam"]).default("nnn"),
  category: z.enum(["all", "cam", "tax", "insurance", "utilities"]).default("all"),
  pro_rata_share: z.number().min(0).max(100).nullish(),
  base_year: z.number().int().nullish(),
  base_amount: z.number().min(0).nullish(),
  expense_stop_psf: z.number().min(0).nullish(),
  fixed_amount_annual: z.number().min(0).nullish(),
  estimated_monthly: z.number().min(0).nullish(),
  cap_type: z.enum(["none", "cumulative", "non_cumulative"]).default("none"),
  cap_pct: z.number().min(0).max(100).nullish(),
  cap_base_amount: z.number().min(0).nullish(),
  cap_base_year: z.number().int().nullish(),
  admin_fee_pct: z.number().min(0).max(100).nullish(),
  gross_up_pct: z.number().min(0).max(100).nullish(),
  exclusions: z.array(z.string()).default([]),
  notes: z.string().nullish(),
  ...verifyShape,
});
export type RecoveryIn = z.infer<typeof recoveryIn>;

export const optionIn = z.object({
  ...citationShape,
  option_type: z.enum(["renewal", "expansion", "termination", "purchase", "rofr", "rofo"]),
  sequence: z.number().int().min(1).default(1),
  term_months: z.number().int().min(0).nullish(),
  notice_start_on: date().nullish(),
  notice_end_on: date().nullish(),
  effective_on: date().nullish(),
  pricing_method: z
    .enum(["fixed_rent", "fixed_increase", "fmv", "pct_of_fmv", "fixed_price", "fee", "matching", "none"])
    .default("none"),
  pricing_params: z.record(z.string(), z.any()).default({}),
  option_rent_psf: z.number().min(0).nullish(),
  increase_pct: z.number().nullish(),
  fmv_pct: z.number().min(0).max(200).nullish(),
  fee_amount: z.number().min(0).nullish(),
  purchase_price: z.number().min(0).nullish(),
  market_rent_psf: z.number().min(0).nullish(),
  space_description: z.string().nullish(),
  conditions: z.string().nullish(),
  status: z.enum(["open", "exercised", "waived", "expired"]).default("open"),
  exercised_on: date().nullish(),
  ...verifyShape,
});
export type OptionIn = z.infer<typeof optionIn>;

export interface OptionEconomics {
  current_rent_psf: number | null;
  option_rent_psf: number | null;
  market_rent_psf: number | null;
  delta_psf: number | null;
  annual_delta: number | null;
  term_value: number | null;
  favors: "tenant" | "landlord" | "neutral" | null;
  remaining_rent: number | null;
  fee_amount: number | null;
  purchase_price: number | null;
  market_value: number | null;
  note: string | null;
}

export const clauseIn = z.object({
  ...citationShape,
  category: z.string().min(1).max(30),
  title: z.string().min(1).max(200),
  summary: z.string().nullish(),
  terms: z.record(z.string(), z.any()).default({}),
  obligated_party: z.enum(["landlord", "tenant", "guarantor"]).nullish(),
  due_on: date().nullish(),
  recurrence: z.enum(["once", "monthly", "quarterly", "annual"]).nullish(),
  response_days: z.number().int().min(0).nullish(),
  amendment_id: uuid().nullish(),
  ...verifyShape,
});
export type ClauseIn = z.infer<typeof clauseIn>;

export const amendmentIn = z.object({
  kind: z
    .enum(["amendment", "assignment", "guaranty", "side_letter", "renewal", "commencement_letter", "other"])
    .default("amendment"),
  title: z.string().min(1).max(200),
  executed_on: date().nullish(),
  effective_on: date(),
  document_id: uuid().nullish(),
  page: z.number().int().min(1).nullish(),
  clause_ref: z.string().nullish(),
  overrides: z.record(z.string(), z.any()).default({}),
  summary: z.string().nullish(),
  rent_steps: z.array(rentStepIn).default([]),
});
export type AmendmentIn = z.infer<typeof amendmentIn>;

export const guarantyIn = z.object({
  ...citationShape,
  guarantor_name: z.string().min(1).max(200),
  guarantor_organization_id: uuid().nullish(),
  guarantor_person_id: uuid().nullish(),
  guaranty_type: z.enum(["full", "limited", "good_guy", "burn_down", "corporate", "personal"]).default("full"),
  cap_amount: z.number().min(0).nullish(),
  effective_on: date().nullish(),
  expires_on: date().nullish(),
  burn_down: z.array(z.record(z.string(), z.any())).default([]),
  financials_required: z.boolean().default(false),
  financials_due_on: date().nullish(),
  estoppel_days: z.number().int().min(0).nullish(),
  status: z.enum(["active", "released", "expired"]).default("active"),
  notes: z.string().nullish(),
  ...verifyShape,
});
export type GuarantyIn = z.infer<typeof guarantyIn>;

export const verifyIn = z.object({ verified: z.boolean().default(true) });
export type VerifyIn = z.infer<typeof verifyIn>;

// --------------------------------------------------------------------------- reconciliation

export const reconRunIn = z.object({
  property_id: uuid(),
  year: z.number().int().min(1990).max(2100),
  budgeted: z.record(z.string(), z.number()).default({}),
  actual: z.record(z.string(), z.number()).default({}),
  total_sf: z.number().gt(0).nullish(),
  lease_ids: z.array(uuid()).nullish(),
});
export type ReconRunIn = z.infer<typeof reconRunIn>;

// --------------------------------------------------------------------------- operative terms / reports

export interface OperativeField {
  original: any;
  operative: any;
  changed: boolean;
  amendment_id: string | null;
  amendment_title: string | null;
  effective_on: string | null;
  verified: boolean;
}

export interface RentRollRow {
  id: string;
  lease_id: string | null;
  property_id: string;
  property_name: string | null;
  space_id: string | null;
  suite: string | null;
  tenant_name: string | null;
  lease_type: string | null;
  status: string;
  sf: number | null;
  annual_rent: number | null;
  monthly_rent: number | null;
  rent_psf: number | null;
  commencement_on: string | null;
  expiration_on: string | null;
  remaining_years: number | null;
  verified: boolean | null;
}

export interface RentRollTotals {
  leased_sf: number;
  vacant_sf: number;
  total_sf: number;
  occupancy_pct: number | null;
  annual_rent: number;
  monthly_rent: number;
  avg_rent_psf: number | null;
  wale_years: number | null;
  tenant_count: number;
}

export interface RentRoll {
  property_id: string | null;
  as_of: string;
  rows: RentRollRow[];
  totals: RentRollTotals;
}

export interface RolloverYear {
  year: number;
  lease_count: number;
  sf: number;
  rent_at_risk: number;
  pct_of_rent: number;
  renewal_probability: number | null;
  expected_downtime_cost: number;
  expected_releasing_cost: number;
  lease_ids: string[];
}

export interface Rollover {
  property_id: string | null;
  as_of: string;
  total_rent: number;
  years: RolloverYear[];
}
