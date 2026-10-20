"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const CLOSING_STATUSES = ["open", "completed", "cancelled"] as const;
export const CATEGORIES = ["settlement_statement", "prorations", "insurance", "entity_standing", "lender_conditions", "tenant_notices", "vendors", "utilities", "other"] as const;
export const ITEM_STATUSES = ["open", "in_progress", "done", "waived", "not_applicable"] as const;
export const SATISFIED = ["done", "waived", "not_applicable"];
export const SOURCE_KINDS = ["equity", "senior_debt", "mezzanine", "seller_financing", "deposit_credit", "other"] as const;
export const USE_KINDS = ["purchase_price", "closing_costs", "acquisition_fee", "financing_costs", "reserves", "capex", "other"] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  settlement_statement: "Settlement statement",
  prorations: "Prorations",
  insurance: "Insurance",
  entity_standing: "Entity standing",
  lender_conditions: "Lender conditions",
  tenant_notices: "Tenant notices",
  vendors: "Vendors",
  utilities: "Utilities",
  other: "Other",
};

export const HANDOFF_LABELS: Record<string, string> = {
  rent_roll: "Rent roll",
  leases: "Leases",
  service_contracts: "Service contracts",
  warranties: "Warranties",
  keys_access: "Keys & access",
  utilities: "Utilities",
  tax_insurance: "Tax & insurance",
  open_dd_items: "Open DD items",
};

export interface Blocker {
  key: string;
  label: string;
  detail: string | null;
}

export interface ClosingListItem {
  id: string;
  opportunity_id: string;
  opportunity_title: string | null;
  property_id: string | null;
  property_label: string | null;
  status: string;
  scheduled_closing_on: string | null;
  closed_on: string | null;
  purchase_price: number | null;
  basis: number | null;
  coordinator_id: string | null;
  coordinator_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  blocking_open: number;
  items_total: number;
  items_done: number;
  wire_status: string;
  asset_id: string | null;
  asset_pending: boolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceLine {
  label: string;
  kind: string;
  amount: number;
}

export interface UseLine extends SourceLine {
  capitalized: boolean;
}

export interface Closing extends ClosingListItem {
  offer_id: string | null;
  uw_model_id: string | null;
  sources: SourceLine[];
  uses: UseLine[];
  total_sources: number | null;
  total_uses: number | null;
  capital_structure: { equity?: number; debt?: number; total?: number; ltv_pct?: number | null; equity_pct?: number | null; by_kind?: Record<string, number> };
  hold_thesis: string | null;
  business_plan: string | null;
  target_hold_years: number | null;
  notes: string | null;
  completed_by_id: string | null;
  asset_error: string | null;
  audit_task_id: string | null;
  audit_due_on: string | null;
  audit_result: Record<string, unknown> | null;
  audit_completed_at: string | null;
  blockers: Blocker[];
  can_complete: boolean;
  has_snapshot: boolean;
  created_by_id: string | null;
}

export interface ChecklistItem {
  id: string;
  closing_id: string;
  template_key: string | null;
  category: string;
  title: string;
  owner_id: string | null;
  owner_name: string | null;
  due_on: string | null;
  status: string;
  is_blocking: boolean;
  document_id: string | null;
  notes: string | null;
  waived_reason: string | null;
  completed_at: string | null;
  completed_by_id: string | null;
  sort_order: number;
  overdue: boolean;
  updated_at: string;
}

export interface Wire {
  id: string;
  closing_id: string;
  is_current: boolean;
  beneficiary_name: string;
  bank_name: string;
  routing_number: string;
  account_number: string;
  amount: number | null;
  instruction_source: string;
  instruction_received_from: string | null;
  instruction_contact_phone: string | null;
  received_at: string;
  callback_phone: string | null;
  callback_phone_source: string | null;
  callback_contact_name: string | null;
  verified_by_id: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  result: "pending" | "passed" | "failed" | "superseded";
  result_notes: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface Snapshot {
  id: string;
  closing_id: string;
  created_at: string;
  created_by_name: string | null;
  sha256: string;
  data: Record<string, unknown>;
}

export interface HandoffItem {
  label: string;
  detail: string | null;
  document_id: string | null;
  status: "pending" | "delivered" | "not_applicable";
}

export interface HandoffPackage {
  id: string;
  closing_id: string;
  asset_id: string | null;
  property_id: string | null;
  sections: Record<string, { items: HandoffItem[]; notes: string | null }>;
  open_dd_items: { id: string; title: string; status: string | null; severity: unknown; due_on: string | null; findings: string | null }[];
  carry_forward: Record<string, unknown>;
  generated_at: string;
  recipient_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by_id: string | null;
  updated_at: string;
}

export interface AuditMetric {
  key: string;
  label: string;
  assumed: number | null;
  actual: number | null;
  variance: number | null;
  variance_pct: number | null;
  unit: "currency" | "percent" | "ratio";
}

export interface PostCloseAudit {
  closing_id: string;
  asset_id: string | null;
  closed_on: string | null;
  due_on: string | null;
  period_start: string | null;
  period_end: string | null;
  months_of_data: number;
  metrics: AuditMetric[];
  notes: string[];
  completed: Record<string, unknown> | null;
}

export interface ClosingFacets {
  status: Record<string, number>;
}

export function wireTone(status: string): "green" | "red" | "amber" | "neutral" {
  return status === "passed" ? "green" : status === "failed" ? "red" : status === "pending" ? "amber" : "neutral";
}

export function useClosing(id: string) {
  return useQuery({ queryKey: ["closings", id], queryFn: () => api.get<Closing>(`/closings/${id}`) });
}

export function useChecklist(id: string) {
  return useQuery({ queryKey: ["closings", id, "checklist"], queryFn: () => api.get<ChecklistItem[]>(`/closings/${id}/checklist`) });
}

export function useWires(id: string) {
  return useQuery({ queryKey: ["closings", id, "wires"], queryFn: () => api.get<Wire[]>(`/closings/${id}/wires`) });
}

export function useSnapshot(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["closings", id, "snapshot"], queryFn: () => api.get<Snapshot>(`/closings/${id}/snapshot`), enabled, retry: false });
}

export function useHandoff(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["closings", id, "handoff"], queryFn: () => api.get<HandoffPackage>(`/closings/${id}/handoff`), enabled, retry: false });
}

export function usePostCloseAudit(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["closings", id, "audit"], queryFn: () => api.get<PostCloseAudit>(`/closings/${id}/post-close-audit`), enabled });
}

/** Any mutation on a closing refreshes the record, its checklist/wires and readiness. */
export function useClosingMutation<TBody, TResult = unknown>(closingId: string, fn: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["closings"] });
      qc.invalidateQueries({ queryKey: ["timeline", "closing", closingId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useCreateClosing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { opportunity_id: string; scheduled_closing_on?: string | null; coordinator_id?: string | null; manager_id?: string | null }) =>
      api.post<Closing>("/closings", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["closings"] }),
  });
}
