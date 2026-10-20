"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Params } from "@/lib/api";

export const STAGES = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed", "withdrawn"] as const;
export const PROGRESSION = ["candidate", "pricing", "marketing", "offers", "contract", "buyer_dd", "closing", "closed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<string, string> = {
  candidate: "Candidate",
  pricing: "Pricing",
  marketing: "Marketing",
  offers: "Offers",
  contract: "Contract",
  buyer_dd: "Buyer DD",
  closing: "Closing",
  closed: "Closed",
  withdrawn: "Withdrawn",
};

export const STAGE_TONES: Record<string, "neutral" | "blue" | "green" | "amber" | "red" | "sky"> = {
  candidate: "neutral",
  pricing: "sky",
  marketing: "sky",
  offers: "blue",
  contract: "blue",
  buyer_dd: "amber",
  closing: "green",
  closed: "green",
  withdrawn: "neutral",
};

export const OFFER_STATUSES = ["received", "countered", "best_and_final", "accepted", "backup", "rejected", "withdrawn"] as const;
export const FINANCING_TYPES = ["cash", "new_loan", "assumption", "seller_financing"] as const;
export const RETRADE_REASONS = ["inspection", "environmental", "title_survey", "financing", "appraisal", "tenant", "market", "other"] as const;
export const RETRADE_DECISIONS = ["pending", "accepted", "countered", "rejected"] as const;
export const RETRADE_OUTCOMES = ["pending", "closed", "buyer_walked", "seller_terminated"] as const;
export const EXCHANGE_TYPES = ["forward", "reverse", "improvement"] as const;
export const EXCHANGE_STATUSES = ["planned", "open", "identified", "completed", "failed", "cancelled"] as const;
export const IDENTIFICATION_RULES = ["three_property", "two_hundred_percent", "ninety_five_percent"] as const;
export const CANDIDATE_STATUSES = ["candidate", "identified", "under_contract", "acquired", "dropped"] as const;

export const IDENTIFICATION_RULE_LABELS: Record<string, string> = {
  three_property: "Three-property rule",
  two_hundred_percent: "200% rule",
  ninety_five_percent: "95% rule",
};

export const stageLabel = (s: string) => STAGE_LABELS[s] ?? s;

export interface DispositionListItem {
  id: string;
  name: string;
  asset_id: string;
  property_id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  stage: Stage;
  stage_entered_at: string;
  days_in_stage: number;
  owner_id: string | null;
  owner_name: string | null;
  is_1031: boolean;
  target_price: number | null;
  best_offer: number | null;
  offer_count: number;
  contract_price: number | null;
  target_closing_on: string | null;
  next_exchange_deadline: string | null;
  updated_at: string;
}

export interface CostLine {
  label: string;
  amount: number;
}

export interface TaxInputs {
  tax_basis?: number | null;
  accumulated_depreciation?: number | null;
  cap_gains_rate?: number;
  recapture_rate?: number;
  state_rate?: number;
  niit_rate?: number;
}

export interface Disposition {
  id: string;
  asset_id: string;
  property_id: string;
  name: string;
  stage: Stage;
  stage_entered_at: string;
  owner_id: string | null;
  reason: string | null;
  is_1031: boolean;
  target_price: number | null;
  list_price: number | null;
  pricing_notes: string | null;
  broker_organization_id: string | null;
  broker_name: string | null;
  commission_pct: number | null;
  marketing_launched_on: string | null;
  offers_due_on: string | null;
  accepted_offer_id: string | null;
  buyer_organization_id: string | null;
  buyer_name: string | null;
  contract_price: number | null;
  contract_executed_on: string | null;
  dd_expires_on: string | null;
  target_closing_on: string | null;
  closed_on: string | null;
  sale_price: number | null;
  cost_lines: CostLine[];
  tax_inputs: TaxInputs;
  comparison: Comparison | Record<string, never>;
  comparison_at: string | null;
  withdrawn_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  property_label: string;
  city: string | null;
  state: string | null;
  owner_name: string | null;
  asset_status: string | null;
}

export type DispositionInput = Partial<
  Pick<
    Disposition,
    | "name" | "owner_id" | "reason" | "is_1031" | "target_price" | "list_price" | "pricing_notes" | "broker_organization_id"
    | "broker_name" | "commission_pct" | "marketing_launched_on" | "offers_due_on" | "buyer_organization_id" | "buyer_name"
    | "contract_price" | "contract_executed_on" | "dd_expires_on" | "target_closing_on" | "closed_on" | "sale_price"
    | "cost_lines" | "tax_inputs" | "notes"
  >
>;

export interface DispositionFacets {
  stage: Record<string, number>;
  owner_id: Record<string, number>;
  is_1031: Record<string, number>;
}

export interface Requirement {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  detail: string | null;
}

export interface Gates {
  current_stage: Stage;
  next_stage: Stage | null;
  can_override: boolean;
  stages: { stage: Stage; ready: boolean; requirements: Requirement[] }[];
}

export interface StageEvent {
  id: string;
  from_stage: string | null;
  to_stage: string;
  at: string;
  actor_name: string | null;
  reason: string | null;
  override: boolean;
  unmet: Requirement[];
}

export interface TaxEstimate {
  amount_realized: number | null;
  tax_basis: number | null;
  accumulated_depreciation: number | null;
  adjusted_basis: number | null;
  gain: number | null;
  depreciation_recapture: number | null;
  capital_gain: number | null;
  recapture_tax: number | null;
  capital_gains_tax: number | null;
  state_tax: number | null;
  niit: number | null;
  total_tax: number | null;
  modeled_estimate: boolean;
}

export interface CompareInput {
  value?: number | null;
  noi?: number | null;
  noi_growth_pct?: number;
  hold_years?: number;
  exit_cap_rate?: number | null;
  discount_rate?: number;
  sale_cost_pct?: number | null;
  capex_planned?: number;
  remaining_lease_term_years?: number | null;
  tax_basis?: number | null;
  accumulated_depreciation?: number | null;
  land_pct?: number;
  depreciation_years?: number;
  cap_gains_rate?: number;
  recapture_rate?: number;
  state_rate?: number;
  niit_rate?: number;
  refi_rate?: number | null;
  refi_ltv?: number | null;
  refi_dscr?: number | null;
  refi_debt_yield?: number | null;
  refi_amort_years?: number | null;
  refi_cost_pct?: number | null;
  treasury_rate?: number | null;
}

export interface ExitBlock {
  exit_noi: number | null;
  exit_value: number | null;
  exit_costs: number | null;
  loan_balance_at_exit: number | null;
  prepayment_at_exit: number | null;
  pre_tax_proceeds: number | null;
  tax: TaxEstimate;
  after_tax_proceeds: number | null;
}

export interface AnnualRow {
  year: number;
  noi: number | null;
  debt_service: number | null;
  capex: number | null;
  cash_flow: number | null;
}

export interface Comparison {
  computed_at: string;
  inputs: CompareInput & {
    value: number | null;
    noi: number | null;
    exit_cap_rate: number;
    sale_cost_pct: number;
    tax_basis: number | null;
    accumulated_depreciation: number | null;
    accumulated_depreciation_estimated: boolean;
    remaining_lease_term_years: number | null;
    debt_balance: number | null;
    debt_maturity: string | null;
    prepayment_cost_now: number | null;
    treasury_rate: number;
    refi_rate: number;
  };
  sell: {
    label: string;
    gross_price: number | null;
    selling_costs: number | null;
    debt_payoff: number | null;
    prepayment_cost: number | null;
    pre_tax_proceeds: number | null;
    tax: TaxEstimate;
    after_tax_proceeds: number | null;
    after_tax_if_1031: number | null;
  };
  hold: { label: string; annual: AnnualRow[]; exit: ExitBlock; npv: number | null; irr_vs_sale: number | null; total_cash_flow: number | null };
  refinance: {
    label: string;
    sizing: { max_loan: number | null; binding: string | null; constraints: Record<string, number>; annual_debt_service?: number };
    new_loan: number | null;
    refi_costs: number | null;
    cash_out: number | null;
    new_debt_service: number | null;
    annual: AnnualRow[];
    exit: ExitBlock;
    npv: number | null;
    irr_vs_sale: number | null;
    total_cash_flow: number | null;
  };
  risks: string[];
  tax_note: string;
  method_note: string;
}

export interface Offer {
  id: string;
  disposition_id: string;
  buyer_name: string;
  buyer_organization_id: string | null;
  buyer_person_id: string | null;
  broker_name: string | null;
  price: number;
  earnest_money: number | null;
  dd_days: number | null;
  closing_days: number | null;
  financing_type: string;
  contingencies: string | null;
  received_on: string;
  expires_on: string | null;
  status: string;
  outcome: string | null;
  notes: string | null;
  created_at: string;
}

export type OfferInput = Omit<Offer, "id" | "disposition_id" | "outcome" | "created_at">;

export interface Retrade {
  id: string;
  disposition_id: string;
  disposition_name: string | null;
  offer_id: string | null;
  buyer_organization_id: string | null;
  buyer_name: string;
  requested_on: string;
  reason_category: string;
  reason: string;
  amount_requested: number;
  decision: string;
  agreed_amount: number | null;
  decided_on: string | null;
  outcome: string;
  notes: string | null;
  created_at: string;
}

export interface RetradeInput {
  offer_id?: string | null;
  buyer_name?: string | null;
  buyer_organization_id?: string | null;
  requested_on: string;
  reason_category: string;
  reason: string;
  amount_requested: number;
  notes?: string | null;
}

export interface BuyerStats {
  key: string;
  buyer_name: string;
  buyer_organization_id: string | null;
  offers: number;
  accepted: number;
  closed: number;
  fell_through: number;
  retrades: number;
  retrade_requested: number;
  retrade_agreed: number;
  accepted_price: number;
  avg_offer: number | null;
  close_rate: number | null;
  retrade_rate: number | null;
  retrade_pct_of_price: number | null;
  last_activity: string | null;
  disposition_ids: string[];
}

export interface ExchangeCandidate {
  id: string;
  property_id: string | null;
  property_label: string | null;
  description: string | null;
  is_backup: boolean;
  rank: number;
  status: string;
  identified_on: string | null;
  expected_price: number | null;
  expected_debt: number | null;
  acquired_on: string | null;
  acquired_price: number | null;
  acquired_debt: number | null;
  notes: string | null;
}

export type CandidateInput = Omit<ExchangeCandidate, "id" | "property_label" | "identified_on">;

export interface ExchangeAnalysis {
  identification_deadline: string | null;
  replacement_deadline: string | null;
  days_to_identification: number | null;
  days_to_replacement: number | null;
  identification_open: boolean;
  identified_count: number;
  backup_count: number;
  replacement_price: number | null;
  replacement_debt: number | null;
  net_equity_relinquished: number | null;
  equity_reinvested: number | null;
  cash_boot: number | null;
  mortgage_boot: number | null;
  total_boot: number | null;
  realized_gain: number | null;
  recognized_gain: number | null;
  deferred_gain: number | null;
  replacement_basis: number | null;
  warnings: string[];
  basis_note: string;
  tax_note: string;
}

export interface Exchange {
  id: string;
  disposition_id: string;
  exchange_type: string;
  status: string;
  qi_organization_id: string | null;
  qi_name: string | null;
  eat_organization_id: string | null;
  parked_property_id: string | null;
  parked_property_label: string | null;
  start_on: string | null;
  identification_deadline: string | null;
  replacement_deadline: string | null;
  tax_return_due_on: string | null;
  identification_rule: string;
  relinquished_sale_price: number | null;
  relinquished_costs: number | null;
  relinquished_debt_paid: number | null;
  relinquished_adjusted_basis: number | null;
  cash_received: number | null;
  additional_cash_invested: number | null;
  improvement_budget: number | null;
  improvement_notes: string | null;
  id_critical_date_id: string | null;
  replacement_critical_date_id: string | null;
  notes: string | null;
  updated_at: string;
  candidates: ExchangeCandidate[];
  analysis: ExchangeAnalysis;
}

export type ExchangeInput = Partial<
  Pick<
    Exchange,
    | "exchange_type" | "status" | "qi_organization_id" | "qi_name" | "eat_organization_id" | "parked_property_id" | "start_on"
    | "tax_return_due_on" | "identification_rule" | "relinquished_sale_price" | "relinquished_costs" | "relinquished_debt_paid"
    | "relinquished_adjusted_basis" | "cash_received" | "additional_cash_invested" | "improvement_budget" | "improvement_notes" | "notes"
  >
>;

export interface ReconLine {
  label: string;
  amount: number | null;
  href?: string;
  subtotal?: boolean;
}

export interface Proceeds {
  price: number | null;
  price_source: string;
  closing_on: string;
  cost_lines: CostLine[];
  selling_costs: number | null;
  debt: { loan_id: string; lender_name: string; payoff: number | null; prepayment_cost: number | null; prepayment_type: string; prepayment_allowed: boolean; reserves_released: number | null; href: string }[];
  debt_payoff: number | null;
  prepayment_cost: number | null;
  reserves_released: number | null;
  distributable: number | null;
  reconciliation: ReconLine[];
  reconciliation_total: number;
  reconciled: boolean;
  gain_reconciliation: ReconLine[];
  tax: TaxEstimate;
  tax_deferred_1031: boolean;
  after_tax_distributable: number | null;
  partners: { partner_id: string | null; name: string; ownership_pct: number | null; amount: number | null; href: string | null }[] | null;
  partners_unavailable: boolean;
  partners_note: string;
  tax_note: string;
  drill: { label: string; href: string }[];
}

export interface QueueSuggestion {
  asset_id: string;
  property_id: string;
  property_label: string;
  city: string | null;
  state: string | null;
  reasons: string[];
  href: string;
}

/* ------------------------------------------------------------------ queries */

export function useDisposition(id: string) {
  return useQuery({ queryKey: ["dispositions", id], queryFn: () => api.get<Disposition>(`/dispositions/${id}`) });
}

export function useDispositionFacets(params: Params) {
  return useQuery({ queryKey: ["dispositions", "facets", params], queryFn: () => api.get<DispositionFacets>("/dispositions/facets", params), placeholderData: (p) => p });
}

export function useDispositionQueue() {
  return useQuery({
    queryKey: ["dispositions", "queue"],
    queryFn: () => api.get<{ candidates: DispositionListItem[]; suggestions: QueueSuggestion[] }>("/dispositions/queue"),
  });
}

export function useBuyers(q?: string) {
  return useQuery({ queryKey: ["dispositions", "buyers", q ?? ""], queryFn: () => api.get<BuyerStats[]>("/dispositions/buyers", { q }) });
}

export function useAllRetrades(buyer?: string) {
  return useQuery({ queryKey: ["dispositions", "retrades", buyer ?? ""], queryFn: () => api.get<Retrade[]>("/dispositions/retrades", { buyer }) });
}

export function useGates(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "gates"], queryFn: () => api.get<Gates>(`/dispositions/${id}/gates`) });
}

export function useStageEvents(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "events"], queryFn: () => api.get<StageEvent[]>(`/dispositions/${id}/events`) });
}

export function useOffers(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "offers"], queryFn: () => api.get<Offer[]>(`/dispositions/${id}/offers`) });
}

export function useRetrades(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "retrades"], queryFn: () => api.get<Retrade[]>(`/dispositions/${id}/retrades`) });
}

export function useExchange(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "exchange"], queryFn: () => api.get<Exchange | null>(`/dispositions/${id}/exchange`) });
}

export function useProceeds(id: string) {
  return useQuery({ queryKey: ["dispositions", id, "proceeds"], queryFn: () => api.get<Proceeds>(`/dispositions/${id}/proceeds`) });
}

/* ------------------------------------------------------------------ mutations */

function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["dispositions"] });
    qc.invalidateQueries({ queryKey: ["assets"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", "disposition", id] });
  };
}

export function useCreateDisposition() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { asset_id: string; name?: string | null; owner_id?: string | null; reason?: string | null; is_1031?: boolean; target_price?: number | null }) =>
      api.post<Disposition>("/dispositions", data),
    onSuccess: (d) => invalidate(d.id),
  });
}

export function useUpdateDisposition(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (data: DispositionInput) => api.patch<Disposition>(`/dispositions/${id}`, data), onSuccess: () => invalidate(id) });
}

export function useDeleteDisposition() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/dispositions/${id}`), onSuccess: () => invalidate() });
}

export function useMoveDisposition(id: string) {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { to_stage: Stage; reason?: string | null; override?: boolean }) => api.post<Disposition>(`/dispositions/${id}/move`, body),
    onSuccess: () => {
      invalidate(id);
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["critical-dates"] });
    },
  });
}

export function useRunComparison(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: CompareInput) => api.post<Comparison>(`/dispositions/${id}/compare`, body), onSuccess: () => invalidate(id) });
}

export function useSaveOffer(dispositionId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: OfferInput }) =>
      id ? api.patch<Offer>(`/dispositions/offers/${id}`, data) : api.post<Offer>(`/dispositions/${dispositionId}/offers`, data),
    onSuccess: () => invalidate(dispositionId),
  });
}

export function useAcceptOffer(dispositionId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (offerId: string) => api.post<Disposition>(`/dispositions/offers/${offerId}/accept`), onSuccess: () => invalidate(dispositionId) });
}

export function useAddRetrade(dispositionId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (data: RetradeInput) => api.post<Retrade>(`/dispositions/${dispositionId}/retrades`, data), onSuccess: () => invalidate(dispositionId) });
}

export function useDecideRetrade(dispositionId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { decision?: string; agreed_amount?: number | null; outcome?: string; notes?: string | null } }) =>
      api.patch<Retrade>(`/dispositions/retrades/${id}`, data),
    onSuccess: () => invalidate(dispositionId),
  });
}

export function useSaveExchange(dispositionId: string) {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ExchangeInput) => api.put<Exchange>(`/dispositions/${dispositionId}/exchange`, data),
    onSuccess: () => {
      invalidate(dispositionId);
      qc.invalidateQueries({ queryKey: ["critical-dates"] });
    },
  });
}

export function useSaveCandidate(dispositionId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: CandidateInput }) =>
      id ? api.patch<Exchange>(`/dispositions/exchange-candidates/${id}`, data) : api.post<Exchange>(`/dispositions/${dispositionId}/exchange/candidates`, data),
    onSuccess: () => invalidate(dispositionId),
  });
}
