"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const CHANNELS = ["phone", "sms", "email"] as const;
export const PHONE_TYPES = ["mobile", "landline", "voip", "unknown"] as const;
export const DNC_STATUSES = ["clear", "listed", "unknown"] as const;
export const CONSENT_STATES = ["unknown", "granted", "revoked"] as const;
export const RESTRICTIONS = ["no_export", "no_outreach", "internal_only", "attribution_required"] as const;
export const CHANNEL_LABELS: Record<string, string> = { phone: "Phone (call)", sms: "SMS", email: "Email" };
export const EVENT_LABELS: Record<string, string> = {
  consent_granted: "Consent granted",
  consent_revoked: "Consent revoked",
  opt_out: "Opt-out",
  suppressed: "Suppressed",
  suppression_lifted: "Suppression lifted",
  dnc_scrubbed: "DNC scrub",
};

export type Channel = (typeof CHANNELS)[number];

export interface ComplianceRecord {
  id: string;
  channel: string;
  value: string;
  normalized_value: string;
  person_id: string | null;
  phone_type: string;
  jurisdiction_state: string | null;
  jurisdiction_country: string;
  dnc_status: string;
  scrub_date: string | null;
  scrub_source: string | null;
  scrub_expires_on: string | null;
  internal_suppression: boolean;
  suppression_reason: string | null;
  suppressed_at: string | null;
  suppressed_until: string | null;
  consent_state: string;
  consent_source: string | null;
  consent_date: string | null;
  opted_out_at: string | null;
  opt_out_count: number;
  provider: string | null;
  notes: string | null;
  updated_at: string;
}

export interface ConsentEvent {
  id: string;
  occurred_at: string;
  record_id: string | null;
  channel: string;
  normalized_value: string;
  person_id: string | null;
  event_type: string;
  source: string | null;
  evidence: string | null;
  actor_id: string | null;
  actor_name: string | null;
  details: Record<string, unknown> | null;
}

export interface RecordDetail extends ComplianceRecord {
  events: ConsentEvent[];
  allowed: boolean;
  reasons: string[];
}

export interface RecordFacets {
  channel: Record<string, number>;
  dnc_status: Record<string, number>;
  consent_state: Record<string, number>;
  phone_type: Record<string, number>;
  suppressed: Record<string, number>;
}

export interface CheckResult {
  channel: string;
  value: string;
  normalized_value: string;
  allowed: boolean;
  reasons: string[];
  record: ComplianceRecord | null;
}

export interface OutboundMessage {
  id: string;
  sent_at: string;
  channel: string;
  to_value: string;
  normalized_value: string;
  person_id: string | null;
  subject: string | null;
  content: string | null;
  actor_id: string | null;
  actor_name: string | null;
  interaction_id: string | null;
  allowed: boolean;
  block_reasons: string[];
}

export interface Cap {
  count: number;
  period_days: number;
}

export interface ComplianceSettings {
  quiet_hours: { start: string; end: string; channels: string[]; default_utc_offset: number };
  frequency_caps: { per_contact?: Cap };
  channel_caps: Partial<Record<Channel, Cap>>;
  scrub_validity_days: number;
  not_interested_suppression_days: number;
  counsel_reviewed_at: string | null;
  counsel_reviewed_by: string | null;
  updated_at: string;
}

export interface ProviderRestriction {
  id: string;
  provider: string;
  restriction: string;
  block_export: boolean;
  notes: string | null;
  is_active: boolean;
  updated_at: string;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["compliance"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  };
}

export function useComplianceRecord(id: string | null) {
  return useQuery({ queryKey: ["compliance", "record", id], queryFn: () => api.get<RecordDetail>(`/compliance/records/${id}`), enabled: !!id });
}

export function useUpsertRecord() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<ComplianceRecord> & { id?: string; channel?: string; value?: string }) =>
      id ? api.patch<ComplianceRecord>(`/compliance/records/${id}`, data) : api.post<ComplianceRecord>("/compliance/records", data),
    onSuccess: invalidate,
  });
}

export function useCheck() {
  return useMutation({
    mutationFn: (body: { channel: string; value: string; at?: string | null }) => api.post<CheckResult>("/compliance/check", body),
  });
}

export function useOptOut() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { channel: string; value: string; source: string; evidence?: string | null; person_id?: string | null }) =>
      api.post<{ record: ComplianceRecord; propagated: number; enrollments_exited: number }>("/compliance/opt-out", body),
    onSuccess: invalidate,
  });
}

export function useConsent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { channel: string; value: string; state: "granted" | "revoked"; source: string; evidence?: string | null; lift_suppression?: boolean; person_id?: string | null }) =>
      api.post<ComplianceRecord>("/compliance/consent", body),
    onSuccess: invalidate,
  });
}

export function useSuppress() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { channel: string; value: string; reason: string; until?: string | null }) => api.post<ComplianceRecord>("/compliance/suppress", body),
    onSuccess: invalidate,
  });
}

export function useComplianceSettings() {
  return useQuery({ queryKey: ["compliance", "settings"], queryFn: () => api.get<ComplianceSettings>("/compliance/settings") });
}

export function useSaveSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Partial<Omit<ComplianceSettings, "updated_at">>) => api.patch<ComplianceSettings>("/compliance/settings", body),
    onSuccess: invalidate,
  });
}

export function useRestrictions() {
  return useQuery({ queryKey: ["compliance", "restrictions"], queryFn: () => api.get<ProviderRestriction[]>("/compliance/provider-restrictions") });
}

export function useSaveRestriction(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Omit<ProviderRestriction, "id" | "updated_at">) =>
      id ? api.patch<ProviderRestriction>(`/compliance/provider-restrictions/${id}`, body) : api.post<ProviderRestriction>("/compliance/provider-restrictions", body),
    onSuccess: invalidate,
  });
}
