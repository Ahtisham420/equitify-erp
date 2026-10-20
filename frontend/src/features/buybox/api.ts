"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const RESULTS = ["pass", "pass_with_exception", "fail", "insufficient_data"] as const;
export type BuyboxResult = (typeof RESULTS)[number];

export const RESULT_LABELS: Record<string, string> = {
  pass: "Pass",
  pass_with_exception: "Pass with exception",
  fail: "Fail",
  insufficient_data: "Insufficient data",
};

export const REQUIREMENTS = ["mandatory", "preferred", "disqualifying"] as const;
export type RequirementLevel = (typeof REQUIREMENTS)[number];

export const REQUIREMENT_LABELS: Record<string, string> = {
  mandatory: "Mandatory",
  preferred: "Preferred",
  disqualifying: "Disqualifying",
};

export const EXCEPTION_LABELS: Record<string, string> = {
  none: "None",
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
};

export type FieldType = "number" | "integer" | "string" | "enum" | "date" | "tags";

export interface FieldMeta {
  key: string;
  label: string;
  type: FieldType;
  unit?: string | null;
  options?: string[];
  derived?: string[];
  operators: string[];
}

export interface BuyboxMeta {
  operators: string[];
  operator_labels: Record<string, string>;
  requirements: string[];
  results: string[];
  exception_states: string[];
  strategies: string[];
  fields: FieldMeta[];
}

export interface CriterionInput {
  field: string;
  operator: string;
  value: unknown;
  requirement: RequirementLevel;
  note?: string | null;
}

export interface Criterion extends CriterionInput {
  id: string;
  position: number;
}

export interface BuyBoxListItem {
  id: string;
  name: string;
  strategy: string;
  owner_id: string | null;
  owner_name: string | null;
  active_from: string | null;
  active_to: string | null;
  is_active: boolean;
  version: number;
  criteria_count: number;
  result_counts: Record<string, number>;
  updated_at: string;
}

export interface BuyBox extends BuyBoxListItem {
  description: string | null;
  criteria: Criterion[];
  created_at: string;
}

export interface BuyBoxInput {
  name: string;
  description?: string | null;
  strategy: string;
  owner_id?: string | null;
  active_from?: string | null;
  active_to?: string | null;
  is_active: boolean;
  criteria?: CriterionInput[];
}

export interface BuyBoxFacets {
  strategy: Record<string, number>;
  is_active: Record<string, number>;
  result: Record<string, number>;
}

export interface BuyboxVersion {
  id: string;
  version: number;
  criteria: (CriterionInput & { id: string; position: number })[];
  change_note: string | null;
  created_at: string;
  created_by_id: string | null;
  created_by_name: string | null;
}

export interface EvaluationDetail {
  criterion_id: string;
  field: string;
  label: string;
  operator: string;
  value: unknown;
  requirement: RequirementLevel;
  actual: unknown;
  outcome: "pass" | "fail" | "missing";
  missing_fields: string[];
  explanation: string;
}

export interface Evaluation {
  id: string;
  property_id: string;
  property_label: string | null;
  property_city: string | null;
  property_state: string | null;
  buy_box_id: string;
  buy_box_name: string | null;
  buy_box_version: number;
  result: BuyboxResult;
  raw_result: BuyboxResult;
  missing_fields: string[];
  details: EvaluationDetail[];
  preferred_misses: EvaluationDetail[];
  evaluated_at: string;
  is_current: boolean;
  trigger: string;
  exception_status: "none" | "requested" | "approved" | "rejected";
  exception_requested_by_id: string | null;
  exception_requested_by_name: string | null;
  exception_requested_at: string | null;
  exception_request_reason: string | null;
  exception_approver_id: string | null;
  exception_approver_name: string | null;
  exception_decided_at: string | null;
  exception_decision_reason: string | null;
}

export interface EvaluateAllResult {
  evaluated: number;
  changed: number;
  unchanged: number;
  by_result: Record<string, number>;
}

export function useBuyboxMeta() {
  return useQuery({ queryKey: ["buybox", "meta"], queryFn: () => api.get<BuyboxMeta>("/buy-boxes/meta"), staleTime: 10 * 60_000 });
}

export function useBuyBox(id: string) {
  return useQuery({ queryKey: ["buybox", id], queryFn: () => api.get<BuyBox>(`/buy-boxes/${id}`) });
}

export function useBuyBoxVersions(id: string) {
  return useQuery({ queryKey: ["buybox", id, "versions"], queryFn: () => api.get<BuyboxVersion[]>(`/buy-boxes/${id}/versions`) });
}

export function useSaveBuyBox(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BuyBoxInput>) => (id ? api.patch<BuyBox>(`/buy-boxes/${id}`, data) : api.post<BuyBox>("/buy-boxes", data)),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["buybox"] });
      qc.invalidateQueries({ queryKey: ["buy-boxes"] });
      qc.invalidateQueries({ queryKey: ["timeline", "buy_box", b.id] });
    },
  });
}

export function useReplaceCriteria(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { criteria: CriterionInput[]; change_note?: string | null }) => api.put<BuyBox>(`/buy-boxes/${id}/criteria`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buybox"] });
      qc.invalidateQueries({ queryKey: ["buy-boxes"] });
      qc.invalidateQueries({ queryKey: ["timeline", "buy_box", id] });
    },
  });
}

export function useEvaluateAll(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EvaluateAllResult>(`/buy-boxes/${id}/evaluate-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buybox"] });
      qc.invalidateQueries({ queryKey: ["buybox-evaluations"] });
      qc.invalidateQueries({ queryKey: ["buy-boxes"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function usePropertyEvaluations(propertyId: string, history = false) {
  return useQuery({
    queryKey: ["buybox-evaluations", "property", propertyId, history],
    queryFn: () => api.get<Evaluation[]>(`/properties/${propertyId}/buybox-evaluations`, { history }),
  });
}

export function useRunPropertyEvaluation(propertyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Evaluation[]>(`/properties/${propertyId}/buybox-evaluations/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["buybox-evaluations"] });
      qc.invalidateQueries({ queryKey: ["buybox"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

function useExceptionMutation<T>(fn: (vars: T) => Promise<Evaluation>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (ev) => {
      qc.invalidateQueries({ queryKey: ["buybox-evaluations"] });
      qc.invalidateQueries({ queryKey: ["buybox"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["timeline", "property", ev.property_id] });
    },
  });
}

export function useRequestException() {
  return useExceptionMutation(({ id, reason }: { id: string; reason: string }) =>
    api.post<Evaluation>(`/buybox-evaluations/${id}/exception-request`, { reason }),
  );
}

export function useDecideException() {
  return useExceptionMutation(({ id, approve, reason }: { id: string; approve: boolean; reason: string }) =>
    api.post<Evaluation>(`/buybox-evaluations/${id}/exception-decision`, { approve, reason }),
  );
}

/** Human-readable rendering of a criterion value. */
export function describeValue(value: unknown, field?: FieldMeta): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map((v) => describeValue(v, field)).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    const s = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    if (field?.unit === "$") return `$${s}`;
    if (field?.unit) return `${s} ${field.unit}`;
    return s;
  }
  return String(value);
}

export function describeCriterion(c: CriterionInput, meta?: BuyboxMeta): string {
  const field = meta?.fields.find((f) => f.key === c.field);
  const op = meta?.operator_labels[c.operator] ?? c.operator;
  if (c.operator === "is_set") return `${field?.label ?? c.field} ${c.value === false ? "is empty" : "is set"}`;
  const value = c.operator === "between" && Array.isArray(c.value) ? c.value.map((v) => describeValue(v, field)).join(" and ") : describeValue(c.value, field);
  return `${field?.label ?? c.field} ${op} ${value}`;
}
