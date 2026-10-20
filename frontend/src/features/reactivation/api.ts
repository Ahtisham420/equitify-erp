"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

import type { ReactivationTypeSpec } from "@/features/pipeline/api";

export const ITEM_STATUSES = ["pending", "snoozed", "reactivated", "dismissed"] as const;
export const TRIGGER_STATUSES = ["armed", "fired", "cancelled"] as const;

export interface Change {
  label: string;
  from: unknown;
  to: unknown;
  source: string | null;
  observed_on: string | null;
}

export interface OriginalContext {
  title?: string;
  dead_reason?: string | null;
  dead_notes?: string | null;
  dead_at?: string | null;
  last_stage?: string | null;
  price_gap?: number | null;
  price_expectation?: number | null;
  offer_price?: number | null;
  estimated_value?: number | null;
  owner_id?: string | null;
  owner_name?: string | null;
  property_label?: string | null;
  asking_price_at_dead?: number | null;
  asking_price_now?: number | null;
  primary_person?: string | null;
  primary_organization?: string | null;
}

export interface ReactivationItem {
  id: string;
  opportunity_id: string;
  opportunity_title: string | null;
  opportunity_stage: string | null;
  property_id: string | null;
  property_label: string | null;
  trigger_id: string | null;
  trigger_type: string;
  trigger_description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  status: string;
  effective_status: string;
  fired_at: string;
  what_changed: string;
  changes: Change[];
  original_context: OriginalContext;
  score_before: number | null;
  score_after: number | null;
  snoozed_until: string | null;
  decided_by_id: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  reactivated_to_stage: string | null;
  converted: boolean;
  converted_at: string | null;
  task_id: string | null;
  created_at: string;
}

export interface Trigger {
  id: string;
  opportunity_id: string;
  opportunity_title: string | null;
  property_id: string | null;
  property_label: string | null;
  trigger_type: string;
  params: Record<string, unknown>;
  origin: string;
  status: string;
  armed_at: string;
  fire_on: string | null;
  fired_at: string | null;
  last_checked_at: string | null;
  check_count: number;
  baseline: Record<string, unknown>;
  dead_reason: string | null;
  cancelled_reason: string | null;
  description: string | null;
}

export interface ReactivationMeta {
  trigger_types: (ReactivationTypeSpec & { label: string })[];
  item_statuses: string[];
  trigger_statuses: string[];
  reactivate_stages: string[];
  dead_reasons: string[];
  revisit_days_by_reason: Record<string, number>;
  property_fields: { key: string; type: "number" | "date" | "text" }[];
  field_operators: string[];
}

export interface TriggerPerformance {
  trigger_type: string;
  label: string;
  armed: number;
  fired: number;
  pending: number;
  snoozed: number;
  reactivated: number;
  converted: number;
  dismissed: number;
  noise_rate: number | null;
  reactivation_rate: number | null;
  conversion_rate: number | null;
  avg_days_dead_to_fire: number | null;
}

export interface Analytics {
  totals: Record<string, number>;
  by_type: TriggerPerformance[];
  top_dismiss_reasons: { trigger_type: string; reason: string | null; count: number }[];
}

export const OPERATOR_LABELS: Record<string, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=", neq: "≠", changed: "changes" };

export function useReactivationMeta() {
  return useQuery({ queryKey: ["reactivation", "meta"], queryFn: () => api.get<ReactivationMeta>("/reactivation/meta"), staleTime: 10 * 60_000 });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["reactivation"] });
  qc.invalidateQueries({ queryKey: ["opportunities"] });
  qc.invalidateQueries({ queryKey: ["tasks"] });
  qc.invalidateQueries({ queryKey: ["scoring"] });
}

export function useItemAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: "reactivate" | "snooze" | "dismiss"; body: Record<string, unknown> }) =>
      api.post<ReactivationItem>(`/reactivation/items/${id}/${action}`, body),
    onSuccess: () => invalidate(qc),
  });
}

export function useTriggerAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, params, reason }: { id: string; action: "update" | "cancel"; params?: Record<string, unknown>; reason?: string }) =>
      action === "update" ? api.patch<Trigger>(`/reactivation/triggers/${id}`, { params }) : api.post<Trigger>(`/reactivation/triggers/${id}/cancel`, { reason }),
    onSuccess: () => invalidate(qc),
  });
}

export function useScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ checked: number; fired: number; woken: number }>("/reactivation/scan"),
    onSuccess: () => invalidate(qc),
  });
}

export function useReactivationAnalytics(sinceDays: number | null) {
  return useQuery({
    queryKey: ["reactivation", "analytics", sinceDays],
    queryFn: () => api.get<Analytics>("/reactivation/analytics", { since_days: sinceDays }),
  });
}
