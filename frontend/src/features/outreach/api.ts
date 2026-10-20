"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page } from "@/lib/api";

export const CHANNELS = ["call", "email", "sms", "meeting", "tour", "letter", "note"] as const;
export const DIRECTIONS = ["outbound", "inbound", "internal"] as const;
export const DISPOSITIONS = [
  "connected", "voicemail", "no_answer", "wrong_number", "gatekeeper", "not_interested", "callback",
  "information_requested", "offer_requested",
] as const;
export const MEANINGFUL_DISPOSITIONS = ["connected", "callback", "information_requested", "offer_requested"];
export const MEANINGFUL_CHANNELS = ["meeting", "tour"];

export const CHANNEL_LABELS: Record<string, string> = {
  call: "Call", email: "Email", sms: "SMS", meeting: "Meeting", tour: "Tour", letter: "Letter", note: "Note",
};
export const DISPOSITION_LABELS: Record<string, string> = {
  connected: "Connected", voicemail: "Voicemail", no_answer: "No answer", wrong_number: "Wrong number",
  gatekeeper: "Gatekeeper", not_interested: "Not interested", callback: "Callback",
  information_requested: "Information requested", offer_requested: "Offer requested",
};
export const DISPOSITION_TONES: Record<string, "green" | "amber" | "red" | "neutral" | "blue" | "sky"> = {
  connected: "green", voicemail: "neutral", no_answer: "neutral", wrong_number: "red", gatekeeper: "amber",
  not_interested: "red", callback: "blue", information_requested: "sky", offer_requested: "green",
};

export function isMeaningful(channel: string, disposition?: string | null) {
  return MEANINGFUL_CHANNELS.includes(channel) || (!!disposition && MEANINGFUL_DISPOSITIONS.includes(disposition));
}

export interface RecordLinks {
  person_id?: string;
  organization_id?: string;
  property_id?: string;
  opportunity_id?: string;
}

export interface Interaction {
  id: string;
  channel: string;
  direction: string;
  occurred_at: string;
  person_id: string | null;
  person_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  property_id: string | null;
  property_label: string | null;
  opportunity_id: string | null;
  opportunity_title: string | null;
  contact_value: string | null;
  disposition: string | null;
  subject: string | null;
  summary: string | null;
  duration_seconds: number | null;
  is_meaningful: boolean;
  next_action: string | null;
  next_action_at: string | null;
  follow_up_task_id: string | null;
  loop_closed: boolean;
  closed_reason: string | null;
  logged_by_id: string | null;
  logged_by_name: string | null;
  sequence_enrollment_id: string | null;
  created_at: string;
}

export interface InteractionInput {
  channel: string;
  direction: string;
  occurred_at?: string | null;
  person_id?: string | null;
  organization_id?: string | null;
  property_id?: string | null;
  opportunity_id?: string | null;
  contact_value?: string | null;
  disposition?: string | null;
  subject?: string | null;
  summary?: string | null;
  duration_seconds?: number | null;
  next_action?: string | null;
  next_action_at?: string | null;
  loop_closed?: boolean;
  closed_reason?: string | null;
  sequence_enrollment_id?: string | null;
  complete_task_id?: string | null;
}

export interface InteractionFacets {
  channel: Record<string, number>;
  direction: Record<string, number>;
  disposition: Record<string, number>;
}

export interface QueueItem {
  key: string;
  kind: "task" | "follow_up" | "sequence_step" | "stalled_deal" | "person_due" | "relationship";
  title: string;
  subtitle: string | null;
  score: number;
  reasons: string[];
  due_at: string | null;
  person_id: string | null;
  organization_id: string | null;
  property_id: string | null;
  opportunity_id: string | null;
  task_id: string | null;
  enrollment_id: string | null;
}

export interface QueueOut {
  items: QueueItem[];
  cap: number;
  total_candidates: number;
  done_today: number;
}

export interface ChannelStatus {
  channel: string;
  value: string;
  normalized_value: string;
  allowed: boolean;
  reasons: string[];
  dnc_status: string;
  consent_state: string;
  suppressed: boolean;
  phone_type: string | null;
  record_id: string | null;
}

export interface Enrollment {
  id: string;
  sequence_id: string;
  sequence_name: string | null;
  person_id: string;
  person_name: string | null;
  owner_id: string | null;
  status: string;
  current_step: number;
  total_steps: number;
  next_step_at: string | null;
  next_step_channel: string | null;
  enrolled_at: string;
  exited_at: string | null;
  exit_reason: string | null;
  last_step_at: string | null;
}

export interface PersonContext {
  person: {
    id: string;
    full_name: string;
    title: string | null;
    primary_email: string | null;
    primary_phone: string | null;
    city: string | null;
    state: string | null;
    owner_id: string | null;
    last_touch_at: string | null;
    next_action_at: string | null;
    relationship_strength: string | number | null;
    tags: string[] | null;
    contact_preferences: unknown;
  } | null;
  organizations: { id: string; name: string; role: string | null; title: string | null; is_current: boolean | null }[];
  properties: { id: string; name: string | null; address_line: string; city: string | null; state: string | null; property_type: string; status: string; role: string | null; interest_pct: number | null }[];
  opportunities: { id: string; title: string; stage: string; stage_entered_at: string | null; next_action: string | null; next_action_at: string | null; property_id: string | null; price_expectation: number | null }[];
  interactions: Interaction[];
  open_tasks: { id: string; title: string; due_at: string | null; priority: string; status: string; task_type: string }[];
  enrollments: Enrollment[];
  contacts: { kind: string; label: string | null; value: string; channels: ChannelStatus[] }[];
  suppression_reasons: string[];
  talking_points: string[];
}

export interface SequenceStep {
  channel: "call" | "email" | "sms" | "letter";
  delay_days: number;
  template: string | null;
}

export interface Sequence {
  id: string;
  name: string;
  description: string | null;
  status: string;
  steps: SequenceStep[];
  enrollment_cap: number | null;
  exit_dispositions: string[];
  owner_id: string | null;
  active_enrollments: number;
  total_enrollments: number;
  created_at: string;
  updated_at: string;
}

export interface SequenceInput {
  name: string;
  description: string | null;
  status: string;
  steps: SequenceStep[];
  enrollment_cap: number | null;
  exit_dispositions: string[];
}

export interface TeamActivity {
  date_from: string;
  date_to: string;
  rows: {
    user_id: string;
    user_name: string;
    total: number;
    meaningful: number;
    by_channel: Record<string, number>;
    by_disposition: Record<string, number>;
    overdue_follow_ups: number;
    stale_records: number;
    untouched_records: number;
  }[];
  overdue: { id: string; title: string; due_at: string | null; assignee_name: string | null; related_type: string | null; related_id: string | null; related_label: string | null }[];
}

function useInvalidateOutreach() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["interactions"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["sequences"] });
    qc.invalidateQueries({ queryKey: ["compliance"] });
    qc.invalidateQueries({ queryKey: ["timeline"] });
  };
}

export function useLogInteraction() {
  const invalidate = useInvalidateOutreach();
  return useMutation({
    mutationFn: (data: InteractionInput) => api.post<Interaction>("/interactions", data),
    onSuccess: invalidate,
  });
}

export function useUpdateInteraction(id: string) {
  const invalidate = useInvalidateOutreach();
  return useMutation({
    mutationFn: (data: Partial<Pick<Interaction, "subject" | "summary" | "next_action" | "next_action_at" | "loop_closed" | "closed_reason">>) =>
      api.patch<Interaction>(`/interactions/${id}`, data),
    onSuccess: invalidate,
  });
}

export function useRecordInteractions(filter: RecordLinks, pageSize = 10) {
  return useQuery({
    queryKey: ["interactions", "record", filter, pageSize],
    queryFn: () => api.get<Page<Interaction>>("/interactions", { ...filter, page_size: pageSize }),
    enabled: Object.values(filter).some(Boolean),
  });
}

export function useQueue(limit: number) {
  return useQuery({ queryKey: ["queue", limit], queryFn: () => api.get<QueueOut>("/queue", { limit }) });
}

export function usePersonContext(personId: string | null | undefined) {
  return useQuery({
    queryKey: ["queue", "context", personId],
    queryFn: () => api.get<PersonContext>(`/queue/context/${personId}`),
    enabled: !!personId,
  });
}

export function useSequences() {
  return useQuery({ queryKey: ["sequences", "list"], queryFn: () => api.get<Sequence[]>("/sequences") });
}

export function useSaveSequence(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SequenceInput) => (id ? api.patch<Sequence>(`/sequences/${id}`, data) : api.post<Sequence>("/sequences", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
  });
}

export function useEnroll(sequenceId: string) {
  const invalidate = useInvalidateOutreach();
  return useMutation({
    mutationFn: (personIds: string[]) =>
      api.post<{ enrolled: number; skipped: { person_id: string; reason: string }[] }>(`/sequences/${sequenceId}/enroll`, { person_ids: personIds }),
    onSuccess: invalidate,
  });
}

export function useEnrollmentAction() {
  const invalidate = useInvalidateOutreach();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "exit" | "advance"; reason?: string }) =>
      api.post<Enrollment>(`/sequence-enrollments/${id}/${action}`, action === "exit" ? { reason } : undefined),
    onSuccess: invalidate,
  });
}

export function useTeamActivity(params: { date_from?: string; date_to?: string }, enabled: boolean) {
  return useQuery({
    queryKey: ["interactions", "team-activity", params],
    queryFn: () => api.get<TeamActivity>("/outreach/team-activity", params),
    enabled,
  });
}

export function formatDuration(seconds?: number | null) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s ? `${s}s` : ""}`.trim() : `${s}s`;
}
