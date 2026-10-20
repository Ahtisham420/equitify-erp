"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Params } from "@/lib/api";

export const ASSET_STATUSES = ["active", "held_for_sale", "disposed"] as const;
export const FIN_CATEGORIES = ["income", "expense", "capex", "debt_service", "reserve", "distribution"] as const;
export const MILESTONE_STATUSES = ["planned", "in_progress", "done", "missed", "cancelled"] as const;
export const DIMENSIONS = ["tenant", "brand", "industry", "guarantor", "lender", "geography"] as const;
export const WATCH_TRIGGERS = ["coverage", "occupancy", "tenant_credit", "maintenance", "covenant", "maturity", "variance"] as const;

export type FinCategory = (typeof FIN_CATEGORIES)[number];
export type Dimension = (typeof DIMENSIONS)[number];

export const GROUP_BY_LABELS: Record<string, string> = {
  property_type: "Property type",
  tenant: "Tenant",
  geography: "Geography",
  corridor: "Corridor",
  vintage: "Vintage",
  lender: "Lender",
  capital_partner: "Capital partner",
  territory: "Territory",
};

export const CATEGORY_LABELS: Record<string, string> = {
  income: "Income",
  expense: "Operating expense",
  capex: "Capital expenditure",
  debt_service: "Debt service",
  reserve: "Reserve deposit",
  distribution: "Distribution",
  noi: "NOI",
};

export const TRIGGER_LABELS: Record<string, string> = {
  coverage: "Coverage",
  occupancy: "Occupancy",
  tenant_credit: "Tenant credit",
  maintenance: "Maintenance backlog",
  covenant: "Covenant",
  maturity: "Debt maturity",
  variance: "Persistent variance",
};

export interface Drill {
  label: string;
  href: string;
}

export interface Metric {
  value: number | null;
  label: string | null;
  source: string | null;
  drill: Drill[];
}

export interface AssetListItem {
  id: string;
  property_id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  property_type: string | null;
  status: string;
  acquired_on: string | null;
  basis: number | null;
  current_value: number | null;
  manager_id: string | null;
  manager_name: string | null;
  noi_ttm: number | null;
  occupancy: number | null;
  leverage: number | null;
  coverage: number | null;
  yield_on_cost: number | null;
  open_watch: number;
  updated_at: string;
}

export interface CapitalLoan {
  id: string;
  lender_name: string;
  balance: number;
  annual_debt_service: number;
  rate: number | null;
  rate_type: string;
  maturity_on: string | null;
  covenant_state: string;
  share: number;
  href: string;
}

export interface CapitalPartner {
  partner_id: string;
  name: string;
  ownership_pct: number;
  commitment: number;
  funded: number;
  href: string;
}

export interface Asset {
  id: string;
  property_id: string;
  status: string;
  acquired_on: string | null;
  basis: number | null;
  equity_invested: number | null;
  current_value: number | null;
  value_as_of: string | null;
  hold_thesis: string | null;
  business_plan: string | null;
  target_hold_years: number | null;
  exit_cap_rate: number | null;
  target_exit_on: string | null;
  exit_assumptions: Record<string, unknown>;
  manager_id: string | null;
  uw_model_id: string | null;
  opportunity_id: string | null;
  closing_id: string | null;
  disposed_on: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  property_label: string;
  address_line: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  property_type: string | null;
  corridor: string | null;
  manager_name: string | null;
  kpis: Record<"occupancy" | "wale" | "noi" | "yield_on_cost" | "leverage" | "coverage" | "value" | "debt", Metric>;
  capital_structure: {
    debt_total: number | null;
    value: number | null;
    equity_invested: number | null;
    ltv: number | null;
    loans: CapitalLoan[];
    partners: CapitalPartner[] | null;
  };
  benchmark: {
    model_id: string;
    available: boolean;
    note?: string;
    name?: string | null;
    version?: number | null;
    approved_at?: string | null;
    outputs?: Record<string, number | null>;
    href?: string;
  } | null;
}

export interface AssetInput {
  property_id?: string;
  status?: string;
  acquired_on?: string | null;
  basis?: number | null;
  equity_invested?: number | null;
  current_value?: number | null;
  value_as_of?: string | null;
  hold_thesis?: string | null;
  business_plan?: string | null;
  target_hold_years?: number | null;
  exit_cap_rate?: number | null;
  target_exit_on?: string | null;
  manager_id?: string | null;
  uw_model_id?: string | null;
  notes?: string | null;
  provenance?: { source: string; observed_on: string | null; confidence: number; verified: boolean };
}

export interface AssetFacets {
  status: Record<string, number>;
  property_type: Record<string, number>;
  state: Record<string, number>;
}

export interface PortfolioTotals {
  asset_count: number;
  value: number | null;
  basis: number | null;
  noi_ttm: number | null;
  debt: number | null;
  debt_service: number | null;
  occupancy: number | null;
  wale: number | null;
  yield_on_cost: number | null;
  leverage: number | null;
  coverage: number | null;
}

export interface PortfolioGroup extends PortfolioTotals {
  key: string;
  label: string;
  measure: number | null;
  share_pct: number | null;
  asset_ids: string[];
  drill: string;
}

export interface Portfolio {
  group_by: string;
  measure_label: string;
  unavailable: string | null;
  totals: PortfolioTotals;
  metrics: Record<string, Metric>;
  groups: PortfolioGroup[];
}

export interface ConcentrationItem {
  key: string;
  label: string;
  amount: number | null;
  pct: number;
  limit_pct: number | null;
  limit_id: string | null;
  severity: string | null;
  breached: boolean;
  asset_ids: string[];
  drill: string;
}

export interface Concentration {
  dimensions: Record<Dimension, { measure: string; total: number | null; items: ConcentrationItem[]; unavailable: string | null }>;
  breaches: (ConcentrationItem & { dimension: Dimension })[];
}

export interface ConcentrationLimit {
  id: string;
  dimension: Dimension;
  key: string | null;
  max_pct: number;
  severity: string;
  is_active: boolean;
  notes: string | null;
  updated_at: string;
}

export interface TenantProfile {
  id: string;
  tenant_key: string;
  tenant_name: string;
  organization_id: string | null;
  brand: string | null;
  industry: string | null;
  credit_rating: string | null;
  credit_watch: boolean;
  notes: string | null;
  updated_at: string;
}

export interface WatchEntry {
  id: string;
  asset_id: string;
  asset_label: string | null;
  trigger: string;
  severity: string;
  status: "open" | "resolved" | "dismissed";
  detail: string | null;
  metric_value: number | null;
  threshold: number | null;
  source_href: string | null;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  alert_id: string | null;
}

export interface Variance {
  id: string;
  asset_id: string;
  asset_label: string | null;
  period: string;
  window: "month" | "ttm";
  basis: "budget" | "underwriting";
  account: string;
  actual: number | null;
  benchmark: number | null;
  variance: number | null;
  variance_pct: number | null;
  owner_id: string | null;
  owner_name: string | null;
  explanation: string | null;
  status: "required" | "submitted" | "accepted" | "rejected";
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface Milestone {
  id: string;
  asset_id: string;
  title: string;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_on: string | null;
  status: string;
  completed_on: string | null;
  task_id: string | null;
  overdue: boolean;
  updated_at: string;
}

export interface FinancialRow {
  id: string;
  asset_id: string;
  period: string;
  account: string;
  category: FinCategory;
  amount: number;
  source: string;
  verified: boolean;
  verified_at: string | null;
  is_current: boolean;
  notes: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface FinancialInput {
  period: string;
  account: string;
  category: FinCategory;
  amount: number;
  notes?: string | null;
}

export interface PerfWindow {
  actual: number | null;
  budget: number | null;
  uw: number | null;
  var_budget: number | null;
  var_budget_pct: number | null;
  fav_budget: boolean | null;
  flag_budget: boolean;
  var_uw: number | null;
  var_uw_pct: number | null;
  fav_uw: boolean | null;
  flag_uw: boolean;
}

export interface PerfLine {
  account: string;
  category: string;
  is_summary: boolean;
  monthly: { period: string; actual: number | null; budget: number | null; uw: number | null }[];
  month: PerfWindow;
  ttm: PerfWindow;
  /** keyed "month:budget" | "month:underwriting" | "ttm:budget" | "ttm:underwriting" */
  explanations: Record<string, { id: string; status: Variance["status"] } | null>;
  drill: string;
}

export interface Performance {
  asset_id: string;
  year: number;
  month: number;
  period: string;
  ttm_start: string;
  ttm_end: string;
  months: string[];
  budget_available: boolean;
  budget_ids: string[];
  uw_available: boolean;
  uw_model_id: string | null;
  uw_note: string;
  thresholds: { pct: number; amount: number };
  lines: PerfLine[];
  summary: PerfLine[];
}

export interface CashFlowRow {
  period: string;
  income: number;
  expense: number;
  noi: number;
  capex: number;
  reserves: number;
  debt_service: number;
  debt_service_estimated: boolean;
  cash_flow_before_debt: number;
  cash_flow_after_debt: number;
  distributions: number;
  net_cash_flow: number;
  cumulative: number;
}

export interface CashFlow {
  start: string;
  end: string;
  rows: CashFlowRow[];
  totals: Record<string, number>;
  asset_count: number;
  drill: Drill[];
  note: string;
}

export interface AssetSettings {
  variance_pct: number;
  variance_amount: number;
  watch_min_dscr: number;
  watch_min_occupancy: number;
  maturity_months: number;
  persistent_variance_months: number;
  maintenance_backlog: number;
  maintenance_overdue_days: number;
}

export interface Observation {
  id: string;
  field: string;
  value: unknown;
  source: string;
  observed_on: string | null;
  confidence: number;
  verification: string;
  recorded_at: string;
}

/* ------------------------------------------------------------------ queries */

export function useAsset(id: string) {
  return useQuery({ queryKey: ["assets", id], queryFn: () => api.get<Asset>(`/assets/${id}`) });
}

export function useAssetByProperty(propertyId: string) {
  return useQuery({
    queryKey: ["assets", "by-property", propertyId],
    queryFn: async () => {
      try {
        return await api.get<Asset>(`/assets/by-property/${propertyId}`);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
  });
}

export function useAssetFacets(params: Params) {
  return useQuery({
    queryKey: ["assets", "facets", params],
    queryFn: () => api.get<AssetFacets>("/assets/facets", params),
    placeholderData: (prev) => prev,
  });
}

export function usePortfolio(groupBy: string, params: Params = {}) {
  return useQuery({
    queryKey: ["assets", "portfolio", groupBy, params],
    queryFn: () => api.get<Portfolio>("/assets/portfolio", { ...params, group_by: groupBy }),
    placeholderData: (prev) => prev,
  });
}

export function usePortfolioCashFlow(months = 12, params: Params = {}) {
  return useQuery({
    queryKey: ["assets", "portfolio-cash-flow", months, params],
    queryFn: () => api.get<CashFlow>("/assets/portfolio/cash-flow", { ...params, months }),
  });
}

export function useConcentration() {
  return useQuery({ queryKey: ["assets", "concentration"], queryFn: () => api.get<Concentration>("/assets/concentration") });
}

export function useConcentrationLimits() {
  return useQuery({ queryKey: ["assets", "limits"], queryFn: () => api.get<ConcentrationLimit[]>("/assets/concentration-limits") });
}

export function useTenantProfiles(q?: string) {
  return useQuery({ queryKey: ["assets", "tenant-profiles", q ?? ""], queryFn: () => api.get<TenantProfile[]>("/assets/tenant-profiles", { q }) });
}

export function useWatchlist(params: { status?: string[]; asset_id?: string; trigger?: string[]; limit?: number } = {}) {
  return useQuery({ queryKey: ["assets", "watchlist", params], queryFn: () => api.get<WatchEntry[]>("/assets/watchlist", params) });
}

export function useVariances(params: { status?: string[]; unexplained?: boolean; asset_id?: string; limit?: number } = {}) {
  return useQuery({ queryKey: ["assets", "variances", params], queryFn: () => api.get<Variance[]>("/assets/variances", params) });
}

export function useFinancials(assetId: string, params: { period_from?: string; period_to?: string; category?: string[]; account?: string; include_history?: boolean } = {}) {
  return useQuery({
    queryKey: ["assets", assetId, "financials", params],
    queryFn: () => api.get<FinancialRow[]>(`/assets/${assetId}/financials`, params),
  });
}

export function usePerformance(assetId: string, year: number, month?: number | null) {
  return useQuery({
    queryKey: ["assets", assetId, "performance", year, month ?? null],
    queryFn: () => api.get<Performance>(`/assets/${assetId}/performance`, { year, month: month ?? undefined }),
    placeholderData: (prev) => prev,
  });
}

export function useCashFlow(assetId: string, months = 12) {
  return useQuery({
    queryKey: ["assets", assetId, "cash-flow", months],
    queryFn: () => api.get<CashFlow>(`/assets/${assetId}/cash-flow`, { months }),
  });
}

export function useMilestones(assetId: string) {
  return useQuery({ queryKey: ["assets", assetId, "milestones"], queryFn: () => api.get<Milestone[]>(`/assets/${assetId}/milestones`) });
}

export function useAssetHistory(assetId: string, enabled = true) {
  return useQuery({ queryKey: ["assets", assetId, "history"], queryFn: () => api.get<Observation[]>(`/assets/${assetId}/history`), enabled });
}

export function useAssetSettings() {
  return useQuery({ queryKey: ["assets", "settings"], queryFn: () => api.get<AssetSettings>("/assets/settings") });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidate() {
  const qc = useQueryClient();
  return (assetId?: string) => {
    qc.invalidateQueries({ queryKey: ["assets"] });
    if (assetId) qc.invalidateQueries({ queryKey: ["timeline", "asset", assetId] });
  };
}

export function useSaveAsset(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: AssetInput) => (id ? api.patch<Asset>(`/assets/${id}`, data) : api.post<Asset>("/assets", data)),
    onSuccess: (a) => {
      invalidate(a.id);
    },
  });
}

export function useDeleteAsset() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/assets/${id}`), onSuccess: () => invalidate() });
}

export function useAddFinancial(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (row: FinancialInput) => api.post<FinancialRow>(`/assets/${assetId}/financials`, row),
    onSuccess: () => invalidate(assetId),
  });
}

export function useBulkFinancials(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { rows: FinancialInput[]; source?: "manual" | "import" }) =>
      api.post<{ rows: number; created: number; superseded: number; unchanged: number }>(`/assets/${assetId}/financials/bulk`, body),
    onSuccess: () => invalidate(assetId),
  });
}

export function useVerifyFinancials(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { period_from: string; period_to: string }) => api.post<{ verified: number }>(`/assets/${assetId}/financials/verify`, body),
    onSuccess: () => invalidate(assetId),
  });
}

export function useDeleteFinancial(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/assets/financials/${id}`), onSuccess: () => invalidate(assetId) });
}

export function useExplainVariance(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { period: string; window: "month" | "ttm"; basis: "budget" | "underwriting"; account: string; actual: number | null; benchmark: number | null; explanation: string; owner_id?: string | null }) =>
      api.post<Variance>(`/assets/${assetId}/variances/explain`, body),
    onSuccess: () => invalidate(assetId),
  });
}

export function useSubmitVariance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, explanation }: { id: string; explanation: string }) => api.post<Variance>(`/assets/variances/${id}/submit`, { explanation }),
    onSuccess: (v) => invalidate(v.asset_id),
  });
}

export function useReviewVariance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: "accepted" | "rejected"; note?: string }) =>
      api.post<Variance>(`/assets/variances/${id}/review`, { decision, note }),
    onSuccess: (v) => invalidate(v.asset_id),
  });
}

export function useScanVariances(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ year, month }: { year: number; month?: number | null }) =>
      api.post<{ created: number }>(`/assets/${assetId}/variances/scan`, undefined, { year, month: month ?? undefined }),
    onSuccess: () => invalidate(assetId),
  });
}

export function useSaveMilestone(assetId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Partial<Pick<Milestone, "title" | "description" | "owner_id" | "due_on" | "status">> }) =>
      id ? api.patch<Milestone>(`/assets/milestones/${id}`, data) : api.post<Milestone>(`/assets/${assetId}/milestones`, data),
    onSuccess: () => {
      invalidate(assetId);
    },
  });
}

export function useScanWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId?: string) =>
      api.post<{ assets: number; opened: number; refreshed: number; cleared: number; concentration_breaches: number }>("/assets/watchlist/scan", undefined, { asset_id: assetId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useResolveWatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: "resolved" | "dismissed"; note: string }) =>
      api.post<WatchEntry>(`/assets/watchlist/${id}/resolve`, { status, note }),
    onSuccess: (e) => invalidate(e.asset_id),
  });
}

export function useCheckConcentration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ breaches: ConcentrationItem[] }>("/assets/concentration/check"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assets", "concentration"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useSaveLimit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Omit<ConcentrationLimit, "id" | "updated_at"> }) =>
      id ? api.patch<ConcentrationLimit>(`/assets/concentration-limits/${id}`, data) : api.post<ConcentrationLimit>("/assets/concentration-limits", data),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteLimit() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/assets/concentration-limits/${id}`), onSuccess: () => invalidate() });
}

export function useSaveTenantProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: Omit<TenantProfile, "id" | "tenant_key" | "updated_at">) => api.post<TenantProfile>("/assets/tenant-profiles", data),
    onSuccess: () => invalidate(),
  });
}

export function useSaveAssetSettings() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (data: AssetSettings) => api.put<AssetSettings>("/assets/settings", data), onSuccess: () => invalidate() });
}
