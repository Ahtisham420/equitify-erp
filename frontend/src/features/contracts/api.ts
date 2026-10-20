"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AuditEvent } from "@/components/data/timeline";
import type { Tone } from "@/components/ui/badge";
import { api, type Page, type Params } from "@/lib/api";

/* ---------------------------------------------------------------- vocabularies */

export const CONTRACT_STATUSES = ["draft", "executed", "closed", "terminated"] as const;
export const CONTRACT_TYPES = ["purchase_sale", "amendment", "assignment", "option", "other"] as const;
export const CONTRACT_TYPE_LABELS: Record<string, string> = {
  purchase_sale: "Purchase and sale",
  amendment: "Amendment",
  assignment: "Assignment",
  option: "Option",
  other: "Other",
};
export const PARTY_ROLES = ["buyer", "seller", "escrow_agent", "title_company", "broker", "attorney", "lender", "other"] as const;

export const DATE_STATUSES = ["proposed", "confirmed", "missed", "completed", "waived"] as const;
export const DATE_STATUS_TONES: Record<string, Tone> = { proposed: "amber", confirmed: "blue", missed: "red", completed: "green", waived: "neutral" };
export const DATE_STATUS_LABELS: Record<string, string> = { proposed: "Proposed", confirmed: "Confirmed", missed: "Missed", completed: "Completed", waived: "Waived" };
export const DATE_SOURCE_LABELS: Record<string, string> = { manual: "Manual", rule: "Rule", ai: "AI extraction" };

export const DATE_TYPE_LABELS: Record<string, string> = {
  effective: "Effective date",
  deposit: "Deposit",
  additional_deposit: "Additional deposit",
  feasibility_expiry: "Feasibility expiry",
  title_objection: "Title objection",
  title_cure: "Title cure",
  survey: "Survey",
  financing: "Financing",
  estoppel: "Estoppel",
  snda: "SNDA",
  closing: "Closing",
  extension: "Extension",
  post_close: "Post-close",
  lease_expiration: "Lease expiration",
  lease_option: "Lease option",
  loan_maturity: "Loan maturity",
  rate_cap_expiry: "Rate cap expiry",
  covenant_test: "Covenant test",
  offer_response: "Offer response",
  other: "Other",
};

export const RELATED_TYPE_LABELS: Record<string, string> = {
  contract: "Contract",
  lease: "Lease",
  loan: "Loan",
  offer: "Offer",
  opportunity: "Opportunity",
  disposition: "Disposition",
  closing: "Closing",
  asset: "Asset",
  property: "Property",
  insurance_policy: "Insurance",
  listing: "Listing",
};

/** Route for the record a critical date belongs to (falls back to the property). */
export function relatedHref(d: { related_type: string; related_id: string; property_id: string | null }): string | null {
  const routes: Record<string, string> = {
    contract: "/contracts",
    opportunity: "/pipeline",
    property: "/properties",
    underwriting: "/underwriting",
  };
  if (routes[d.related_type]) return `${routes[d.related_type]}/${d.related_id}`;
  return d.property_id ? `/properties/${d.property_id}` : null;
}

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const DD_STATUSES = ["not_started", "in_progress", "blocked", "complete", "waived"] as const;
export const DD_STATUS_TONES: Record<string, Tone> = { not_started: "neutral", in_progress: "blue", blocked: "red", complete: "green", waived: "neutral" };
export const DD_CATEGORY_LABELS: Record<string, string> = {
  title: "Title",
  survey: "Survey",
  environmental: "Environmental",
  physical: "Physical",
  zoning: "Zoning & entitlements",
  tenancy: "Leases & tenancy",
  financial: "Financial",
  legal: "Legal",
  general: "General",
};

export const REPORT_TYPES = ["survey", "phase_i", "phase_ii", "pca", "zoning", "appraisal", "title", "lease_audit"] as const;
export const REPORT_TYPE_LABELS: Record<string, string> = {
  survey: "Survey",
  phase_i: "Phase I ESA",
  phase_ii: "Phase II ESA",
  pca: "Property condition (PCA)",
  zoning: "Zoning",
  appraisal: "Appraisal",
  title: "Title",
  lease_audit: "Lease audit",
};
export const REPORT_STATUSES = ["not_ordered", "ordered", "in_progress", "delivered", "reviewed", "cancelled"] as const;
export const REPORT_STATUS_TONES: Record<string, Tone> = { not_ordered: "neutral", ordered: "sky", in_progress: "blue", delivered: "green", reviewed: "green", cancelled: "neutral" };

export const EXCEPTION_KINDS = ["title_exception", "easement", "encroachment", "survey_matter", "lien", "restriction", "other"] as const;
export const EXCEPTION_SOURCES = ["title_commitment", "survey", "other"] as const;
export const EXCEPTION_STATUSES = ["open", "objected", "cure_pending", "cured", "accepted", "waived", "uncured"] as const;
export const EXCEPTION_STATUS_TONES: Record<string, Tone> = { open: "neutral", objected: "amber", cure_pending: "amber", cured: "green", accepted: "sky", waived: "neutral", uncured: "red" };

export const ESTOPPEL_KINDS = ["estoppel", "snda"] as const;
export const ESTOPPEL_STATUSES = ["not_requested", "requested", "received", "approved", "waived"] as const;
export const ESTOPPEL_STATUS_TONES: Record<string, Tone> = { not_requested: "neutral", requested: "sky", received: "blue", approved: "green", waived: "neutral" };

export const RISK_CATEGORIES = ["title", "survey", "environmental", "physical", "zoning", "tenancy", "financial", "legal", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "decided", "closed"] as const;
export const RISK_DECISIONS = ["proceed", "mitigate", "renegotiate", "terminate", "accept"] as const;
export const DECISION_KINDS = ["extend", "terminate", "proceed", "waive_contingency", "renegotiate", "other"] as const;
export const DECISION_KIND_LABELS: Record<string, string> = {
  extend: "Extend a deadline",
  terminate: "Terminate the contract",
  proceed: "Proceed past feasibility",
  waive_contingency: "Waive a contingency",
  renegotiate: "Renegotiate",
  other: "Other",
};

/** Day-count terms that drive the date engine (contract.key_terms). */
export const TERM_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "deposit_days", label: "Deposit due (business days)", hint: "Default 3" },
  { key: "feasibility_days", label: "Feasibility period (days)", hint: "Default 30" },
  { key: "additional_deposit_days", label: "Additional deposit after feasibility (business days)" },
  { key: "title_objection_days", label: "Title objection (days)", hint: "Default 20" },
  { key: "title_cure_days", label: "Seller cure after objection (days)", hint: "Default 10" },
  { key: "survey_days", label: "Survey objection (days)", hint: "Default 25" },
  { key: "financing_days", label: "Financing contingency (days)" },
  { key: "estoppel_days", label: "Estoppels due (days)" },
  { key: "snda_days", label: "SNDAs due (days)" },
  { key: "closing_days", label: "Closing (days after anchor)", hint: "Default 30" },
  { key: "extension_count", label: "Closing extensions available" },
  { key: "extension_days", label: "Days per extension" },
  { key: "post_close_days", label: "Post-closing obligations (days after closing)" },
];
export const ANCHOR_LABELS: Record<string, string> = {
  effective_on: "Effective date",
  executed_on: "Execution date",
  feasibility_expiry: "Feasibility expiry",
  title_objection: "Title objection",
  closing: "Closing",
};

/* ---------------------------------------------------------------- types */

export interface Party {
  role: string;
  name: string;
  person_id?: string | null;
  organization_id?: string | null;
  notes?: string | null;
}

export interface ContractListItem {
  id: string;
  title: string;
  contract_type: string;
  status: string;
  property_id: string | null;
  property_label: string | null;
  property_type: string | null;
  opportunity_id: string | null;
  opportunity_label: string | null;
  owner_id: string | null;
  owner_name: string | null;
  effective_on: string | null;
  purchase_price: number | null;
  feasibility_on: string | null;
  days_to_feasibility: number | null;
  closing_on: string | null;
  open_blockers: number;
  dd_total: number;
  dd_done: number;
  tags: string[];
  updated_at: string;
}

export interface Contract extends ContractListItem {
  document_id: string | null;
  offer_id: string | null;
  executed_on: string | null;
  executed_at: string | null;
  earnest_money: number | null;
  additional_deposit: number | null;
  parties: Party[];
  key_terms: Record<string, unknown>;
  calendar_id: string | null;
  attorney_person_id: string | null;
  attorney_organization_id: string | null;
  terminated_at: string | null;
  notes: string | null;
  created_at: string;
  created_by_id: string | null;
}

export type ContractInput = Partial<Omit<Contract, "id" | "status" | "property_label" | "property_type" | "opportunity_label" | "owner_name" | "feasibility_on" | "days_to_feasibility" | "closing_on" | "open_blockers" | "dd_total" | "dd_done" | "updated_at" | "created_at" | "created_by_id" | "executed_at" | "terminated_at">> & { status?: string };

export interface ContractFacets {
  status: Record<string, number>;
  contract_type: Record<string, number>;
  owner_id: Record<string, number>;
}

export interface Blocker {
  kind: "critical_date" | "dd_item" | "risk" | "estoppel" | "title_exception" | "third_party_report";
  id: string;
  label: string;
  severity: string;
  detail: string | null;
}

export interface ContractStatus {
  contract_id: string;
  status: string;
  effective_on: string | null;
  feasibility_on: string | null;
  feasibility_status: string | null;
  days_to_feasibility: number | null;
  closing_on: string | null;
  days_to_closing: number | null;
  blockers: Blocker[];
  counts: Record<string, number>;
}

export interface DateRule {
  key?: string;
  from?: string;
  days?: number;
  business_days?: boolean;
  roll_forward?: boolean;
  calendar_id?: string | null;
  assumed?: boolean;
  term?: string;
  custom?: boolean;
}

export interface Citation {
  document_id?: string | null;
  page?: number | null;
  clause?: string | null;
  text?: string | null;
  confidence?: number | null;
}

export interface CriticalDate {
  id: string;
  related_type: string;
  related_id: string;
  related_label: string | null;
  key: string;
  property_id: string | null;
  property_label: string | null;
  date_type: string;
  label: string;
  due_on: string;
  original_due_on: string | null;
  proposed_due_on: string | null;
  rule: DateRule | null;
  business_days: boolean;
  calendar_id: string | null;
  status: string;
  source: string;
  citation: Citation | null;
  confirmed_by_id: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  confirm_note: string | null;
  owner_id: string | null;
  owner_name: string | null;
  lead_days: number;
  is_blocking: boolean;
  completed_at: string | null;
  completed_by_id: string | null;
  resolution_note: string | null;
  escalation_level: number;
  notes: string | null;
  days_until: number | null;
  updated_at: string;
}

export interface CriticalDateEvent {
  id: string;
  critical_date_id: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  from_due_on: string | null;
  to_due_on: string | null;
  reason: string | null;
  actor_id: string | null;
  actor_name: string | null;
  at: string;
  data: Record<string, unknown>;
}

export interface DateFacets {
  status: Record<string, number>;
  related_type: Record<string, number>;
  date_type: Record<string, number>;
  owner_id: Record<string, number>;
}

export interface DateSummary {
  overdue: number;
  next_7: number;
  next_30: number;
  next_90: number;
  proposed: number;
  blocking_open: number;
  missed: number;
}

export interface DDTemplateItem {
  key: string;
  category: string;
  title: string;
  description: string | null;
  severity: string | null;
  due_days: number | null;
  depends_on: string[];
  report_type: string | null;
}

export interface DDTemplate {
  id: string;
  code: string;
  name: string;
  property_types: string[];
  is_generic: boolean;
  is_active: boolean;
  version: number;
  items: DDTemplateItem[];
  updated_at: string;
}

export interface DDItem {
  id: string;
  contract_id: string;
  template_id: string | null;
  key: string | null;
  category: string;
  title: string;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  status: string;
  due_on: string | null;
  depends_on: string[];
  blocked_by: { id: string; title: string; status: string }[];
  source: string;
  findings: string | null;
  severity: string | null;
  cost_impact: number | null;
  resolution: string | null;
  escalation_level: number;
  escalated_at: string | null;
  escalation_note: string | null;
  report_id: string | null;
  completed_at: string | null;
  sort_order: number;
  is_overdue: boolean;
  updated_at: string;
}

export interface Report {
  id: string;
  contract_id: string;
  report_type: string;
  vendor_organization_id: string | null;
  vendor_name: string | null;
  vendor_label: string | null;
  status: string;
  ordered_on: string | null;
  expected_on: string | null;
  delivered_on: string | null;
  cost: number | null;
  findings: string | null;
  severity: string | null;
  document_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  notes: string | null;
  is_late: boolean;
  updated_at: string;
}

export interface TitleException {
  id: string;
  contract_id: string;
  kind: string;
  source: string;
  schedule_ref: string | null;
  description: string;
  recording_ref: string | null;
  severity: string | null;
  status: string;
  objection_sent_on: string | null;
  cure_due_on: string | null;
  cure_response: string | null;
  resolved_on: string | null;
  attorney_person_id: string | null;
  attorney_organization_id: string | null;
  attorney_label: string | null;
  document_id: string | null;
  notes: string | null;
  updated_at: string;
}

export interface Discrepancy {
  field: string;
  label: string;
  expected: unknown;
  reported: unknown;
  delta: number | null;
}

export interface Estoppel {
  id: string;
  contract_id: string;
  kind: string;
  tenant_name: string;
  lease_id: string | null;
  status: string;
  requested_on: string | null;
  due_on: string | null;
  received_on: string | null;
  expected_monthly_rent: number | null;
  expected_expiration_on: string | null;
  expected_security_deposit: number | null;
  reported_monthly_rent: number | null;
  reported_expiration_on: string | null;
  reported_security_deposit: number | null;
  reported_landlord_default: boolean | null;
  reported_notes: string | null;
  discrepancies: Discrepancy[];
  has_discrepancy: boolean;
  discrepancy_resolution: string | null;
  discrepancy_resolved_at: string | null;
  document_id: string | null;
  notes: string | null;
  updated_at: string;
}

export interface Risk {
  id: string;
  contract_id: string;
  title: string;
  description: string | null;
  category: string;
  severity: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  cost_impact: number | null;
  mitigation: string | null;
  decision_required: boolean;
  decision_due_on: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  needs_decision: boolean;
  updated_at: string;
}

export interface Decision {
  id: string;
  contract_id: string;
  kind: string;
  reasoning: string;
  critical_date_id: string | null;
  previous_due_on: string | null;
  new_due_on: string | null;
  effective_on: string | null;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string;
  data: Record<string, unknown>;
}

export interface HolidayCalendar {
  id: string;
  code: string;
  name: string;
  description: string | null;
  weekend_days: number[];
  is_default: boolean;
  rule_set: string | null;
  seeded_years: number[];
}

export interface UserOption {
  id: string;
  full_name: string;
  email: string;
}

/* ---------------------------------------------------------------- helpers */

export function describeRule(rule: DateRule | null | undefined): string | null {
  if (!rule || rule.from === undefined) return null;
  const from = ANCHOR_LABELS[rule.from] ?? rule.from.replace(/_/g, " ");
  if (!rule.days) return `On ${from.toLowerCase()}`;
  const unit = rule.business_days ? "business" : "calendar";
  const sign = rule.days < 0 ? "before" : "after";
  return `${Math.abs(rule.days)} ${unit} days ${sign} ${from.toLowerCase()}${rule.roll_forward ? ", rolled to next business day" : ""}`;
}

export function daysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

const OPEN = ["proposed", "confirmed", "missed"];
export const isOpenDate = (d: { status: string }) => OPEN.includes(d.status);
export const isOverdueDate = (d: { status: string; days_until: number | null }) => isOpenDate(d) && (d.days_until ?? 0) < 0;

/* ---------------------------------------------------------------- hooks */

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["contracts"] });
    qc.invalidateQueries({ queryKey: ["critical-dates"] });
    qc.invalidateQueries({ queryKey: ["timeline"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["alerts"] });
  };
}

export function useContract(id: string) {
  return useQuery({ queryKey: ["contracts", id], queryFn: () => api.get<Contract>(`/contracts/${id}`) });
}

export function useContractStatus(id: string) {
  return useQuery({ queryKey: ["contracts", id, "status"], queryFn: () => api.get<ContractStatus>(`/contracts/${id}/status`) });
}

export function useContractsFor(params: Params, enabled = true) {
  return useQuery({
    queryKey: ["contracts", "list", params],
    queryFn: () => api.get<Page<ContractListItem>>("/contracts", params),
    enabled,
  });
}

export function useSaveContract(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: ContractInput) => (id ? api.patch<Contract>(`/contracts/${id}`, data) : api.post<Contract>("/contracts", data)),
    onSuccess: invalidate,
  });
}

export function useExecuteContract(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { effective_on?: string | null; executed_on?: string | null }) => api.post<Contract>(`/contracts/${id}/execute`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteContract() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/contracts/${id}`), onSuccess: invalidate });
}

export function useContractDates(id: string) {
  return useQuery({ queryKey: ["critical-dates", "contract", id], queryFn: () => api.get<CriticalDate[]>(`/contracts/${id}/critical-dates`) });
}

export function useGenerateDates(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.post<CriticalDate[]>(`/contracts/${id}/generate-dates`), onSuccess: invalidate });
}

export function useProposeFromExtracted(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => api.post<{ proposed: CriticalDate[]; skipped: string[]; message: string | null }>(`/contracts/${id}/propose-from-extracted`),
    onSuccess: invalidate,
  });
}

export function useRecordDates(relatedType: string, relatedId: string) {
  const params = { related_type: relatedType, related_id: relatedId, page_size: 200, sort: "due_on" };
  return useQuery({
    queryKey: ["critical-dates", "record", params],
    queryFn: () => api.get<Page<CriticalDate>>("/critical-dates", params),
    enabled: !!relatedId,
  });
}

export type DateAction = "confirm" | "complete" | "waive" | "reschedule";

export function useDateAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: DateAction; body: Record<string, unknown> }) =>
      api.post<CriticalDate>(`/critical-dates/${id}/${action}`, body),
    onSuccess: invalidate,
  });
}

export function useUpdateDate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => api.patch<CriticalDate>(`/critical-dates/${id}`, data),
    onSuccess: invalidate,
  });
}

export function useCreateDate() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (data: Record<string, unknown>) => api.post<CriticalDate>("/critical-dates", data), onSuccess: invalidate });
}

export function useBulkDates() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { ids: string[]; action: "confirm" | "complete"; note?: string | null }) =>
      api.post<{ updated: number; skipped: string[] }>("/critical-dates/bulk", body),
    onSuccess: invalidate,
  });
}

export function useScanDates() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.post<Record<string, number | boolean>>("/critical-dates/scan"), onSuccess: invalidate });
}

export function useDateEvents(id: string | null) {
  return useQuery({
    queryKey: ["critical-dates", id, "events"],
    queryFn: () => api.get<CriticalDateEvent[]>(`/critical-dates/${id}/events`),
    enabled: !!id,
  });
}

export function useUserOptions() {
  return useQuery({ queryKey: ["users", "options"], queryFn: () => api.get<UserOption[]>("/users/options"), staleTime: 5 * 60_000 });
}

export function useCalendars() {
  return useQuery({ queryKey: ["contracts", "calendars"], queryFn: () => api.get<HolidayCalendar[]>("/holiday-calendars"), staleTime: 5 * 60_000 });
}

/* DD */

export function useDDItems(contractId: string) {
  return useQuery({ queryKey: ["contracts", contractId, "dd-items"], queryFn: () => api.get<DDItem[]>(`/contracts/${contractId}/dd-items`) });
}

export function useSaveDDItem(contractId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
      id ? api.patch<DDItem>(`/dd-items/${id}`, data) : api.post<DDItem>(`/contracts/${contractId}/dd-items`, data),
    onSuccess: invalidate,
  });
}

export function useDeleteDDItem() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/dd-items/${id}`), onSuccess: invalidate });
}

export function useEscalateDDItem() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.post<DDItem>(`/dd-items/${id}/escalate`, { note }), onSuccess: invalidate });
}

export function useApplyTemplate(contractId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (templateId: string | null) => api.post<DDItem[]>(`/contracts/${contractId}/apply-template`, { template_id: templateId }),
    onSuccess: invalidate,
  });
}

export function useTemplates() {
  return useQuery({ queryKey: ["contracts", "dd-templates"], queryFn: () => api.get<DDTemplate[]>("/dd-templates"), staleTime: 60_000 });
}

/* Reports, title, estoppels, risks, decisions */

function useChildList<T>(contractId: string, path: string) {
  return useQuery({ queryKey: ["contracts", contractId, path], queryFn: () => api.get<T[]>(`/contracts/${contractId}/${path}`) });
}

function useChildSave<T>(contractId: string, path: string, itemPath: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
      id ? api.patch<T>(`/${itemPath}/${id}`, data) : api.post<T>(`/contracts/${contractId}/${path}`, data),
    onSuccess: invalidate,
  });
}

function useChildDelete(itemPath: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.delete(`/${itemPath}/${id}`), onSuccess: invalidate });
}

export const useReports = (id: string) => useChildList<Report>(id, "reports");
export const useSaveReport = (id: string) => useChildSave<Report>(id, "reports", "third-party-reports");
export const useDeleteReport = () => useChildDelete("third-party-reports");

export const useTitleExceptions = (id: string) => useChildList<TitleException>(id, "title-exceptions");
export const useSaveTitleException = (id: string) => useChildSave<TitleException>(id, "title-exceptions", "title-exceptions");
export const useDeleteTitleException = () => useChildDelete("title-exceptions");

export const useEstoppels = (id: string) => useChildList<Estoppel>(id, "estoppels");
export const useSaveEstoppel = (id: string) => useChildSave<Estoppel>(id, "estoppels", "estoppels");
export const useDeleteEstoppel = () => useChildDelete("estoppels");

export function useResolveEstoppel() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.post<Estoppel>(`/estoppels/${id}/resolve`, { note }), onSuccess: invalidate });
}

export const useRisks = (id: string) => useChildList<Risk>(id, "risks");
export const useSaveRisk = (id: string) => useChildSave<Risk>(id, "risks", "risks");
export const useDeleteRisk = () => useChildDelete("risks");

export function useDecideRisk() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: string; reason: string }) => api.post<Risk>(`/risks/${id}/decide`, { decision, reason }),
    onSuccess: invalidate,
  });
}

export const useDecisions = (id: string) => useChildList<Decision>(id, "decisions");

export function useRecordDecision(contractId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<Decision>(`/contracts/${contractId}/decisions`, body), onSuccess: invalidate });
}

export function useContractActivity(id: string) {
  return useQuery({ queryKey: ["contracts", id, "activity"], queryFn: () => api.get<AuditEvent[]>(`/contracts/${id}/activity`) });
}
