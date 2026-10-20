"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Params } from "@/lib/api";

export const LOAN_STATUSES = ["active", "paid_off", "defeased", "refinanced", "default"] as const;
export const LOAN_TYPES = ["senior", "mezzanine", "bridge", "construction", "cmbs", "agency", "bank", "life_company", "seller_financing", "other"] as const;
export const RATE_TYPES = ["fixed", "floating"] as const;
export const RECOURSE_TYPES = ["non_recourse", "partial", "full"] as const;
export const PREPAYMENT_TYPES = ["none", "open", "lockout", "yield_maintenance", "defeasance", "step_down"] as const;
export const COVENANT_KINDS = ["dscr", "debt_yield", "ltv", "occupancy", "net_worth"] as const;
export const FREQUENCIES = ["monthly", "quarterly", "semiannual", "annual"] as const;
export const RESERVE_TYPES = ["tax", "insurance", "replacement", "ti_lc", "interest", "capex", "debt_service", "other"] as const;
export const REPORT_TYPES = ["financial_statements", "operating_statement", "rent_roll", "compliance_certificate", "budget", "insurance_certificate", "tax_returns", "other"] as const;
export const COVENANT_STATES = ["pass", "watch", "projected_breach", "breach", "insufficient_data", "none"] as const;

export const COVENANT_KIND_LABELS: Record<string, string> = {
  dscr: "DSCR",
  debt_yield: "Debt yield",
  ltv: "LTV",
  occupancy: "Occupancy",
  net_worth: "Guarantor net worth",
};

export const COVENANT_STATE_LABELS: Record<string, string> = {
  pass: "Pass",
  watch: "Watch",
  projected_breach: "Projected breach",
  breach: "Breach",
  insufficient_data: "Insufficient data",
  none: "No covenants",
};

/** Tone for covenant states (StatusBadge has no map for projected_breach / insufficient_data). */
export const COVENANT_STATE_TONES: Record<string, "green" | "amber" | "red" | "neutral"> = {
  pass: "green",
  watch: "amber",
  projected_breach: "red",
  breach: "red",
  insufficient_data: "neutral",
  none: "neutral",
};

export interface Guarantor {
  kind: "person" | "organization";
  person_id: string | null;
  organization_id: string | null;
  name: string | null;
  guaranty_type: "payment" | "carveout" | "completion" | "environmental" | "other";
  limit_amount: number | null;
}

export interface Prepayment {
  type: (typeof PREPAYMENT_TYPES)[number];
  lockout_end: string | null;
  open_from: string | null;
  step_down: { until: string; pct: number }[];
  ym_floor_pct: number | null;
  treasury_rate: number | null;
  defeasance_fee: number | null;
  notes: string | null;
}

export interface LoanListItem {
  id: string;
  name: string | null;
  loan_number: string | null;
  label: string;
  property_id: string | null;
  property_label: string | null;
  asset_id: string | null;
  lender_name: string | null;
  loan_type: string;
  current_balance: number | null;
  rate: number | null;
  rate_type: string;
  maturity_on: string | null;
  months_to_maturity: number | null;
  in_refi_window: boolean;
  cap_expires_on: string | null;
  status: string;
  covenant_state: string;
  updated_at: string;
}

export interface Collateral {
  id: string;
  property_id: string;
  property_label: string | null;
  allocated_amount: number | null;
  release_price: number | null;
  is_primary: boolean;
}

export interface Loan {
  id: string;
  name: string | null;
  loan_number: string | null;
  property_id: string | null;
  asset_id: string | null;
  lender_organization_id: string | null;
  lender_name: string | null;
  loan_type: string;
  original_balance: number | null;
  current_balance: number | null;
  originated_on: string | null;
  maturity_on: string | null;
  extension_options: Record<string, unknown>[];
  rate_type: "fixed" | "floating";
  rate: number | null;
  index_name: string | null;
  spread: number | null;
  rate_floor: number | null;
  amortization_months: number | null;
  io_months: number | null;
  recourse: "non_recourse" | "partial" | "full";
  recourse_notes: string | null;
  guarantors: Guarantor[];
  prepayment: Prepayment;
  cap_strike: number | null;
  cap_provider: string | null;
  cap_expires_on: string | null;
  swap_rate: number | null;
  swap_expires_on: string | null;
  status: string;
  owner_id: string | null;
  notes: string | null;
  label: string;
  property_label: string | null;
  lender_label: string | null;
  owner_name: string | null;
  covenant_state: string;
  annual_debt_service: number | null;
  months_to_maturity: number | null;
  refi_window_opens_on: string | null;
  in_refi_window: boolean;
  collateral: Collateral[];
  reserve_balance: number;
  created_at: string;
  updated_at: string;
}

export type LoanInput = Partial<Omit<Loan, "id" | "label" | "property_label" | "lender_label" | "owner_name" | "covenant_state" | "annual_debt_service" | "months_to_maturity" | "refi_window_opens_on" | "in_refi_window" | "collateral" | "reserve_balance" | "created_at" | "updated_at" | "prepayment" | "guarantors">> & {
  prepayment?: Partial<Prepayment>;
  guarantors?: Partial<Guarantor>[];
  effective_on?: string | null;
  change_note?: string | null;
};

export interface LoanFacets {
  status: Record<string, number>;
  rate_type: Record<string, number>;
  loan_type: Record<string, number>;
  covenant_state: Record<string, number>;
  lender_name: Record<string, number>;
}

export interface LoanEvent {
  id: string;
  event_type: string;
  at: string;
  effective_on: string | null;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  note: string | null;
  actor_name: string | null;
}

export interface LadderBucket {
  key: string;
  balance: number;
  fixed_balance: number;
  floating_balance: number;
  count: number;
  share_pct: number | null;
  drill: string;
  loans: { id: string; label: string; property_label: string | null; balance: number; maturity_on: string; rate: number | null; href: string }[];
}

export interface Ladder {
  bucket: "year" | "quarter" | "month";
  total: number | null;
  buckets: LadderBucket[];
  undated: { id: string; label: string; balance: number | null }[];
}

export interface Exposure {
  total_balance: number | null;
  floating_balance: number | null;
  floating_pct: number | null;
  hedged_floating_balance: number | null;
  unhedged_floating_balance: number | null;
  weighted_rate: number | null;
  annual_cost_per_100bp_unhedged: number | null;
  caps_expiring: { id: string; label: string; property_label: string | null; cap_expires_on: string; cap_strike: number | null; balance: number | null; href: string }[];
  drill: string;
}

export interface Covenant {
  id: string;
  loan_id: string;
  loan_label: string | null;
  property_id: string | null;
  property_label: string | null;
  kind: (typeof COVENANT_KINDS)[number];
  label: string | null;
  operator: "min" | "max";
  threshold: number;
  watch_threshold: number | null;
  effective_watch: number | null;
  frequency: string;
  next_test_on: string | null;
  cure_period_days: number | null;
  is_active: boolean;
  last_state: string | null;
  last_projected_state: string | null;
  last_value: number | null;
  last_projected_value: number | null;
  last_tested_on: string | null;
  notes: string | null;
}

export interface CovenantInput {
  kind: Covenant["kind"];
  label?: string | null;
  operator?: "min" | "max" | null;
  threshold: number;
  watch_threshold?: number | null;
  frequency: string;
  next_test_on?: string | null;
  cure_period_days?: number | null;
  is_active?: boolean;
  notes?: string | null;
}

export interface CovenantTest {
  id: string;
  covenant_id: string;
  loan_id: string;
  test_date: string;
  period_start: string | null;
  period_end: string | null;
  measured_value: number | null;
  threshold: number;
  state: string;
  projected_value: number | null;
  projected_state: string | null;
  projected_on: string | null;
  inputs: Record<string, unknown> & { drill?: { label: string; href: string }[] };
  basis: string;
  is_manual: boolean;
  notes: string | null;
  created_at: string;
}

export interface Reserve {
  id: string;
  loan_id: string;
  reserve_type: string;
  label: string | null;
  required_amount: number | null;
  monthly_deposit: number | null;
  cap_amount: number | null;
  release_conditions: string | null;
  notes: string | null;
  balance: number;
  funded_pct: number | null;
  updated_at: string;
}

export type ReserveInput = Omit<Reserve, "id" | "loan_id" | "balance" | "funded_pct" | "updated_at">;

export interface ReserveTxn {
  id: string;
  reserve_id: string;
  loan_id: string;
  kind: "deposit" | "release" | "adjustment";
  amount: number;
  occurred_on: string;
  balance_after: number;
  document_id: string | null;
  memo: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface Obligation {
  id: string;
  loan_id: string;
  report_type: string;
  label: string | null;
  frequency: string;
  days_after_period: number;
  next_due_on: string | null;
  owner_id: string | null;
  owner_name: string | null;
  is_active: boolean;
  notes: string | null;
  last_submitted_on: string | null;
  critical_date_id: string | null;
  task_id: string | null;
  overdue: boolean;
  updated_at: string;
}

export type ObligationInput = Pick<Obligation, "report_type" | "label" | "frequency" | "days_after_period" | "next_due_on" | "owner_id" | "is_active" | "notes">;

export interface PrepaymentEstimate {
  type: string;
  payoff_on: string;
  balance: number;
  allowed: boolean;
  cost: number;
  cost_pct: number;
  lines: { label: string; amount: number }[];
  explanation: string;
  estimate: boolean;
}

export interface MarketTerms {
  rate: number;
  ltv: number;
  dscr: number;
  debt_yield: number;
  amort_years: number;
  cap_rate: number;
  treasury_rate: number;
  sale_cost_pct: number;
  refi_cost_pct: number;
}

export interface Refinance {
  as_of: string;
  payoff_on: string;
  market: MarketTerms;
  noi: number | null;
  noi_period_end: string | null;
  value: number | null;
  value_basis: string | null;
  sizing: { max_loan: number | null; binding: "ltv" | "dscr" | "debt_yield" | null; constraints: Record<string, number>; annual_debt_service?: number };
  current_balance: number;
  prepayment: PrepaymentEstimate;
  refi_costs: number;
  payoff: number;
  net_proceeds: number | null;
  shortfall: number;
  current_annual_debt_service: number;
  new_annual_debt_service: number | null;
  current_dscr: number | null;
  new_dscr: number | null;
  window: { opens_on: string | null; in_window: boolean; months_to_maturity: number | null; window_months: number };
  drill: { label: string; href: string }[];
}

export interface HoldRefiSell {
  market: MarketTerms;
  noi: number | null;
  value: number | null;
  value_basis: string | null;
  hold: { annual_cash_flow: number | null; debt_service: number | null; dscr: number | null; equity: number | null; maturity_on: string | null; notes: string };
  refinance: { new_loan: number | null; binding_constraint: string | null; cash_out: number | null; shortfall: number; annual_cash_flow: number | null; debt_service: number | null; dscr: number | null; prepayment_cost: number; costs: number };
  sell: { gross_price: number | null; sale_costs: number | null; debt_payoff: number | null; prepayment_cost: number | null; prepayment_allowed: boolean; net_equity: number | null };
  note: string;
}

export interface DebtSettings {
  maturity_lead_months: number[];
  refi_window_months: number;
  cap_lead_days: number[];
  covenant_watch_buffer_pct: number;
  projection_quarters: number;
  market: MarketTerms;
}

export function loanTitle(l: { label?: string | null; name?: string | null; lender_name?: string | null }) {
  return l.label || l.name || l.lender_name || "Loan";
}

/* ------------------------------------------------------------------ queries */

export function useLoan(id: string) {
  return useQuery({ queryKey: ["loans", id], queryFn: () => api.get<Loan>(`/loans/${id}`) });
}

export function useLoansByProperty(propertyId: string) {
  return useQuery({ queryKey: ["loans", "by-property", propertyId], queryFn: () => api.get<LoanListItem[]>(`/loans/by-property/${propertyId}`) });
}

export function useLoanFacets(params: Params) {
  return useQuery({ queryKey: ["loans", "facets", params], queryFn: () => api.get<LoanFacets>("/loans/facets", params), placeholderData: (p) => p });
}

export function useLadder(bucket: "year" | "quarter" | "month", params: Params = {}) {
  return useQuery({ queryKey: ["loans", "ladder", bucket, params], queryFn: () => api.get<Ladder>("/loans/ladder", { ...params, bucket }), placeholderData: (p) => p });
}

export function useExposure() {
  return useQuery({ queryKey: ["loans", "exposure"], queryFn: () => api.get<Exposure>("/loans/exposure") });
}

export function useCovenantStatus(params: { state?: string[]; kind?: string[]; loan_id?: string } = {}) {
  return useQuery({ queryKey: ["loans", "covenants", params], queryFn: () => api.get<Covenant[]>("/loans/covenants", params) });
}

export function useLoanEvents(id: string) {
  return useQuery({ queryKey: ["loans", id, "events"], queryFn: () => api.get<LoanEvent[]>(`/loans/${id}/events`) });
}

export function usePrepayment(id: string, payoffOn: string | null, treasuryRate: number | null) {
  return useQuery({
    queryKey: ["loans", id, "prepayment", payoffOn, treasuryRate],
    queryFn: () => api.get<PrepaymentEstimate>(`/loans/${id}/prepayment`, { payoff_on: payoffOn, treasury_rate: treasuryRate }),
    placeholderData: (p) => p,
  });
}

function toParams(m: Partial<MarketTerms>): Params {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v)));
}

export function useRefinance(id: string, market: Partial<MarketTerms> = {}) {
  return useQuery({
    queryKey: ["loans", id, "refinance", market],
    queryFn: () => api.get<Refinance>(`/loans/${id}/refinance`, toParams(market)),
    placeholderData: (p) => p,
  });
}

export function useHoldRefiSell(id: string, market: Partial<MarketTerms> = {}) {
  return useQuery({
    queryKey: ["loans", id, "hold-refi-sell", market],
    queryFn: () => api.get<HoldRefiSell>(`/loans/${id}/hold-refi-sell`, toParams(market)),
    placeholderData: (p) => p,
  });
}

export function useLoanCovenants(id: string) {
  return useQuery({ queryKey: ["loans", id, "covenants"], queryFn: () => api.get<Covenant[]>(`/loans/${id}/covenants`) });
}

export function useCovenantTests(id: string, covenantId?: string) {
  return useQuery({
    queryKey: ["loans", id, "covenant-tests", covenantId ?? null],
    queryFn: () => api.get<CovenantTest[]>(`/loans/${id}/covenant-tests`, { covenant_id: covenantId }),
  });
}

export function useReserves(id: string) {
  return useQuery({ queryKey: ["loans", id, "reserves"], queryFn: () => api.get<Reserve[]>(`/loans/${id}/reserves`) });
}

export function useReserveTxns(id: string, reserveId?: string) {
  return useQuery({
    queryKey: ["loans", id, "reserve-transactions", reserveId ?? null],
    queryFn: () => api.get<ReserveTxn[]>(`/loans/${id}/reserve-transactions`, { reserve_id: reserveId }),
  });
}

export function useObligations(id: string) {
  return useQuery({ queryKey: ["loans", id, "obligations"], queryFn: () => api.get<Obligation[]>(`/loans/${id}/obligations`) });
}

export function useDebtSettings() {
  return useQuery({ queryKey: ["loans", "settings"], queryFn: () => api.get<DebtSettings>("/loans/settings") });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidate() {
  const qc = useQueryClient();
  return (loanId?: string) => {
    qc.invalidateQueries({ queryKey: ["loans"] });
    qc.invalidateQueries({ queryKey: ["assets"] });
    if (loanId) qc.invalidateQueries({ queryKey: ["timeline", "loan", loanId] });
  };
}

export function useSaveLoan(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: LoanInput) => (id ? api.patch<Loan>(`/loans/${id}`, data) : api.post<Loan>("/loans", data)),
    onSuccess: (l) => invalidate(l.id),
  });
}

export function useDeleteLoan() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/loans/${id}`), onSuccess: () => invalidate() });
}

export function useAddCollateral(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { property_id: string; allocated_amount?: number | null; release_price?: number | null }) => api.post<Loan>(`/loans/${loanId}/collateral`, body),
    onSuccess: () => invalidate(loanId),
  });
}

export function useRemoveCollateral(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (linkId: string) => api.delete(`/loans/${loanId}/collateral/${linkId}`), onSuccess: () => invalidate(loanId) });
}

export function useSaveCovenant(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: CovenantInput }) =>
      id ? api.patch<Covenant>(`/loans/covenants/${id}`, data) : api.post<Covenant>(`/loans/${loanId}/covenants`, data),
    onSuccess: () => invalidate(loanId),
  });
}

export function useTestCovenant(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, manual_value, test_date, notes }: { id: string; manual_value?: number | null; test_date?: string | null; notes?: string | null }) =>
      api.post<CovenantTest>(`/loans/covenants/${id}/test`, { manual_value, test_date, notes }),
    onSuccess: () => invalidate(loanId),
  });
}

export function useTestAllCovenants(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.post<CovenantTest[]>(`/loans/${loanId}/covenants/test`), onSuccess: () => invalidate(loanId) });
}

export function useSaveReserve(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: ReserveInput }) =>
      id ? api.patch<Reserve>(`/loans/reserves/${id}`, data) : api.post<Reserve>(`/loans/${loanId}/reserves`, data),
    onSuccess: () => invalidate(loanId),
  });
}

export function usePostReserveTxn(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ reserveId, data }: { reserveId: string; data: { kind: ReserveTxn["kind"]; amount: number; occurred_on: string; document_id?: string | null; memo?: string | null } }) =>
      api.post<ReserveTxn>(`/loans/reserves/${reserveId}/transactions`, data),
    onSuccess: () => invalidate(loanId),
  });
}

export function useSaveObligation(loanId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: ObligationInput }) =>
      id ? api.patch<Obligation>(`/loans/obligations/${id}`, data) : api.post<Obligation>(`/loans/${loanId}/obligations`, data),
    onSuccess: () => invalidate(loanId),
  });
}

export function useSubmitObligation(loanId: string) {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, submitted_on, document_id, note }: { id: string; submitted_on?: string | null; document_id?: string | null; note?: string | null }) =>
      api.post<Obligation>(`/loans/obligations/${id}/submit`, { submitted_on, document_id, note }),
    onSuccess: () => {
      invalidate(loanId);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["critical-dates"] });
    },
  });
}

export function useScanLoans() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Record<string, number>>("/loans/scan"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loans"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useSaveDebtSettings() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (data: DebtSettings) => api.put<DebtSettings>("/loans/settings", data), onSuccess: () => invalidate() });
}
