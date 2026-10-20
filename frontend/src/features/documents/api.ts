"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { API_URL, api, type Page, type Params } from "@/lib/api";

export const DOC_CLASSES = [
  "acquisition", "lease", "amendment", "estoppel", "snda", "debt", "loan_agreement", "tax", "insurance",
  "closing", "settlement_statement", "survey", "title", "environmental", "pca", "appraisal", "bov", "entity",
  "correspondence", "contract", "loi", "other",
] as const;

export const DOC_CLASS_LABELS: Record<string, string> = {
  acquisition: "Acquisition",
  lease: "Lease",
  amendment: "Lease amendment",
  estoppel: "Estoppel",
  snda: "SNDA",
  debt: "Debt",
  loan_agreement: "Loan agreement",
  tax: "Tax",
  insurance: "Insurance",
  closing: "Closing",
  settlement_statement: "Settlement statement",
  survey: "Survey",
  title: "Title",
  environmental: "Environmental",
  pca: "Property condition (PCA)",
  appraisal: "Appraisal",
  bov: "BOV",
  entity: "Entity",
  correspondence: "Correspondence",
  contract: "Contract",
  loi: "LOI",
  other: "Other",
};

export const LINK_TYPES = [
  "property", "person", "organization", "opportunity", "offer", "contract", "closing", "asset", "lease", "loan",
  "disposition", "work_order", "vendor", "capital_project", "insurance_policy", "capital_partner", "listing",
  "brokerage_deal", "uw_model",
] as const;

export const LINK_TYPE_LABELS: Record<string, string> = {
  property: "Property",
  person: "Person",
  organization: "Organization",
  opportunity: "Opportunity",
  offer: "Offer",
  contract: "Contract",
  closing: "Closing",
  asset: "Asset",
  lease: "Lease",
  loan: "Loan",
  disposition: "Disposition",
  work_order: "Work order",
  vendor: "Vendor",
  capital_project: "Capital project",
  insurance_policy: "Insurance policy",
  capital_partner: "Capital partner",
  listing: "Listing",
  brokerage_deal: "Brokerage deal",
  uw_model: "Underwriting model",
};

/** Record types that have a searchable picker endpoint. */
export const PICKER_ENDPOINTS: Record<string, { endpoint: string; label: (r: Record<string, unknown>) => string }> = {
  property: { endpoint: "/properties", label: (r) => String(r.name || r.address_line || "") },
  person: { endpoint: "/people", label: (r) => String(r.full_name ?? "") },
  organization: { endpoint: "/organizations", label: (r) => String(r.name ?? "") },
  opportunity: { endpoint: "/opportunities", label: (r) => String(r.title ?? "") },
};

const RECORD_ROUTES: Record<string, string> = {
  property: "/properties",
  person: "/people",
  organization: "/organizations",
  opportunity: "/pipeline",
  uw_model: "/underwriting",
};

export function recordHref(entityType: string, entityId: string): string | null {
  const base = RECORD_ROUTES[entityType];
  return base ? `${base}/${entityId}` : null;
}

export const VALUE_STATUSES = ["pending", "confirmed", "edited", "rejected"] as const;
export const VALUE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending review",
  confirmed: "Confirmed",
  edited: "Edited & confirmed",
  rejected: "Rejected",
};

export interface DocumentLink {
  id: string;
  document_id: string;
  entity_type: string;
  entity_id: string;
  label: string | null;
  created_at: string;
}

export interface DocumentRef {
  id: string;
  title: string;
  filename: string;
  version: number;
  created_at: string;
}

export interface DocumentListItem {
  id: string;
  title: string;
  doc_class: string;
  classification_source: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  version: number;
  is_sensitive: boolean;
  legal_hold: boolean;
  retention_until: string | null;
  extraction_status: string;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  pending_values: number;
  links: DocumentLink[];
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface DocumentDetail extends DocumentListItem {
  description: string | null;
  classification_confidence: number | null;
  sha256: string;
  parent_document_id: string | null;
  is_latest: boolean;
  has_text: boolean;
  text_content: string | null;
  text_source: string | null;
  can_delete: boolean;
  delete_blocked_reason: string | null;
  duplicates: DocumentRef[];
}

export interface DocumentFacets {
  doc_class: Record<string, number>;
  sensitivity: Record<string, number>;
  linked_type: Record<string, number>;
  extraction_status: Record<string, number>;
}

export interface ExtractedValue {
  id: string;
  document_id: string;
  document_title: string | null;
  job_id: string | null;
  origin: "ai" | "manual";
  target_entity_type: string | null;
  target_entity_id: string | null;
  target_label: string | null;
  field: string;
  value_type: "text" | "number" | "money" | "date" | "percent";
  value: unknown;
  original_value: unknown;
  page: number | null;
  clause: string | null;
  citation_text: string | null;
  confidence: number;
  status: "pending" | "confirmed" | "rejected" | "edited";
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  ai_model: string | null;
  applied_observation_id: string | null;
  is_date: boolean;
  applicable: boolean;
  current_value: unknown;
  conflict: boolean | null;
  created_at: string;
}

export interface ValueFacets {
  status: Record<string, number>;
  field: Record<string, number>;
  target_entity_type: Record<string, number>;
}

export interface ExtractionJob {
  id: string;
  document_id: string;
  status: string;
  target_entity_type: string | null;
  target_entity_id: string | null;
  fields: string[];
  provider: string | null;
  model: string | null;
  values_count: number;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AccessLogEntry {
  id: string;
  action: "view" | "download" | "preview";
  occurred_at: string;
  user_id: string | null;
  user_name: string | null;
  ip_address: string | null;
}

export interface Citation {
  document_id: string | null;
  page: number | null;
  clause: string | null;
  text: string | null;
}

export interface SearchHit {
  document_id: string;
  title: string;
  doc_class: string;
  filename: string;
  is_sensitive: boolean;
  matched_in: string[];
  snippet: string | null;
  citations: Citation[];
  links: DocumentLink[];
}

export interface AICallEntry {
  id: string;
  provider: string;
  model: string | null;
  purpose: string;
  prompt_hash: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  status: string;
  error: string | null;
  document_id: string | null;
  created_by_id: string | null;
  created_at: string;
}

export interface SchemaField {
  field: string;
  label: string;
  type: ExtractedValue["value_type"];
}

export interface DocumentsMeta {
  doc_classes: string[];
  link_types: string[];
  max_upload_mb: number;
  inline_types: string[];
  schemas: Record<string, SchemaField[]>;
  property_fields: string[];
  ai: { name: string; model: string; available: boolean };
}

export interface SummaryResult {
  ai_used: boolean;
  provider: string;
  summary: string | null;
  citations: Citation[];
  document_ids: string[];
  message: string | null;
}

export interface DraftResult {
  ai_used: boolean;
  provider: string;
  draft: string;
  sources: { field: string; value: unknown; source: string }[];
}

export function docClassLabel(c?: string | null) {
  return c ? DOC_CLASS_LABELS[c] ?? c : "—";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Signed URLs are API-relative (`/api/v1/documents/download?token=…`); resolve against the API origin. */
export async function getSignedUrl(id: string, inline = false): Promise<string> {
  const res = await api.get<{ url: string; expires_at: string; inline: boolean }>(`/documents/${id}/signed-url`, { inline });
  return new URL(res.url, API_URL).toString();
}

/** Download through a short-lived signed link (attachment disposition, so the page does not navigate). */
export async function downloadDocument(id: string): Promise<void> {
  const url = await getSignedUrl(id, false);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Open inline in a new tab. The tab is opened synchronously so popup blockers allow it. */
export async function openDocumentInTab(id: string): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const url = await getSignedUrl(id, true);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

export function useDocumentsMeta() {
  return useQuery({ queryKey: ["documents", "meta"], queryFn: () => api.get<DocumentsMeta>("/documents/meta"), staleTime: 5 * 60_000 });
}

export function useDocument(id: string) {
  return useQuery({ queryKey: ["documents", id], queryFn: () => api.get<DocumentDetail>(`/documents/${id}`) });
}

export function useDocumentVersions(id: string) {
  return useQuery({ queryKey: ["documents", id, "versions"], queryFn: () => api.get<DocumentListItem[]>(`/documents/${id}/versions`) });
}

export function useDocumentAccessLog(id: string, enabled = true) {
  return useQuery({ queryKey: ["documents", id, "access-log"], queryFn: () => api.get<AccessLogEntry[]>(`/documents/${id}/access-log`), enabled });
}

export function useDocumentJobs(id: string) {
  return useQuery({
    queryKey: ["documents", id, "jobs"],
    queryFn: () => api.get<ExtractionJob[]>(`/documents/${id}/jobs`),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "queued" || j.status === "running") ? 3000 : false),
  });
}

export function useDocumentAICalls(id: string, enabled = true) {
  return useQuery({
    queryKey: ["documents", id, "ai-calls"],
    queryFn: () => api.get<Page<AICallEntry>>("/documents/ai-calls", { document_id: id, page_size: 50 }),
    enabled,
  });
}

export function useRecordDocuments(entityType: string, entityId: string) {
  const params = { entity_type: entityType, entity_id: entityId, page_size: 100, sort: "-updated_at" };
  return useQuery({
    queryKey: ["documents", "list", "record", params],
    queryFn: () => api.get<Page<DocumentListItem>>("/documents", params),
  });
}

export function useExtractedValues(params: Params, enabled = true) {
  return useQuery({
    queryKey: ["documents", "values", params],
    queryFn: () => api.get<Page<ExtractedValue>>("/documents/extracted-values", params),
    enabled,
  });
}

function useInvalidateDocs() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["documents"] });
    if (id) qc.invalidateQueries({ queryKey: ["timeline", "document", id] });
  };
}

export interface UploadInput {
  file: File;
  title?: string;
  doc_class?: string;
  description?: string;
  is_sensitive?: boolean;
  retention_until?: string;
  tags?: string;
  entity_type?: string;
  entity_id?: string;
}

export function useUploadDocument() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (input: UploadInput) => {
      const fd = new FormData();
      fd.append("file", input.file);
      for (const [k, v] of Object.entries(input)) {
        if (k === "file" || v === undefined || v === null || v === "") continue;
        fd.append(k, typeof v === "boolean" ? String(v) : String(v));
      }
      return api.post<DocumentDetail>("/documents", fd);
    },
    onSuccess: (d) => invalidate(d.id),
  });
}

export function useUploadVersion(id: string) {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<DocumentDetail>(`/documents/${id}/versions`, fd);
    },
    onSuccess: (d) => invalidate(d.id),
  });
}

export function useUpdateDocument(id: string) {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (body: Partial<Pick<DocumentDetail, "title" | "description" | "doc_class" | "is_sensitive" | "retention_until" | "legal_hold" | "tags">>) =>
      api.patch<DocumentDetail>(`/documents/${id}`, body),
    onSuccess: () => invalidate(id),
  });
}

export function useDeleteDocument() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => invalidate(),
  });
}

export function useSetDocumentText(id: string) {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (text: string) => api.put<DocumentDetail>(`/documents/${id}/text`, { text }),
    onSuccess: () => invalidate(id),
  });
}

export function useAddLink() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: ({ documentId, entity_type, entity_id }: { documentId: string; entity_type: string; entity_id: string }) =>
      api.post<DocumentLink>(`/documents/${documentId}/links`, { entity_type, entity_id }),
    onSuccess: (_, v) => invalidate(v.documentId),
  });
}

export function useRemoveLink() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: ({ documentId, linkId }: { documentId: string; linkId: string }) => api.delete(`/documents/${documentId}/links/${linkId}`),
    onSuccess: (_, v) => invalidate(v.documentId),
  });
}

export function useRequestExtraction(id: string) {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (body: { target_entity_type?: string; target_entity_id?: string; fields?: string[] }) =>
      api.post<ExtractionJob>(`/documents/${id}/extract`, body),
    onSuccess: () => invalidate(id),
  });
}

export function useAddManualValue(id: string) {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (body: {
      field: string;
      value: unknown;
      value_type: ExtractedValue["value_type"];
      page?: number | null;
      clause?: string | null;
      citation_text?: string | null;
      target_entity_type?: string | null;
      target_entity_id?: string | null;
    }) => api.post<ExtractedValue>(`/documents/${id}/values`, body),
    onSuccess: () => invalidate(id),
  });
}

export type ReviewAction =
  | { kind: "confirm"; id: string; accept_conflict?: boolean; note?: string }
  | { kind: "edit"; id: string; value: unknown; accept_conflict?: boolean; note?: string }
  | { kind: "reject"; id: string; note?: string };

export function useReviewValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: ReviewAction) => {
      const { kind, id, ...body } = a;
      return api.post<ExtractedValue>(`/documents/extracted-values/${id}/${kind}`, body);
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      if (v.target_entity_type === "property" && v.target_entity_id) {
        qc.invalidateQueries({ queryKey: ["properties", v.target_entity_id] });
        qc.invalidateQueries({ queryKey: ["timeline", "property", v.target_entity_id] });
      }
    },
  });
}

export function useSummarize() {
  return useMutation({
    mutationFn: (body: { document_ids?: string[]; entity_type?: string; entity_id?: string; purpose?: string }) =>
      api.post<SummaryResult>("/documents/summarize", body),
  });
}

export function useDraft() {
  return useMutation({
    mutationFn: (body: { kind: "outreach" | "offer" | "proposal" | "report"; entity_type: "property"; entity_id: string; instructions?: string }) =>
      api.post<DraftResult>("/documents/draft", body),
  });
}
