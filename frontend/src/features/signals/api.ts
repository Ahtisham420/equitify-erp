"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const SIGNAL_CATEGORIES = ["debt", "legal", "tax", "ownership", "physical", "tenancy", "behavioral", "market", "development"] as const;
export const SIGNAL_STATUSES = ["active", "expired", "dismissed"] as const;
export const SEVERITIES = [1, 2, 3, 4, 5] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  debt: "Debt",
  legal: "Legal",
  tax: "Tax",
  ownership: "Ownership",
  physical: "Physical",
  tenancy: "Tenancy",
  behavioral: "Behavioral",
  market: "Market",
  development: "Development",
};

export const SEVERITY_LABELS: Record<number, string> = { 1: "1 · Minimal", 2: "2 · Low", 3: "3 · Moderate", 4: "4 · High", 5: "5 · Critical" };

export interface Signal {
  id: string;
  property_id: string | null;
  property_label: string | null;
  owner_kind: "person" | "organization" | null;
  owner_id: string | null;
  owner_label: string | null;
  category: string;
  signal_type: string;
  type_label: string | null;
  title: string | null;
  description: string | null;
  observed_on: string;
  severity: number;
  source: string;
  source_reference: string | null;
  confidence: number;
  expires_on: string | null;
  half_life_days: number | null;
  is_sensitive: boolean;
  redacted: boolean;
  status: string;
  effective_status: string;
  current_weight: number;
  age_days: number;
  priority: "low" | "normal" | "high" | "urgent";
  stacked: boolean;
  details: Record<string, unknown>;
  verification: "unverified" | "verified" | "rejected";
  verified_at: string | null;
  dismissed_reason: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export interface SignalInput {
  property_id?: string | null;
  owner_kind?: "person" | "organization" | null;
  owner_id?: string | null;
  signal_type?: string;
  title?: string | null;
  description?: string | null;
  observed_on?: string;
  severity?: number | null;
  source?: string;
  source_reference?: string | null;
  confidence?: number;
  expires_on?: string | null;
  is_sensitive?: boolean | null;
  verified?: boolean;
  details?: Record<string, unknown>;
}

export interface SignalFacets {
  category: Record<string, number>;
  severity: Record<string, number>;
  status: Record<string, number>;
  signal_type: Record<string, number>;
}

export interface SignalType {
  id: string;
  key: string;
  label: string;
  category: string;
  description: string | null;
  default_severity: number;
  half_life_days: number | null;
  default_expiry_days: number | null;
  is_sensitive: boolean;
  is_active: boolean;
  signal_count: number;
  updated_at: string;
}

export type SignalTypeInput = Omit<SignalType, "id" | "signal_count" | "updated_at">;

export interface MotivationContribution {
  signal_id: string;
  signal_type: string;
  category: string;
  severity: number;
  confidence: number;
  weight: number;
  contribution: number;
  observed_on: string;
  source: string;
  stacked: boolean;
}

export interface Motivation {
  property_id: string;
  index: number;
  base: number;
  stack_multiplier: number;
  stacked: boolean;
  stack_count: number;
  window_days: number;
  active_signals: number;
  contributions: MotivationContribution[];
}

export interface SignalSettings {
  enabled: boolean;
  window_days: number;
  min_independent: number;
  stack_bonus: number;
  alert_min_severity: number;
}

export interface SignalSubscription {
  id: string;
  subscriber_id: string;
  name: string;
  categories: string[];
  signal_types: string[];
  min_severity: number;
  property_id: string | null;
  owner_kind: "person" | "organization" | null;
  owner_id: string | null;
  territory_id: string | null;
  property_types: string[];
  stacked_only: boolean;
  is_active: boolean;
  created_at: string;
}

export type SubscriptionInput = Omit<SignalSubscription, "id" | "subscriber_id" | "created_at">;

export function signalTitle(s: Pick<Signal, "title" | "type_label" | "signal_type">) {
  return s.title || s.type_label || s.signal_type.replace(/_/g, " ");
}

export function halfLifeLabel(days: number | null | undefined) {
  if (!days) return "No decay";
  if (days % 365 === 0) return `${days / 365} yr`;
  if (days % 30 === 0) return `${days / 30} mo`;
  return `${days} d`;
}

export function useSignalTypes() {
  return useQuery({ queryKey: ["signals", "types"], queryFn: () => api.get<SignalType[]>("/signals/types"), staleTime: 5 * 60_000 });
}

export function useSignal(id: string | null | undefined) {
  return useQuery({ queryKey: ["signals", id], queryFn: () => api.get<Signal>(`/signals/${id}`), enabled: !!id });
}

export function usePropertySignals(propertyId: string, includeInactive = false) {
  return useQuery({
    queryKey: ["signals", "property", propertyId, includeInactive],
    queryFn: () => api.get<{ motivation: Motivation; signals: Signal[] }>(`/signals/property/${propertyId}`, { include_inactive: includeInactive }),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>, s?: { property_id: string | null }) {
  qc.invalidateQueries({ queryKey: ["signals"] });
  qc.invalidateQueries({ queryKey: ["scoring"] });
  qc.invalidateQueries({ queryKey: ["alerts"] });
  if (s?.property_id) qc.invalidateQueries({ queryKey: ["timeline", "property", s.property_id] });
}

export function useSaveSignal(id?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SignalInput) => (id ? api.patch<Signal>(`/signals/${id}`, data) : api.post<Signal>("/signals", data)),
    onSuccess: (s) => invalidate(qc, s),
  });
}

export function useSignalAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, reason, state }: { id: string; action: "dismiss" | "restore" | "verify" | "delete"; reason?: string; state?: string }) => {
      if (action === "delete") return api.delete<Signal>(`/signals/${id}`);
      if (action === "dismiss") return api.post<Signal>(`/signals/${id}/dismiss`, { reason });
      if (action === "verify") return api.post<Signal>(`/signals/${id}/verify`, { state });
      return api.post<Signal>(`/signals/${id}/restore`);
    },
    onSuccess: (s) => invalidate(qc, s ?? undefined),
  });
}

export function useSaveSignalType(id?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<SignalTypeInput>) => (id ? api.patch<SignalType>(`/signals/types/${id}`, data) : api.post<SignalType>("/signals/types", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["signals"] }),
  });
}

export function useSignalSettings() {
  return useQuery({ queryKey: ["signals", "settings"], queryFn: () => api.get<SignalSettings>("/signals/settings") });
}

export function useSaveSignalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<SignalSettings>) => api.put<SignalSettings>("/signals/settings", data),
    onSuccess: (s) => {
      qc.setQueryData(["signals", "settings"], s);
      qc.invalidateQueries({ queryKey: ["signals"] });
      qc.invalidateQueries({ queryKey: ["automation-rules"] });
    },
  });
}

export function useSignalSubscriptions() {
  return useQuery({ queryKey: ["signals", "subscriptions"], queryFn: () => api.get<SignalSubscription[]>("/signals/subscriptions") });
}

export function useSaveSubscription(id?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SubscriptionInput) => (id ? api.put<SignalSubscription>(`/signals/subscriptions/${id}`, data) : api.post<SignalSubscription>("/signals/subscriptions", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["signals", "subscriptions"] }),
  });
}

export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/signals/subscriptions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["signals", "subscriptions"] }),
  });
}
