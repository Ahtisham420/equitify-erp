"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page } from "@/lib/api";

export const PARTNER_TYPES = ["individual", "family_office", "fund", "institution", "trust", "sponsor", "other"] as const;
export const PARTNER_STATUSES = ["prospect", "active", "inactive"] as const;
export const EVENT_TYPES = ["call", "distribution", "liquidation"] as const;
export const EVENT_STATUSES = ["draft", "pending_approval", "approved", "posted", "rejected", "reversed"] as const;
export const TIER_TYPES = ["return_of_capital", "preferred_return", "catch_up", "split"] as const;
export const HURDLE_TYPES = ["none", "irr", "equity_multiple"] as const;
export const PACKAGE_TYPES = ["property_performance", "portfolio", "valuation", "distributions", "capital_accounts"] as const;
export const FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
export const CHANNELS = ["email", "portal", "mail", "phone"] as const;

export const TIER_LABELS: Record<string, string> = {
  return_of_capital: "Return of capital",
  preferred_return: "Preferred return",
  catch_up: "GP catch-up",
  split: "Promote split",
  residual: "Residual",
  call: "Capital call",
};
export const PACKAGE_LABELS: Record<string, string> = {
  property_performance: "Property performance",
  portfolio: "Portfolio",
  valuation: "Valuation",
  distributions: "Distributions",
  capital_accounts: "Capital accounts",
};
export const EVENT_TONES: Record<string, "neutral" | "amber" | "blue" | "green" | "red"> = {
  draft: "neutral",
  pending_approval: "amber",
  approved: "blue",
  posted: "green",
  rejected: "red",
  reversed: "neutral",
  pending: "amber",
  partial: "amber",
  funded: "green",
  late: "red",
  default: "red",
  paid: "green",
  generated: "neutral",
  issued: "green",
};

export interface PartnerListItem {
  id: string;
  name: string;
  type: string;
  status: string;
  email: string | null;
  organization_id: string | null;
  person_id: string | null;
  portal_user_id: string | null;
  owner_id: string | null;
  tags: string[];
  updated_at: string;
  commitment: number;
  funded: number;
  unfunded: number;
  investment_count: number;
  in_default: boolean;
}

export interface ReportingPrefs {
  frequency?: string;
  packages?: string[];
  delivery?: string;
  format?: string;
}

export interface CommunicationPrefs {
  channel?: string;
  recipients?: string[];
  do_not_contact?: boolean;
  notes?: string;
}

export interface Partner {
  id: string;
  name: string;
  type: string;
  status: string;
  organization_id: string | null;
  person_id: string | null;
  email: string | null;
  phone: string | null;
  reporting_requirements: string | null;
  reporting_prefs: ReportingPrefs;
  communication_prefs: CommunicationPrefs;
  portal_user_id: string | null;
  owner_id: string | null;
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  organization_name: string | null;
  person_name: string | null;
  portal_user_name: string | null;
  owner_name: string | null;
  commitment: number;
  funded: number;
  unfunded: number;
  in_default: boolean;
}

export type PartnerInput = Partial<Omit<Partner, "id" | "created_at" | "updated_at" | "organization_name" | "person_name" | "portal_user_name" | "owner_name" | "commitment" | "funded" | "unfunded" | "in_default">>;

export interface PartnerFacets {
  type: Record<string, number>;
  status: Record<string, number>;
}

export interface Investment {
  id: string;
  partner_id: string;
  partner_name: string | null;
  asset_id: string;
  asset_label: string | null;
  property_id: string | null;
  waterfall_id: string | null;
  waterfall_name: string | null;
  commitment: number;
  funded: number;
  unfunded: number;
  ownership_pct: number;
  pref_rate: number;
  pref_compounding: "simple" | "annual";
  day_count: "act_365" | "act_360" | "30_360";
  waterfall_position: "lp" | "gp";
  status: "active" | "exited";
  invested_on: string | null;
  notes: string | null;
  updated_at: string;
}

export interface InvestmentInput {
  partner_id?: string;
  asset_id?: string;
  waterfall_id?: string | null;
  commitment?: number;
  ownership_pct?: number;
  pref_rate?: number;
  pref_compounding?: string;
  day_count?: string;
  waterfall_position?: string;
  status?: string;
  invested_on?: string | null;
  notes?: string | null;
  provenance?: { source: string; observed_on: string | null; confidence: number; verified: boolean };
}

export interface AccountSummary {
  investment_id: string;
  partner_id: string;
  asset_id: string;
  asset_label: string | null;
  position: string;
  ownership_pct: number;
  commitment: number;
  contributions: number;
  distributions: number;
  return_of_capital: number;
  preferred_paid: number;
  profit_distributions: number;
  income_allocated: number;
  loss_allocated: number;
  unreturned_capital: number;
  accrued_pref: number;
  pref_accrued_total: number;
  unfunded: number;
  ending_balance: number;
}

export interface Entry {
  id: string;
  partner_id: string;
  investment_id: string;
  asset_id: string;
  event_id: string | null;
  allocation_id: string | null;
  entry_type: string;
  component: string | null;
  amount: number;
  effective_on: string;
  memo: string | null;
  reverses_entry_id: string | null;
  created_at: string;
  reversed: boolean;
}

export interface Statement {
  partner_id: string;
  as_of: string;
  accounts: AccountSummary[];
  totals: Record<string, number>;
  entries: Entry[];
}

export interface TierBreakdown {
  tier: number;
  name: string;
  tier_type: string;
  component: string;
  amount: number;
}

export interface CalcAllocation {
  investment_id: string;
  partner_id: string;
  name: string;
  position: string;
  ownership_pct: number;
  amount: number;
  tiers: TierBreakdown[];
  unreturned_capital_before?: number;
  pref_unpaid_before?: number;
  commitment?: number;
  unfunded_before?: number;
  exceeds_unfunded?: boolean;
}

export interface CalcTier {
  position: number;
  name: string;
  tier_type: string;
  hurdle_type: string;
  hurdle_value: number | null;
  amount: number;
  lp_amount: number;
  gp_amount: number;
  lp_irr_after?: number | null;
  lp_multiple_after?: number | null;
}

export interface Calc {
  amount: number;
  allocated: number;
  tiers: CalcTier[];
  allocations: CalcAllocation[];
  warnings: string[];
  waterfall: { id: string; name: string; version: number } | null;
  inputs: Record<string, unknown>;
  computed_at: string;
}

export interface EventInputs {
  gross_proceeds?: number | null;
  debt_payoff?: number | null;
  closing_costs?: number | null;
  reserves?: number | null;
  default_rate?: number | null;
  grace_days?: number | null;
  penalty_pct?: number | null;
  purpose?: string | null;
  wire_instructions?: string | null;
}

export interface EventListItem {
  id: string;
  event_type: string;
  name: string;
  asset_id: string;
  asset_label: string | null;
  event_date: string;
  due_on: string | null;
  amount: number;
  status: string;
  version: number;
  approved_version: number | null;
  updated_at: string;
}

export interface CapitalEvent extends EventListItem {
  property_id: string | null;
  waterfall_id: string | null;
  waterfall_version: number | null;
  inputs: EventInputs;
  calc: Calc;
  notes: string | null;
  submitted_by_id: string | null;
  submitted_at: string | null;
  approved_by_id: string | null;
  approved_at: string | null;
  decision_note: string | null;
  posted_by_id: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  created_by_id: string | null;
  actor_names: Record<string, string>;
  can_approve: boolean;
}

export interface EventVersion {
  id: string;
  version: number;
  amount: number;
  calc: Calc;
  created_at: string;
}

export interface EventPreviewInput {
  event_type: string;
  asset_id: string;
  amount?: number | null;
  event_date: string;
  due_on?: string | null;
  waterfall_id?: string | null;
  inputs?: EventInputs;
  name?: string | null;
  notes?: string | null;
}

export interface Allocation {
  id: string;
  event_id: string;
  partner_id: string;
  investment_id: string;
  event_type: string;
  amount: number;
  tiers: TierBreakdown[];
  status: string;
  due_on: string | null;
  funded_amount: number;
  funded_on: string | null;
  late_interest: number;
  penalty_flag: boolean;
  default_flag: boolean;
  notice_text: string | null;
  paid_on: string | null;
  payment_reference: string | null;
  partner_name: string | null;
  event_name: string | null;
  event_date: string | null;
  asset_label: string | null;
  days_late: number;
  accrued_late_interest: number;
}

export interface Tier {
  id?: string;
  position: number;
  name: string | null;
  tier_type: string;
  hurdle_type: string;
  hurdle_value: number | null;
  lp_share: number;
  gp_share: number;
  catch_up_rate: number;
  catch_up_target: number;
}

export interface Waterfall {
  id: string;
  name: string;
  asset_id: string | null;
  asset_label: string | null;
  description: string | null;
  version: number;
  is_active: boolean;
  tiers: Tier[];
  updated_at: string;
}

export interface PackageListItem {
  id: string;
  partner_id: string;
  partner_name: string | null;
  asset_id: string | null;
  schedule_id: string | null;
  title: string;
  package_types: string[];
  period_start: string;
  period_end: string;
  status: string;
  generated_at: string;
  issued_at: string | null;
}

export interface ReportPackage extends PackageListItem {
  snapshot: { sections?: Record<string, unknown>; data_policy?: string; period?: { start: string; end: string } };
  excluded: { section: string; item?: string | null; reason: string }[];
}

export interface Schedule {
  id: string;
  name: string;
  partner_id: string | null;
  partner_name: string | null;
  asset_id: string | null;
  package_types: string[];
  frequency: string;
  next_run_on: string;
  is_active: boolean;
  auto_issue: boolean;
  last_run_at: string | null;
}

export interface AssetOption {
  id: string;
  label: string;
  property_id: string | null;
  status: string | null;
}

export interface PortalData {
  partners: Partner[];
  investments: Investment[];
  capital_accounts: AccountSummary[];
  totals: Record<string, number>;
  distributions: Allocation[];
  capital_calls: Allocation[];
  documents: { id: string; title: string; doc_class: string | null; filename: string | null; created_at: string; entity_type: string; entity_id: string }[];
  reports: PackageListItem[];
}

/* ------------------------------------------------------------------ hooks */

const KEY = "investors";

export function usePartner(id: string) {
  return useQuery({ queryKey: [KEY, "partner", id], queryFn: () => api.get<Partner>(`/investors/partners/${id}`) });
}

export function useSavePartner(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PartnerInput) => (id ? api.patch<Partner>(`/investors/partners/${id}`, data) : api.post<Partner>("/investors/partners", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useInvestments(params: { partner_id?: string; asset_id?: string }, enabled = true) {
  return useQuery({
    queryKey: [KEY, "investments", params],
    queryFn: () => api.get<Investment[]>("/investors/investments", params),
    enabled,
  });
}

export function useSaveInvestment(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: InvestmentInput) => (id ? api.patch<Investment>(`/investors/investments/${id}`, data) : api.post<Investment>("/investors/investments", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useStatement(partnerId: string, asOf?: string) {
  return useQuery({
    queryKey: [KEY, "statement", partnerId, asOf ?? null],
    queryFn: () => api.get<Statement>(`/investors/partners/${partnerId}/statement`, { as_of: asOf }),
  });
}

export function useReverseEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<Entry>(`/investors/entries/${id}/reverse`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useAllocations(params: { partner_id?: string; event_id?: string; event_type?: string[]; status?: string[] }, enabled = true) {
  return useQuery({
    queryKey: [KEY, "allocations", params],
    queryFn: () => api.get<Allocation[]>("/investors/allocations", params),
    enabled,
  });
}

export function useFundAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; amount: number; funded_on: string; reference?: string | null }) =>
      api.post<Allocation>(`/investors/allocations/${id}/fund`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDefaultAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; default_flag: boolean; penalty_flag?: boolean | null; note?: string | null }) =>
      api.post<Allocation>(`/investors/allocations/${id}/default`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useCapitalEvent(id: string | null) {
  return useQuery({
    queryKey: [KEY, "event", id],
    queryFn: () => api.get<CapitalEvent>(`/investors/capital-events/${id}`),
    enabled: !!id,
  });
}

export function useEventVersions(id: string | null) {
  return useQuery({
    queryKey: [KEY, "event", id, "versions"],
    queryFn: () => api.get<EventVersion[]>(`/investors/capital-events/${id}/versions`),
    enabled: !!id,
  });
}

export function useEventAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: "submit" | "approve" | "reject" | "post" | "reverse" | "recalculate"; body?: unknown }) =>
      api.post<CapitalEvent>(`/investors/capital-events/${id}/${action}`, body ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EventPreviewInput) => api.post<CapitalEvent>("/investors/capital-events", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useWaterfalls(enabled = true) {
  return useQuery({ queryKey: [KEY, "waterfalls"], queryFn: () => api.get<Waterfall[]>("/investors/waterfalls"), enabled });
}

export function useSaveWaterfall(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; asset_id: string | null; description: string | null; is_active: boolean; tiers: Tier[] }) =>
      id ? api.put<Waterfall>(`/investors/waterfalls/${id}`, body) : api.post<Waterfall>("/investors/waterfalls", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "waterfalls"] }),
  });
}

export function useAssetOptions(enabled = true) {
  return useQuery({
    queryKey: [KEY, "asset-options"],
    queryFn: () => api.get<AssetOption[]>("/investors/asset-options"),
    enabled,
    staleTime: 60_000,
  });
}

export function usePackage(id: string | null) {
  return useQuery({
    queryKey: [KEY, "package", id],
    queryFn: () => api.get<ReportPackage>(`/investors/report-packages/${id}`),
    enabled: !!id,
  });
}

export function usePartnerPackages(partnerId: string) {
  return useQuery({
    queryKey: [KEY, "packages", partnerId],
    queryFn: () => api.get<Page<PackageListItem>>("/investors/report-packages", { partner_id: partnerId, page_size: 100 }),
  });
}

export function useGeneratePackages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { partner_id?: string | null; asset_id?: string | null; period_start: string; period_end: string; package_types: string[]; title?: string | null }) =>
      api.post<PackageListItem[]>("/investors/report-packages", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useIssuePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<PackageListItem>(`/investors/report-packages/${id}/issue`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useSchedules(enabled = true) {
  return useQuery({ queryKey: [KEY, "schedules"], queryFn: () => api.get<Schedule[]>("/investors/report-schedules"), enabled });
}

export function useSaveSchedule(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Schedule>) =>
      id ? api.patch<Schedule>(`/investors/report-schedules/${id}`, body) : api.post<Schedule>("/investors/report-schedules", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function usePortal() {
  return useQuery({ queryKey: [KEY, "portal"], queryFn: () => api.get<PortalData>("/investors/portal/me") });
}

/** Fractions (0–1) shown as percentages. */
export function pct(fraction: number | null | undefined, digits = 1) {
  if (fraction === null || fraction === undefined) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}
