"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const UW_STATUSES = ["draft", "submitted", "approved", "rejected", "superseded"] as const;
export const TEMPLATES = ["stnl", "multi_tenant_retail", "gas_convenience", "medical", "ground_lease", "land"] as const;
export const TEMPLATE_LABELS: Record<string, string> = {
  stnl: "Single-tenant net lease",
  multi_tenant_retail: "Multi-tenant retail",
  gas_convenience: "Gas / convenience",
  medical: "Medical",
  ground_lease: "Ground lease",
  land: "Land",
};
export const PROPERTY_TYPE_TEMPLATE: Record<string, string> = {
  stnl: "stnl", retail: "multi_tenant_retail", multi_tenant_retail: "multi_tenant_retail", gas_convenience: "gas_convenience",
  medical: "medical", ground_lease: "ground_lease", land: "land",
};

/** Sourced value: every material assumption carries its evidence. */
export interface SV {
  value: number | null;
  source?: string | null;
  comp_id?: string | null;
  comp_ids?: string[];
  comp_set_id?: string | null;
  document_id?: string | null;
  note?: string | null;
}

export type Assumptions = Record<string, unknown> & {
  template?: string;
  model_type?: "income" | "land";
  leases?: LeaseRow[];
  expenses?: ExpenseRow[];
  capex?: { year: number | null; amount: number | null; description?: string | null }[];
};

export interface LeaseRow {
  id: string;
  tenant: string | null;
  suite: string | null;
  space_id: string | null;
  lease_id: string | null;
  row_source?: string | null;
  area_sf: number | null;
  vacant: boolean;
  commencement_on: string | null;
  expiration_on: string | null;
  base_rent_annual: SV;
  rent_psf: number | null;
  rent_steps: { start_on: string; annual_rent: number | null }[];
  escalation_pct: number | null;
  recovery_type: string;
  expense_stop_psf: number | null;
  recovery_share_pct: number | null;
  fixed_recovery_annual: number | null;
  abatements: { start_on: string; end_on: string; pct: number | null }[];
  percentage_rent: { rate_pct: number | null; sales_annual: number | null; sales_growth_pct: number | null; breakpoint: number | null };
  options: { term_years: number | null; rent_change_pct: number | null }[];
  renewal_probability_pct: SV;
  downtime_months: number | null;
  market_rent_psf: SV;
  new_lease_term_years: number | null;
  ti_new_psf: number | null;
  ti_renewal_psf: number | null;
  lc_new_pct: number | null;
  lc_renewal_pct: number | null;
  free_rent_new_months: number | null;
  tenant_credit: string | null;
}

export interface ExpenseRow {
  id: string;
  name: string;
  category: string;
  annual_amount: SV;
  growth_pct: number | null;
  recoverable: boolean;
}

export interface Scenario {
  key: string;
  name: string;
  kind: "base" | "downside" | "upside" | "named";
  overrides: Record<string, unknown>;
  outputs?: Outputs;
}

export type Outputs = Record<string, number | string | null | number[] | Record<string, number | null>> & {
  purchase_price?: number | null;
  noi_year1?: number | null;
  going_in_cap?: number | null;
  stabilized_cap?: number | null;
  loan_amount?: number | null;
  dscr?: number | null;
  debt_yield?: number | null;
  cash_on_cash?: number | null;
  irr?: number | null;
  unlevered_irr?: number | null;
  equity_multiple?: number | null;
  exit_value?: number | null;
  peak_equity?: number | null;
  breakeven_occupancy?: number | null;
  cash_flows_unlevered?: number[];
  cash_flows_levered?: number[];
};

export interface UwListItem {
  id: string;
  root_id: string | null;
  name: string;
  template: string;
  version: number;
  status: string;
  is_locked: boolean;
  is_latest: boolean;
  property_id: string | null;
  opportunity_id: string | null;
  property_label: string | null;
  purchase_price: number | null;
  irr: number | null;
  going_in_cap: number | null;
  equity_multiple: number | null;
  unsourced_count: number;
  approved_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface UwModel {
  id: string;
  root_id: string | null;
  parent_id: string | null;
  name: string;
  template: string;
  version: number;
  status: string;
  is_locked: boolean;
  is_latest: boolean;
  change_note: string | null;
  property_id: string | null;
  opportunity_id: string | null;
  comp_set_id: string | null;
  property_label: string | null;
  opportunity_label: string | null;
  assumptions: Assumptions;
  scenarios: Scenario[];
  outputs: Outputs;
  annual: Record<string, number | string>[];
  warnings: string[];
  unsourced: { path: string; label: string }[];
  simulation: Simulation | null;
  calculated_at: string | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  decision_note: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  can_approve_amount: boolean;
}

export interface VersionItem {
  id: string;
  version: number;
  status: string;
  is_locked: boolean;
  is_latest: boolean;
  change_note: string | null;
  created_by_name: string | null;
  created_at: string;
  approved_at: string | null;
  purchase_price: number | null;
  irr: number | null;
}

export interface UwEvent {
  id: string;
  model_id: string;
  action: string;
  actor_name: string | null;
  at: string;
  note: string | null;
  details: Record<string, unknown>;
}

export interface DiffOut {
  base_id: string;
  other_id: string;
  base_version: number;
  other_version: number;
  assumptions: { path: string; from: unknown; to: unknown }[];
  outputs: { key: string; from: number | null; to: number | null; delta: number | null }[];
}

export interface SensitivityRow {
  variable: string;
  label: string;
  unit: string;
  step: number;
  low: number | null;
  high: number | null;
  swing: number;
  points: { shift: number; value: number | null }[];
}

export interface Sensitivity {
  metric: string;
  base: number | null;
  rows: SensitivityRow[];
}

export interface SimMetric {
  count: number;
  mean?: number;
  min?: number;
  max?: number;
  p5?: number;
  p10?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
  p95?: number;
  histogram?: { from: number; to: number; count: number }[];
}

export interface SimRange {
  path: string;
  label?: string | null;
  min: number;
  max: number;
  mode?: number | null;
}

export interface Simulation {
  iterations: number;
  seed: number;
  ranges: SimRange[];
  metrics: Record<string, SimMetric>;
  prob_irr_below_target?: number;
  target_irr?: number;
  run_at?: string;
  run_by?: string;
  stored?: boolean;
}

export interface VarianceCell {
  uw: number | null;
  actual: number | null;
  variance: number | null;
  variance_pct: number | null;
}

export interface Variance {
  model_id: string;
  version: number;
  available: boolean;
  reason: string | null;
  asset_id: string | null;
  rows: ({ year: number; months_actual: number } & Record<"income" | "expense" | "noi" | "capex" | "debt_service", VarianceCell>)[];
}

/* ---------------------------------------------------------------- path helpers */

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Immutable set of a dotted path (creates intermediate objects). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".");
  const clone = (Array.isArray(obj) ? [...obj] : { ...(obj as object) }) as Record<string, unknown>;
  const [head, ...rest] = parts;
  clone[head] = rest.length ? setPath((clone[head] ?? {}) as object, rest.join("."), value) : value;
  return clone as T;
}

export function svValue(x: unknown): number | null {
  if (x && typeof x === "object" && "value" in (x as Record<string, unknown>)) {
    const v = (x as SV).value;
    return v === null || v === undefined ? null : Number(v);
  }
  return typeof x === "number" ? x : null;
}

export function isSourced(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const s = x as SV;
  return !!(s.source || s.comp_id || (s.comp_ids && s.comp_ids.length) || s.document_id);
}

export const MODEL_PATHS: { path: string; label: string }[] = [
  { path: "acquisition.purchase_price", label: "Purchase price" },
  { path: "acquisition.closing_cost_pct", label: "Closing costs %" },
  { path: "acquisition.hold_years", label: "Hold years" },
  { path: "financing.interest_rate", label: "Interest rate %" },
  { path: "financing.ltv_max", label: "Max LTV %" },
  { path: "exit.exit_cap", label: "Exit cap %" },
  { path: "exit.selling_cost_pct", label: "Selling costs %" },
  { path: "revenue.general_vacancy_pct", label: "General vacancy %" },
  { path: "revenue.credit_loss_pct", label: "Credit loss %" },
  { path: "revenue.market_rent_growth_pct", label: "Market rent growth %" },
  { path: "expense_settings.expense_growth_pct", label: "Expense growth %" },
  { path: "expense_settings.mgmt_fee_pct", label: "Management fee %" },
  { path: "leases.*.renewal_probability_pct", label: "Renewal probability % (all leases)" },
  { path: "leases.*.downtime_months", label: "Downtime months (all leases)" },
  { path: "leases.*.market_rent_psf", label: "Market rent $/SF (all leases)" },
  { path: "leases.*.ti_new_psf", label: "New-lease TI $/SF (all leases)" },
  { path: "expenses.*.growth_pct", label: "Expense line growth % (all)" },
];

export const LAND_PATHS: { path: string; label: string }[] = [
  { path: "acquisition.purchase_price", label: "Purchase price" },
  { path: "land.bulk_price_per_usable_acre", label: "Exit price per usable acre" },
  { path: "land.entitlement_months", label: "Entitlement months" },
  { path: "land.entitlement_cost", label: "Entitlement cost" },
  { path: "land.utilities_cost", label: "Utilities cost" },
  { path: "land.site_work_cost", label: "Site work cost" },
  { path: "land.absorption_months", label: "Absorption months" },
  { path: "land.ground_lease_cap", label: "Ground lease cap %" },
  { path: "financing.interest_rate", label: "Interest rate %" },
];

export const OUTPUT_LABELS: Record<string, string> = {
  purchase_price: "Purchase price",
  closing_costs: "Closing costs",
  total_capitalization: "Total capitalization",
  loan_amount: "Loan amount",
  equity: "Equity",
  ltv: "LTV",
  noi_year1: "Year 1 NOI",
  going_in_cap: "Going-in cap",
  stabilized_cap: "Stabilized cap",
  dscr: "DSCR",
  debt_yield: "Debt yield",
  cash_on_cash: "Cash-on-cash (Y1)",
  avg_cash_on_cash: "Avg cash-on-cash",
  unlevered_irr: "Unlevered IRR",
  irr: "Levered IRR",
  equity_multiple: "Equity multiple",
  exit_value: "Exit value",
  exit_cap: "Exit cap",
  peak_equity: "Peak equity",
  breakeven_occupancy: "Break-even occupancy",
  profit: "Profit",
};

/** Formats an output by key: percents, multiples and money. */
export function formatOutput(key: string, v: unknown): string {
  if (v === null || v === undefined || typeof v !== "number" || Number.isNaN(v)) return "—";
  if (["going_in_cap", "stabilized_cap", "debt_yield", "cash_on_cash", "avg_cash_on_cash", "unlevered_irr", "irr", "exit_cap", "breakeven_occupancy", "ltv", "interest_rate", "occupancy_year1", "usable_pct"].includes(key))
    return `${v.toFixed(2)}%`;
  if (["equity_multiple", "unlevered_multiple"].includes(key)) return `${v.toFixed(2)}x`;
  if (key === "dscr") return `${v.toFixed(2)}x`;
  if (["hold_years", "walt_years", "stabilized_year"].includes(key)) return v.toFixed(1);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

/* ---------------------------------------------------------------- hooks */

export function useUwModel(id: string) {
  return useQuery({ queryKey: ["uw-models", id], queryFn: () => api.get<UwModel>(`/uw-models/${id}`) });
}

function useModelMutation<TBody>(id: string, fn: (body: TBody) => Promise<UwModel>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (m) => {
      qc.setQueryData(["uw-models", m.id], m);
      qc.invalidateQueries({ queryKey: ["uw-models", "list"] });
      qc.invalidateQueries({ queryKey: ["uw-models", id, "versions"] });
      qc.invalidateQueries({ queryKey: ["uw-models", id, "events"] });
      qc.invalidateQueries({ queryKey: ["uw-models", id, "sensitivity"] });
      if (m.id !== id) qc.invalidateQueries({ queryKey: ["uw-models", id] });
    },
  });
}

export function useCreateUwModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; template: string; property_id?: string | null; opportunity_id?: string | null; comp_set_id?: string | null; analysis_start?: string | null; seed_tenants?: string }) =>
      api.post<UwModel>("/uw-models", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["uw-models"] }),
  });
}

export function useSaveAssumptions(id: string) {
  return useModelMutation(id, (body: { assumptions: Assumptions; change_note?: string | null }) => api.put<UwModel>(`/uw-models/${id}/assumptions`, body));
}

export function useSaveScenarios(id: string) {
  return useModelMutation(id, (body: { scenarios: Omit<Scenario, "outputs">[]; change_note?: string | null }) => api.put<UwModel>(`/uw-models/${id}/scenarios`, body));
}

export function useNewVersion(id: string) {
  return useModelMutation(id, (body: { change_note?: string | null }) => api.post<UwModel>(`/uw-models/${id}/versions`, body));
}

export function useDecision(id: string, action: "submit" | "approve" | "reject") {
  return useModelMutation(id, (body: { note?: string | null; acknowledge_unsourced?: boolean }) => api.post<UwModel>(`/uw-models/${id}/${action}`, body));
}

export function useRecalculate(id: string) {
  return useModelMutation(id, () => api.post<UwModel>(`/uw-models/${id}/recalculate`));
}

export function useVersions(id: string, rootId?: string | null) {
  return useQuery({ queryKey: ["uw-models", id, "versions", rootId], queryFn: () => api.get<VersionItem[]>(`/uw-models/${id}/versions`) });
}

export function useUwEvents(id: string) {
  return useQuery({ queryKey: ["uw-models", id, "events"], queryFn: () => api.get<UwEvent[]>(`/uw-models/${id}/events`) });
}

export function useDiff(id: string, against: string | null) {
  return useQuery({
    queryKey: ["uw-models", id, "diff", against],
    queryFn: () => api.get<DiffOut>(`/uw-models/${id}/diff`, against ? { against } : undefined),
    retry: false,
  });
}

export function useSensitivity(id: string, metric: string, scenario: string | null, updatedAt: string) {
  return useQuery({
    queryKey: ["uw-models", id, "sensitivity", metric, scenario, updatedAt],
    queryFn: () => api.get<Sensitivity>(`/uw-models/${id}/sensitivity`, { metric, scenario }),
  });
}

export function useSimulate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { iterations: number; seed: number; ranges: SimRange[]; target_irr?: number | null; scenario_key?: string | null }) =>
      api.post<Simulation>(`/uw-models/${id}/simulate`, body),
    onSuccess: (r) => {
      if (r.stored) qc.invalidateQueries({ queryKey: ["uw-models", id] });
    },
  });
}

export function useVariance(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["uw-models", id, "variance"], queryFn: () => api.get<Variance>(`/uw-models/${id}/variance`), enabled, retry: false });
}
