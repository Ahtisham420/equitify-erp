"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const BANDS = ["high", "medium", "low"] as const;
export type Band = (typeof BANDS)[number];
export const BAND_LABELS: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
export const COMPONENT_KEYS = ["economics", "location", "motivation", "transaction_probability", "relationship", "negative_risk"] as const;
export const COMPONENT_LABELS: Record<string, string> = {
  economics: "Economics / pricing gap",
  location: "Location / growth",
  motivation: "Owner motivation",
  transaction_probability: "Transaction probability",
  relationship: "Relationship strength",
  negative_risk: "Negative risk",
};
export const COMPONENT_SHORT: Record<string, string> = {
  economics: "Econ",
  location: "Loc",
  motivation: "Motiv",
  transaction_probability: "Prob",
  relationship: "Rel",
  negative_risk: "Risk",
};

export interface ScoreComponent {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  inputs: Record<string, unknown>;
  positive: string[];
  negative: string[];
  missing: string[];
}

export interface ConfidenceFactor {
  key: string;
  label: string;
  value: number;
  weight: number;
  detail: string | null;
}

export interface Score {
  id: string;
  property_id: string;
  score: number;
  confidence: number;
  adjusted_score: number;
  band: Band;
  components: ScoreComponent[];
  confidence_factors: ConfidenceFactor[];
  drivers: { positive?: string[]; negative?: string[]; note?: string };
  eligibility: { buy_box_id?: string; buy_box_name?: string; version?: number; result: string }[];
  config_version: number;
  needs_research: boolean;
  requires_human_approval: boolean;
  value_basis: number | null;
  trigger: string;
  computed_at: string;
  is_current: boolean;
}

export interface HistoryPoint {
  id: string;
  score: number;
  confidence: number;
  band: Band;
  config_version: number;
  trigger: string;
  computed_at: string;
}

export interface PropertyScore {
  property_id: string;
  eligible: boolean;
  eligibility: { buy_box_id?: string; buy_box_name?: string; version?: number; result: string }[];
  score: Score | null;
  history: HistoryPoint[];
}

export interface RankingItem {
  id: string;
  property_id: string;
  property_label: string | null;
  property_city: string | null;
  property_state: string | null;
  property_type: string | null;
  asking_price: number | null;
  position: number;
  score: number;
  confidence: number;
  adjusted_score: number;
  band: Band;
  config_version: number;
  needs_research: boolean;
  requires_human_approval: boolean;
  component_values: Record<string, number>;
  top_positive: string | null;
  top_negative: string | null;
  previous_score: number | null;
  computed_at: string;
}

export interface RankingFacets {
  band: Record<string, number>;
  property_type: Record<string, number>;
}

export interface ScoreConfig {
  id: string;
  version: number;
  name: string;
  status: "draft" | "proposed" | "active" | "retired" | "rejected";
  weights: Record<string, number>;
  band_thresholds: Record<string, number>;
  alert_threshold: number;
  high_dollar_threshold: number;
  notes: string | null;
  source: string;
  basis: {
    samples?: number;
    won?: number;
    lost?: number;
    components?: Record<string, { won_mean: number; lost_mean: number; separation: number; factor: number; old_weight: number; new_weight: number }>;
  };
  based_on_version: number | null;
  approved_by_id: string | null;
  approved_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
  rejected_reason: string | null;
  created_at: string;
  created_by_id: string | null;
}

export interface ConfigInput {
  name: string;
  weights: Record<string, number>;
  band_thresholds: Record<string, number>;
  alert_threshold: number;
  high_dollar_threshold: number;
  notes: string | null;
}

export interface Outcome {
  id: string;
  property_id: string;
  property_label: string | null;
  opportunity_id: string | null;
  disposition: string;
  decided_at: string;
  score_at_decision: number | null;
  confidence_at_decision: number | null;
  band_at_decision: string | null;
  config_version: number | null;
  components_at_decision: Record<string, number>;
  result: "open" | "won" | "lost";
  result_at: string | null;
  elapsed_days: number | null;
  source: string;
  notes: string | null;
}

export interface OutcomeSummary {
  total: number;
  won: number;
  lost: number;
  open: number;
  avg_score_won: number | null;
  avg_score_lost: number | null;
  by_band: Record<string, Record<string, number>>;
  recalibration_ready: boolean;
  min_required: Record<string, number>;
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["scoring"] });
}

export function usePropertyScore(propertyId: string | null | undefined) {
  return useQuery({
    queryKey: ["scoring", "property", propertyId],
    queryFn: () => api.get<PropertyScore>(`/scoring/properties/${propertyId}`),
    enabled: !!propertyId,
  });
}

export function useRescore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => api.post<PropertyScore>(`/scoring/properties/${propertyId}/rescore`),
    onSuccess: (r) => {
      invalidate(qc);
      qc.setQueryData(["scoring", "property", r.property_id], r);
      qc.invalidateQueries({ queryKey: ["timeline", "property", r.property_id] });
    },
  });
}

export function useScoreConfigs() {
  return useQuery({ queryKey: ["scoring", "configs"], queryFn: () => api.get<ScoreConfig[]>("/scoring/configs") });
}

export function useSaveConfig(id?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ConfigInput) => (id ? api.put<ScoreConfig>(`/scoring/configs/${id}`, data) : api.post<ScoreConfig>("/scoring/configs", data)),
    onSuccess: () => invalidate(qc),
  });
}

export function useConfigAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "activate" | "reject"; reason?: string }) =>
      api.post<ScoreConfig>(`/scoring/configs/${id}/${action}`, action === "reject" ? { reason } : undefined),
    onSuccess: () => invalidate(qc),
  });
}

export function useRecalibrate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ScoreConfig>("/scoring/configs/recalibrate"),
    onSuccess: () => invalidate(qc),
  });
}

export function useOutcomeSummary() {
  return useQuery({ queryKey: ["scoring", "outcomes", "summary"], queryFn: () => api.get<OutcomeSummary>("/scoring/outcomes/summary") });
}

export function useRescoreAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ rescored: number }>("/scoring/rescore-all"),
    onSuccess: () => invalidate(qc),
  });
}
