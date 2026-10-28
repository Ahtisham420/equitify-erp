import { z } from "zod";

const uuid = () => z.string().uuid();
const dateStr = () => z.string().date();
/** Optional field that pydantic would fill with `None` when absent (nested models are dumped in full). */
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullish().default(null);

export const CredentialKind = z.enum(["license", "insurance_coi", "w9", "other"]);
export const Decision = z.enum(["approved", "rejected"]);

export const decisionIn = z.object({
  decision: Decision,
  note: z.string().nullish(),
});
export type DecisionIn = z.infer<typeof decisionIn>;

// ======================================================================= vendors

export const vendorContact = z.object({
  name: z.string(),
  role: opt(z.string()),
  email: opt(z.string()),
  phone: opt(z.string()),
});
export type VendorContact = z.infer<typeof vendorContact>;

export const vendorRate = z.object({
  service: z.string(),
  unit: opt(z.string()), // hour | visit | sf | job
  rate: opt(z.number()),
  notes: opt(z.string()),
});
export type VendorRate = z.infer<typeof vendorRate>;

export const vendorContract = z.object({
  title: z.string(),
  start_on: opt(dateStr()),
  end_on: opt(dateStr()),
  value: opt(z.number()),
  document_id: opt(uuid()),
});
export type VendorContract = z.infer<typeof vendorContract>;

const vendorStatus = z.enum(["active", "pending", "inactive", "suspended"]);

export const vendorIn = z.object({
  name: z.string().min(1).max(200),
  organization_id: uuid().nullish(),
  services: z.array(z.string()).default([]),
  status: vendorStatus.default("active"),
  primary_contact_name: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  address: z.string().nullish(),
  contacts: z.array(vendorContact).default([]),
  rates: z.array(vendorRate).default([]),
  contracts: z.array(vendorContract).default([]),
  service_area: z.string().nullish(),
  requires_insurance: z.boolean().default(true),
  requires_license: z.boolean().default(false),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
});
export type VendorIn = z.infer<typeof vendorIn>;

export const vendorUpdate = z
  .object({
    name: z.string().min(1).max(200).nullish(),
    organization_id: uuid().nullish(),
    services: z.array(z.string()).nullish(),
    status: vendorStatus.nullish(),
    primary_contact_name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    address: z.string().nullish(),
    contacts: z.array(vendorContact).nullish(),
    rates: z.array(vendorRate).nullish(),
    contracts: z.array(vendorContract).nullish(),
    service_area: z.string().nullish(),
    requires_insurance: z.boolean().nullish(),
    requires_license: z.boolean().nullish(),
    notes: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .strict();
export type VendorUpdate = z.infer<typeof vendorUpdate>;

export const credentialIn = z.object({
  kind: CredentialKind,
  name: z.string().min(1).max(200),
  number: z.string().nullish(),
  issuer: z.string().nullish(),
  coverage_amount: z.number().min(0).nullish(),
  effective_on: dateStr().nullish(),
  expires_on: dateStr().nullish(),
  is_required: z.boolean().default(true),
  document_id: uuid().nullish(),
  verified: z.boolean().default(false),
  notes: z.string().nullish(),
});
export type CredentialIn = z.infer<typeof credentialIn>;

const rating = () => z.number().int().min(1).max(5);

export const reviewIn = z.object({
  rating: rating(),
  quality: rating().nullish(),
  timeliness: rating().nullish(),
  communication: rating().nullish(),
  comment: z.string().nullish(),
  work_order_id: uuid().nullish(),
  project_id: uuid().nullish(),
});
export type ReviewIn = z.infer<typeof reviewIn>;

// ======================================================================= capital projects

export const milestone = z.object({
  key: z.string(),
  label: z.string(),
  due_on: opt(dateStr()),
  completed_on: opt(dateStr()),
});
export type Milestone = z.infer<typeof milestone>;

export const projectIn = z.object({
  property_id: uuid(),
  asset_id: uuid().nullish(),
  name: z.string().min(1).max(200),
  category: z.string().default("other"),
  scope: z.string().nullish(),
  manager_id: uuid().nullish(),
  original_budget: z.number().min(0),
  contingency: z.number().min(0).nullish(),
  start_on: dateStr().nullish(),
  target_completion_on: dateStr().nullish(),
  milestones: z.array(milestone).default([]),
  useful_life_years: z.number().int().min(1).max(100).nullish(),
  notes: z.string().nullish(),
});
export type ProjectIn = z.infer<typeof projectIn>;

export const projectUpdate = z
  .object({
    name: z.string().min(1).max(200).nullish(),
    category: z.string().nullish(),
    scope: z.string().nullish(),
    manager_id: uuid().nullish(),
    contingency: z.number().min(0).nullish(),
    start_on: dateStr().nullish(),
    target_completion_on: dateStr().nullish(),
    milestones: z.array(milestone).nullish(),
    warranty_expires_on: dateStr().nullish(),
    warranty_terms: z.string().nullish(),
    useful_life_years: z.number().int().min(1).max(100).nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type ProjectUpdate = z.infer<typeof projectUpdate>;

export const budgetRevisionIn = z.object({
  new_budget: z.number().min(0),
  reason: z.string().min(3),
});
export type BudgetRevisionIn = z.infer<typeof budgetRevisionIn>;

export const projectStatusIn = z.object({
  status: z.enum(["pending_approval", "bidding", "in_progress", "completed", "closed", "cancelled", "draft"]),
  note: z.string().nullish(),
  actual_completion_on: dateStr().nullish(),
  warranty_expires_on: dateStr().nullish(),
  warranty_terms: z.string().nullish(),
});
export type ProjectStatusIn = z.infer<typeof projectStatusIn>;

export const bidIn = z.object({
  vendor_id: uuid(),
  amount: z.number().gt(0),
  submitted_on: dateStr().nullish(),
  valid_until: dateStr().nullish(),
  duration_days: z.number().int().min(0).nullish(),
  scope_notes: z.string().nullish(),
  document_id: uuid().nullish(),
});
export type BidIn = z.infer<typeof bidIn>;

export const bidStatusIn = z.object({
  status: z.enum(["shortlisted", "rejected", "withdrawn", "submitted"]),
  note: z.string().nullish(),
});
export type BidStatusIn = z.infer<typeof bidStatusIn>;

export const awardIn = z.object({ note: z.string().nullish() });
export type AwardIn = z.infer<typeof awardIn>;

const lienWaiverType = z.enum(["conditional", "unconditional"]);

export const drawIn = z.object({
  amount: z.number().gt(0),
  requested_on: dateStr(),
  period_end_on: dateStr().nullish(),
  percent_complete: z.number().min(0).max(100).nullish(),
  retainage: z.number().min(0).nullish(),
  lien_waiver_document_id: uuid().nullish(),
  lien_waiver_type: lienWaiverType.nullish(),
  notes: z.string().nullish(),
});
export type DrawIn = z.infer<typeof drawIn>;

export const drawUpdate = z
  .object({
    lien_waiver_document_id: uuid().nullish(),
    lien_waiver_type: lienWaiverType.nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type DrawUpdate = z.infer<typeof drawUpdate>;

export const drawPayIn = z.object({
  paid_on: dateStr(),
  payment_reference: z.string().nullish(),
});
export type DrawPayIn = z.infer<typeof drawPayIn>;

export const changeOrderIn = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  reason: z.string().nullish(),
  amount: z.number(),
  days_impact: z.number().int().nullish(),
  document_id: uuid().nullish(),
});
export type ChangeOrderIn = z.infer<typeof changeOrderIn>;

// ======================================================================= insurance

const policyStatus = z.enum(["active", "pending_renewal", "expired", "cancelled"]);

export const policyIn = z.object({
  property_id: uuid().nullish(),
  asset_id: uuid().nullish(),
  policy_number: z.string().min(1).max(120),
  coverage_type: z.string().default("property"),
  carrier: z.string().min(1).max(200),
  broker: z.string().nullish(),
  named_insured: z.string().nullish(),
  limit_amount: z.number().min(0).nullish(),
  aggregate_limit: z.number().min(0).nullish(),
  deductible: z.number().min(0).nullish(),
  premium: z.number().min(0).nullish(),
  effective_on: dateStr(),
  expires_on: dateStr(),
  status: policyStatus.default("active"),
  document_id: uuid().nullish(),
  renewal_of_id: uuid().nullish(),
  notes: z.string().nullish(),
});
export type PolicyIn = z.infer<typeof policyIn>;

export const certificateIn = z.object({
  holder_kind: z.enum(["tenant", "vendor"]),
  vendor_id: uuid().nullish(),
  tenant_organization_id: uuid().nullish(),
  tenant_name: z.string().nullish(),
  lease_id: uuid().nullish(),
  property_id: uuid().nullish(),
  coverage_type: z.string().default("general_liability"),
  carrier: z.string().nullish(),
  policy_number: z.string().nullish(),
  limit_amount: z.number().min(0).nullish(),
  required_limit: z.number().min(0).nullish(),
  additional_insured: z.boolean().default(false),
  additional_insured_required: z.boolean().default(true),
  effective_on: dateStr().nullish(),
  expires_on: dateStr().nullish(),
  received_on: dateStr().nullish(),
  requested_on: dateStr().nullish(),
  document_id: uuid().nullish(),
  notes: z.string().nullish(),
});
export type CertificateIn = z.infer<typeof certificateIn>;

export const claimIn = z.object({
  policy_id: uuid().nullish(),
  property_id: uuid().nullish(),
  claim_number: z.string().nullish(),
  incident_on: dateStr(),
  reported_on: dateStr().nullish(),
  cause: z.string().nullish(),
  description: z.string().nullish(),
  claimed_amount: z.number().min(0).nullish(),
  reserve_amount: z.number().min(0).nullish(),
  paid_amount: z.number().min(0).nullish(),
  deductible_applied: z.number().min(0).nullish(),
  adjuster_name: z.string().nullish(),
  adjuster_contact: z.string().nullish(),
  work_order_id: uuid().nullish(),
});
export type ClaimIn = z.infer<typeof claimIn>;

export const claimStatusIn = z.object({
  status: z.enum(["reported", "open", "under_review", "approved", "denied", "paid", "closed"]),
  note: z.string().nullish(),
  paid_amount: z.number().min(0).nullish(),
});
export type ClaimStatusIn = z.infer<typeof claimStatusIn>;

// ======================================================================= property tax

export const assessmentIn = z.object({
  property_id: uuid(),
  parcel_id: uuid().nullish(),
  tax_year: z.number().int().min(1900).max(2200),
  jurisdiction: z.string().nullish(),
  account_number: z.string().nullish(),
  assessed_land: z.number().min(0).nullish(),
  assessed_improvements: z.number().min(0).nullish(),
  assessed_total: z.number().min(0),
  market_value: z.number().min(0).nullish(),
  taxable_value: z.number().min(0).nullish(),
  tax_rate: z.number().min(0).max(100).nullish(),
  estimated_tax: z.number().min(0).nullish(),
  notice_received_on: dateStr().nullish(),
  protest_deadline_on: dateStr().nullish(),
  source: z.string().nullish(),
  observed_on: dateStr().nullish(),
  notes: z.string().nullish(),
});
export type AssessmentIn = z.infer<typeof assessmentIn>;

const protestStatus = z.enum([
  "considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost", "withdrawn",
]);

export const protestIn = z.object({
  assessment_id: uuid(),
  status: protestStatus.default("considering"),
  deadline_on: dateStr().nullish(),
  filed_on: dateStr().nullish(),
  consultant_organization_id: uuid().nullish(),
  consultant_name: z.string().nullish(),
  consultant_fee_pct: z.number().min(0).max(100).nullish(),
  consultant_fee_flat: z.number().min(0).nullish(),
  owner_opinion_value: z.number().min(0).nullish(),
  evidence_document_ids: z.array(uuid()).default([]),
  evidence_notes: z.string().nullish(),
  hearing_on: dateStr().nullish(),
  notes: z.string().nullish(),
});
export type ProtestIn = z.infer<typeof protestIn>;

export const protestUpdate = z
  .object({
    status: protestStatus.nullish(),
    deadline_on: dateStr().nullish(),
    filed_on: dateStr().nullish(),
    consultant_organization_id: uuid().nullish(),
    consultant_name: z.string().nullish(),
    consultant_fee_pct: z.number().min(0).max(100).nullish(),
    consultant_fee_flat: z.number().min(0).nullish(),
    owner_opinion_value: z.number().min(0).nullish(),
    evidence_document_ids: z.array(uuid()).nullish(),
    evidence_notes: z.string().nullish(),
    hearing_on: dateStr().nullish(),
    notes: z.string().nullish(),
  })
  .strict();
export type ProtestUpdate = z.infer<typeof protestUpdate>;

export const hearingResultIn = z.object({
  hearing_result: z.enum(["reduced", "no_change", "increased", "settled", "withdrawn"]),
  final_value: z.number().min(0).nullish(),
  resolved_on: dateStr().nullish(),
  note: z.string().nullish(),
});
export type HearingResultIn = z.infer<typeof hearingResultIn>;

export const paymentIn = z.object({
  property_id: uuid(),
  assessment_id: uuid().nullish(),
  tax_year: z.number().int().min(1900).max(2200),
  installment: z.string().nullish(),
  amount_due: z.number().min(0),
  due_on: dateStr(),
  document_id: uuid().nullish(),
  notes: z.string().nullish(),
});
export type PaymentIn = z.infer<typeof paymentIn>;

export const paymentConfirmIn = z.object({
  amount_paid: z.number().min(0),
  paid_on: dateStr(),
  method: z.string().nullish(),
  confirmation_number: z.string().min(1).max(120),
  document_id: uuid().nullish(),
});
export type PaymentConfirmIn = z.infer<typeof paymentConfirmIn>;

// ======================================================================= budgets

export const budgetIn = z.object({
  property_id: uuid(),
  fiscal_year: z.number().int().min(1900).max(2200),
  name: z.string().nullish(),
  notes: z.string().nullish(),
  load_prior_actuals: z.boolean().default(true),
});
export type BudgetIn = z.infer<typeof budgetIn>;

export const lineCell = z.object({
  account: z.string().min(1).max(120),
  category: z.enum(["income", "expense", "capex"]).default("expense"),
  month: z.number().int().min(1).max(12),
  amount: z.number().nullish(),
  reforecast_amount: z.number().nullish(),
});
export type LineCell = z.infer<typeof lineCell>;

export const linesIn = z.object({
  cells: z.array(lineCell).max(5000).default([]),
  remove_accounts: z.array(z.string()).default([]),
});
export type LinesIn = z.infer<typeof linesIn>;

export const newVersionIn = z.object({
  kind: z.enum(["original", "reforecast"]).default("reforecast"),
  name: z.string().nullish(),
});
export type NewVersionIn = z.infer<typeof newVersionIn>;
