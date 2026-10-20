"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Params } from "@/lib/api";

export const STAGES = [
  "sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer",
  "under_contract", "due_diligence", "closing", "closed", "dead", "nurture",
] as const;
export type Stage = (typeof STAGES)[number];
export const ACTIVE_STAGES: Stage[] = ["sourced", "screening", "research", "underwriting", "contact", "negotiation", "offer", "under_contract", "due_diligence", "closing"];
export const PROGRESSION: Stage[] = [...ACTIVE_STAGES, "closed"];

export const STAGE_LABELS: Record<string, string> = {
  sourced: "Sourced",
  screening: "Screening",
  research: "Research",
  underwriting: "Underwriting",
  contact: "Contact",
  negotiation: "Negotiation",
  offer: "Offer",
  under_contract: "Under contract",
  due_diligence: "Due diligence",
  closing: "Closing",
  closed: "Closed",
  dead: "Dead",
  nurture: "Nurture",
};

export const DEAD_REASONS = ["price_gap", "owner_not_selling", "failed_buybox", "title_or_survey", "financing", "competition", "timing", "other"] as const;
export const DEAD_REASON_LABELS: Record<string, string> = {
  price_gap: "Price gap",
  owner_not_selling: "Owner not selling",
  failed_buybox: "Failed buy box",
  title_or_survey: "Title or survey",
  financing: "Financing",
  competition: "Competition",
  timing: "Timing",
  other: "Other",
};
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export interface OpportunityListItem {
  id: string;
  title: string;
  property_id: string | null;
  property_label: string | null;
  property_city: string | null;
  property_state: string | null;
  owner_id: string | null;
  owner_name: string | null;
  stage: Stage;
  stage_entered_at: string;
  stage_age_days: number;
  stalled: boolean;
  priority: string;
  source: string | null;
  next_action: string | null;
  next_action_at: string | null;
  value: number | null;
  price_expectation: number | null;
  offer_price: number | null;
  dead_reason: string | null;
  next_touch_on: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ReactivationRule {
  type: string;
  params: Record<string, unknown>;
}

export interface Opportunity extends OpportunityListItem {
  primary_person_id: string | null;
  primary_person_label: string | null;
  primary_organization_id: string | null;
  primary_organization_label: string | null;
  research_missing_fields: string[];
  research_notes: string | null;
  estimated_value: number | null;
  cap_rate: number | null;
  underwriting_notes: string | null;
  offer_sent_at: string | null;
  response_due_at: string | null;
  contract_executed_on: string | null;
  dd_deadline: string | null;
  closing_date: string | null;
  closed_price: number | null;
  closed_on: string | null;
  closed_snapshot: Record<string, unknown> | null;
  dead_notes: string | null;
  price_gap: number | null;
  reactivation_rule: ReactivationRule | null;
  dead_at: string | null;
  nurture_cadence_days: number | null;
  notes: string | null;
  created_by_id: string | null;
}

export type OpportunityInput = Partial<
  Pick<
    Opportunity,
    | "title" | "owner_id" | "primary_person_id" | "primary_organization_id" | "priority" | "source" | "next_action" | "next_action_at"
    | "research_missing_fields" | "research_notes" | "estimated_value" | "cap_rate" | "underwriting_notes" | "price_expectation"
    | "offer_price" | "offer_sent_at" | "response_due_at" | "contract_executed_on" | "dd_deadline" | "closing_date" | "closed_price"
    | "closed_on" | "dead_reason" | "dead_notes" | "price_gap" | "reactivation_rule" | "next_touch_on" | "nurture_cadence_days"
    | "notes" | "tags"
  >
>;

export interface Requirement {
  key: string;
  label: string;
  met: boolean;
  blocking: boolean;
  detail: string | null;
  fields: string[];
}

export interface StageGates {
  stage: Stage;
  ready: boolean;
  requirements: Requirement[];
}

export interface GatesOut {
  current_stage: Stage;
  next_stage: Stage | null;
  can_override: boolean;
  stages: StageGates[];
}

export interface StageEvent {
  id: string;
  opportunity_id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  actor_id: string | null;
  actor_name: string | null;
  at: string;
  override: boolean;
  reason: string | null;
  unmet: Requirement[];
  snapshot: Record<string, unknown>;
}

export interface ReactivationParamSpec {
  key: string;
  label: string;
  type: "number" | "date" | "select" | "text" | "boolean";
  options?: string[];
}

export interface ReactivationTypeSpec {
  type: string;
  label: string;
  params: ReactivationParamSpec[];
  required: string[];
  any_of: string[];
}

export interface PipelineMeta {
  stages: Stage[];
  active_stages: Stage[];
  terminal_stages: Stage[];
  dead_reasons: string[];
  priorities: string[];
  reactivation_types: ReactivationTypeSpec[];
  default_stall_days: number;
}

export interface BoardColumn {
  stage: Stage;
  count: number;
  value: number;
  stall_days: number;
  items: OpportunityListItem[];
}

export interface PipelineMetrics {
  stages: { stage: Stage; count: number; value: number; avg_age_days: number | null; stalled: number; stall_days: number }[];
  velocity: { stage: Stage; avg_days: number | null; samples: number }[];
  conversion: { stage: Stage; next_stage: Stage; entered: number; converted: number; rate: number | null }[];
  stalled: OpportunityListItem[];
  totals: Record<string, number>;
}

export interface OpportunityFacets {
  stage: Record<string, number>;
  priority: Record<string, number>;
  owner_id: Record<string, number>;
  source: Record<string, number>;
  dead_reason: Record<string, number>;
}

/** Shape of 409/422/403 error details returned by create/move. */
export interface GateErrorDetail {
  message?: string;
  unmet?: Requirement[];
  existing?: { id: string; title: string; stage: string }[];
}

export function stageLabel(s?: string | null) {
  return s ? STAGE_LABELS[s] ?? s : "—";
}

export function usePipelineMeta() {
  return useQuery({ queryKey: ["opportunities", "meta"], queryFn: () => api.get<PipelineMeta>("/opportunities/meta"), staleTime: 10 * 60_000 });
}

export function useOpportunity(id: string | null | undefined) {
  return useQuery({ queryKey: ["opportunities", id], queryFn: () => api.get<Opportunity>(`/opportunities/${id}`), enabled: !!id });
}

export function useGates(id: string | null | undefined) {
  return useQuery({ queryKey: ["opportunities", id, "gates"], queryFn: () => api.get<GatesOut>(`/opportunities/${id}/gates`), enabled: !!id });
}

export function useStageEvents(id: string) {
  return useQuery({ queryKey: ["opportunities", id, "events"], queryFn: () => api.get<StageEvent[]>(`/opportunities/${id}/events`) });
}

export function useBoard(params: Params) {
  return useQuery({
    queryKey: ["opportunities", "board", params],
    queryFn: () => api.get<BoardColumn[]>("/opportunities/board", params),
    placeholderData: keepPreviousData,
  });
}

export function usePipelineMetrics(params: Params) {
  return useQuery({
    queryKey: ["opportunities", "metrics", params],
    queryFn: () => api.get<PipelineMetrics>("/opportunities/metrics", params),
    placeholderData: keepPreviousData,
  });
}

export function useStageSettings() {
  return useQuery({ queryKey: ["opportunities", "stage-settings"], queryFn: () => api.get<Record<string, number>>("/opportunities/stage-settings") });
}

function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string, propertyId?: string | null) => {
    qc.invalidateQueries({ queryKey: ["opportunities"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", "opportunity", id] });
    if (propertyId) {
      qc.invalidateQueries({ queryKey: ["properties", propertyId] });
      qc.invalidateQueries({ queryKey: ["timeline", "property", propertyId] });
    }
  };
}

export function useSaveStageSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (stall_days: Record<string, number>) => api.put<Record<string, number>>("/opportunities/stage-settings", { stall_days }),
    onSuccess: () => invalidate(),
  });
}

export function useCreateOpportunity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ data, force }: { data: OpportunityInput & { property_id: string; override_reason?: string | null }; force?: boolean }) =>
      api.post<Opportunity>("/opportunities", data, force ? { force: true } : undefined),
    onSuccess: (o) => invalidate(o.id, o.property_id),
  });
}

export function useUpdateOpportunity(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: OpportunityInput) => api.patch<Opportunity>(`/opportunities/${id}`, data),
    onSuccess: (o) => invalidate(o.id, o.property_id),
  });
}

export function useMoveOpportunity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, to_stage, fields, override_reason }: { id: string; to_stage: Stage; fields: OpportunityInput; override_reason?: string | null }) =>
      api.post<Opportunity>(`/opportunities/${id}/move`, { to_stage, fields, override_reason: override_reason || null }),
    onSuccess: (o) => invalidate(o.id, o.property_id),
  });
}

export function useDeleteOpportunity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/opportunities/${id}`),
    onSuccess: () => invalidate(),
  });
}

export interface UserOption {
  id: string;
  full_name: string;
  email: string;
}

export function useUserOptions() {
  return useQuery({ queryKey: ["users", "options"], queryFn: () => api.get<UserOption[]>("/users/options"), staleTime: 5 * 60_000, retry: false });
}

/* ------------------------------------------------------------------ date helpers for inputs */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO timestamp -> value for <input type="datetime-local">. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO timestamp (or null). */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
