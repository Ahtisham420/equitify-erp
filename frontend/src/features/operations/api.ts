"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page } from "@/lib/api";

/* ------------------------------------------------------------------ constants */

export const VENDOR_STATUSES = ["active", "pending", "inactive", "suspended"] as const;
export const VENDOR_SERVICES = [
  "hvac", "plumbing", "electrical", "roofing", "general_contractor", "paving", "landscaping", "janitorial",
  "fire_life_safety", "pest_control", "security", "snow_removal", "signage", "elevator", "environmental", "other",
] as const;
export const CREDENTIAL_KINDS = ["license", "insurance_coi", "w9", "other"] as const;
export const CREDENTIAL_LABELS: Record<string, string> = { license: "License", insurance_coi: "Certificate of insurance", w9: "W-9", other: "Other" };
export const PROJECT_STATUSES = ["draft", "pending_approval", "approved", "bidding", "awarded", "in_progress", "completed", "closed", "cancelled"] as const;
export const PROJECT_FLOW = ["draft", "pending_approval", "approved", "bidding", "awarded", "in_progress", "completed", "closed"] as const;
export const PROJECT_CATEGORIES = ["roof", "parking_lot", "hvac", "facade", "structural", "tenant_improvement", "life_safety", "ada", "landscaping", "interior", "other"] as const;
export const COVERAGE_TYPES = [
  "property", "general_liability", "umbrella", "flood", "earthquake", "wind", "builders_risk", "environmental",
  "terrorism", "workers_comp", "auto", "other",
] as const;
export const POLICY_STATUSES = ["active", "pending_renewal", "expired", "cancelled"] as const;
export const CERTIFICATE_STATUSES = ["requested", "compliant", "deficient", "expired"] as const;
export const CLAIM_STATUSES = ["reported", "open", "under_review", "approved", "denied", "paid", "closed"] as const;
export const PROTEST_STATUSES = ["considering", "filed", "evidence_submitted", "hearing_scheduled", "settled", "won", "lost", "withdrawn"] as const;
export const HEARING_RESULTS = ["reduced", "no_change", "increased", "settled", "withdrawn"] as const;
export const PAYMENT_STATUSES = ["scheduled", "paid", "confirmed", "late"] as const;
export const BUDGET_STATUSES = ["draft", "submitted", "approved", "superseded"] as const;
export const BUDGET_CATEGORIES = ["income", "expense", "capex"] as const;

/* ------------------------------------------------------------------ vendors */

export interface VendorContact { name: string; role?: string | null; email?: string | null; phone?: string | null }
export interface VendorRate { service: string; unit?: string | null; rate?: number | null; notes?: string | null }
export interface VendorContract { title: string; start_on?: string | null; end_on?: string | null; value?: number | null; document_id?: string | null }

export interface VendorListItem {
  id: string;
  name: string;
  organization_id: string | null;
  services: string[];
  status: string;
  primary_contact_name: string | null;
  email: string | null;
  phone: string | null;
  performance_rating: number | null;
  tags: string[];
  updated_at: string;
  compliant: boolean;
  compliance_reasons: string[];
  next_expiry_on: string | null;
  spend_ytd: number;
}

export interface Credential {
  id: string;
  vendor_id: string;
  kind: string;
  name: string;
  number: string | null;
  issuer: string | null;
  coverage_amount: number | null;
  effective_on: string | null;
  expires_on: string | null;
  is_required: boolean;
  status: "valid" | "expiring" | "expired" | "pending" | "rejected";
  document_id: string | null;
  verified_by_id: string | null;
  verified_at: string | null;
  notes: string | null;
  days_to_expiry: number | null;
  updated_at: string;
}

export interface CredentialInput {
  kind: string;
  name: string;
  number?: string | null;
  issuer?: string | null;
  coverage_amount?: number | null;
  effective_on?: string | null;
  expires_on?: string | null;
  is_required: boolean;
  document_id?: string | null;
  verified: boolean;
  notes?: string | null;
}

export interface Review {
  id: string;
  rating: number;
  quality: number | null;
  timeliness: number | null;
  communication: number | null;
  comment: string | null;
  work_order_id: string | null;
  project_id: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface VendorPerformance {
  review_rating: number | null;
  review_count: number;
  satisfaction_avg: number | null;
  completed_work_orders: number;
  on_time_pct: number | null;
  avg_days_to_complete: number | null;
  bids_submitted: number;
  bids_won: number;
}

export interface Vendor extends VendorListItem {
  address: string | null;
  contacts: VendorContact[];
  rates: VendorRate[];
  contracts: VendorContract[];
  service_area: string | null;
  requires_insurance: boolean;
  requires_license: boolean;
  notes: string | null;
  created_at: string;
  credentials: Credential[];
  reviews: Review[];
  performance: VendorPerformance;
  spend: { work_orders_total: number; projects_total: number; total: number; ytd: number };
  bids: { id: string; project_id: string; project_name: string | null; amount: number; status: string; submitted_on: string | null; created_at: string }[];
  work_orders: { id: string; number: number; title: string; status: string; actual_cost: number | null; satisfaction_rating: number | null; completed_at: string | null; created_at: string }[];
  certificates: Certificate[];
}

export interface VendorInput {
  name: string;
  organization_id?: string | null;
  services: string[];
  status: string;
  primary_contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  contacts: VendorContact[];
  rates: VendorRate[];
  contracts: VendorContract[];
  service_area?: string | null;
  requires_insurance: boolean;
  requires_license: boolean;
  notes?: string | null;
  tags: string[];
}

export interface VendorFacets {
  status: Record<string, number>;
  services: Record<string, number>;
}

export interface Compliance {
  compliant: boolean;
  reasons: string[];
}

/* ------------------------------------------------------------------ capital projects */

export interface Milestone { key: string; label: string; due_on: string | null; completed_on: string | null }

export interface ProjectListItem {
  id: string;
  property_id: string;
  property_name: string | null;
  asset_id: string | null;
  name: string;
  category: string;
  status: string;
  manager_id: string | null;
  manager_name: string | null;
  original_budget: number;
  current_budget: number;
  contract_amount: number | null;
  contractor_vendor_id: string | null;
  contractor_name: string | null;
  start_on: string | null;
  target_completion_on: string | null;
  actual_completion_on: string | null;
  committed: number;
  spent: number;
  pending_change_orders: number;
  updated_at: string;
}

export interface Bid {
  id: string;
  project_id: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_compliant: boolean | null;
  vendor_compliance_reasons: string[];
  amount: number;
  submitted_on: string | null;
  valid_until: string | null;
  duration_days: number | null;
  scope_notes: string | null;
  document_id: string | null;
  status: string;
  decision_note: string | null;
  created_at: string;
}

export interface Draw {
  id: string;
  project_id: string;
  number: number;
  amount: number;
  requested_on: string;
  period_end_on: string | null;
  percent_complete: number | null;
  retainage: number | null;
  lien_waiver_document_id: string | null;
  lien_waiver_type: "conditional" | "unconditional" | null;
  notes: string | null;
  status: string;
  approved_by_id: string | null;
  approved_at: string | null;
  paid_on: string | null;
  payment_reference: string | null;
  created_at: string;
  /** True when a waiver document id is set or a document is linked to entity "lien_waiver"/draw id. */
  lien_waiver_on_file: boolean;
}

export interface ChangeOrder {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string | null;
  reason: string | null;
  amount: number;
  days_impact: number | null;
  document_id: string | null;
  status: string;
  decided_by_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface BudgetEntry {
  id: string;
  kind: "original" | "change_order" | "revision";
  amount_before: number;
  amount_after: number;
  delta: number;
  reason: string | null;
  change_order_id: string | null;
  recorded_at: string;
  created_by_id: string | null;
}

export interface ProjectApproval {
  id: string;
  stage: string;
  decision: string;
  amount: number | null;
  reference_id: string | null;
  note: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string;
}

export interface Recoverability {
  project_cost: number;
  useful_life_years: number;
  lease_count: number;
  recoverable_amount: number;
  recoverable_pct: number | null;
  annual_recovery: number;
  status: "recoverable" | "not_recoverable" | "no_leases";
  leases: {
    lease_id: string;
    tenant_name: string | null;
    lease_type: string | null;
    rentable_sf: number | null;
    share_pct: number | null;
    recoverable: boolean;
    recoverable_amount: number;
    annual_recovery: number;
    reason: string;
  }[];
}

export interface Project extends ProjectListItem {
  scope: string | null;
  contingency: number | null;
  budget_approved_by_id: string | null;
  budget_approved_at: string | null;
  awarded_bid_id: string | null;
  milestones: Milestone[];
  warranty_expires_on: string | null;
  warranty_terms: string | null;
  useful_life_years: number | null;
  recoverability: Recoverability | null;
  recoverability_analyzed_at: string | null;
  notes: string | null;
  created_at: string;
  paid: number;
  remaining: number;
  approved_change_orders: number;
  bids: Bid[];
  draws: Draw[];
  change_orders: ChangeOrder[];
  budget_history: BudgetEntry[];
  approvals: ProjectApproval[];
}

export interface ProjectInput {
  property_id: string;
  asset_id?: string | null;
  name: string;
  category: string;
  scope?: string | null;
  manager_id?: string | null;
  original_budget: number;
  contingency?: number | null;
  start_on?: string | null;
  target_completion_on?: string | null;
  milestones: Milestone[];
  useful_life_years?: number | null;
  notes?: string | null;
}

export type ProjectUpdate = Partial<Omit<ProjectInput, "property_id" | "asset_id" | "original_budget">> & {
  warranty_expires_on?: string | null;
  warranty_terms?: string | null;
};

/* ------------------------------------------------------------------ insurance */

export interface Policy {
  id: string;
  property_id: string | null;
  property_name: string | null;
  asset_id: string | null;
  policy_number: string;
  coverage_type: string;
  carrier: string;
  broker: string | null;
  named_insured: string | null;
  limit_amount: number | null;
  aggregate_limit: number | null;
  deductible: number | null;
  premium: number | null;
  effective_on: string;
  expires_on: string;
  status: string;
  document_id: string | null;
  renewal_of_id: string | null;
  notes: string | null;
  days_to_expiry: number | null;
  open_claims: number;
  updated_at: string;
}
export type PolicyInput = Omit<Policy, "id" | "property_name" | "days_to_expiry" | "open_claims" | "updated_at">;

export interface Certificate {
  id: string;
  holder_kind: "tenant" | "vendor";
  vendor_id: string | null;
  tenant_organization_id: string | null;
  tenant_name: string | null;
  lease_id: string | null;
  property_id: string | null;
  coverage_type: string;
  carrier: string | null;
  policy_number: string | null;
  limit_amount: number | null;
  required_limit: number | null;
  additional_insured: boolean;
  additional_insured_required: boolean;
  effective_on: string | null;
  expires_on: string | null;
  received_on: string | null;
  requested_on: string | null;
  document_id: string | null;
  notes: string | null;
  status: string;
  deficiencies: string[];
  holder_name: string | null;
  property_name: string | null;
  days_to_expiry: number | null;
  updated_at: string;
}
export type CertificateInput = Omit<Certificate, "id" | "status" | "deficiencies" | "holder_name" | "property_name" | "days_to_expiry" | "updated_at">;

export interface Claim {
  id: string;
  policy_id: string | null;
  property_id: string | null;
  claim_number: string | null;
  incident_on: string;
  reported_on: string | null;
  cause: string | null;
  description: string | null;
  claimed_amount: number | null;
  reserve_amount: number | null;
  paid_amount: number | null;
  deductible_applied: number | null;
  adjuster_name: string | null;
  adjuster_contact: string | null;
  work_order_id: string | null;
  status: string;
  status_history: { from: string | null; to: string; at: string; by_name: string | null; note: string | null }[];
  closed_on: string | null;
  property_name: string | null;
  policy_label: string | null;
  updated_at: string;
}
export type ClaimInput = Omit<Claim, "id" | "status" | "status_history" | "closed_on" | "property_name" | "policy_label" | "updated_at">;

/* ------------------------------------------------------------------ property tax */

export interface Assessment {
  id: string;
  property_id: string;
  property_name: string | null;
  parcel_id: string | null;
  tax_year: number;
  jurisdiction: string | null;
  account_number: string | null;
  assessed_land: number | null;
  assessed_improvements: number | null;
  assessed_total: number;
  market_value: number | null;
  taxable_value: number | null;
  tax_rate: number | null;
  estimated_tax: number | null;
  notice_received_on: string | null;
  protest_deadline_on: string | null;
  source: string | null;
  observed_on: string | null;
  notes: string | null;
  prior_assessed_total: number | null;
  change_pct: number | null;
  protest_id: string | null;
  protest_status: string | null;
  updated_at: string;
}
export type AssessmentInput = Omit<Assessment, "id" | "property_name" | "prior_assessed_total" | "change_pct" | "protest_id" | "protest_status" | "updated_at">;

export interface Protest {
  id: string;
  assessment_id: string;
  property_id: string;
  property_name: string | null;
  tax_year: number;
  status: string;
  deadline_on: string | null;
  filed_on: string | null;
  consultant_organization_id: string | null;
  consultant_name: string | null;
  consultant_fee_pct: number | null;
  consultant_fee_flat: number | null;
  owner_opinion_value: number | null;
  evidence_document_ids: string[];
  evidence_notes: string | null;
  hearing_on: string | null;
  hearing_result: string | null;
  final_value: number | null;
  value_reduction: number | null;
  tax_savings: number | null;
  consultant_fee: number | null;
  net_savings: number | null;
  resolved_on: string | null;
  notes: string | null;
  assessed_total: number | null;
  days_to_deadline: number | null;
  updated_at: string;
}
export interface ProtestInput {
  assessment_id: string;
  status?: string;
  deadline_on?: string | null;
  filed_on?: string | null;
  consultant_organization_id?: string | null;
  consultant_name?: string | null;
  consultant_fee_pct?: number | null;
  consultant_fee_flat?: number | null;
  owner_opinion_value?: number | null;
  evidence_document_ids?: string[];
  evidence_notes?: string | null;
  hearing_on?: string | null;
  notes?: string | null;
}

export interface TaxPayment {
  id: string;
  property_id: string;
  property_name: string | null;
  assessment_id: string | null;
  tax_year: number;
  installment: string | null;
  amount_due: number;
  due_on: string;
  document_id: string | null;
  notes: string | null;
  amount_paid: number | null;
  paid_on: string | null;
  method: string | null;
  confirmation_number: string | null;
  status: string;
  confirmed_by_id: string | null;
  confirmed_at: string | null;
  updated_at: string;
}

export interface TaxSummary {
  protests: number;
  resolved: number;
  total_value_reduction: number;
  total_tax_savings: number;
  total_consultant_fees: number;
  total_net_savings: number;
  success_rate: number | null;
}

/* ------------------------------------------------------------------ budgets */

export interface BudgetListItem {
  id: string;
  property_id: string;
  property_name: string | null;
  asset_id: string | null;
  fiscal_year: number;
  version: number;
  kind: "original" | "reforecast";
  name: string;
  status: string;
  parent_budget_id: string | null;
  approved_by_id: string | null;
  approved_at: string | null;
  total_income: number;
  total_expense: number;
  total_capex: number;
  noi: number;
  updated_at: string;
}

export interface GridRow {
  account: string;
  category: "income" | "expense" | "capex";
  budget: number[];
  reforecast: (number | null)[];
  prior_actual: (number | null)[];
  actual: (number | null)[];
  budget_total: number;
  reforecast_total: number | null;
  prior_actual_total: number | null;
  actual_total: number | null;
  variance: number | null;
  variance_pct: number | null;
}

export interface Budget extends BudgetListItem {
  notes: string | null;
  approval_note: string | null;
  submitted_at: string | null;
  superseded_at: string | null;
  created_at: string;
  rows: GridRow[];
  versions: BudgetListItem[];
  actuals_available: boolean;
}

export interface LineCell {
  account: string;
  category: "income" | "expense" | "capex";
  month: number;
  amount?: number | null;
  reforecast_amount?: number | null;
}

/* ------------------------------------------------------------------ helpers */

export type Decision = "approved" | "rejected";

export function expiryTone(days: number | null | undefined): "red" | "amber" | "green" | "neutral" {
  if (days === null || days === undefined) return "neutral";
  if (days < 0) return "red";
  if (days <= 30) return "amber";
  return "green";
}

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

/* ------------------------------------------------------------------ vendor hooks */

export function useVendor(id: string) {
  return useQuery({ queryKey: ["vendors", id], queryFn: () => api.get<Vendor>(`/vendors/${id}`) });
}

export function useVendorCompliance(id: string | null | undefined) {
  return useQuery({ queryKey: ["vendors", id, "compliance"], queryFn: () => api.get<Compliance>(`/vendors/${id}/compliance`), enabled: !!id });
}

export function useSaveVendor(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<VendorInput>) => (id ? api.patch<Vendor>(`/vendors/${id}`, data) : api.post<Vendor>("/vendors", data)),
    onSuccess: (v) => {
      qc.setQueryData(["vendors", v.id], v);
      qc.invalidateQueries({ queryKey: ["vendors"] });
      qc.invalidateQueries({ queryKey: ["timeline", "vendor", v.id] });
    },
  });
}

export function useSaveCredential(vendorId: string, credentialId?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: CredentialInput) =>
      credentialId ? api.put<Credential>(`/vendor-credentials/${credentialId}`, data) : api.post<Credential>(`/vendors/${vendorId}/credentials`, data),
    onSuccess: () => invalidate("vendors", "work-orders", "capital-projects"),
  });
}

export function useRemoveCredential() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/vendor-credentials/${id}`), onSuccess: () => invalidate("vendors") });
}

export function useAddReview(vendorId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { rating: number; quality?: number | null; timeliness?: number | null; communication?: number | null; comment?: string | null }) =>
      api.post<Review>(`/vendors/${vendorId}/reviews`, data),
    onSuccess: () => invalidate("vendors"),
  });
}

export function useArchiveVendor() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/vendors/${id}`), onSuccess: () => invalidate("vendors") });
}

export function useOperationsScan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () =>
      api.post<{ credentials_expiring: number; credentials_expired: number; policies_expiring: number; certificates_lapsed: number; protest_deadlines: number; payments_due: number; alerts_raised: number }>("/operations/scan"),
    onSuccess: () => invalidate("vendors", "insurance", "tax", "alerts"),
  });
}

/* ------------------------------------------------------------------ project hooks */

export function useProject(id: string) {
  return useQuery({ queryKey: ["capital-projects", id], queryFn: () => api.get<Project>(`/capital-projects/${id}`) });
}

export function useProjectsFor(params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: ["capital-projects", "list", "embedded", params],
    queryFn: () => api.get<Page<ProjectListItem>>("/capital-projects", { page_size: 50, ...params }),
  });
}

export function useSaveProject(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectInput | ProjectUpdate) =>
      id ? api.patch<Project>(`/capital-projects/${id}`, data) : api.post<Project>("/capital-projects", data),
    onSuccess: (p) => {
      qc.setQueryData(["capital-projects", p.id], p);
      qc.invalidateQueries({ queryKey: ["capital-projects"] });
      qc.invalidateQueries({ queryKey: ["timeline", "capital_project", p.id] });
    },
  });
}

/**
 * Generic project mutation. `path` is relative to the API root, e.g.
 * `/capital-projects/{id}/status`, `/project-bids/{bidId}/award`, `/change-orders/{coId}/decision`.
 * Every project-scoped mutation refreshes the project detail.
 */
export function useProjectAction<TBody = unknown, TOut = unknown>(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body, method = "post" }: { path: string; body?: TBody; method?: "post" | "patch" }) =>
      method === "patch" ? api.patch<TOut>(path, body) : api.post<TOut>(path, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capital-projects"] });
      qc.invalidateQueries({ queryKey: ["timeline", "capital_project", projectId] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
    },
  });
}

export function useArchiveProject() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/capital-projects/${id}`), onSuccess: () => invalidate("capital-projects") });
}

/* ------------------------------------------------------------------ insurance hooks */

export function usePoliciesFor(params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: ["insurance", "policies", "embedded", params],
    queryFn: () => api.get<Page<Policy>>("/insurance/policies", { page_size: 100, ...params }),
  });
}

export function useSavePolicy(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: PolicyInput) => (id ? api.put<Policy>(`/insurance/policies/${id}`, data) : api.post<Policy>("/insurance/policies", data)),
    onSuccess: () => invalidate("insurance"),
  });
}

export function useArchivePolicy() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/insurance/policies/${id}`), onSuccess: () => invalidate("insurance") });
}

export function useSaveCertificate(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: CertificateInput) =>
      id ? api.put<Certificate>(`/insurance/certificates/${id}`, data) : api.post<Certificate>("/insurance/certificates", data),
    onSuccess: () => invalidate("insurance", "vendors"),
  });
}

export function useArchiveCertificate() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/insurance/certificates/${id}`), onSuccess: () => invalidate("insurance", "vendors") });
}

export function useSaveClaim(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: ClaimInput) => (id ? api.put<Claim>(`/insurance/claims/${id}`, data) : api.post<Claim>("/insurance/claims", data)),
    onSuccess: () => invalidate("insurance"),
  });
}

export function useClaimStatus(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { status: string; note?: string | null; paid_amount?: number | null }) => api.post<Claim>(`/insurance/claims/${id}/status`, body),
    onSuccess: () => invalidate("insurance"),
  });
}

/* ------------------------------------------------------------------ tax hooks */

export function useAssessmentsFor(params: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: ["tax", "assessments", "embedded", params],
    queryFn: () => api.get<Page<Assessment>>("/tax/assessments", { page_size: 100, ...params }),
  });
}

export function useTaxSummary(params: { property_id?: string; tax_year?: number }) {
  return useQuery({ queryKey: ["tax", "summary", params], queryFn: () => api.get<TaxSummary>("/tax/summary", params) });
}

export function useSaveAssessment(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: AssessmentInput) => (id ? api.put<Assessment>(`/tax/assessments/${id}`, data) : api.post<Assessment>("/tax/assessments", data)),
    onSuccess: () => invalidate("tax"),
  });
}

export function useSaveProtest(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: ProtestInput | Partial<Omit<ProtestInput, "assessment_id">>) =>
      id ? api.patch<Protest>(`/tax/protests/${id}`, data) : api.post<Protest>("/tax/protests", data),
    onSuccess: () => invalidate("tax"),
  });
}

export function useRecordHearing(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { hearing_result: string; final_value?: number | null; resolved_on?: string | null; note?: string | null }) =>
      api.post<Protest>(`/tax/protests/${id}/hearing`, body),
    onSuccess: () => invalidate("tax"),
  });
}

export function useCreatePayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { property_id: string; assessment_id?: string | null; tax_year: number; installment?: string | null; amount_due: number; due_on: string; document_id?: string | null; notes?: string | null }) =>
      api.post<TaxPayment>("/tax/payments", data),
    onSuccess: () => invalidate("tax"),
  });
}

export function useConfirmPayment(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { amount_paid: number; paid_on: string; method?: string | null; confirmation_number: string; document_id?: string | null }) =>
      api.post<TaxPayment>(`/tax/payments/${id}/confirm`, body),
    onSuccess: () => invalidate("tax"),
  });
}

/* ------------------------------------------------------------------ budget hooks */

export function useBudget(id: string) {
  return useQuery({ queryKey: ["budgets", id], queryFn: () => api.get<Budget>(`/budgets/${id}`) });
}

export function useCreateBudget() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { property_id: string; fiscal_year: number; name?: string | null; notes?: string | null; load_prior_actuals: boolean }) =>
      api.post<Budget>("/budgets", data),
    onSuccess: () => invalidate("budgets"),
  });
}

/** POST/PUT on a budget sub-resource; updates the cached budget with the response. */
export function useBudgetAction<TBody = unknown>(id: string, action: "lines" | "load-prior-actuals" | "submit" | "approval" | "versions") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => (action === "lines" ? api.put<Budget>(`/budgets/${id}/lines`, body) : api.post<Budget>(`/budgets/${id}/${action}`, body ?? {})),
    onSuccess: (b) => {
      qc.setQueryData(["budgets", b.id], b);
      qc.invalidateQueries({ queryKey: ["budgets"] });
      qc.invalidateQueries({ queryKey: ["timeline", "budget", id] });
    },
  });
}

export function useArchiveBudget() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/budgets/${id}`), onSuccess: () => invalidate("budgets") });
}
