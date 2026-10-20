"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const COMMISSION_STATUSES = ["forecast", "earned", "invoiced", "paid", "cancelled"] as const;
export const SIDES = ["listing", "buyer", "tenant", "landlord", "dual", "other"] as const;
export const RECONCILIATION_STATES = ["unpaid", "matched", "short", "over"] as const;
export const PRODUCTION_GROUPS = [
  { value: "agent", label: "Agent" },
  { value: "team", label: "Team" },
  { value: "property_type", label: "Property type" },
  { value: "source", label: "Source" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
] as const;

export const STATUS_TONES: Record<string, "neutral" | "amber" | "blue" | "green" | "red" | "sky"> = {
  forecast: "sky",
  earned: "blue",
  invoiced: "amber",
  paid: "green",
  cancelled: "neutral",
  unpaid: "neutral",
  matched: "green",
  short: "red",
  over: "amber",
  issued: "amber",
  void: "neutral",
};

export interface Participant {
  agent_id: string;
  share_pct: number;
  override_agent_pct: number | null;
}

export interface Deduction {
  label: string;
  amount: number;
  agent_id: string | null;
}

export interface CommissionListItem {
  id: string;
  brokerage_deal_id: string | null;
  title: string;
  agent_id: string | null;
  agent_name: string | null;
  team_id: string | null;
  property_type: string | null;
  source: string | null;
  side: string | null;
  deal_volume: number | null;
  gross: number;
  status: string;
  probability: number | null;
  expected_close_on: string | null;
  expected_on: string | null;
  earned_on: string | null;
  paid_on: string | null;
  paid_total: number;
  discrepancy: number;
  reconciliation_status: string;
  approved_at: string | null;
  my_net: number | null;
  house_amount: number | null;
  updated_at: string;
}

export interface Split {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  role: string;
  label: string | null;
  share_pct: number | null;
  gci_amount: number;
  agent_pct: number | null;
  amount: number;
  deductions: number;
  net_amount: number;
  ytd_gci_before: number | null;
  capped: boolean;
  detail: { plan?: string | null; bands?: { gci: number; agent_pct: number; amount: number; override?: boolean }[] };
}

export interface Invoice {
  id: string;
  commission_id: string;
  commission_title: string | null;
  invoice_number: string;
  bill_to: string;
  issued_on: string;
  due_on: string;
  amount: number;
  status: string;
  rendered_text: string;
  void_reason: string | null;
  created_at: string;
}

export interface Payment {
  id: string;
  commission_id: string;
  invoice_id: string | null;
  amount: number;
  received_on: string;
  reference: string | null;
  method: string | null;
  note: string | null;
  created_at: string;
}

export interface Commission extends CommissionListItem {
  property_id: string | null;
  split_plan_id: string | null;
  participants: Participant[];
  referral_party: string | null;
  referral_pct: number | null;
  referral_amount: number | null;
  deductions: Deduction[];
  agent_net_total: number | null;
  calc: { referral?: number; net_gci?: number; house?: number; deductions_total?: number };
  approved_by_id: string | null;
  released_at: string | null;
  release_note: string | null;
  notes: string | null;
  created_at: string;
  splits: Split[];
  invoices: Invoice[];
  payments: Payment[];
  deal: { id: string; label: string | null; stage: string | null; probability: number | null; expected_close_on: string | null } | null;
  compliance: { complete: boolean; reasons: string[] };
  restricted: boolean;
}

export interface CommissionInput {
  brokerage_deal_id?: string | null;
  title?: string | null;
  agent_id?: string | null;
  property_id?: string | null;
  property_type?: string | null;
  source?: string | null;
  side?: string | null;
  deal_volume?: number | null;
  gross?: number;
  probability?: number | null;
  expected_close_on?: string | null;
  expected_on?: string | null;
  split_plan_id?: string | null;
  participants?: Participant[];
  referral_party?: string | null;
  referral_pct?: number | null;
  referral_amount?: number | null;
  deductions?: Deduction[];
  notes?: string | null;
}

export interface CommissionEvent {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  at: string;
  actor_name: string | null;
  note: string | null;
}

export interface Facets {
  status: Record<string, number>;
  side: Record<string, number>;
  property_type: Record<string, number>;
  reconciliation_status: Record<string, number>;
}

export interface ForecastBucket {
  month: string;
  weighted: number;
  unweighted: number;
  count: number;
}

export interface ForecastItem {
  id: string;
  kind: "commission" | "deal";
  title: string | null;
  status: string | null;
  agent_id: string | null;
  amount: number;
  probability: number | null;
  weight: number;
  weighted: number;
  expected_on: string | null;
  bucket: string;
}

export interface Forecast {
  start: string;
  months: ForecastBucket[];
  past_due: ForecastBucket;
  unscheduled: ForecastBucket;
  total_weighted: number;
  total_unweighted: number;
  items: ForecastItem[];
  pipeline_included: boolean;
  restricted: boolean;
}

export interface Accuracy {
  months: { month: string; forecast: number | null; forecast_3m: number | null; actual: number; variance: number | null; accuracy_pct: number | null }[];
  average_accuracy_pct: number | null;
  snapshots: number;
}

export interface ProductionRow {
  key: string;
  label: string;
  count: number;
  volume: number;
  gci: number;
  avg_deal_size: number | null;
  avg_gci: number | null;
  cycle_time_days: number | null;
  deals_total: number;
  deals_closed: number;
  deals_lost: number;
  conversion_pct: number | null;
  stage_counts: Record<string, number>;
}

export interface Production {
  group_by: string;
  start: string;
  end: string;
  rows: ProductionRow[];
  totals: { count: number; volume: number; gci: number; avg_deal_size: number | null; cycle_time_days: number | null; deals_total: number; deals_closed: number };
  pipeline_available: boolean;
  restricted: boolean;
}

export interface PlanTier {
  min_ytd_gci: number;
  agent_pct: number;
}

export interface SplitPlan {
  id: string;
  name: string;
  description: string | null;
  tiers: PlanTier[];
  annual_cap: number | null;
  is_default: boolean;
  is_active: boolean;
  agent_count: number;
  updated_at: string;
}

export interface AgentPlan {
  agent_id: string;
  agent_name: string | null;
  team_id: string | null;
  plan_id: string | null;
  plan_name: string | null;
  effective_from: string | null;
  ytd_gci: number;
  ytd_house: number;
}

export interface DealOption {
  id: string;
  label: string;
  stage: string | null;
  agent_id: string | null;
  expected_close_on: string | null;
  probability: number | null;
  gross_commission_estimate: number | null;
  has_commission: boolean;
}

const KEY = "commissions";

export function useCommission(id: string | null) {
  return useQuery({ queryKey: [KEY, "detail", id], queryFn: () => api.get<Commission>(`/commissions/${id}`), enabled: !!id });
}

export function useCommissionEvents(id: string | null) {
  return useQuery({ queryKey: [KEY, "detail", id, "events"], queryFn: () => api.get<CommissionEvent[]>(`/commissions/${id}/events`), enabled: !!id });
}

export function useSaveCommission(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CommissionInput) => (id ? api.patch<Commission>(`/commissions/${id}`, body) : api.post<Commission>("/commissions", body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useCommissionAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: "earn" | "approve" | "cancel" | "invoices" | "payments" | "release"; body?: unknown }) =>
      api.post<unknown>(`/commissions/${id}/${action}`, body ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDealOptions(enabled: boolean) {
  return useQuery({ queryKey: [KEY, "deal-options"], queryFn: () => api.get<DealOption[]>("/commissions/deal-options"), enabled, staleTime: 30_000 });
}

export function useSplitPlans(enabled = true) {
  return useQuery({ queryKey: [KEY, "plans"], queryFn: () => api.get<SplitPlan[]>("/commissions/split-plans"), enabled });
}

export function useAgentPlans(enabled = true) {
  return useQuery({ queryKey: [KEY, "agent-plans"], queryFn: () => api.get<AgentPlan[]>("/commissions/agent-plans"), enabled });
}

export function useSavePlan(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<SplitPlan, "id" | "agent_count" | "updated_at">) =>
      id ? api.put<SplitPlan>(`/commissions/split-plans/${id}`, body) : api.post<SplitPlan>("/commissions/split-plans", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useAssignPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, plan_id }: { agentId: string; plan_id: string | null }) => api.put<void>(`/commissions/agent-plans/${agentId}`, { plan_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<Invoice>(`/commissions/invoices/${id}/void`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
