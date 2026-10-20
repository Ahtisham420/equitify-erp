"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Params } from "@/lib/api";

export const CHARGE_TYPES = [
  "base_rent", "recovery", "cam", "tax", "insurance", "utilities", "fixed_cam", "late_fee", "recovery_true_up",
  "percentage_rent", "parking", "repair", "other",
] as const;
export const MANUAL_CHARGE_TYPES = ["repair", "utilities", "parking", "percentage_rent", "late_fee", "other"] as const;
export const CHARGE_STATUSES = ["pending_approval", "open", "partial", "paid", "credit", "void"] as const;
export const CHARGE_SOURCES = ["schedule", "manual", "late_fee", "reconciliation"] as const;
export const PAYMENT_METHODS = ["ach", "check", "wire", "card", "cash", "other"] as const;
export const COLLECTION_STATUSES = ["current", "delinquent", "payment_plan", "legal", "resolved"] as const;

export const CHARGE_TYPE_LABELS: Record<string, string> = {
  base_rent: "Base rent", recovery: "Recoveries", cam: "CAM", tax: "Taxes", insurance: "Insurance", utilities: "Utilities",
  fixed_cam: "Fixed CAM", late_fee: "Late fee", recovery_true_up: "Recovery true-up", percentage_rent: "Percentage rent",
  parking: "Parking", repair: "Repair / chargeback", other: "Other",
};
export const SOURCE_LABELS: Record<string, string> = {
  schedule: "Lease schedule", manual: "Manual", late_fee: "Late-fee terms", reconciliation: "Reconciliation",
};
export const METHOD_LABELS: Record<string, string> = { ach: "ACH", check: "Check", wire: "Wire", card: "Card", cash: "Cash", other: "Other" };

export const BUCKETS = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
] as const;

export interface Buckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}

export interface Charge {
  id: string;
  lease_id: string;
  property_id: string;
  tenant_name: string | null;
  charge_type: string;
  period_start: string | null;
  period_end: string | null;
  due_on: string;
  amount: number;
  amount_paid: number;
  balance: number;
  days_past_due: number;
  status: string;
  source: string;
  source_ref: Record<string, unknown>;
  description: string | null;
  approved_by_id: string | null;
  approved_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface Application {
  id: string;
  payment_id: string;
  charge_id: string;
  amount: number;
  applied_on: string;
  method: string;
  reversed_at: string | null;
  reversal_reason: string | null;
  created_by_id: string | null;
}

export interface Payment {
  id: string;
  lease_id: string;
  property_id: string;
  tenant_name: string | null;
  received_on: string;
  amount: number;
  unapplied_amount: number;
  method: string;
  reference: string | null;
  status: string;
  reversed_at: string | null;
  reversal_reason: string | null;
  notes: string | null;
  external_ref: string | null;
  created_at: string;
  applications: Application[];
}

export interface TenantBalance {
  id: string;
  lease_id: string;
  tenant_name: string;
  property_id: string;
  property_name: string | null;
  lease_status: string;
  balance: number;
  past_due: number;
  unapplied: number;
  buckets: Buckets;
  collection_status: string;
  step_key: string | null;
  days_past_due: number;
  has_plan: boolean;
}

export interface LedgerEntry {
  id: string;
  on: string;
  kind: "charge" | "payment" | "reversal" | "void";
  description: string;
  charge_type: string | null;
  debit: number;
  credit: number;
  balance: number;
  status: string | null;
  ref_id: string;
  source: string | null;
  source_ref: Record<string, unknown>;
}

export interface Ledger {
  tenant: TenantBalance;
  entries: LedgerEntry[];
  open_charges: Charge[];
  late_fee_terms: { basis: string; grace_days: number | null; pct: number | null; flat: number | null };
}

export interface DashboardRow {
  id: string;
  label: string;
  property_id: string | null;
  lease_id: string | null;
  buckets: Buckets;
  unapplied: number;
  tenants: number;
}

export interface Dashboard {
  as_of: string;
  totals: Buckets;
  unapplied: number;
  delinquent_tenants: number;
  billed_this_month: number;
  collected_this_month: number;
  collection_rate: number | null;
  by_property: DashboardRow[];
  by_tenant: DashboardRow[];
}

export interface LadderStep {
  key: string;
  label: string;
  days_past_due: number;
  min_balance: number;
  create_task: boolean;
  task_priority: string;
  collection_status: "delinquent" | "legal";
  subject: string;
  body: string;
}

export interface Settings {
  late_fee_defaults: { grace_days: number; pct: number | null; flat: number | null; charge_types: string[] };
  ladder: LadderStep[];
  alert_days: number;
}

export interface Collection {
  id: string;
  lease_id: string;
  tenant_name: string | null;
  property_name: string | null;
  status: string;
  step_index: number;
  step_key: string | null;
  step_label: string | null;
  past_due_balance: number;
  days_past_due: number;
  oldest_due_on: string | null;
  on_hold: boolean;
  last_evaluated_at: string | null;
}

export interface Notice {
  id: string;
  lease_id: string;
  property_id: string;
  tenant_name: string | null;
  step_key: string;
  step_index: number;
  label: string;
  balance: number;
  days_past_due: number;
  subject: string;
  body: string;
  status: string;
  delivery_method: string | null;
  sent_at: string | null;
  sent_by_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface Installment {
  id: string;
  sequence: number;
  due_on: string;
  amount: number;
  paid_amount: number;
  status: string;
}

export interface Plan {
  id: string;
  lease_id: string;
  property_id: string;
  tenant_name: string | null;
  total_amount: number;
  start_on: string;
  installment_count: number;
  frequency_months: number;
  grace_days: number;
  status: string;
  paid_amount: number;
  breached_at: string | null;
  notes: string | null;
  created_at: string;
  installments: Installment[];
}

export interface SyncBatch {
  id: string;
  direction: "export" | "import";
  system: string;
  status: string;
  period_from: string | null;
  period_to: string | null;
  property_id: string | null;
  entry_count: number;
  matched_count: number;
  conflict_count: number;
  external_batch_id: string | null;
  summary: string | null;
  created_at: string;
  payload?: Record<string, unknown>[];
}

export interface SyncConflict {
  id: string;
  batch_id: string;
  entity_type: string;
  entity_id: string | null;
  external_id: string | null;
  field: string;
  local_value: unknown;
  external_value: unknown;
  status: string;
  resolved_by_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface ChargeFacets {
  status: Record<string, number>;
  charge_type: Record<string, number>;
  source: Record<string, number>;
}

/* ------------------------------------------------------------------ queries */

export function useDashboard(params: Params) {
  return useQuery({
    queryKey: ["receivables", "dashboard", params],
    queryFn: () => api.get<Dashboard>("/receivables/dashboard", params),
    placeholderData: (prev) => prev,
  });
}

export function useLedger(leaseId: string) {
  return useQuery({ queryKey: ["receivables", "ledger", leaseId], queryFn: () => api.get<Ledger>(`/receivables/tenants/${leaseId}/ledger`) });
}

export function useSettings() {
  return useQuery({ queryKey: ["receivables", "settings"], queryFn: () => api.get<Settings>("/receivables/settings"), staleTime: 60_000 });
}

export function useCollections(params: Params) {
  return useQuery({ queryKey: ["receivables", "collections", params], queryFn: () => api.get<Collection[]>("/receivables/delinquency", params) });
}

export function usePlans(params: Params) {
  return useQuery({ queryKey: ["receivables", "plans", params], queryFn: () => api.get<Plan[]>("/receivables/payment-plans", params) });
}

/* ------------------------------------------------------------------ mutations */

/** Every receivables mutation refreshes the module (balances, aging and ledgers all move together). */
export function useReceivablesMutation<TBody = unknown, TOut = unknown>(path: string | ((body: TBody) => string), method: "post" | "put" = "post") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => {
      const p = typeof path === "function" ? path(body) : path;
      return method === "put" ? api.put<TOut>(p, body) : api.post<TOut>(p, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["receivables"] });
      qc.invalidateQueries({ queryKey: ["leases", "reconciliations"] });
      qc.invalidateQueries({ queryKey: ["timeline"] });
    },
  });
}

export function bucketPastDue(b: Buckets) {
  return b.d1_30 + b.d31_60 + b.d61_90 + b.d90_plus;
}

export function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
