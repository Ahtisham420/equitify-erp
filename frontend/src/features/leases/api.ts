"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Observation, Provenance } from "@/features/properties/api";

export const LEASE_STATUSES = ["draft", "active", "expired", "terminated"] as const;
export const LEASE_TYPES = ["nnn", "absolute_nnn", "modified_gross", "gross", "ground", "percentage"] as const;
export const LEASE_TYPE_LABELS: Record<string, string> = {
  nnn: "NNN",
  absolute_nnn: "Absolute NNN",
  modified_gross: "Modified gross",
  gross: "Gross",
  ground: "Ground lease",
  percentage: "Percentage",
};
export const ESCALATION_METHODS = [
  { value: "fixed_pct", label: "Fixed %" },
  { value: "fixed_amount", label: "Fixed $ increase" },
  { value: "cpi", label: "CPI (floor / cap)" },
  { value: "step_table", label: "Step table" },
  { value: "flat", label: "Flat (no escalation)" },
];
export const RECOVERY_METHODS = [
  { value: "nnn", label: "NNN (pro-rata share)" },
  { value: "modified_gross", label: "Modified gross" },
  { value: "base_year", label: "Base year" },
  { value: "expense_stop", label: "Expense stop" },
  { value: "fixed_cam", label: "Fixed CAM" },
];
export const RECOVERY_CATEGORIES = ["all", "cam", "tax", "insurance", "utilities"] as const;
export const CAP_TYPES = [
  { value: "none", label: "No cap" },
  { value: "cumulative", label: "Cumulative" },
  { value: "non_cumulative", label: "Non-cumulative" },
];
export const OPTION_TYPES = ["renewal", "expansion", "termination", "purchase", "rofr", "rofo"] as const;
export const OPTION_LABELS: Record<string, string> = {
  renewal: "Renewal",
  expansion: "Expansion",
  termination: "Termination",
  purchase: "Purchase",
  rofr: "ROFR",
  rofo: "ROFO",
};
export const PRICING_METHODS = [
  { value: "fixed_rent", label: "Fixed rent PSF" },
  { value: "fixed_increase", label: "% over current rent" },
  { value: "fmv", label: "Fair market value" },
  { value: "pct_of_fmv", label: "% of FMV" },
  { value: "fixed_price", label: "Fixed price" },
  { value: "fee", label: "Termination fee" },
  { value: "matching", label: "Match third-party terms" },
  { value: "none", label: "Not specified" },
];
export const CLAUSE_CATEGORIES = [
  "use", "exclusive", "cotenancy", "kickout", "assignment", "subletting", "maintenance", "replacement", "insurance",
  "holdover", "default", "remedies", "estoppel", "certificate", "reporting", "landlord_obligation", "radius",
  "relocation", "sna", "other",
] as const;
export const OBLIGATION_CATEGORIES = ["estoppel", "certificate", "reporting", "landlord_obligation", "insurance"];
export const AMENDMENT_KINDS = ["amendment", "assignment", "guaranty", "side_letter", "renewal", "commencement_letter", "other"] as const;
export const GUARANTY_TYPES = ["full", "limited", "good_guy", "burn_down", "corporate", "personal"] as const;
export const OVERRIDABLE_FIELDS = [
  "tenant_name", "space_id", "lease_type", "commencement_on", "expiration_on", "rentable_sf", "base_rent_annual",
  "pro_rata_share", "security_deposit", "landlord_name", "premises_description", "late_fee_grace_days", "late_fee_pct",
  "late_fee_flat", "status",
] as const;

export interface Citation {
  document_id: string | null;
  page: number | null;
  clause_ref: string | null;
  quoted_text: string | null;
}

interface Verifiable {
  verified: boolean;
  ai_extracted: boolean;
  confidence: number | null;
  verified_by_id: string | null;
  verified_at: string | null;
}

export interface LeaseListItem {
  id: string;
  property_id: string;
  property_name: string | null;
  space_id: string | null;
  suite: string | null;
  tenant_name: string;
  status: string;
  lease_type: string;
  commencement_on: string | null;
  expiration_on: string | null;
  rentable_sf: number | null;
  current_annual_rent: number | null;
  rent_psf: number | null;
  verified: boolean;
  ai_extracted: boolean;
  updated_at: string;
}

export interface Lease extends Verifiable {
  id: string;
  property_id: string;
  property_name: string | null;
  space_id: string | null;
  suite: string | null;
  asset_id: string | null;
  document_id: string | null;
  tenant_organization_id: string | null;
  tenant_name: string;
  landlord_name: string | null;
  premises_description: string | null;
  status: string;
  lease_type: string;
  execution_on: string | null;
  commencement_on: string | null;
  rent_commencement_on: string | null;
  expiration_on: string | null;
  rentable_sf: number | null;
  pro_rata_share: number | null;
  base_rent_annual: number | null;
  security_deposit: number | null;
  late_fee_grace_days: number | null;
  late_fee_pct: number | null;
  late_fee_flat: number | null;
  market_rent_psf: number | null;
  renewal_probability: number | null;
  downtime_months: number | null;
  releasing_cost_psf: number | null;
  escalation: Record<string, unknown>;
  citations: Record<string, Citation>;
  manager_id: string | null;
  manager_name: string | null;
  notes: string | null;
  tags: string[];
  current_annual_rent: number | null;
  unverified_items: number;
  provenance: Record<string, Observation>;
  created_at: string;
  updated_at: string;
}

export type LeaseInput = Partial<Omit<Lease, "id" | "provenance" | "property_name" | "suite" | "manager_name" | "current_annual_rent" | "unverified_items" | "created_at" | "updated_at" | "escalation" | keyof Verifiable>> & {
  provenance?: Provenance;
};

export interface LeaseFacets {
  status: Record<string, number>;
  lease_type: Record<string, number>;
  verified: Record<string, number>;
  expiring: Record<string, number>;
}

export interface RentStep extends Citation {
  id: string;
  lease_id: string;
  amendment_id: string | null;
  start_on: string;
  end_on: string;
  annual_rent: number;
  monthly_rent: number;
  rent_psf: number | null;
  charge_type: string;
  source: string;
  note: string | null;
}

export interface OperativeField {
  original: unknown;
  operative: unknown;
  changed: boolean;
  amendment_id: string | null;
  amendment_title: string | null;
  effective_on: string | null;
  verified: boolean;
}

export interface OperativeTerms {
  as_of: string;
  fields: Record<string, OperativeField>;
  rent_steps: RentStep[];
  amendments_applied: string[];
  pending_amendments: string[];
}

export interface Recovery extends Citation, Verifiable {
  id: string;
  lease_id: string;
  method: string;
  category: string;
  pro_rata_share: number | null;
  base_year: number | null;
  base_amount: number | null;
  expense_stop_psf: number | null;
  fixed_amount_annual: number | null;
  estimated_monthly: number | null;
  cap_type: string;
  cap_pct: number | null;
  cap_base_amount: number | null;
  cap_base_year: number | null;
  admin_fee_pct: number | null;
  gross_up_pct: number | null;
  exclusions: string[];
  notes: string | null;
}

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

export interface LeaseOption extends Citation, Verifiable {
  id: string;
  lease_id: string;
  option_type: string;
  sequence: number;
  term_months: number | null;
  notice_start_on: string | null;
  notice_end_on: string | null;
  effective_on: string | null;
  pricing_method: string;
  pricing_params: Record<string, unknown>;
  option_rent_psf: number | null;
  increase_pct: number | null;
  fmv_pct: number | null;
  fee_amount: number | null;
  purchase_price: number | null;
  market_rent_psf: number | null;
  space_description: string | null;
  conditions: string | null;
  status: string;
  exercised_on: string | null;
  economics: OptionEconomics | null;
}

export interface Clause extends Citation, Verifiable {
  id: string;
  lease_id: string;
  amendment_id: string | null;
  category: string;
  title: string;
  summary: string | null;
  terms: Record<string, unknown>;
  obligated_party: string | null;
  due_on: string | null;
  recurrence: string | null;
  response_days: number | null;
  updated_at: string;
}

export interface Amendment {
  id: string;
  lease_id: string;
  kind: string;
  sequence: number;
  title: string;
  executed_on: string | null;
  effective_on: string;
  document_id: string | null;
  page: number | null;
  clause_ref: string | null;
  overrides: Record<string, unknown>;
  summary: string | null;
  verified: boolean;
  verified_by_id: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface Guaranty extends Citation, Verifiable {
  id: string;
  lease_id: string;
  guarantor_name: string;
  guarantor_organization_id: string | null;
  guarantor_person_id: string | null;
  guaranty_type: string;
  cap_amount: number | null;
  effective_on: string | null;
  expires_on: string | null;
  burn_down: { on?: string; cap_amount?: number }[];
  financials_required: boolean;
  financials_due_on: string | null;
  estoppel_days: number | null;
  status: string;
  notes: string | null;
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

export interface RentRoll {
  property_id: string | null;
  as_of: string;
  rows: RentRollRow[];
  totals: {
    leased_sf: number;
    vacant_sf: number;
    total_sf: number;
    occupancy_pct: number | null;
    annual_rent: number;
    monthly_rent: number;
    avg_rent_psf: number | null;
    wale_years: number | null;
    tenant_count: number;
  };
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

export interface Reconciliation {
  id: string;
  lease_id: string;
  property_id: string;
  tenant_name: string | null;
  year: number;
  budgeted_pool: Record<string, number>;
  actual_pool: Record<string, number>;
  share_pct: number | null;
  budgeted_share: number;
  actual_share: number;
  cap_reduction: number;
  estimates_billed: number;
  true_up_amount: number;
  details: Record<string, unknown>[];
  status: string;
  finalized_at: string | null;
  billed_charge_id: string | null;
  updated_at: string;
}

export interface SpaceOption {
  id: string;
  suite: string;
  area_sf: number | null;
  occupancy_status: string;
  tenant_name: string | null;
}

export type ChildKind = "recoveries" | "options" | "clauses" | "guaranties";

export function leaseLabel(l: { tenant_name: string; suite?: string | null }) {
  return l.suite ? `${l.tenant_name} · Suite ${l.suite}` : l.tenant_name;
}

/* ------------------------------------------------------------------ queries */

export function useLease(id: string) {
  return useQuery({ queryKey: ["leases", id], queryFn: () => api.get<Lease>(`/leases/${id}`) });
}

export function useLeaseChildren<T>(id: string, kind: ChildKind | "amendments" | "rent-steps") {
  return useQuery({ queryKey: ["leases", id, kind], queryFn: () => api.get<T[]>(`/leases/${id}/${kind}`) });
}

export function useOperativeTerms(id: string) {
  return useQuery({ queryKey: ["leases", id, "operative"], queryFn: () => api.get<OperativeTerms>(`/leases/${id}/operative-terms`) });
}

export function useLeaseHistory(id: string, enabled = true) {
  return useQuery({ queryKey: ["leases", id, "history"], queryFn: () => api.get<Observation[]>(`/leases/${id}/history`), enabled });
}

export function useSpaceOptions(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["leases", "space-options", propertyId],
    queryFn: () => api.get<SpaceOption[]>("/leases/space-options", { property_id: propertyId }),
    enabled: !!propertyId,
  });
}

export function useRentRoll(propertyId: string | null, asOf?: string | null) {
  return useQuery({
    queryKey: ["leases", "rent-roll", propertyId, asOf],
    queryFn: () => api.get<RentRoll>("/leases/rent-roll", { property_id: propertyId, as_of: asOf }),
    placeholderData: (prev) => prev,
  });
}

export function useRollover(propertyId: string | null, years = 10) {
  return useQuery({
    queryKey: ["leases", "rollover", propertyId, years],
    queryFn: () => api.get<Rollover>("/leases/rollover", { property_id: propertyId, years }),
    placeholderData: (prev) => prev,
  });
}

export function useReconciliations(params: { property_id?: string | null; lease_id?: string; year?: number | null }) {
  return useQuery({
    queryKey: ["leases", "reconciliations", params],
    queryFn: () => api.get<Reconciliation[]>("/leases/reconciliations", params),
  });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidateLease(id?: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["leases"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", "lease", id] });
    qc.invalidateQueries({ queryKey: ["critical-dates"] });
  };
}

export function useSaveLease(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LeaseInput) => (id ? api.patch<Lease>(`/leases/${id}`, data) : api.post<Lease>("/leases", data)),
    onSuccess: (l) => {
      qc.invalidateQueries({ queryKey: ["leases"] });
      qc.setQueryData(["leases", l.id], l);
      qc.invalidateQueries({ queryKey: ["timeline", "lease", l.id] });
    },
  });
}

export function useLeaseAction<TBody = unknown, TOut = unknown>(id: string, path: string, method: "post" | "patch" | "delete" = "post") {
  const invalidate = useInvalidateLease(id);
  return useMutation({
    mutationFn: (body: TBody) =>
      method === "delete" ? api.delete<TOut>(`/leases/${id}/${path}`) : method === "patch" ? api.patch<TOut>(`/leases/${id}/${path}`, body) : api.post<TOut>(`/leases/${id}/${path}`, body),
    onSuccess: invalidate,
  });
}

/** Generic child mutation: path is computed per call (e.g. `options/<id>/verify`). */
export function useLeaseMutation(id: string) {
  const invalidate = useInvalidateLease(id);
  return useMutation({
    mutationFn: ({ method, path, body }: { method: "post" | "patch" | "delete"; path: string; body?: unknown }) =>
      method === "delete" ? api.delete(`/leases/${id}/${path}`) : method === "patch" ? api.patch(`/leases/${id}/${path}`, body) : api.post(`/leases/${id}/${path}`, body),
    onSuccess: invalidate,
  });
}

export function useRunReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { property_id: string; year: number; budgeted: Record<string, number>; actual: Record<string, number>; total_sf?: number | null }) =>
      api.post<{ created: number; updated: number; skipped_locked: number; items: Reconciliation[] }>("/leases/reconciliations/run", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leases"] }),
  });
}

export function useFinalizeReconciliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Reconciliation>(`/leases/reconciliations/${id}/finalize`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leases"] });
      qc.invalidateQueries({ queryKey: ["receivables"] });
    },
  });
}

export async function openCitation(documentId: string, page?: number | null) {
  const r = await api.get<{ url: string }>(`/leases/documents/${documentId}/open`, { page: page ?? undefined });
  window.open(r.url, "_blank", "noopener");
}
