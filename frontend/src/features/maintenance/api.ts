"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Page } from "@/lib/api";

/* ------------------------------------------------------------------ constants */

export const WO_STATUSES = ["open", "assigned", "in_progress", "completed", "verified", "cancelled"] as const;
export const WO_FLOW = ["open", "assigned", "in_progress", "completed", "verified"] as const;
export const WO_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WO_SOURCES = ["tenant", "staff", "inspection", "preventive"] as const;
export const WO_CATEGORIES = [
  "hvac", "plumbing", "electrical", "roof", "structural", "parking_lot", "landscaping", "life_safety",
  "janitorial", "pest_control", "doors_locks", "signage", "elevator", "general", "other",
] as const;
export const CATEGORY_LABELS: Record<string, string> = {
  hvac: "HVAC", plumbing: "Plumbing", electrical: "Electrical", roof: "Roof", structural: "Structural",
  parking_lot: "Parking lot", landscaping: "Landscaping", life_safety: "Life safety", janitorial: "Janitorial",
  pest_control: "Pest control", doors_locks: "Doors & locks", signage: "Signage", elevator: "Elevator",
  general: "General", other: "Other",
};
export const APPROVAL_STATES = ["not_required", "pending", "approved", "rejected"] as const;
export const RESPONSIBILITY = ["undetermined", "tenant", "landlord", "shared"] as const;
export const PM_FREQUENCIES = ["weekly", "monthly", "quarterly", "semiannual", "annual", "custom"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const INSPECTION_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export const FINDING_STATUSES = ["open", "work_order_created", "resolved", "deferred"] as const;

/** Entity types used when linking documents through the documents module. */
export const DOC_ENTITY = {
  workOrder: "work_order",
  workOrderEvidence: "work_order_evidence",
  finding: "inspection_finding",
} as const;

/* ------------------------------------------------------------------ types */

export interface StatusHistoryEntry {
  from: string | null;
  to: string;
  at: string;
  by_id: string | null;
  by_name: string | null;
  note: string | null;
}

export interface WorkOrderListItem {
  id: string;
  number: number;
  title: string;
  source: string;
  category: string;
  priority: string;
  status: string;
  property_id: string;
  property_name: string | null;
  asset_id: string | null;
  space_id: string | null;
  system: string | null;
  location_detail: string | null;
  assignee_type: "vendor" | "staff" | null;
  vendor_id: string | null;
  vendor_name: string | null;
  assigned_user_id: string | null;
  assignee_name: string | null;
  estimate_amount: number | null;
  actual_cost: number | null;
  approval_status: string;
  tenant_responsibility: string;
  due_on: string | null;
  satisfaction_rating: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  verified_at: string | null;
}

export interface ResponsibilityBasis {
  clause_id: string | null;
  clause_type: string | null;
  document_id: string | null;
  page: number | null;
  clause_ref: string | null;
  excerpt: string;
  party: "tenant" | "landlord" | "shared";
}

export interface WorkOrder extends WorkOrderListItem {
  description: string | null;
  lease_id: string | null;
  requested_by_name: string | null;
  requester_contact: string | null;
  tenant_organization_id: string | null;
  reported_at: string | null;
  photo_document_ids: string[];
  status_history: StatusHistoryEntry[];
  assigned_at: string | null;
  started_at: string | null;
  approval_threshold: number | null;
  approved_by_id: string | null;
  approved_at: string | null;
  approval_note: string | null;
  completed_by_id: string | null;
  completion_notes: string | null;
  evidence_document_ids: string[];
  verified_by_id: string | null;
  cancelled_reason: string | null;
  satisfaction_comment: string | null;
  tenant_share_pct: number | null;
  responsibility_reason: string | null;
  responsibility_basis: ResponsibilityBasis[];
  responsibility_method: "lease_rules" | "manual" | null;
  responsibility_determined_at: string | null;
  chargeback_status: "none" | "created" | "pending_manual";
  chargeback_amount: number | null;
  chargeback_charge_id: string | null;
  pm_schedule_id: string | null;
  inspection_id: string | null;
  finding_id: string | null;
  created_by_id: string | null;
  evidence_count: number;
  vendor_compliance: { compliant: boolean; reasons: string[] } | null;
  allowed_transitions: string[];
}

export interface WorkOrderInput {
  title: string;
  description?: string | null;
  source?: string;
  category?: string;
  priority?: string;
  property_id: string;
  asset_id?: string | null;
  space_id?: string | null;
  lease_id?: string | null;
  system?: string | null;
  location_detail?: string | null;
  requested_by_name?: string | null;
  requester_contact?: string | null;
  tenant_organization_id?: string | null;
  reported_at?: string | null;
  due_on?: string | null;
  estimate_amount?: number | null;
  photo_document_ids?: string[];
}

export type WorkOrderUpdate = Partial<Omit<WorkOrderInput, "property_id" | "source" | "estimate_amount" | "reported_at">>;

export interface WorkOrderFacets {
  status: Record<string, number>;
  priority: Record<string, number>;
  category: Record<string, number>;
  source: Record<string, number>;
  approval_status: Record<string, number>;
}

export interface MaintenanceSettings {
  approval_threshold: number;
  finding_auto_wo_severity: string;
  pm_default_lead_days: number;
}

export interface PMSchedule {
  id: string;
  property_id: string;
  property_name: string | null;
  asset_id: string | null;
  system: string;
  title: string;
  description: string | null;
  category: string;
  priority: string;
  frequency: string;
  interval_days: number | null;
  lead_days: number;
  last_service_on: string | null;
  next_service_on: string;
  default_vendor_id: string | null;
  vendor_name: string | null;
  default_assignee_id: string | null;
  estimate_amount: number | null;
  is_active: boolean;
  last_generated_on: string | null;
  last_work_order_id: string | null;
  is_due: boolean;
  updated_at: string;
}

export type PMScheduleInput = Omit<PMSchedule, "id" | "property_name" | "vendor_name" | "last_generated_on" | "last_work_order_id" | "is_due" | "updated_at">;

export interface ServiceHistory {
  work_orders: WorkOrderListItem[];
  pm_schedules: PMSchedule[];
  total_cost: number;
  completed_count: number;
  open_count: number;
}

export interface TemplateItem {
  key: string;
  label: string;
  guidance?: string | null;
  category?: string | null;
}
export interface TemplateSection {
  key: string;
  title: string;
  items: TemplateItem[];
}
export interface InspectionTemplate {
  id: string;
  name: string;
  property_type: string | null;
  description: string | null;
  sections: TemplateSection[];
  version: number;
  is_active: boolean;
  item_count: number;
  updated_at: string;
}
export interface TemplateInput {
  name: string;
  property_type: string | null;
  description: string | null;
  sections: TemplateSection[];
  is_active: boolean;
}

export interface InspectionListItem {
  id: string;
  template_id: string | null;
  template_name: string | null;
  property_id: string;
  property_name: string | null;
  property_type: string | null;
  asset_id: string | null;
  inspector_id: string | null;
  inspector_name: string | null;
  status: string;
  scheduled_on: string | null;
  completed_at: string | null;
  score: number | null;
  finding_count: number;
  open_finding_count: number;
  updated_at: string;
}

export interface ItemResponse {
  result: "pass" | "fail" | "na" | null;
  note: string | null;
  answered_at?: string;
}

export interface Finding {
  id: string;
  inspection_id: string;
  property_id: string;
  item_key: string | null;
  item_label: string | null;
  section_title: string | null;
  title: string;
  description: string | null;
  category: string;
  severity: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  captured_at: string | null;
  photo_document_ids: string[];
  work_order_id: string | null;
  created_at: string;
}

export interface FindingInput {
  item_key?: string | null;
  title: string;
  description?: string | null;
  category?: string;
  severity?: string;
  latitude?: number | null;
  longitude?: number | null;
  location_accuracy_m?: number | null;
  captured_at?: string | null;
  photo_document_ids?: string[];
}

export interface Inspection extends InspectionListItem {
  template_version: number | null;
  sections: TemplateSection[];
  responses: Record<string, ItemResponse>;
  started_at: string | null;
  latitude: number | null;
  longitude: number | null;
  summary: string | null;
  findings: Finding[];
  progress: { total: number; answered: number; pass: number; fail: number; na: number };
  created_at: string;
}

/* ------------------------------------------------------------------ helpers */

export function woLabel(w: { number: number; title: string }) {
  return `#${w.number} · ${w.title}`;
}

export function categoryLabel(c?: string | null) {
  return c ? CATEGORY_LABELS[c] ?? c : "—";
}

/* ------------------------------------------------------------------ work orders */

function useInvalidateWO() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["work-orders"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", "work_order", id] });
  };
}

export function useWorkOrder(id: string) {
  return useQuery({ queryKey: ["work-orders", id], queryFn: () => api.get<WorkOrder>(`/work-orders/${id}`) });
}

export function useWorkOrderFacets(params: Record<string, string | string[] | undefined>) {
  return useQuery({
    queryKey: ["work-orders", "facets", params],
    queryFn: () => api.get<WorkOrderFacets>("/work-orders/facets", params),
    placeholderData: (prev) => prev,
  });
}

export function useWorkOrdersFor(params: Record<string, string | number | boolean | undefined>) {
  return useQuery({
    queryKey: ["work-orders", "list", "embedded", params],
    queryFn: () => api.get<Page<WorkOrderListItem>>("/work-orders", { page_size: 50, ...params }),
  });
}

export function useSaveWorkOrder(id?: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateWO();
  return useMutation({
    mutationFn: (data: WorkOrderInput | WorkOrderUpdate) =>
      id ? api.patch<WorkOrder>(`/work-orders/${id}`, data) : api.post<WorkOrder>("/work-orders", data),
    onSuccess: (wo) => {
      qc.setQueryData(["work-orders", wo.id], wo);
      invalidate(wo.id);
    },
  });
}

/** Generic action on a work order: POST /work-orders/{id}/{action}. */
export function useWorkOrderAction<TBody = unknown>(id: string, action: "assign" | "transition" | "costs" | "approval" | "responsibility" | "chargeback" | "satisfaction" | "evidence") {
  const qc = useQueryClient();
  const invalidate = useInvalidateWO();
  return useMutation({
    mutationFn: (body: TBody) => api.post<WorkOrder>(`/work-orders/${id}/${action}`, body ?? {}),
    onSuccess: (wo) => {
      qc.setQueryData(["work-orders", wo.id], wo);
      invalidate(wo.id);
      qc.invalidateQueries({ queryKey: ["pm-schedules"] });
      qc.invalidateQueries({ queryKey: ["inspections"] });
    },
  });
}

export function useBulkWorkOrders() {
  const invalidate = useInvalidateWO();
  return useMutation({
    mutationFn: (body: { ids: string[]; priority?: string; assigned_user_id?: string }) =>
      api.post<{ updated: number }>("/work-orders/bulk", body),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveWorkOrder() {
  const invalidate = useInvalidateWO();
  return useMutation({ mutationFn: (id: string) => api.delete(`/work-orders/${id}`), onSuccess: () => invalidate() });
}

export function useMaintenanceSettings() {
  return useQuery({ queryKey: ["work-orders", "settings"], queryFn: () => api.get<MaintenanceSettings>("/work-orders/settings") });
}

export function useSaveMaintenanceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MaintenanceSettings) => api.put<MaintenanceSettings>("/work-orders/settings", body),
    onSuccess: (s) => qc.setQueryData(["work-orders", "settings"], s),
  });
}

export function useServiceHistory(params: { asset_id?: string | null; property_id?: string | null; system?: string | null }, enabled = true) {
  return useQuery({
    queryKey: ["work-orders", "service-history", params],
    queryFn: () => api.get<ServiceHistory>("/work-orders/service-history", params),
    enabled: enabled && !!(params.asset_id || params.property_id),
  });
}

/* ------------------------------------------------------------------ preventive maintenance */

export function useSavePMSchedule(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PMScheduleInput) => (id ? api.put<PMSchedule>(`/pm-schedules/${id}`, data) : api.post<PMSchedule>("/pm-schedules", data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pm-schedules"] }),
  });
}

export function useArchivePMSchedule() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/pm-schedules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["pm-schedules"] }) });
}

export function useScanPM() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId?: string) =>
      api.post<{ scanned: number; generated: number; work_order_ids: string[] }>("/pm-schedules/scan", undefined, propertyId ? { property_id: propertyId } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pm-schedules"] });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
    },
  });
}

/* ------------------------------------------------------------------ inspection templates */

export function useInspectionTemplates(params: { property_type?: string | null; active?: boolean; q?: string } = {}) {
  return useQuery({
    queryKey: ["inspection-templates", params],
    queryFn: () => api.get<InspectionTemplate[]>("/inspection-templates", { ...params, property_type: params.property_type ?? undefined }),
  });
}

export function useSaveTemplate(id?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TemplateInput) =>
      id ? api.put<InspectionTemplate>(`/inspection-templates/${id}`, data) : api.post<InspectionTemplate>("/inspection-templates", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inspection-templates"] }),
  });
}

export function useArchiveTemplate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/inspection-templates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["inspection-templates"] }) });
}

/* ------------------------------------------------------------------ inspections */

export function useInspection(id: string) {
  return useQuery({ queryKey: ["inspections", id], queryFn: () => api.get<Inspection>(`/inspections/${id}`) });
}

export function useCreateInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { template_id: string; property_id: string; asset_id?: string | null; inspector_id?: string | null; scheduled_on?: string | null }) =>
      api.post<Inspection>("/inspections", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inspections"] }),
  });
}

function useInspectionMutation<TBody>(id: string, fn: (body: TBody) => Promise<Inspection>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (insp) => {
      qc.setQueryData(["inspections", id], insp);
      qc.invalidateQueries({ queryKey: ["inspections"] });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
    },
  });
}

export function useUpdateInspection(id: string) {
  return useInspectionMutation(id, (body: { inspector_id?: string | null; scheduled_on?: string | null; summary?: string | null; latitude?: number | null; longitude?: number | null }) =>
    api.patch<Inspection>(`/inspections/${id}`, body),
  );
}

export function useRecordResponses(id: string) {
  return useInspectionMutation(id, (responses: { item_key: string; result: "pass" | "fail" | "na" | null; note?: string | null }[]) =>
    api.post<Inspection>(`/inspections/${id}/responses`, { responses }),
  );
}

export function useInspectionStatus(id: string) {
  return useInspectionMutation(id, (body: { status: "in_progress" | "completed" | "cancelled"; summary?: string | null }) =>
    api.post<Inspection>(`/inspections/${id}/status`, body),
  );
}

export function useAddFinding(inspectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FindingInput) =>
      api.post<{ finding: Finding; work_order_id: string | null; auto_created: boolean }>(`/inspections/${inspectionId}/findings`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inspections"] });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
    },
  });
}

export function useUpdateFinding(inspectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<FindingInput> & { id: string; status?: string }) => api.patch<Finding>(`/inspection-findings/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inspections", inspectionId] }),
  });
}

export function useFindingWorkOrder(inspectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) => api.post<WorkOrder>(`/inspection-findings/${findingId}/work-order`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inspections", inspectionId] });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
    },
  });
}

export function useArchiveInspection() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/inspections/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["inspections"] }) });
}
