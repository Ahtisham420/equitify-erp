"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TASK_TYPES = ["follow_up", "call", "research", "review", "approval", "due_diligence", "general"] as const;
export const ALERT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export const ALERT_RESOLUTIONS = [
  { value: "actioned", label: "Actioned — work was done" },
  { value: "not_actionable", label: "Not actionable" },
  { value: "duplicate", label: "Duplicate" },
  { value: "false_positive", label: "False positive" },
] as const;
export const RELATED_TYPES = ["property", "person", "organization", "opportunity"] as const;

export const TASK_TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  call: "Call",
  research: "Research",
  review: "Review",
  approval: "Approval",
  due_diligence: "Due diligence",
  general: "General",
};

export interface TaskRef {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: string;
  priority: string;
  due_at: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  related_type: string | null;
  related_id: string | null;
  related_label: string | null;
  source: string;
  depends_on: string[];
  dependencies: TaskRef[];
  blocked: boolean;
  completed_at: string | null;
  completed_by_id: string | null;
  resolution_note: string | null;
  escalation_level: number;
  created_at: string;
  updated_at: string;
  created_by_id: string | null;
}

export interface TaskInput {
  title?: string;
  description?: string | null;
  task_type?: string;
  priority?: string;
  status?: string;
  due_at?: string | null;
  assignee_id?: string | null;
  related_type?: string | null;
  related_id?: string | null;
  related_label?: string | null;
  depends_on?: string[];
}

export interface TaskFacets {
  status: Record<string, number>;
  priority: Record<string, number>;
  task_type: Record<string, number>;
}

export interface Alert {
  id: string;
  title: string;
  reason: string;
  severity: string;
  status: string;
  owner_id: string | null;
  owner_name: string | null;
  related_type: string | null;
  related_id: string | null;
  related_label: string | null;
  rule_key: string | null;
  due_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolved_by_id: string | null;
  resolution_note: string | null;
  resolution_kind: string | null;
  escalation_level: number;
  created_at: string;
}

export interface AlertFacets {
  status: Record<string, number>;
  severity: Record<string, number>;
  rule_key: Record<string, number>;
}

export interface AutomationRule {
  id: string;
  key: string;
  name: string;
  description: string | null;
  event: string | null;
  enabled: boolean;
  thresholds: Record<string, unknown>;
  last_run_at: string | null;
  run_count: number;
  error_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface NoiseRow {
  rule_key: string;
  total: number;
  open: number;
  actioned: number;
  dismissed: number;
  dismiss_rate: number;
  avg_hours_to_resolve: number | null;
}

export interface EscalationResult {
  dry_run: boolean;
  skipped: boolean;
  tasks_escalated: number;
  alerts_escalated: number;
  managers_notified: number;
  items: { kind: string; id: string; title: string; level: number; priority?: { from: string; to: string }; severity?: { from: string; to: string } }[];
}

export interface Subscription {
  id: string;
  name: string;
  subscriber_id: string;
  subscriber_name: string | null;
  territory_id: string | null;
  property_types: string[];
  tenant: string | null;
  owner_id: string | null;
  saved_view_id: string | null;
  rule_keys: string[];
  min_severity: string;
  channel: "in_app" | "email" | "digest";
  is_active: boolean;
  created_at: string;
}

export type SubscriptionInput = Omit<Subscription, "id" | "subscriber_name" | "created_at" | "subscriber_id"> & { subscriber_id?: string | null };

export interface Digest {
  generated_at: string;
  due_today: Task[];
  overdue: Task[];
  new_alerts: Alert[];
  subscribed_alerts: Alert[];
}

/** Where a polymorphic related record lives in the app. */
/** Detail route per related record type; every module's tasks/alerts link back to their source record. */
const RELATED_ROUTES: Record<string, (id: string) => string> = {
  property: (id) => `/properties/${id}`,
  person: (id) => `/people/${id}`,
  organization: (id) => `/organizations/${id}`,
  opportunity: (id) => `/pipeline/${id}`,
  task: (id) => `/tasks?task=${id}`,
  parcel: (id) => `/parcels/${id}`,
  territory: (id) => `/territories/${id}`,
  buy_box: (id) => `/buy-boxes/${id}`,
  document: (id) => `/documents/${id}`,
  uw_model: (id) => `/underwriting/${id}`,
  comp_set: (id) => `/comps/sets/${id}`,
  offer: (id) => `/offers/${id}`,
  contract: (id) => `/contracts/${id}`,
  closing: (id) => `/closings/${id}`,
  asset: (id) => `/assets/${id}`,
  lease: (id) => `/leases/${id}`,
  loan: (id) => `/loans/${id}`,
  disposition: (id) => `/dispositions/${id}`,
  work_order: (id) => `/work-orders/${id}`,
  inspection: (id) => `/inspections/${id}`,
  vendor: (id) => `/vendors/${id}`,
  capital_project: (id) => `/capital-projects/${id}`,
  budget: (id) => `/budgets/${id}`,
  capital_partner: (id) => `/investors/${id}`,
  listing: (id) => `/listings/${id}`,
  tour: (id) => `/tours/${id}`,
  deal_room: (id) => `/tours/rooms/${id}`,
  import_job: (id) => `/imports/${id}`,
  user: (id) => `/admin/users/${id}`,
};

export function relatedHref(type?: string | null, id?: string | null): string | null {
  if (!type || !id) return null;
  return RELATED_ROUTES[type]?.(id) ?? null;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["alerts"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  };
}

export function useTask(id: string | null | undefined) {
  return useQuery({ queryKey: ["tasks", "detail", id], queryFn: () => api.get<Task>(`/tasks/${id}`), enabled: !!id });
}

export function useSaveTask(id?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: TaskInput) => (id ? api.patch<Task>(`/tasks/${id}`, data) : api.post<Task>("/tasks", data)),
    onSuccess: invalidate,
  });
}

export function useTaskAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "complete" | "cancel" | "reopen"; note?: string | null }) =>
      api.post<Task>(`/tasks/${id}/${action}`, action === "reopen" ? undefined : { note: note || null }),
    onSuccess: invalidate,
  });
}

export function useAlertAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action, note, kind }: { id: string; action: "acknowledge" | "resolve"; note?: string; kind?: string }) =>
      api.post<Alert>(`/alerts/${id}/${action}`, action === "resolve" ? { note, kind } : { note: note || null }),
    onSuccess: invalidate,
  });
}

export function useRules() {
  return useQuery({ queryKey: ["automation", "rules"], queryFn: () => api.get<AutomationRule[]>("/automation/rules") });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }: { key: string; enabled?: boolean; thresholds?: Record<string, unknown> }) =>
      api.patch<AutomationRule>(`/automation/rules/${key}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });
}

export function useRunEscalations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) => api.post<EscalationResult>("/automation/run-escalations", undefined, { dry_run: dryRun }),
    onSuccess: (r) => {
      if (!r.dry_run) {
        qc.invalidateQueries({ queryKey: ["automation"] });
        qc.invalidateQueries({ queryKey: ["tasks"] });
        qc.invalidateQueries({ queryKey: ["alerts"] });
      }
    },
  });
}

export function useAlertNoise(sinceDays = 90) {
  return useQuery({ queryKey: ["automation", "noise", sinceDays], queryFn: () => api.get<NoiseRow[]>("/alerts/noise", { since_days: sinceDays }) });
}

export function useSubscriptions(scope: "mine" | "all" = "mine") {
  return useQuery({ queryKey: ["alert-subscriptions", scope], queryFn: () => api.get<Subscription[]>("/alert-subscriptions", { scope }) });
}

export function useSaveSubscription(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SubscriptionInput) =>
      id ? api.patch<Subscription>(`/alert-subscriptions/${id}`, data) : api.post<Subscription>("/alert-subscriptions", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-subscriptions"] }),
  });
}

export function useDeleteSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/alert-subscriptions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-subscriptions"] }),
  });
}

export function useDigest() {
  return useQuery({ queryKey: ["tasks", "digest"], queryFn: () => api.get<Digest>("/tasks/digest") });
}

/** `<input type="datetime-local">` value <-> ISO string helpers. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
