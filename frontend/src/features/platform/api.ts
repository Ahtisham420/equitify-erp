"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- Types ---------------------------------------------------------------------------------------

export interface ProviderOption {
  name: string;
  label: string;
  description: string | null;
  required_config: string[];
  required_credentials: string[];
}

export interface Integration {
  id: string;
  category: string;
  provider: string;
  label: string | null;
  status: "not_configured" | "manual" | "active" | "error" | "disabled";
  is_primary: boolean;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  credentials_version: number;
  credentials_rotated_at: string | null;
  usage_restrictions: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_tested_at: string | null;
  updated_at: string;
}

export interface IntegrationCategory {
  key: string;
  label: string;
  providers: Integration[];
  options: ProviderOption[];
}

export interface TestResult {
  ok: boolean;
  message: string;
  missing: string[];
  integration: Integration;
}

export interface FeatureFlag {
  id: string;
  key: string;
  description: string | null;
  enabled: boolean;
  is_sensitive: boolean;
  rollout_roles: string[];
  rollout_user_ids: string[];
  updated_at: string;
  updated_by_id: string | null;
}

export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  last_delivery_at: string | null;
  consecutive_failures: number;
  created_at: string;
  secret: string | null;
}

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  subscription_name: string | null;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "sending" | "delivered" | "failed" | "dead";
  attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface JobRun {
  id: string;
  job_key: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  counts: Record<string, unknown>;
  triggered_by_id: string | null;
}

export interface JobSummary {
  job_key: string;
  runs: number;
  failures: number;
  last_status: string;
  last_started_at: string;
  last_error: string | null;
}

export interface ExportEvent {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  summary: string | null;
  rows: number | null;
  ip_address: string | null;
}

export interface ExportByUser {
  actor_id: string | null;
  actor_name: string | null;
  exports: number;
  rows: number;
  last_at: string;
}

export interface RetentionPolicy {
  id: string;
  entity_type: string;
  retain_days: number;
  action: "review" | "archive";
  description: string | null;
  is_active: boolean;
  updated_at: string;
}

export interface LegalHold {
  id: string;
  entity_type: string;
  entity_id: string | null;
  reason: string;
  matter: string | null;
  placed_by_id: string | null;
  placed_by_name: string | null;
  placed_at: string;
  released_at: string | null;
  released_by_id: string | null;
  release_reason: string | null;
}

export interface BackupRecord {
  id: string;
  kind: "backup" | "restore_test";
  environment: string;
  performed_at: string;
  reference: string | null;
  encrypted: boolean;
  point_in_time: boolean;
  size_bytes: number | null;
  rpo_target_minutes: number | null;
  rto_target_minutes: number | null;
  achieved_rpo_minutes: number | null;
  achieved_rto_minutes: number | null;
  result: "success" | "partial" | "failed";
  notes: string | null;
  performed_by_id: string | null;
  meets_targets: boolean | null;
}

export interface HealthCheck {
  key: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface Health {
  status: "ok" | "warning" | "error";
  environment: string;
  checked_at: string;
  db_latency_ms: number | null;
  job_failures_24h: number;
  webhook_dead_letters: number;
  webhook_pending: number;
  integrations_in_error: number;
  ai: { name: string; model: string; available: boolean };
  last_backup_at: string | null;
  last_restore_test_at: string | null;
  checks: HealthCheck[];
}

export interface EnvironmentInfo {
  environment: string;
  app_name: string;
  api_prefix: string;
  api_version: string;
  encryption_key_configured: boolean;
  ai_configured: boolean;
  mfa_enforced: boolean;
  data_rules: string[];
}

export interface ApiCatalog {
  version: string;
  prefix: string;
  auth: string[];
  actions: string[];
  modules: { module: string; label: string; scopes: string[] }[];
  webhook_events: string[];
}

// --- Query keys ----------------------------------------------------------------------------------

export const platformKeys = {
  all: ["platform"] as const,
  health: ["platform", "health"] as const,
  environment: ["platform", "environment"] as const,
  api: ["platform", "api"] as const,
  integrations: ["platform", "integrations"] as const,
  flags: ["platform", "flags"] as const,
  subscriptions: ["platform", "webhooks", "subscriptions"] as const,
  events: ["platform", "webhooks", "events"] as const,
  jobSummary: (days: number) => ["platform", "jobs", "summary", days] as const,
  exportsByUser: (days: number) => ["platform", "exports", "by-user", days] as const,
  retention: ["platform", "retention"] as const,
  holds: (active: boolean) => ["platform", "legal-holds", active] as const,
  backups: ["platform", "backups"] as const,
};

// --- Hooks ---------------------------------------------------------------------------------------

export const useHealth = () => useQuery({ queryKey: platformKeys.health, queryFn: () => api.get<Health>("/platform/health"), refetchInterval: 60_000 });
export const useEnvironment = () => useQuery({ queryKey: platformKeys.environment, queryFn: () => api.get<EnvironmentInfo>("/platform/environment") });
export const useApiCatalog = () => useQuery({ queryKey: platformKeys.api, queryFn: () => api.get<ApiCatalog>("/platform/api") });
export const useIntegrations = () => useQuery({ queryKey: platformKeys.integrations, queryFn: () => api.get<IntegrationCategory[]>("/platform/integrations") });
export const useFlags = () => useQuery({ queryKey: platformKeys.flags, queryFn: () => api.get<FeatureFlag[]>("/platform/flags") });
export const useSubscriptions = () => useQuery({ queryKey: platformKeys.subscriptions, queryFn: () => api.get<WebhookSubscription[]>("/platform/webhooks/subscriptions") });
export const useWebhookEvents = () => useQuery({ queryKey: platformKeys.events, queryFn: () => api.get<string[]>("/platform/webhooks/events"), staleTime: Infinity });
export const useJobSummary = (days: number) => useQuery({ queryKey: platformKeys.jobSummary(days), queryFn: () => api.get<JobSummary[]>("/platform/jobs/summary", { days }) });
export const useExportsByUser = (days: number) => useQuery({ queryKey: platformKeys.exportsByUser(days), queryFn: () => api.get<ExportByUser[]>("/platform/exports/by-user", { days }) });
export const useRetention = () => useQuery({ queryKey: platformKeys.retention, queryFn: () => api.get<RetentionPolicy[]>("/platform/retention") });
export const useLegalHolds = (active: boolean) => useQuery({ queryKey: platformKeys.holds(active), queryFn: () => api.get<LegalHold[]>("/platform/legal-holds", { active }) });
export const useBackups = () => useQuery({ queryKey: platformKeys.backups, queryFn: () => api.get<BackupRecord[]>("/platform/backups") });

/** Mutation helper that invalidates the whole platform namespace on success. */
export function usePlatformMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: platformKeys.all }),
  });
}

// --- AI ------------------------------------------------------------------------------------------

export interface PropertyResult {
  id: string;
  name: string | null;
  address_line: string;
  city: string | null;
  state: string | null;
  county: string | null;
  property_type: string;
  status: string;
  building_area_sf: number | null;
  land_area_acres: number | null;
  asking_price: number | null;
  occupancy_pct: number | null;
  year_built: number | null;
  completeness_score: number;
  tags: string[];
  updated_at: string;
}

export interface NLQueryResult {
  question: string;
  ai_used: boolean;
  provider: string;
  message: string | null;
  filters: Record<string, string | number | (string | number)[]>;
  unmapped: string[];
  items: PropertyResult[];
  total: number;
  page: number;
  page_size: number;
}

export interface AISuggestion {
  id: string;
  source_type: string;
  source_id: string;
  kind: "summary" | "commitment" | "next_action";
  content: string;
  details: { party?: string | null; due_hint?: string | null; due_in_days?: number | null; rationale?: string | null; original?: string };
  status: "pending" | "accepted" | "rejected" | "superseded";
  provider: string | null;
  model: string | null;
  decided_by_id: string | null;
  decided_at: string | null;
  task_id: string | null;
  created_at: string;
}

export interface SummarizeResult {
  ai_used: boolean;
  provider: string;
  message: string | null;
  suggestions: AISuggestion[];
}

export interface TalkingPointsResult {
  person_id: string;
  person_name: string;
  ai_used: boolean;
  provider: string;
  message: string | null;
  points: { text: string; basis: string }[];
  properties: { id: string; label: string; relationship: string; property_type: string; status: string; city: string | null; state: string | null; opportunity_stage: string | null }[];
  recent_interactions: { id: string; occurred_at: string; channel: string; disposition: string | null; summary: string; next_action: string | null }[];
  signals: { property_id: string; property: string; title: string; category: string; observed_on: string; severity: number; source: string }[];
  valuations: { property_id: string; property: string; value_point: number | null; value_low: number | null; value_high: number | null; as_of: string | null; method: string | null }[];
}

export const aiKeys = {
  suggestions: (interactionId: string) => ["platform", "ai", "suggestions", interactionId] as const,
  talkingPoints: (personId: string) => ["platform", "ai", "talking-points", personId] as const,
};

export const useAIStatus = () =>
  useQuery({ queryKey: ["platform", "ai", "status"], queryFn: () => api.get<{ name: string; model: string; available: boolean }>("/platform/ai/status"), staleTime: 300_000 });

export const useInteractionSuggestions = (interactionId: string) =>
  useQuery({ queryKey: aiKeys.suggestions(interactionId), queryFn: () => api.get<AISuggestion[]>(`/platform/ai/interactions/${interactionId}/suggestions`) });

export const useTalkingPoints = (personId: string, enabled = true) =>
  useQuery({
    queryKey: aiKeys.talkingPoints(personId),
    queryFn: () => api.get<TalkingPointsResult>(`/platform/ai/talking-points/${personId}`),
    enabled,
    staleTime: 300_000,
  });
